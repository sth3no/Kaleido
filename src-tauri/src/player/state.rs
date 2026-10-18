//! What mpv tells the UI (spec 4.4): property changes batched into `player:state`, `time-pos`
//! at most 10 times a second, file and log events, and the client messages Kaleido uses.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use mpv_ffi::{EndFileReason, Event, Mpv, PropertyKind, PropertyValue};
use serde::{Serialize, Serializer};
use serde_json::Value;

use super::{ENGINE_OBSERVE_BASE, EventLoop};

/// The properties the UI renders, observed under their index as reply id.
pub const OBSERVED: &[(&str, PropertyKind)] = &[
    ("pause", PropertyKind::Flag),
    ("time-pos", PropertyKind::Double),
    ("duration", PropertyKind::Double),
    ("volume", PropertyKind::Double),
    ("volume-max", PropertyKind::Double),
    ("mute", PropertyKind::Flag),
    ("speed", PropertyKind::Double),
    ("media-title", PropertyKind::String),
    ("playlist", PropertyKind::String),
    ("playlist-pos", PropertyKind::Int64),
    ("track-list", PropertyKind::String),
    ("chapter-list", PropertyKind::String),
    ("chapter", PropertyKind::Int64),
    ("video-params", PropertyKind::String),
    ("osd-dimensions", PropertyKind::String),
    ("fullscreen", PropertyKind::Flag),
    ("ontop", PropertyKind::Flag),
    ("idle-active", PropertyKind::Flag),
    ("eof-reached", PropertyKind::Flag),
    ("paused-for-cache", PropertyKind::Flag),
    ("seeking", PropertyKind::Flag),
    ("sub-delay", PropertyKind::Double),
    ("sub-scale", PropertyKind::Double),
    ("audio-delay", PropertyKind::Double),
    ("aid", PropertyKind::Int64),
    ("sid", PropertyKind::Int64),
    ("vid", PropertyKind::Int64),
    ("hwdec-current", PropertyKind::String),
];

/// Observed as text; mpv writes these as JSON and the UI gets them parsed.
pub const JSON_PROPERTIES: [&str; 5] = [
    "playlist",
    "track-list",
    "chapter-list",
    "video-params",
    "osd-dimensions",
];

// The ids are indexes into `OBSERVED`; the engine keeps the ids from its base up for itself.
const _: () = assert!((OBSERVED.len() as u64) < ENGINE_OBSERVE_BASE);

const TIME_POS: &str = "time-pos";
const TIME_POS_INTERVAL: Duration = Duration::from_millis(100);

/// Why a file stopped (`player:end-file`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    Eof,
    Stop,
    Quit,
    Error,
    Redirect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogLine {
    pub level: String,
    pub prefix: String,
    pub text: String,
}

/// What the UI and Rust's own handlers hear from mpv. The serialized form is the payload of the
/// event on [`PlayerEvent::channel`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PlayerEvent {
    /// Properties that changed since the last one, newest value each.
    State {
        changes: BTreeMap<String, Value>,
    },
    #[serde(serialize_with = "empty_object")]
    FileLoaded,
    EndFile {
        reason: EndReason,
        error: Option<String>,
        /// The `filename` of the playlist entry that failed, as mpv's `playlist` property has it
        /// (the path or link as it was loaded); `None` where the playlist no longer has the entry,
        /// and for every end but an error: that is the one the UI has to say something about, and
        /// the only one for which the playlist is read.
        file: Option<String>,
        /// Whether mpv goes on by itself after the file that failed: true when an entry follows it
        /// in the playlist, or the playlist loops and has more than one entry. `false` for every
        /// other end, and where the playlist cannot be read.
        continues: bool,
    },
    /// A `script-message kaleido …`, without the leading `kaleido`.
    Message {
        args: Vec<String>,
    },
    Log(LogLine),
    /// thumbfast finished a thumbnail; the JSON says where (Rust only).
    ThumbRendered(String),
    /// mpv is quitting (Rust only).
    Shutdown,
}

fn empty_object<S: Serializer>(serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    serializer.serialize_map(Some(0))?.end()
}

impl PlayerEvent {
    /// The Tauri event the UI listens to; `None` for events only Rust handles.
    pub fn channel(&self) -> Option<&'static str> {
        match self {
            PlayerEvent::State { .. } => Some("player:state"),
            PlayerEvent::FileLoaded => Some("player:file-loaded"),
            PlayerEvent::EndFile { .. } => Some("player:end-file"),
            PlayerEvent::Message { .. } => Some("player:message"),
            PlayerEvent::Log(_) => Some("player:log"),
            PlayerEvent::ThumbRendered(_) | PlayerEvent::Shutdown => None,
        }
    }
}

/// Where [`StateLoop`] delivers its events (on the mpv event thread).
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: PlayerEvent);
}

