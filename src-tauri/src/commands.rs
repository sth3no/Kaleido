//! The Tauri commands (thin): the UI's way into the player. They check what they are given and
//! queue it on the engine; none of them waits for mpv on the main thread, where Tauri runs a
//! synchronous command (M0 review), because mpv may be busy.

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::glass::{GlassController, GlassRect, GlassState};
use crate::input::{self, InputEvent};
use crate::paths::AppPaths;
use crate::player::{self, Engine, LoadIssue, LoadMode, PlayerCommand};
use crate::settings::{self, AudioDevice, Binding, Settings, SettingsError, SharedSettings};
use crate::surface::{Layout, Surface};
use crate::system::diagnostics::{self, License};
use crate::system::{self, ROADMAP_URL, Snapshot, clipboard::PasteOutcome, dialog::DialogPurpose};
use crate::thumbs::{self, ThumbStore};

/// Runs a player command. The error is a message for the log; the UI has nothing to correct.
/// A screenshot goes to the glass, which takes the glass out of the picture first (spec 8.2).
#[tauri::command]
pub fn player_command(
    engine: State<'_, Engine>,
    glass: State<'_, GlassController>,
    cmd: PlayerCommand,
) -> Result<(), String> {
    if let PlayerCommand::Screenshot { mode } = cmd {
        glass.screenshot(mode);
        return Ok(());
    }
    player::command::send(&engine, &cmd).map_err(|error| error.to_string())
}

/// Input the UI did not handle (keys, the mouse, the wheel) for mpv. It is queued on the engine,
/// like every command, so that the events stay in the order they came in (a key's down before
/// its up); nothing waits for mpv.
#[tauri::command]
pub fn player_input(engine: State<'_, Engine>, event: InputEvent) {
    if !input::send(&engine, &event) {
        tracing::warn!("input refused: {event:?}");
    }
}

/// Opens files and links. A source that cannot be opened is reported and the others open.
/// Asynchronous, so that looking for the files (a network share may answer slowly) does not
/// hold up the main thread.
#[tauri::command]
pub async fn player_load(
    engine: State<'_, Engine>,
    sources: Vec<String>,
    mode: LoadMode,
) -> Result<(), Vec<LoadIssue>> {
    // Relative to where Kaleido runs, as for a command line.
    let cwd = std::env::current_dir().unwrap_or_default();
    player::open_sources(&engine, &sources, mode, &cwd)
}

/// The UI listens to the player's events now: what was opened before plays, and the UI gets
/// the player's state. Waits for mpv, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_ui_ready(app: AppHandle) -> Snapshot {
    tauri::async_runtime::spawn_blocking(move || system::ui_ready(&app))
        .await
        .unwrap_or_else(|error| {
            tracing::error!("cannot read the player state for the UI: {error}");
            Snapshot::new()
        })
}

/// Shows the open dialog and returns at once; what is picked opens from the dialog's thread.
#[tauri::command]
pub fn system_open_dialog(app: AppHandle, purpose: DialogPurpose) {
    system::dialog::open(&app, purpose);
}

/// Opens the link on the clipboard. Asynchronous: another program may hold the clipboard for
/// a moment.
#[tauri::command]
pub async fn system_paste(app: AppHandle) -> PasteOutcome {
    system::clipboard::paste(&app)
}

/// Opens the link typed or pasted into the paste field.
#[tauri::command]
pub fn system_open_text(app: AppHandle, text: String) -> Result<(), LoadIssue> {
    system::clipboard::open_text(&app, &text)
}

/// Opens the public roadmap in the browser. Asynchronous: starting the browser may take a
/// moment.
#[tauri::command]
pub async fn system_open_roadmap() {
    if let Err(error) = tauri_plugin_opener::open_url(ROADMAP_URL, None::<&str>) {
        tracing::warn!("cannot open the roadmap: {error}");
    }
}

