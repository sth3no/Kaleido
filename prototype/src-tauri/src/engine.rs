use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use mpv_ffi::{Event, Mpv, PropertyKind, PropertyValue, load_api, locate_libmpv};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::glass::{self, GlassRect, OutputOrigin};
use crate::thumbs;

/// Properties the UI renders (M0 subset of spec 4.4 `player:state`).
const OBSERVED: &[(&str, PropertyKind)] = &[
    ("pause", PropertyKind::Flag),
    ("time-pos", PropertyKind::Double),
    ("duration", PropertyKind::Double),
    ("volume", PropertyKind::Double),
    ("fullscreen", PropertyKind::Flag),
    ("media-title", PropertyKind::String),
    ("video-params/gamma", PropertyKind::String),
    ("video-params/h", PropertyKind::Int64),
    ("osd-dimensions/w", PropertyKind::Int64),
    ("osd-dimensions/h", PropertyKind::Int64),
    ("osd-dimensions/ml", PropertyKind::Int64),
    ("osd-dimensions/mt", PropertyKind::Int64),
];

const TIME_POS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
struct GlassState {
    rects: Vec<GlassRect>,
    scale: f64,
    origin: OutputOrigin,
}

pub struct Engine {
    pub mpv: Mpv,
    glass: Mutex<GlassState>,
    thumb: Mutex<Vec<u8>>,
}

#[derive(Clone, Serialize)]
struct Prop {
    name: String,
    value: Value,
}

#[derive(Clone, Serialize)]
struct ThumbReady {
    width: u32,
    height: u32,
}

pub fn to_json(value: &PropertyValue) -> Value {
    match value {
        PropertyValue::Unavailable => Value::Null,
        PropertyValue::Flag(b) => json!(b),
        PropertyValue::Int64(i) => json!(i),
        PropertyValue::Double(d) => json!(d),
        PropertyValue::String(s) => json!(s),
    }
}

impl Engine {
    pub fn start(
        app: AppHandle,
        wid: isize,
        options: &[(&str, String)],
    ) -> mpv_ffi::Result<Arc<Engine>> {
        let mpv = Mpv::create(load_api(&locate_libmpv())?)?;
        mpv.set_option("wid", &wid.to_string())?;
        for (name, value) in options {
            mpv.set_option(name, value)?;
        }
        mpv.initialize()?;
        for (id, (name, kind)) in OBSERVED.iter().enumerate() {
            mpv.observe(id as u64, name, *kind)?;
        }
        mpv.request_log_messages("warn")?;
        // `s` = screenshot with the glass regions removed first (spec 5.4 #8); `S` stays mpv's default.
        mpv.command(&["keybind", "s", "script-message kaleido screenshot"])?;
        let engine = Arc::new(Engine {
            mpv,
            glass: Mutex::new(GlassState {
                scale: 1.0,
                ..GlassState::default()
            }),
            thumb: Mutex::new(Vec::new()),
        });
        let pump = Arc::clone(&engine);
        thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || pump.run_events(&app))
            .expect("spawn mpv event thread");
        Ok(engine)
    }

    pub fn latest_thumb(&self) -> Vec<u8> {
        self.thumb.lock().unwrap().clone()
    }

    fn on_thumbfast_render(&self, app: &AppHandle, json: &str) {
        match thumbs::load(json, &std::env::temp_dir()) {
            Ok(thumb) => {
                let ready = ThumbReady {
                    width: thumb.width,
                    height: thumb.height,
                };
                *self.thumb.lock().unwrap() = thumb.rgba;
                let _ = app.emit("thumb:ready", ready);
            }
            Err(e) => {
                let _ = app.emit("player:log", format!("thumbfast-render rejected: {e:?}"));
            }
        }
    }

    pub fn set_glass(&self, rects: Vec<GlassRect>, scale: f64) -> mpv_ffi::Result<()> {
        let mut glass = self.glass.lock().unwrap();
        glass.rects = rects;
        glass.scale = scale;
        self.apply_glass(&glass)
    }

    fn apply_glass(&self, glass: &GlassState) -> mpv_ffi::Result<()> {
        let opts = glass::shader_opts(&glass.rects, glass.scale, glass.origin);
        self.mpv.set_property("glsl-shader-opts", &opts)
    }

    fn on_output_margin(&self, name: &str, value: &PropertyValue) {
        if !glass::OUTPUT_EXCLUDES_MARGINS {
            return;
        }
        let PropertyValue::Int64(px) = value else {
            return;
        };
        let mut glass = self.glass.lock().unwrap();
        match name {
            "osd-dimensions/ml" => glass.origin.x = *px as f64,
            "osd-dimensions/mt" => glass.origin.y = *px as f64,
            _ => return,
        }
        let _ = self.apply_glass(&glass);
    }

    fn screenshot_without_glass(&self) {
        let glass = self.glass.lock().unwrap();
        let _ = self.mpv.set_property(
            "glsl-shader-opts",
            &glass::shader_opts(&[], 1.0, OutputOrigin::default()),
        );
        let _ = self.mpv.command(&["screenshot"]);
        let _ = self.apply_glass(&glass);
    }

    fn run_events(&self, app: &AppHandle) {
        let mut last_time_pos = Instant::now();
        loop {
            match self.mpv.wait_event(-1.0) {
                // mpv's `quit` (q, window close) ends the app (spec 5.1).
                Event::Shutdown => {
                    app.exit(0);
                    return;
                }
                Event::PropertyChange { name, value, .. } => {
                    if name == "time-pos" {
                        if last_time_pos.elapsed() < TIME_POS_INTERVAL {
                            continue;
                        }
                        last_time_pos = Instant::now();
                    }
                    if name.starts_with("osd-dimensions/m") {
                        self.on_output_margin(&name, &value);
                    }
                    let _ = app.emit(
                        "player:prop",
                        Prop {
                            value: to_json(&value),
                            name,
                        },
                    );
                }
                Event::FileLoaded => {
                    let _ = app.emit("player:file-loaded", ());
                }
                Event::EndFile { reason } => {
                    let _ = app.emit("player:end-file", format!("{reason:?}"));
                }
                Event::LogMessage {
                    prefix,
                    level,
                    text,
                } => {
                    let _ = app.emit("player:log", format!("[{prefix}] {level}: {text}"));
                }
                Event::ClientMessage { args } => self.on_client_message(app, args),
                _ => {}
            }
        }
    }

    fn on_client_message(&self, app: &AppHandle, args: Vec<String>) {
        match args.as_slice() {
            [target, action] if target == "kaleido" && action == "screenshot" => {
                self.screenshot_without_glass()
            }
            [message, json] if message == "thumbfast-render" => self.on_thumbfast_render(app, json),
            _ => {
                let _ = app.emit("player:message", args);
            }
        }
    }
}