/// At most one value per `interval` (spec 4.4: `time-pos` max 10×/s) without losing the latest:
/// a value that comes too early is held and sent when the interval ends.
pub struct Throttle<T> {
    interval: Duration,
    last_sent: Option<Instant>,
    held: Option<T>,
}

impl<T> Throttle<T> {
    pub fn new(interval: Duration) -> Throttle<T> {
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
    pub fn offer(&mut self, now: Instant, value: T) -> Option<T> {
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
    pub fn due(&mut self, now: Instant) -> Option<T> {
        if self.held.is_some() && self.ready(now) {
            self.last_sent = Some(now);
            self.held.take()
        } else {
            None
        }
    }

    /// How long until the held value is due; None when nothing is held.
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        let sent = self.last_sent?;
        self.held
            .as_ref()
            .map(|_| self.interval.saturating_sub(now.duration_since(sent)))
    }
}

/// Turns mpv's events into [`PlayerEvent`]s for `S`.
pub struct StateLoop<S: EventSink> {
    sink: S,
    changes: BTreeMap<String, Value>,
    time_pos: Throttle<Value>,
}

impl<S: EventSink> StateLoop<S> {
    pub fn new(sink: S) -> StateLoop<S> {
        StateLoop {
            sink,
            changes: BTreeMap::new(),
            time_pos: Throttle::new(TIME_POS_INTERVAL),
        }
    }

    /// [`handle_with`] for an event that needs nothing of mpv's.
    ///
    /// [`handle_with`]: StateLoop::handle_with
    #[cfg(test)]
    fn handle(&mut self, now: Instant, event: Event) {
        self.handle_with(now, event, |_| None);
    }

    /// Takes one mpv event at time `now`. Property changes wait in the batch for [`flush`]; the
    /// other events are sent at once, after the batch so far: the UI sees them in the order mpv
    /// produced them (a `script-message` that follows `add volume 5` must find the new volume).
    /// `time-pos` stays throttled whatever else arrives.
    ///
    /// `property` reads the text of a property of mpv's (`None` where it cannot). It is asked for
    /// the end of a file that failed, and for nothing else: see [`failure`].
    ///
    /// [`flush`]: StateLoop::flush
    fn handle_with(
        &mut self,
        now: Instant,
        event: Event,
        property: impl Fn(&str) -> Option<String>,
    ) {
        match event {
            Event::PropertyChange { name, value, .. } => self.change(now, name, value),
            Event::FileLoaded => self.send(PlayerEvent::FileLoaded),
            Event::EndFile {
                reason,
                playlist_entry_id,
            } => {
                let (reason, error) = end_reason(reason);
                let (file, continues) = if reason == EndReason::Error {
                    failure(&property, playlist_entry_id)
                } else {
                    (None, false)
                };
                self.send(PlayerEvent::EndFile {
                    reason,
                    error,
                    file,
                    continues,
                });
            }
            Event::ClientMessage { args } => match client_message(args) {
                // Rust's own, not part of what the UI sees in order.
                Some(event @ PlayerEvent::ThumbRendered(_)) => self.sink.emit(event),
                Some(event) => self.send(event),
                None => {}
            },
            Event::LogMessage {
                prefix,
                level,
                text,
            } => {
                // `request_log_messages("warn")` keeps the others away already.
                if matches!(level.as_str(), "warn" | "error" | "fatal") {
                    self.sink.emit(PlayerEvent::Log(LogLine {
                        level,
                        prefix,
                        text,
                    }));
                }
            }
            Event::Shutdown => self.send(PlayerEvent::Shutdown),
            _ => {}
        }
    }

    /// The event loop is idle: sends the batch, and the held `time-pos` if its interval has
    /// ended. Returns when to be called again for a `time-pos` still held.
    fn flush(&mut self, now: Instant) -> Option<Duration> {
        if let Some(value) = self.time_pos.due(now) {
            self.changes.insert(TIME_POS.to_owned(), value);
        }
        self.send_changes();
        self.time_pos.wait(now)
    }

    fn change(&mut self, now: Instant, name: String, value: PropertyValue) {
        let value = to_json(&name, value);
        if name == TIME_POS {
            // A value that has to wait is sent by `flush`; a newer one replaces it.
            if let Some(value) = self.time_pos.offer(now, value) {
                self.changes.insert(name, value);
            }
        } else {
            self.changes.insert(name, value);
        }
    }

    /// Sends `event` after the changes collected so far.
    fn send(&mut self, event: PlayerEvent) {
        self.send_changes();
        self.sink.emit(event);
    }