/// Where the video goes: the whole window, a frame of the mini-player animation, the mini player
/// in its corner, or nowhere. Synchronous, so it runs on the main thread, which moves mpv's
/// window; that does not wait for mpv's core.
#[tauri::command]
pub fn surface_set_layout(surface: State<'_, Surface>, layout: Layout) {
    surface.set_layout(layout);
}

/// The glass elements the UI measured (CSS px), nothing for no glass. Synchronous: it only
/// queues the new regions on the engine.
#[tauri::command]
pub fn glass_set_regions(glass: State<'_, GlassController>, rects: Vec<GlassRect>) {
    glass.set_regions(rects);
}

/// Whether the glass is on, as the `glass:state` event says it when the state changes. The UI
/// asks when it starts and after a reload, because it may have missed the event (also the glass
/// that could not start sent none). Reads the controller only.
#[tauri::command]
pub fn glass_state(glass: State<'_, GlassController>) -> GlassState {
    glass.state()
}

/// Asks thumbfast for the timeline preview at `seconds`; it arrives as `player:thumb` and is
/// fetched with `thumb_get`. Synchronous: it only queues the request on the engine.
#[tauri::command]
pub fn thumb_request(engine: State<'_, Engine>, seconds: f64) {
    thumbs::request(&engine, seconds);
}

/// The pointer left the seekbar: thumbfast stops rendering. Synchronous: it only queues the
/// request on the engine.
#[tauri::command]
pub fn thumb_clear(engine: State<'_, Engine>) {
    thumbs::clear(&engine);
}

/// The latest preview as binary data: the width and the height as little-endian `u32`, then the
/// RGBA pixels (empty before the first preview). Reads the stored preview only, so the main
/// thread does not wait for anything.
#[tauri::command]
pub fn thumb_get(store: State<'_, ThumbStore>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(store.latest())
}

/// Runs `job` on a blocking thread: it waits for mpv (or the system), which must hold up
/// neither the main thread nor the async runtime. `None` if it panicked.
async fn on_blocking_thread<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::error!("a task on a blocking thread failed: {error}");
            None
        }
    }
}

/// Kaleido's own settings (settings.json). Reads the store only.
#[tauri::command]
pub fn settings_get(store: State<'_, SharedSettings>) -> Settings {
    settings::lock(&store).get().clone()
}

/// Changes Kaleido's settings: `patch` is merged in (a JSON merge patch), checked and written;
/// on an error nothing changed. The UI hears the new settings as `settings:changed`.
/// Synchronous: it writes one small file and never waits for mpv.
#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    store: State<'_, SharedSettings>,
    patch: Value,
) -> Result<Settings, SettingsError> {
    let settings = settings::lock(&store).update(patch)?;
    if let Err(error) = app.emit("settings:changed", &settings) {
        tracing::warn!("cannot send settings:changed to the UI: {error}");
    }
    Ok(settings)
}

/// Every mpv option the settings manage, from mpv.conf or else the player. Waits for mpv,
/// hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_get_mpv(app: AppHandle) -> BTreeMap<String, Option<String>> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths), Some(glass)) = (
            app.try_state::<Engine>(),
            app.try_state::<AppPaths>(),
            app.try_state::<GlassController>(),
        ) else {
            return BTreeMap::new();
        };
        settings::get_mpv(&engine, &paths.config_dir, glass.shader())
    })
    .await
    .unwrap_or_default()
}

/// Sets an mpv option from the allow-list in mpv.conf and, if it can be, in the player (`None`
/// takes it out). Waits for mpv (the audio devices), hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_set_mpv(
    app: AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), SettingsError> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths), Some(glass)) = (
            app.try_state::<Engine>(),
            app.try_state::<AppPaths>(),
            app.try_state::<GlassController>(),
        ) else {
            return Err(SettingsError::Unavailable);
        };
        settings::set_mpv(&engine, &glass, &paths.config_dir, &key, value.as_deref())
    })
    .await
    .unwrap_or(Err(SettingsError::Unavailable))
}

