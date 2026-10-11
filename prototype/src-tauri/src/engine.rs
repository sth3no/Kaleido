use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use mpv_ffi::{Event, Mpv, PropertyKind, PropertyValue, load_api, locate_libmpv};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

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

pub struct Engine {
    pub mpv: Mpv,
}

#[derive(Clone, Serialize)]
struct Prop {
    name: String,
    value: Value,
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
        let engine = Arc::new(Engine { mpv });
        let pump = Arc::clone(&engine);
        thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || pump.run_events(&app))
            .expect("spawn mpv event thread");
        Ok(engine)
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
        let _ = app.emit("player:message", args);
    }
}