    fn send_changes(&mut self) {
        if !self.changes.is_empty() {
            self.sink.emit(PlayerEvent::State {
                changes: std::mem::take(&mut self.changes),
            });
        }
    }
}

/// The contract's name of why a file ended, and the error for `Error`.
fn end_reason(reason: EndFileReason) -> (EndReason, Option<String>) {
    match reason {
        EndFileReason::Eof => (EndReason::Eof, None),
        EndFileReason::Stop => (EndReason::Stop, None),
        EndFileReason::Quit => (EndReason::Quit, None),
        EndFileReason::Error { message, .. } => (EndReason::Error, Some(message)),
        EndFileReason::Redirect => (EndReason::Redirect, None),
        EndFileReason::Other(code) => {
            tracing::warn!("mpv ended a file for the unknown reason {code}");
            (EndReason::Stop, None)
        }
    }
}

/// What the UI is told of a file that failed (`file` and `continues` of `player:end-file`), from
/// mpv's `playlist` and `loop-playlist` as they are now, read through `property`. The entry that
/// failed is the one with the event's `id`. A playlist that cannot be read leaves both unknown
/// (`None`, `false`); a `loop-playlist` that cannot be read counts as no loop.
fn failure(property: &impl Fn(&str) -> Option<String>, id: i64) -> (Option<String>, bool) {
    let Some(playlist) = property("playlist") else {
        return (None, false);
    };
    let looping = property("loop-playlist").is_some_and(|value| value != "no");
    failed_entry(&playlist, id, looping)
}

/// `playlist` is the JSON text of mpv's `playlist` property, a list of `{ "id", "filename", … }`.
/// Gives the `filename` of the entry with `id` (`None` when there is none: it was removed already,
/// or the text is not what mpv writes; mpv numbers the entries from 1, so 0 names none), and
/// whether mpv goes on after it by itself: an entry follows it, or the playlist `looping` has
/// another entry to play.
fn failed_entry(playlist: &str, id: i64, looping: bool) -> (Option<String>, bool) {
    let entries: Value = match serde_json::from_str(playlist) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!("mpv's playlist is not JSON ({error}): {playlist}");
            return (None, false);
        }
    };
    let Some(entries) = entries.as_array() else {
        tracing::warn!("mpv's playlist is not a list: {playlist}");
        return (None, false);
    };
    let position = entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_i64) == Some(id));
    let file = position
        .and_then(|index| entries[index].get("filename")?.as_str())
        .map(str::to_owned);
    let follows = position.is_some_and(|index| index + 1 < entries.len());
    (file, follows || (looping && entries.len() > 1))
}

/// `script-message kaleido <action> …` is for the UI and `script-message thumbfast-render
/// <json>` for Rust; any other message is not Kaleido's.
fn client_message(mut args: Vec<String>) -> Option<PlayerEvent> {
    match args.first().map(String::as_str) {
        Some("kaleido") if args.len() > 1 => Some(PlayerEvent::Message {
            args: args.split_off(1),
        }),
        Some("thumbfast-render") if args.len() == 2 => {
            Some(PlayerEvent::ThumbRendered(args.swap_remove(1)))
        }
        _ => None,
    }
}

/// The JSON value of a property; the text of a `JSON_PROPERTIES` property is parsed.
fn to_json(name: &str, value: PropertyValue) -> Value {
    match value {
        PropertyValue::Unavailable => Value::Null,
        PropertyValue::Flag(flag) => flag.into(),
        PropertyValue::Int64(number) => number.into(),
        // Not finite → null.
        PropertyValue::Double(number) => number.into(),
        PropertyValue::String(text) if JSON_PROPERTIES.contains(&name) => {
            serde_json::from_str(&text).unwrap_or_else(|error| {
                tracing::warn!("mpv's {name} is not JSON ({error}): {text}");
                Value::Null
            })
        }
        PropertyValue::String(text) => text.into(),
    }
}

impl<S: EventSink> EventLoop for StateLoop<S> {
    fn on_event(&mut self, mpv: &Mpv, event: Event) {
        self.handle_with(Instant::now(), event, |name| {
            mpv.get_string(name)
                .inspect_err(|error| tracing::warn!("cannot read mpv's {name}: {error}"))
                .ok()
        });
    }

    fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
        self.flush(Instant::now())
    }
}

/// Starts the observations the [`StateLoop`] reports and asks for warnings and errors in the log
/// events. Queue it on the engine before the first file is loaded.
pub fn observe_all(mpv: &Mpv) -> mpv_ffi::Result<()> {
    for (id, &(name, kind)) in (0..).zip(OBSERVED) {
        mpv.observe(id, name, kind)?;
    }
    mpv.request_log_messages("warn")
}