/// The audio outputs mpv offers. Waits for mpv, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_audio_devices(app: AppHandle) -> Vec<AudioDevice> {
    on_blocking_thread(move || {
        app.try_state::<Engine>()
            .map(|engine| settings::audio_devices(&engine))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Every key that is bound, with what it does and where that comes from: Kaleido, the user,
/// mpv or a plugin (spec 8.10). Waits for mpv, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_bindings(app: AppHandle) -> Vec<Binding> {
    on_blocking_thread(move || {
        app.try_state::<Engine>()
            .map(|engine| settings::bindings(&engine))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Moves the binding of `key` to `new_key` and silences `key`, in input.conf and in the player.
/// The UI sends keys only; the command is the one the key has. Waits for mpv, hence
/// asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_rebind(
    app: AppHandle,
    key: String,
    new_key: String,
) -> Result<(), SettingsError> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths)) = (app.try_state::<Engine>(), app.try_state::<AppPaths>())
        else {
            return Err(SettingsError::Unavailable);
        };
        settings::rebind(&engine, &paths.config_dir, &key, &new_key)
    })
    .await
    .unwrap_or(Err(SettingsError::Unavailable))
}

/// Puts `key` back to Kaleido's default for it, or to the one of mpv or a plugin. Waits for mpv,
/// hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_reset_binding(app: AppHandle, key: String) -> Result<(), SettingsError> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths)) = (app.try_state::<Engine>(), app.try_state::<AppPaths>())
        else {
            return Err(SettingsError::Unavailable);
        };
        settings::reset_binding(&engine, &paths.config_dir, &key)
    })
    .await
    .unwrap_or(Err(SettingsError::Unavailable))
}

/// The files in the shaders folder that `glsl-shaders` may name. Lists one local folder.
#[tauri::command]
pub fn settings_list_shaders(paths: State<'_, AppPaths>) -> Vec<String> {
    settings::list_shaders(&paths.config_dir)
}

/// The installed font families (DirectWrite). The first call reads them, which may take a
/// moment, so it is asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_fonts() -> Vec<String> {
    on_blocking_thread(|| settings::system_fonts().to_vec())
        .await
        .unwrap_or_default()
}

/// The diagnostics as text for a bug report: versions, Windows, GPU and plugins, with no file
/// paths and no URLs. Waits for mpv (its versions), hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_diagnostics(app: AppHandle) -> String {
    diagnostics_text(app).await
}

/// Puts the diagnostics (as `system_diagnostics` returns them) on the clipboard. Another program
/// may hold the clipboard, so it can fail; the UI says so.
#[tauri::command]
pub async fn system_copy_diagnostics(app: AppHandle) -> Result<(), String> {
    let text = diagnostics_text(app.clone()).await;
    if text.is_empty() {
        return Err("the diagnostics are not available".to_owned());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

async fn diagnostics_text(app: AppHandle) -> String {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths)) = (app.try_state::<Engine>(), app.try_state::<AppPaths>())
        else {
            return String::new();
        };
        diagnostics::report(&engine, &paths)
    })
    .await
    .unwrap_or_default()
}

/// Shows the logs folder in the file manager. Asynchronous: starting it may take a moment.
#[tauri::command]
pub async fn system_open_logs(app: AppHandle) {
    let Some(paths) = app.try_state::<AppPaths>() else {
        return;
    };
    if let Err(error) = tauri_plugin_opener::open_path(&paths.logs_dir, None::<&str>) {
        tracing::warn!("cannot open the logs folder: {error}");
    }
}

