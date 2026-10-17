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

/// At most one value per `interval` (spec 4.4: `time-pos` max 10×/s) without losing the latest:
/// a value that comes too early is held and sent when the interval ends.
struct Throttle<T> {
    interval: Duration,
    last_sent: Option<Instant>,
    held: Option<T>,
}

impl<T> Throttle<T> {
    fn new(interval: Duration) -> Throttle<T> {
        Throttle {
            interval,
            last_sent: None,
            held: None,
        }
    }

    fn ready(&self, now: Instant) -> bool {
        self.last_sent
            .is_none_or(|sent| now.duration_since(sent) >= self.interval)
    }

    /// Some = send this now; None = held until `due`.
    fn offer(&mut self, now: Instant, value: T) -> Option<T> {
        if self.ready(now) {
            self.held = None;
            self.last_sent = Some(now);
            Some(value)
        } else {
            self.held = Some(value);
            None
        }
    }

    /// The held value once its interval has ended.
    fn due(&mut self, now: Instant) -> Option<T> {
        if self.held.is_some() && self.ready(now) {
            self.last_sent = Some(now);
            self.held.take()
        } else {
            None
        }
    }

    /// How long until the held value is due; None when nothing is held.
    fn wait(&self, now: Instant) -> Option<Duration> {
        let sent = self.last_sent?;
        self.held
            .as_ref()
            .map(|_| self.interval.saturating_sub(now.duration_since(sent)))
    }
}

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

    /// Recover properties emitted before React mounted (also handles a dev-page reload).
    pub fn sync_state(&self, app: &AppHandle) {
        for (name, kind) in OBSERVED {
            let value = match kind {
                PropertyKind::Flag => self.mpv.get_flag(name).map(|v| json!(v)),
                PropertyKind::Int64 => self.mpv.get_i64(name).map(|v| json!(v)),
                PropertyKind::Double => self.mpv.get_f64(name).map(|v| json!(v)),
                PropertyKind::String => self.mpv.get_string(name).map(|v| json!(v)),
            };
            if let Ok(value) = value {
                let _ = app.emit(
                    "player:prop",
                    Prop {
                        name: (*name).into(),
                        value,
                    },
                );
            }
        }
        if self.mpv.get_flag("idle-active").is_ok_and(|idle| !idle) {
            let _ = app.emit("player:file-loaded", ());
        }
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
        let mut time_pos = Throttle::new(TIME_POS_INTERVAL);
        let emit_time_pos = |value: PropertyValue| {
            let _ = app.emit(
                "player:prop",
                Prop {
                    name: "time-pos".into(),
                    value: to_json(&value),
                },
            );
        };
        loop {
            let timeout = time_pos
                .wait(Instant::now())
                .map_or(-1.0, |wait| wait.as_secs_f64());
            let event = self.mpv.wait_event(timeout);
            if let Some(value) = time_pos.due(Instant::now()) {
                emit_time_pos(value);
            }
            match event {
                // mpv's `quit` (q, window close) ends the app (spec 5.1).
                Event::Shutdown => {
                    app.exit(0);
                    return;
                }
                Event::PropertyChange { name, value, .. } if name == "time-pos" => {
                    if let Some(value) = time_pos.offer(Instant::now(), value) {
                        emit_time_pos(value);
                    }
                }
                Event::PropertyChange { name, value, .. } => {
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

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    #[test]
    fn first_value_goes_out_immediately() {
        let start = Instant::now();
        let mut throttle = Throttle::new(100 * MS);
        assert_eq!(throttle.offer(start, 1.0), Some(1.0));
        assert_eq!(throttle.wait(start), None);
    }

    /// Holding Left while paused seeks every ~25 ms; the last position must still reach the UI.
    #[test]
    fn a_value_inside_the_interval_is_held_and_sent_when_it_ends() {
        let start = Instant::now();
        let mut throttle = Throttle::new(100 * MS);
        throttle.offer(start, 1.0);
        assert_eq!(throttle.offer(start + 30 * MS, 2.0), None);
        assert_eq!(throttle.wait(start + 30 * MS), Some(70 * MS));
        assert_eq!(throttle.due(start + 99 * MS), None);
        assert_eq!(throttle.due(start + 100 * MS), Some(2.0));
        assert_eq!(throttle.wait(start + 100 * MS), None);
    }

    #[test]
    fn the_latest_held_value_wins() {
        let start = Instant::now();
        let mut throttle = Throttle::new(100 * MS);
        throttle.offer(start, 1.0);
        throttle.offer(start + 30 * MS, 2.0);
        throttle.offer(start + 60 * MS, 3.0);
        assert_eq!(throttle.due(start + 100 * MS), Some(3.0));
        assert_eq!(throttle.due(start + 200 * MS), None);
    }

    #[test]
    fn after_the_interval_a_new_value_goes_out_at_once() {
        let start = Instant::now();
        let mut throttle = Throttle::new(100 * MS);
        throttle.offer(start, 1.0);
        assert_eq!(throttle.offer(start + 150 * MS, 2.0), Some(2.0));
        assert_eq!(throttle.offer(start + 200 * MS, 3.0), None);
        assert_eq!(throttle.due(start + 250 * MS), Some(3.0));
    }
}