/// The current value of every observed property, for a UI that starts after mpv did.
pub fn snapshot(mpv: &Mpv) -> BTreeMap<String, Value> {
    OBSERVED
        .iter()
        .map(|&(name, kind)| {
            let value = match kind {
                PropertyKind::Flag => mpv.get_flag(name).map(PropertyValue::Flag),
                PropertyKind::Int64 => mpv.get_i64(name).map(PropertyValue::Int64),
                PropertyKind::Double => mpv.get_f64(name).map(PropertyValue::Double),
                PropertyKind::String => mpv.get_string(name).map(PropertyValue::String),
            };
            // A property without a value (no file, no track) is null, as in its change event.
            let value = to_json(name, value.unwrap_or(PropertyValue::Unavailable));
            (name.to_owned(), value)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use mpv_ffi::{EndFileReason, Event, PropertyValue};
    use serde_json::{Value, json};

    use super::{
        BTreeMap, EndReason, EventSink, LogLine, OBSERVED, PlayerEvent, StateLoop, Throttle,
        observe_all, snapshot,
    };
    use crate::player::Engine;
    use crate::player::testing::{NoEvents, clip, headless, temp_paths};

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
    fn throttle_keeps_the_latest_time_pos() {
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

    /// Keeps what the loop emits.
    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<PlayerEvent>>>);

    impl EventSink for Recorder {
        fn emit(&self, event: PlayerEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    impl Recorder {
        fn events(&self) -> Vec<PlayerEvent> {
            self.0.lock().unwrap().clone()
        }

        /// The `time-pos` of each batch that has one.
        fn time_positions(&self) -> Vec<Value> {
            self.events()
                .into_iter()
                .filter_map(|event| match event {
                    PlayerEvent::State { mut changes } => changes.remove("time-pos"),
                    _ => None,
                })
                .collect()
        }

        /// Waits until `find` picks something from the events so far; panics after 5 s.
        fn wait_for<T>(&self, what: &str, find: impl Fn(&PlayerEvent) -> Option<T>) -> T {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(found) = self.events().iter().find_map(&find) {
                    return found;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {what}: {:#?}",
                    self.events()
                );
                thread::sleep(10 * MS);
            }
        }

        /// Waits until a batch reports `name` with `value`.
        fn wait_for_change(&self, name: &str, value: &Value) {
            self.wait_for(&format!("{name} = {value}"), |event| match event {
                PlayerEvent::State { changes } => (changes.get(name) == Some(value)).then_some(()),
                _ => None,
            });
        }
    }

    fn property(name: &str, value: PropertyValue) -> Event {
        Event::PropertyChange {
            id: 0,
            name: name.into(),
            value,
        }
    }

    fn message(args: &[&str]) -> Event {
        Event::ClientMessage {
            args: args.iter().map(|&arg| arg.to_owned()).collect(),
        }
    }

    fn changes<const N: usize>(pairs: [(&str, Value); N]) -> PlayerEvent {
        PlayerEvent::State {
            changes: pairs
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
        }
    }

    #[test]
    fn batch_merges_changes_from_one_drain() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        state.handle(now, property("pause", PropertyValue::Flag(true)));
        state.handle(now, property("volume", PropertyValue::Double(10.0)));
        state.handle(now, property("volume", PropertyValue::Double(20.0)));
        assert_eq!(
            recorder.events(),
            [],
            "nothing goes out before the drain ends"
        );

        state.flush(now);
        assert_eq!(
            recorder.events(),
            [changes([("pause", json!(true)), ("volume", json!(20.0))])]
        );
        state.flush(now);
        assert_eq!(recorder.events().len(), 1, "no empty batch");
    }

    #[test]
    fn time_pos_is_sent_at_most_10_per_second() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let start = Instant::now();
        // A new position every 10 ms for 200 ms; the loop is idle after each.
        let mut deadline = None;
        for i in 0..20u32 {
            let now = start + i * 10 * MS;
            state.handle(
                now,
                property("time-pos", PropertyValue::Double(f64::from(i))),
            );
            deadline = state.flush(now);
        }
        assert_eq!(recorder.time_positions(), [json!(0.0), json!(10.0)]);

        // The last position (19) waits for the end of the interval, and on_idle says when.
        let deadline = deadline.expect("a held time-pos asks to be woken");
        assert_eq!(deadline, 10 * MS);
        let last = start + 19 * 10 * MS;
        state.flush(last + deadline - MS);
        assert_eq!(
            recorder.time_positions().len(),
            2,
            "not before the deadline"
        );
        assert_eq!(state.flush(last + deadline), None);
        assert_eq!(
            recorder.time_positions(),
            [json!(0.0), json!(10.0), json!(19.0)]
        );
    }

    #[test]
    fn other_changes_do_not_wait_for_time_pos() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let start = Instant::now();
        state.handle(start, property("time-pos", PropertyValue::Double(1.0)));
        state.flush(start);
        let now = start + 30 * MS;
        state.handle(now, property("time-pos", PropertyValue::Double(2.0)));
        state.handle(now, property("pause", PropertyValue::Flag(true)));
        assert_eq!(state.flush(now), Some(70 * MS));
        assert_eq!(
            recorder.events(),
            [
                changes([("time-pos", json!(1.0))]),
                changes([("pause", json!(true))])
            ]
        );
    }

    #[test]
    fn client_messages_only_for_kaleido() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        state.handle(now, message(&["kaleido", "osd", "volume"]));
        state.handle(now, message(&["other", "x"]));
        state.handle(now, message(&["kaleido"]));
        state.handle(now, message(&[]));
        assert_eq!(
            recorder.events(),
            [PlayerEvent::Message {
                args: vec!["osd".into(), "volume".into()]
            }]
        );
    }

    #[test]
    fn thumbfast_render_goes_to_rust_only() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        state.handle(now, message(&["thumbfast-render", r#"{"w":64}"#]));
        // thumbfast sends exactly one argument.
        state.handle(now, message(&["thumbfast-render"]));
        state.handle(now, message(&["thumbfast-render", "{}", "extra"]));
        let events = recorder.events();
        assert_eq!(events, [PlayerEvent::ThumbRendered(r#"{"w":64}"#.into())]);
        assert_eq!(events[0].channel(), None);
    }

    /// A script-message that follows a property change (`add volume 5; script-message kaleido osd
    /// volume`) must not reach the UI before the change does.
    #[test]
    fn events_keep_their_order_with_the_changes_before_them() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        state.handle(now, property("volume", PropertyValue::Double(5.0)));
        state.handle(now, message(&["kaleido", "osd", "volume"]));
        state.handle(now, property("duration", PropertyValue::Double(60.0)));
        state.handle(now, Event::FileLoaded);
        state.handle(now, property("pause", PropertyValue::Flag(true)));
        state.handle(
            now,
            Event::EndFile {
                reason: EndFileReason::Eof,
                playlist_entry_id: 1,
            },
        );
        state.flush(now);
        assert_eq!(
            recorder.events(),
            [
                changes([("volume", json!(5.0))]),
                PlayerEvent::Message {
                    args: vec!["osd".into(), "volume".into()]
                },
                changes([("duration", json!(60.0))]),
                PlayerEvent::FileLoaded,
                changes([("pause", json!(true))]),
                PlayerEvent::EndFile {
                    reason: EndReason::Eof,
                    error: None,
                    file: None,
                    continues: false
                },
            ]
        );
    }

    #[test]
    fn end_reasons_map_to_the_contract_names() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        for reason in [
            EndFileReason::Eof,
            EndFileReason::Stop,
            EndFileReason::Quit,
            EndFileReason::Error {
                code: -13,
                message: "loading failed".into(),
            },
            EndFileReason::Redirect,
        ] {
            state.handle(
                now,
                Event::EndFile {
                    reason,
                    playlist_entry_id: 1,
                },
            );
        }
        let ended = |reason, error: Option<&str>| PlayerEvent::EndFile {
            reason,
            error: error.map(str::to_owned),
            file: None,
            continues: false,
        };
        assert_eq!(
            recorder.events(),
            [
                ended(EndReason::Eof, None),
                ended(EndReason::Stop, None),
                ended(EndReason::Quit, None),
                ended(EndReason::Error, Some("loading failed")),
                ended(EndReason::Redirect, None),
            ]
        );
    }

    const PLAYLIST: &str = r#"[
        {"filename": "C:\\Videa\\a.mkv", "id": 4},
        {"filename": "https://example.com/watch?v=abc", "id": 7, "current": true}
    ]"#;

    /// A file fails with the entry `id`; mpv's `playlist` and `loop-playlist` are as given (`None`
    /// for a property that cannot be read). Gives `file` and `continues` of what the UI is told.
    fn failure_of(
        id: i64,
        playlist: Option<&str>,
        looping: Option<&str>,
    ) -> (Option<String>, bool) {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let event = Event::EndFile {
            reason: EndFileReason::Error {
                code: -13,
                message: "loading failed".into(),
            },
            playlist_entry_id: id,
        };
        state.handle_with(Instant::now(), event, |name| match name {
            "playlist" => playlist.map(str::to_owned),
            "loop-playlist" => looping.map(str::to_owned),
            other => panic!("read {other}"),
        });
        match recorder.events().as_slice() {
            [
                PlayerEvent::EndFile {
                    file, continues, ..
                },
            ] => (file.clone(), *continues),
            other => panic!("not one end of a file: {other:?}"),
        }
    }

    /// The failed file is the playlist entry whose `id` is the event's.
    #[test]
    fn a_failed_file_is_named_by_its_id() {
        let file = |id, playlist| failure_of(id, playlist, Some("no")).0;
        assert_eq!(file(4, Some(PLAYLIST)).as_deref(), Some(r"C:\Videa\a.mkv"));
        assert_eq!(
            file(7, Some(PLAYLIST)).as_deref(),
            Some("https://example.com/watch?v=abc")
        );
        // An entry the playlist no longer has (or never had: mpv's ids start at 1).
        assert_eq!(file(5, Some(PLAYLIST)), None);
        assert_eq!(file(0, Some(PLAYLIST)), None);
        // No playlist to read, text that is no JSON, JSON that is no list, an entry without a name.
        assert_eq!(file(4, None), None);
        assert_eq!(file(4, Some("[{")), None);
        assert_eq!(file(4, Some(r#"{"id": 4, "filename": "a"}"#)), None);
        assert_eq!(file(4, Some(r#"[{"id": 4}]"#)), None);
        assert_eq!(file(4, Some(r#"[{"id": 4, "filename": 5}]"#)), None);
    }

    /// mpv goes on by itself where an entry follows the one that failed.
    #[test]
    fn a_failed_file_continues_when_an_entry_follows_it() {
        let continues = |id, playlist| failure_of(id, playlist, Some("no")).1;
        assert!(continues(4, Some(PLAYLIST)), "the first of two");
        assert!(!continues(7, Some(PLAYLIST)), "the last of two");
        let alone = r#"[{"filename": "a.mkv", "id": 1}]"#;
        assert!(!continues(1, Some(alone)), "the only one");
        // Not knowing the entry, or the playlist, is not knowing that anything follows.
        assert!(!continues(5, Some(PLAYLIST)));
        assert!(!continues(4, None));
        assert!(!continues(4, Some("[{")));
        assert!(!continues(4, Some(r#"{"id": 4}"#)));
    }

    /// With the playlist looping mpv starts over after the last entry, if there is another to play.
    #[test]
    fn a_looping_playlist_continues_after_its_last_entry() {
        let last = |looping| failure_of(7, Some(PLAYLIST), looping).1;
        for looping in ["inf", "force", "3", "1"] {
            assert!(last(Some(looping)), "loop-playlist={looping}");
        }
        assert!(!last(Some("no")));
        // A loop-playlist that cannot be read counts as none.
        assert!(!last(None));

        // A playlist of one entry has nothing to start over with.
        let alone = r#"[{"filename": "a.mkv", "id": 1}]"#;
        assert!(!failure_of(1, Some(alone), Some("inf")).1);

        // An entry that is not in the list is still a list that loops.
        assert_eq!(failure_of(5, Some(PLAYLIST), Some("inf")), (None, true));
        // No playlist, no knowing.
        assert_eq!(failure_of(7, None, Some("inf")), (None, false));
    }

    /// Only a file that failed is asked about: the playlist is read for nothing else, and so not
    /// while mpv quits.
    #[test]
    fn only_an_error_reads_the_playlist() {
        let reads = std::cell::RefCell::new(Vec::<String>::new());
        let property = |name: &str| {
            reads.borrow_mut().push(name.to_owned());
            Some(if name == "playlist" { PLAYLIST } else { "no" }.to_owned())
        };
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        state.handle_with(now, Event::FileLoaded, property);
        state.handle_with(now, message(&["kaleido", "osd", "volume"]), property);
        for reason in [
            EndFileReason::Eof,
            EndFileReason::Stop,
            EndFileReason::Quit,
            EndFileReason::Redirect,
            EndFileReason::Other(99),
        ] {
            state.handle_with(
                now,
                Event::EndFile {
                    reason,
                    playlist_entry_id: 4,
                },
                property,
            );
        }
        assert_eq!(*reads.borrow(), Vec::<String>::new());
        // Whatever the playlist has, they end without a file and without going on.
        let ends = recorder.events();
        assert_eq!(ends.len(), 7);
        for end in &ends[2..] {
            assert!(
                matches!(
                    end,
                    PlayerEvent::EndFile {
                        file: None,
                        continues: false,
                        ..
                    }
                ),
                "{end:?}"
            );
        }

        state.handle_with(
            now,
            Event::EndFile {
                reason: EndFileReason::Error {
                    code: -13,
                    message: "loading failed".into(),
                },
                playlist_entry_id: 4,
            },
            property,
        );
        assert_eq!(*reads.borrow(), ["playlist", "loop-playlist"]);
        assert_eq!(
            recorder.events().last(),
            Some(&PlayerEvent::EndFile {
                reason: EndReason::Error,
                error: Some("loading failed".into()),
                file: Some(r"C:\Videa\a.mkv".into()),
                continues: true,
            })
        );
    }

    #[test]
    fn only_warnings_and_worse_are_logged() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        for level in ["info", "warn", "v", "error", "debug", "fatal"] {
            state.handle(
                now,
                Event::LogMessage {
                    prefix: "cplayer".into(),
                    level: level.into(),
                    text: format!("a {level} line"),
                },
            );
        }
        let logged = |level: &str| {
            PlayerEvent::Log(LogLine {
                level: level.into(),
                prefix: "cplayer".into(),
                text: format!("a {level} line"),
            })
        };
        assert_eq!(
            recorder.events(),
            [logged("warn"), logged("error"), logged("fatal")]
        );
    }

    #[test]
    fn unparsable_json_becomes_null() {
        let recorder = Recorder::default();
        let mut state = StateLoop::new(recorder.clone());
        let now = Instant::now();
        state.handle(
            now,
            property("track-list", PropertyValue::String("[{".into())),
        );
        state.handle(
            now,
            property(
                "chapter-list",
                PropertyValue::String(r#"[{"time":1.5}]"#.into()),
            ),
        );
        state.handle(now, property("playlist", PropertyValue::Unavailable));
        state.handle(
            now,
            property("media-title", PropertyValue::String("[{".into())),
        );
        state.flush(now);
        assert_eq!(
            recorder.events(),
            [changes([
                ("track-list", Value::Null),
                ("chapter-list", json!([{"time": 1.5}])),
                ("playlist", Value::Null),
                ("media-title", json!("[{")),
            ])]
        );
    }

    /// The serialized form is what the UI receives (the IPC table of the plan).
    #[test]
    fn payloads_match_the_ui_contract() {
        let payload = |event: &PlayerEvent| serde_json::to_value(event).unwrap();
        assert_eq!(
            payload(&changes([("pause", json!(true))])),
            json!({"changes": {"pause": true}})
        );
        assert_eq!(payload(&PlayerEvent::FileLoaded), json!({}));
        assert_eq!(
            payload(&PlayerEvent::EndFile {
                reason: EndReason::Error,
                error: Some("loading failed".into()),
                file: Some(r"C:\Videa\a.mkv".into()),
                continues: true
            }),
            json!({
                "reason": "error",
                "error": "loading failed",
                "file": r"C:\Videa\a.mkv",
                "continues": true
            })
        );
        assert_eq!(
            payload(&PlayerEvent::EndFile {
                reason: EndReason::Eof,
                error: None,
                file: None,
                continues: false
            }),
            json!({"reason": "eof", "error": null, "file": null, "continues": false})
        );
        assert_eq!(
            payload(&PlayerEvent::Message {
                args: vec!["osd".into()]
            }),
            json!({"args": ["osd"]})
        );
        assert_eq!(
            payload(&PlayerEvent::Log(LogLine {
                level: "warn".into(),
                prefix: "ffmpeg".into(),
                text: "x".into()
            })),
            json!({"level": "warn", "prefix": "ffmpeg", "text": "x"})
        );
    }

    #[test]
    fn channels_name_the_ui_events() {
        let state = changes([]);
        let log = PlayerEvent::Log(LogLine {
            level: "warn".into(),
            prefix: String::new(),
            text: String::new(),
        });
        let end = PlayerEvent::EndFile {
            reason: EndReason::Stop,
            error: None,
            file: None,
            continues: false,
        };
        let message = PlayerEvent::Message { args: vec![] };
        assert_eq!(state.channel(), Some("player:state"));
        assert_eq!(
            PlayerEvent::FileLoaded.channel(),
            Some("player:file-loaded")
        );
        assert_eq!(end.channel(), Some("player:end-file"));
        assert_eq!(message.channel(), Some("player:message"));
        assert_eq!(log.channel(), Some("player:log"));
        assert_eq!(PlayerEvent::ThumbRendered(String::new()).channel(), None);
        assert_eq!(PlayerEvent::Shutdown.channel(), None);
    }

    /// An engine running a [`StateLoop`] into a recorder, observing from the start.
    fn running(dir: &std::path::Path) -> (Engine, Recorder) {
        let recorder = Recorder::default();
        let engine =
            Engine::start(headless(temp_paths(dir)), StateLoop::new(recorder.clone())).unwrap();
        engine.call(observe_all).unwrap();
        (engine, recorder)
    }

    #[test]
    fn every_observed_property_is_reported_at_the_start() {
        let tmp = tempfile::tempdir().unwrap();
        let (_engine, recorder) = running(tmp.path());
        let reported = || {
            let mut all = BTreeMap::new();
            for event in recorder.events() {
                if let PlayerEvent::State { changes } = event {
                    all.extend(changes);
                }
            }
            all
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while reported().len() < OBSERVED.len() {
            assert!(Instant::now() < deadline, "only {:#?}", reported());
            thread::sleep(10 * MS);
        }
        let all = reported();
        assert_eq!(all.len(), OBSERVED.len());
        for (name, expected) in [
            ("pause", json!(false)),
            ("mute", json!(false)),
            ("volume", json!(100.0)),
            ("volume-max", json!(130.0)),
            ("speed", json!(1.0)),
            ("idle-active", json!(true)),
            ("fullscreen", json!(false)),
            ("playlist", json!([])),
            ("track-list", json!([])),
            ("chapter-list", json!([])),
            ("time-pos", Value::Null),
        ] {
            assert_eq!(all[name], expected, "{name}");
        }
    }

    #[test]
    fn list_properties_arrive_as_json() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 5);
        let (engine, recorder) = running(tmp.path());
        engine.command(&["loadfile", &clip.to_string_lossy()]);

        let tracks = recorder.wait_for("the track list", |event| match event {
            PlayerEvent::State { changes } => changes
                .get("track-list")
                .filter(|tracks| tracks[0]["type"] == "video")
                .cloned(),
            _ => None,
        });
        assert_eq!(tracks[0]["type"], "video");
        let params = recorder.wait_for("the video parameters", |event| match event {
            PlayerEvent::State { changes } => changes
                .get("video-params")
                .filter(|params| params["w"] == 64)
                .cloned(),
            _ => None,
        });
        assert_eq!(params["h"], 36);
        let playlist = recorder.wait_for("the playlist", |event| match event {
            PlayerEvent::State { changes } => changes
                .get("playlist")
                .filter(|playlist| playlist[0]["filename"].is_string())
                .cloned(),
            _ => None,
        });
        assert_eq!(playlist[0]["filename"], clip.to_string_lossy().as_ref());

        // The other kinds too: a track id is a number (null when no track is selected).
        recorder.wait_for_change("vid", &json!(1));
        recorder.wait_for_change("playlist-pos", &json!(0));
    }

    /// Frames arrive 30 times a second; the UI gets a `time-pos` 10 times a second at most.
    #[test]
    fn time_pos_while_playing_is_throttled() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 5);
        let (engine, recorder) = running(tmp.path());
        engine.command(&["loadfile", &clip.to_string_lossy()]);

        recorder.wait_for("one second of playback", |event| match event {
            PlayerEvent::State { changes } => changes
                .get("time-pos")
                .filter(|time| time.as_f64().is_some_and(|time| time >= 1.0))
                .cloned(),
            _ => None,
        });
        let sent = recorder.time_positions().len();
        assert!(
            (5..=15).contains(&sent),
            "{sent} time-pos updates in a second"
        );
    }

    /// Holding an arrow key seeks faster than 10 times a second and then stops: the last position
    /// must arrive although no more events from mpv wake the loop.
    #[test]
    fn the_last_seek_position_arrives_after_the_interval() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 10);
        let (engine, recorder) = running(tmp.path());
        engine.command(&["set", "pause", "yes"]);
        engine.command(&["loadfile", &clip.to_string_lossy()]);
        recorder.wait_for("the duration", |event| match event {
            PlayerEvent::State { changes } => {
                changes.get("duration").filter(|d| d.is_number()).cloned()
            }
            _ => None,
        });

        for seconds in ["1", "2", "3", "4", "5"] {
            engine.command(&["seek", seconds, "absolute"]);
        }
        recorder.wait_for("the last position", |event| match event {
            PlayerEvent::State { changes } => changes
                .get("time-pos")
                .filter(|time| time.as_f64().is_some_and(|time| (time - 5.0).abs() < 0.1))
                .cloned(),
            _ => None,
        });
    }

    #[test]
    fn end_file_carries_reason_and_error() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("missing.mkv");
        let (engine, recorder) = running(tmp.path());
        engine.command(&["loadfile", &missing.to_string_lossy()]);

        let (reason, error) = recorder.wait_for("the end of the file", |event| match event {
            PlayerEvent::EndFile { reason, error, .. } => Some((*reason, error.clone())),
            _ => None,
        });
        assert_eq!(reason, EndReason::Error);
        assert!(error.is_some_and(|error| !error.is_empty()));
    }

    /// The UI names the file that failed by this, and says whether mpv goes on: a playlist of
    /// [missing.mkv, good clip] starts with the first, which fails, and the second follows.
    #[test]
    fn end_file_names_the_file_that_failed_and_says_the_playlist_goes_on() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("missing.mkv");
        let good = clip(tmp.path(), 5);
        let (engine, recorder) = running(tmp.path());
        // Both are in the playlist before the first one starts.
        engine.command(&["loadfile", &missing.to_string_lossy(), "append"]);
        engine.command(&["loadfile", &good.to_string_lossy(), "append"]);
        engine.command(&["playlist-play-index", "0"]);

        let (file, continues) = recorder.wait_for("the failed file", |event| match event {
            PlayerEvent::EndFile {
                reason: EndReason::Error,
                file,
                continues,
                ..
            } => Some((file.clone(), *continues)),
            _ => None,
        });
        assert!(
            file.as_deref()
                .is_some_and(|file| file.ends_with("missing.mkv")),
            "{file:?}"
        );
        assert!(continues, "the clip follows");
    }

    /// A file that fails alone leaves mpv with nothing to play.
    #[test]
    fn a_lone_failing_file_does_not_continue() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("missing.mkv");
        let (engine, recorder) = running(tmp.path());
        engine.command(&["loadfile", &missing.to_string_lossy()]);

        let continues = recorder.wait_for("the failed file", |event| match event {
            PlayerEvent::EndFile {
                reason: EndReason::Error,
                continues,
                ..
            } => Some(*continues),
            _ => None,
        });
        assert!(!continues);
    }

    #[test]
    fn snapshot_reports_current_values() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        engine.command(&["set", "volume", "42"]);
        let snapshot = engine.call(snapshot);
        assert_eq!(snapshot["volume"], json!(42.0));
        assert_eq!(snapshot.len(), OBSERVED.len());
        assert_eq!(snapshot["pause"], json!(false));
        assert_eq!(snapshot["playlist"], json!([]));
        assert_eq!(snapshot["time-pos"], Value::Null);
    }
}