/// The licenses of the third-party software Kaleido ships (spec 11.6). Reads two files from the
/// installation, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_licenses(app: AppHandle) -> Vec<License> {
    on_blocking_thread(move || {
        app.try_state::<AppPaths>()
            .map(|paths| diagnostics::licenses(&paths.resource_dir.join("licenses")))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// The contract with the UI. `tests/fixtures/ipc` holds what the UI sends and hears as JSON, and
/// the UI's own test (`src/ipc/contract.test.ts`) type-checks the same files against its types:
/// when a serde type changes, one of the two fails, and the TypeScript types are fixed to match.
///
/// A file is an array of samples, named
/// - after a command (`player_command.json`): the arguments `invoke` takes, one object per call,
///   `{}` for a command without arguments;
/// - after an event, its name with `:` as `.` (`player.state.json`): the payloads Rust emits;
/// - `returns.<command>.json` and `rejects.<command>.json`: what a command resolves or rejects
///   with, where that is more than a number or a string.
#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde::Serialize;
    use serde::de::DeserializeOwned;
    use serde_json::{Map, Number, Value, json};

    use crate::glass::{GlassReason, GlassRect, GlassState};
    use crate::input::{self, InputEvent};
    use crate::player::command::{ScreenshotMode, SeekMode, TrackKind};
    use crate::player::load::SourceError;
    use crate::player::{
        self, CommandError, EndReason, LoadIssue, LoadMode, LogLine, PlayerCommand, PlayerEvent,
    };
    use crate::settings::{
        self, Appearance, AudioDevice, Binding, BindingSource, Language, Playback,
        ReduceTransparency, Settings, SettingsError, SettingsStore, ThemeMode,
    };
    use crate::surface::Layout;
    use crate::system::OpenRequestEvent;
    use crate::system::clipboard::PasteOutcome;
    use crate::system::diagnostics::License;
    use crate::system::dialog::DialogPurpose;
    use crate::thumbs::{self, ThumbReady};

    fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ipc")
    }

    /// The samples in `<name>.json`.
    fn samples(name: &str) -> Vec<Value> {
        let path = fixture_dir().join(format!("{name}.json"));
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        match serde_json::from_str(&text) {
            Ok(Value::Array(samples)) => samples,
            Ok(_) => panic!("{name}.json is not an array of samples"),
            Err(error) => panic!("{name}.json is not JSON: {error}"),
        }
    }

    /// The arguments of one call in a command's fixture: exactly `names`, as Tauri takes them.
    fn arguments<'a>(command: &str, call: &'a Value, names: &[&str]) -> &'a Map<String, Value> {
        let Some(object) = call.as_object() else {
            panic!("{command}: {call} is not an object of arguments");
        };
        let given: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        let wanted: BTreeSet<&str> = names.iter().copied().collect();
        assert_eq!(given, wanted, "{command}: {call}");
        object
    }

    /// The argument `name` as the Rust parameter's type.
    fn argument<T: DeserializeOwned>(
        command: &str,
        arguments: &Map<String, Value>,
        name: &str,
    ) -> T {
        let value = arguments.get(name).cloned().unwrap_or(Value::Null);
        serde_json::from_value(value)
            .unwrap_or_else(|error| panic!("{command}: {name} does not fit: {error}"))
    }

    /// The one argument `name` of every call.
    fn column<T: DeserializeOwned>(command: &str, calls: &[Value], name: &str) -> Vec<T> {
        calls
            .iter()
            .map(|call| argument(command, arguments(command, call, &[name]), name))
            .collect()
    }

    /// The two arguments `names` of every call.
    fn pairs<A: DeserializeOwned, B: DeserializeOwned>(
        command: &str,
        calls: &[Value],
        names: [&str; 2],
    ) -> Vec<(A, B)> {
        calls
            .iter()
            .map(|call| {
                let given = arguments(command, call, &names);
                (
                    argument(command, given, names[0]),
                    argument(command, given, names[1]),
                )
            })
            .collect()
    }

    /// The commands registered with Tauri, read from the `generate_handler!` list in lib.rs: a
    /// command added there needs a fixture and a check here, or this test says so.
    fn registered_commands() -> Vec<String> {
        const MARKER: &str = "generate_handler![";
        let source = include_str!("lib.rs");
        let start = source.find(MARKER).expect("lib.rs registers the commands") + MARKER.len();
        let end = start
            + source[start..]
                .find(']')
                .expect("the list of commands ends");
        let commands: Vec<String> = source[start..end]
            .split(',')
            .filter_map(|item| item.trim().strip_prefix("commands::"))
            .map(str::to_owned)
            .collect();
        assert!(!commands.is_empty(), "no commands found in lib.rs");
        commands
    }

    /// The commands the UI calls without arguments.
    const WITHOUT_ARGUMENTS: [&str; 16] = [
        "system_ui_ready",
        "system_paste",
        "system_open_roadmap",
        "glass_state",
        "thumb_clear",
        "thumb_get",
        "settings_get",
        "settings_get_mpv",
        "settings_audio_devices",
        "settings_bindings",
        "settings_list_shaders",
        "system_fonts",
        "system_diagnostics",
        "system_copy_diagnostics",
        "system_open_logs",
        "system_licenses",
    ];

    fn player_commands() -> Vec<PlayerCommand> {
        use PlayerCommand::*;
        vec![
            TogglePause,
            SetPause { paused: true },
            Seek {
                target: -5.5,
                mode: SeekMode::Relative,
                exact: false,
            },
            Seek {
                target: 120.0,
                mode: SeekMode::Absolute,
                exact: true,
            },
            Seek {
                target: 50.0,
                mode: SeekMode::AbsolutePercent,
                exact: false,
            },
            SetVolume { volume: 80.0 },
            SetMute { muted: true },
            SetSpeed { speed: 1.25 },
            SelectTrack {
                kind: TrackKind::Sub,
                id: Some(2),
            },
            SelectTrack {
                kind: TrackKind::Audio,
                id: None,
            },
            SelectTrack {
                kind: TrackKind::Video,
                id: Some(1),
            },
            SetSubDelay { seconds: -0.5 },
            SetSubScale { scale: 1.5 },
            SetAudioDelay { seconds: 0.25 },
            SetSubMargin { margin: 80 },
            PlaylistNext,
            PlaylistPrev,
            PlaylistPlay { index: 3 },
            PlaylistRemove { index: 1 },
            PlaylistMove { from: 0, to: 2 },
            Screenshot {
                mode: ScreenshotMode::Subtitles,
            },
            Screenshot {
                mode: ScreenshotMode::Video,
            },
            Screenshot {
                mode: ScreenshotMode::Window,
            },
            Screenshot {
                mode: ScreenshotMode::EachFrame,
            },
            SetFullscreen { on: true },
            SetOntop { on: false },
            Stop,
        ]
    }

    fn input_events() -> Vec<InputEvent> {
        vec![
            InputEvent::KeyDown {
                key: "Ctrl+a".into(),
            },
            InputEvent::KeyUp { key: "ě".into() },
            InputEvent::MouseMove { x: -3, y: 480 },
            InputEvent::ButtonDown {
                button: "MBTN_LEFT".into(),
            },
            InputEvent::ButtonUp {
                button: "MBTN_BACK".into(),
            },
            InputEvent::Wheel {
                key: "WHEEL_DOWN".into(),
                steps: 2,
            },
        ]
    }

    /// Deserializes the arguments of a command's fixture into the types of the Rust parameters
    /// and checks them against the values the fixture is meant to carry.
    fn check_command(command: &str, calls: &[Value]) {
        if WITHOUT_ARGUMENTS.contains(&command) {
            assert_eq!(calls.to_vec(), vec![json!({})], "{command}");
            return;
        }
        match command {
            "player_command" => {
                let commands = column::<PlayerCommand>(command, calls, "cmd");
                assert_eq!(commands, player_commands());
                // The values are ones the player takes: only a screenshot is not mpv's to run.
                for cmd in &commands {
                    match (cmd, player::to_mpv(cmd)) {
                        (PlayerCommand::Screenshot { .. }, result) => {
                            assert_eq!(result, Err(CommandError::Routed), "{cmd:?}");
                        }
                        (_, result) => assert!(result.is_ok(), "{cmd:?}: {result:?}"),
                    }
                }
            }
            "player_input" => {
                let events = column::<InputEvent>(command, calls, "event");
                assert_eq!(events, input_events());
                for event in &events {
                    assert!(!input::to_commands(event).is_empty(), "{event:?}");
                }
            }
            "player_load" => assert_eq!(
                pairs::<Vec<String>, LoadMode>(command, calls, ["sources", "mode"]),
                [
                    (vec!["C:\\Videa\\film.mkv".to_owned()], LoadMode::Replace),
                    (
                        vec![
                            "https://example.com/video.mp4".to_owned(),
                            "\\\\server\\share\\Videa čeština (2026)\\žluťoučký kůň.mkv".to_owned(),
                        ],
                        LoadMode::Append
                    ),
                    (Vec::new(), LoadMode::Replace),
                ]
            ),
            "system_open_dialog" => assert_eq!(
                column::<DialogPurpose>(command, calls, "purpose"),
                [DialogPurpose::Media, DialogPurpose::Subtitle]
            ),
            "system_open_text" => assert_eq!(
                column::<String>(command, calls, "text"),
                ["https://example.com/watch?v=abc", "  not a link  "]
            ),
            "surface_set_layout" => assert_eq!(
                column::<Layout>(command, calls, "layout"),
                [
                    Layout::Full,
                    Layout::Rect {
                        x: 12.5,
                        y: 40.0,
                        w: 640.0,
                        h: 360.0
                    },
                    Layout::Mini {
                        w: 360.0,
                        h: 202.5,
                        right: 16.0,
                        bottom: 16.0
                    },
                    Layout::Hidden,
                ]
            ),
            "glass_set_regions" => assert_eq!(
                column::<Vec<GlassRect>>(command, calls, "rects"),
                [
                    vec![
                        GlassRect {
                            x: 24.0,
                            y: 16.0,
                            w: 320.0,
                            h: 44.0,
                            r: 22.0,
                            a: 0.8
                        },
                        // Left out by the UI: fully.
                        GlassRect {
                            x: 160.0,
                            y: 640.0,
                            w: 960.0,
                            h: 72.0,
                            r: 28.0,
                            a: 1.0
                        },
                    ],
                    Vec::new(),
                ]
            ),
            "thumb_request" => assert_eq!(column::<f64>(command, calls, "seconds"), [0.0, 754.321]),
            "settings_set" => {
                // Every patch is one the settings take (nothing unknown, everything in range).
                let tmp = tempfile::tempdir().unwrap();
                let mut store = SettingsStore::load(tmp.path().join(settings::SETTINGS_FILE));
                for patch in column::<Value>(command, calls, "patch") {
                    store
                        .update(patch.clone())
                        .unwrap_or_else(|error| panic!("{patch}: {error}"));
                }
                let now = store.get();
                assert_eq!(now.language, Language::Cs);
                assert_eq!(now.appearance.mode, ThemeMode::Dark);
                assert_eq!(now.appearance.accent, "#ff8800");
                // `null` took the key out, so it is the default again.
                assert_eq!(now.appearance.blur, Appearance::default().blur);
                assert_eq!(now.playback.open_while_playing, LoadMode::Append);
            }
            "settings_set_mpv" => assert_eq!(
                pairs::<String, Option<String>>(command, calls, ["key", "value"]),
                [
                    ("volume".to_owned(), Some("80".to_owned())),
                    ("hwdec".to_owned(), None),
                ]
            ),
            "settings_rebind" => assert_eq!(
                pairs::<String, String>(command, calls, ["key", "newKey"]),
                [("f".to_owned(), "Ctrl+f".to_owned())]
            ),
            "settings_reset_binding" => {
                assert_eq!(column::<String>(command, calls, "key"), ["Ctrl+f"]);
            }
            other => panic!("{other} is registered, but has no check here: add its fixture"),
        }
    }

    /// Serializes `payload` under the fixture `name`.
    fn serialized(into: &mut BTreeMap<String, Vec<Value>>, name: &str, payload: &impl Serialize) {
        into.entry(name.to_owned())
            .or_default()
            .push(serde_json::to_value(payload).expect("the payload serializes"));
    }

    /// An event of the player, under the name of its channel.
    fn player_event(into: &mut BTreeMap<String, Vec<Value>>, event: &PlayerEvent) {
        let channel = event.channel().expect("an event for the UI");
        serialized(into, &channel.replace(':', "."), event);
    }

    /// What Rust sends to the UI, by the real types: every event's payloads, and what the
    /// commands with a structured answer resolve or reject with. Keyed by fixture name.
    fn serialized_fixtures() -> BTreeMap<String, Vec<Value>> {
        let mut sent = BTreeMap::new();
        let out = &mut sent;

        // mpv's property values are JSON that Rust passes on as it gets it, so the batches are
        // the fixture's own; what is checked is the shape around them.
        for sample in samples("player.state") {
            let changes = argument(
                "player.state",
                arguments("player.state", &sample, &["changes"]),
                "changes",
            );
            player_event(out, &PlayerEvent::State { changes });
        }
        player_event(out, &PlayerEvent::FileLoaded);
        for (reason, error) in [
            (EndReason::Eof, None),
            (EndReason::Stop, None),
            (EndReason::Quit, None),
            (EndReason::Error, Some("loading failed")),
            (EndReason::Redirect, None),
        ] {
            player_event(
                out,
                &PlayerEvent::EndFile {
                    reason,
                    error: error.map(str::to_owned),
                },
            );
        }
        for args in [["osd", "volume"], ["osd", "seek"], ["osd", "speed"]] {
            player_event(
                out,
                &PlayerEvent::Message {
                    args: args.map(str::to_owned).to_vec(),
                },
            );
        }
        for (level, prefix, text) in [
            ("warn", "ffmpeg/video", "Invalid NAL unit size\n"),
            ("error", "vo/gpu-next", "Failed to compile shader\n"),
            ("fatal", "cplayer", "Error initializing\n"),
        ] {
            player_event(
                out,
                &PlayerEvent::Log(LogLine {
                    level: level.to_owned(),
                    prefix: prefix.to_owned(),
                    text: text.to_owned(),
                }),
            );
        }

        serialized(
            out,
            &thumbs::READY_EVENT.replace(':', "."),
            &ThumbReady {
                width: 200,
                height: 112,
                seq: 3,
            },
        );
        for count in [1, 12] {
            serialized(out, "system.open-request", &OpenRequestEvent { count });
        }
        // lib.rs sends `json!({})`.
        serialized(out, "system.paste-empty", &json!({}));
        for state in [
            GlassState {
                enabled: true,
                reason: None,
            },
            GlassState {
                enabled: false,
                reason: Some(GlassReason::User),
            },
            GlassState {
                enabled: false,
                reason: Some(GlassReason::System),
            },
            GlassState {
                enabled: false,
                reason: Some(GlassReason::GpuFailure),
            },
        ] {
            serialized(out, "glass.state", &state);
        }
        serialized(out, "settings.changed", &Settings::default());
        serialized(
            out,
            "settings.changed",
            &Settings {
                language: Language::Cs,
                appearance: Appearance {
                    mode: ThemeMode::Dark,
                    accent: "#ff8800".to_owned(),
                    glass_tint: "#101018".to_owned(),
                    glass_opacity: 0.6,
                    blur: 30.0,
                    saturation: 1.2,
                    radius: 16.0,
                    mica: false,
                    reduce_transparency: ReduceTransparency::On,
                    ui_scale: 1.25,
                },
                playback: Playback {
                    open_while_playing: LoadMode::Append,
                },
                ..Settings::default()
            },
        );

        serialized(
            out,
            "returns.settings_bindings",
            &vec![
                Binding {
                    key: "RIGHT".to_owned(),
                    command: "no-osd seek 5; script-message kaleido osd seek".to_owned(),
                    source: BindingSource::Kaleido,
                    comment: None,
                },
                Binding {
                    key: "Ctrl+f".to_owned(),
                    command: "cycle fullscreen".to_owned(),
                    source: BindingSource::User,
                    comment: Some("My fullscreen".to_owned()),
                },
                Binding {
                    key: "i".to_owned(),
                    command: "script-binding stats/display-stats".to_owned(),
                    source: BindingSource::Mpv,
                    comment: None,
                },
                Binding {
                    key: "Ctrl+h".to_owned(),
                    command: "script-binding thumbfast/toggle".to_owned(),
                    source: BindingSource::Plugin {
                        name: "thumbfast".to_owned(),
                    },
                    comment: None,
                },
                Binding {
                    key: "q".to_owned(),
                    command: "ignore".to_owned(),
                    source: BindingSource::User,
                    comment: None,
                },
            ],
        );
        serialized(
            out,
            "returns.settings_audio_devices",
            &vec![
                AudioDevice {
                    name: "auto".to_owned(),
                    description: "Autoselect device".to_owned(),
                },
                AudioDevice {
                    name: "wasapi/{0.0.0.00000000}.{a1b2c3d4}".to_owned(),
                    description: "Reproduktory (Realtek Audio)".to_owned(),
                },
            ],
        );
        serialized(
            out,
            "returns.system_licenses",
            &vec![
                License {
                    name: "libmpv".to_owned(),
                    version: "0.41.0".to_owned(),
                    license: "GPL-3.0-or-later".to_owned(),
                    url: "https://mpv.io".to_owned(),
                },
                License {
                    name: "zustand".to_owned(),
                    version: "5.0.15".to_owned(),
                    license: "MIT".to_owned(),
                    url: "https://github.com/pmndrs/zustand".to_owned(),
                },
            ],
        );
        for outcome in [PasteOutcome::Played, PasteOutcome::Empty] {
            serialized(out, "returns.system_paste", &outcome);
        }

        let issue = |source: &str, kind| LoadIssue {
            source: source.to_owned(),
            kind,
        };
        serialized(
            out,
            "rejects.player_load",
            &vec![
                issue("C:\\Videa\\chybí.mkv", SourceError::NotFound),
                issue("file:///C:/Videa/film.mkv", SourceError::Protocol),
                issue("", SourceError::Invalid),
            ],
        );
        serialized(
            out,
            "rejects.system_open_text",
            &issue("ftp://example.com/video.mp4", SourceError::Protocol),
        );
        serialized(
            out,
            "rejects.system_open_text",
            &issue("not a link", SourceError::Invalid),
        );
        for error in [
            SettingsError::NotAllowed {
                key: "futureKey".to_owned(),
            },
            SettingsError::Invalid {
                key: "appearance.blur".to_owned(),
                reason: "from 0 to 40".to_owned(),
            },
            SettingsError::Io {
                message: "the disk is full".to_owned(),
            },
            SettingsError::Unavailable,
        ] {
            serialized(out, "rejects.settings_set", &error);
        }
        sent
    }

    /// The same JSON whether a number was written `1` or `1.0`.
    fn numeric(value: &Value) -> Value {
        match value {
            Value::Number(number) => number
                .as_f64()
                .and_then(Number::from_f64)
                .map_or(Value::Null, Value::Number),
            Value::Array(items) => Value::Array(items.iter().map(numeric).collect()),
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(name, field)| (name.clone(), numeric(field)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    #[test]
    fn ipc_fixtures_match_serde() {
        // What the UI sends: every registered command takes its fixture's arguments.
        let commands = registered_commands();
        for command in &commands {
            check_command(command, &samples(command));
        }

        // What Rust sends: the real types serialize to the fixture's JSON.
        let sent = serialized_fixtures();
        for (name, payloads) in &sent {
            assert_eq!(
                numeric(&Value::Array(payloads.clone())),
                numeric(&Value::Array(samples(name))),
                "{name}.json: what Rust serializes is not what the fixture says"
            );
        }

        // No fixture is left that nothing checks.
        let on_disk: BTreeSet<String> = fs::read_dir(fixture_dir())
            .expect("the fixtures folder")
            .map(|entry| entry.expect("a fixture file").path())
            .map(|path| {
                assert_eq!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("json"),
                    "{path:?}"
                );
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .expect("a fixture name")
                    .to_owned()
            })
            .collect();
        let checked: BTreeSet<String> = commands
            .iter()
            .cloned()
            .chain(sent.keys().cloned())
            .collect();
        assert_eq!(on_disk, checked);
    }
}
