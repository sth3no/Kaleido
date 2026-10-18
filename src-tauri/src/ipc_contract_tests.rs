//! The contract with the UI, from Rust's side. `tests/fixtures/ipc` holds what the UI sends and
//! hears as JSON, and the UI's own test (`src/ipc/contract.test.ts`) checks the same files against
//! its TypeScript types: when a serde type changes, one of the two fails, and the TypeScript types
//! are fixed to match.
//!
//! A file is an array of samples, named
//! - after a command (`player_command.json`): the arguments `invoke` takes, one object per call,
//!   `{}` for a command without arguments;
//! - after an event, its name with `:` as `.` (`player.state.json`): the payloads Rust emits;
//! - `returns.<command>.json` and `rejects.<command>.json`: what a command resolves or rejects
//!   with, where that is more than a number or a string.
//!
//! What is checked, in both directions (a key the fixture has and the type does not, and the
//! other way round, fail alike):
//! - What the UI sends: every argument is read into the real Rust type and written again; the
//!   result has to be the fixture's JSON. The types are `Serialize` for this in test builds only.
//! - What Rust sends: real values of the event and answer types are serialized and have to be the
//!   fixture's JSON.
//! - Every variant of every enum in a fixture: `variants!` is a `match` without a wildcard arm for
//!   each, so a variant added to a Rust type does not compile until it is listed, and then the
//!   fixtures have to carry it.
//! - Every command registered in lib.rs has a fixture, and every fixture is checked.
//!
//! What cannot be checked: Tauri gives no way to read the parameter names of a command, so they
//! are copied by hand in `check_command` (camelCase of the Rust parameter); the TypeScript
//! wrappers are held to the same names by `contract.test.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Number, Value, json};

use crate::glass::{self, GlassReason, GlassRect, GlassState};
use crate::input::{self, InputEvent};
use crate::player::command::{ScreenshotMode, SeekMode, TrackKind};
use crate::player::load::SourceError;
use crate::player::{
    self, CommandError, EndReason, LoadIssue, LoadMode, LogLine, PlayerCommand, PlayerEvent,
};
use crate::settings::{
    self, Appearance, AudioDevice, Binding, BindingSource, Language, Playback, ReduceTransparency,
    Settings, SettingsError, SettingsStore, ThemeMode,
};
use crate::surface::{CaptionButton, Layout};
use crate::system::clipboard::PasteOutcome;
use crate::system::diagnostics::License;
use crate::system::dialog::DialogPurpose;
use crate::system::{self, OpenRequestEvent, SourcePage};
use crate::themes::{self, SystemAppearance};
use crate::thumbs::{self, ThumbReady};

// ---------------------------------------------------------------------------------------------
// Reading fixtures

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

/// The name of an event's fixture: the event's name with `:` as `.`.
fn fixture_name(event: &str) -> String {
    event.replace(':', ".")
}

fn written<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("the value serializes")
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

/// `actual` is `expected`, key for key.
fn assert_same(what: &str, actual: &[Value], expected: &[Value]) {
    assert_eq!(
        numeric(&Value::Array(actual.to_vec())),
        numeric(&Value::Array(expected.to_vec())),
        "{what}: the left side is what Rust has, the right side what the fixture says"
    );
}

// ---------------------------------------------------------------------------------------------
// What the UI sends

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
fn argument<T: DeserializeOwned>(command: &str, arguments: &Map<String, Value>, name: &str) -> T {
    let value = arguments.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value)
        .unwrap_or_else(|error| panic!("{command}: {name} does not fit: {error}"))
}

fn call_of(arguments: &[(&str, Value)]) -> Value {
    Value::Object(
        arguments
            .iter()
            .map(|(name, value)| ((*name).to_owned(), value.clone()))
            .collect(),
    )
}

/// The one argument `name` of every call, read into `T` and written again: the calls must come
/// back as they were.
fn column<T: DeserializeOwned + Serialize>(command: &str, calls: &[Value], name: &str) -> Vec<T> {
    column_spelled(command, calls, name, Value::clone)
}

/// As [`column`], for a type with a key serde fills in when the fixture leaves it out: `spelled`
/// writes the call the way it comes back.
fn column_spelled<T: DeserializeOwned + Serialize>(
    command: &str,
    calls: &[Value],
    name: &str,
    spelled: fn(&Value) -> Value,
) -> Vec<T> {
    let values: Vec<T> = calls
        .iter()
        .map(|call| argument(command, arguments(command, call, &[name]), name))
        .collect();
    let again: Vec<Value> = values
        .iter()
        .map(|value| call_of(&[(name, written(value))]))
        .collect();
    let wanted: Vec<Value> = calls.iter().map(spelled).collect();
    assert_same(&format!("{command}, written again"), &again, &wanted);
    values
}

/// The two arguments `names` of every call, read and written again like [`column`].
fn pairs<A, B>(command: &str, calls: &[Value], names: [&str; 2]) -> Vec<(A, B)>
where
    A: DeserializeOwned + Serialize,
    B: DeserializeOwned + Serialize,
{
    let values: Vec<(A, B)> = calls
        .iter()
        .map(|call| {
            let given = arguments(command, call, &names);
            (
                argument(command, given, names[0]),
                argument(command, given, names[1]),
            )
        })
        .collect();
    let again: Vec<Value> = values
        .iter()
        .map(|(first, second)| call_of(&[(names[0], written(first)), (names[1], written(second))]))
        .collect();
    assert_same(&format!("{command}, written again"), &again, calls);
    values
}

/// A glass rectangle may leave out `a`; serde then fills in 1 (fully).
fn with_default_opacity(call: &Value) -> Value {
    let mut call = call.clone();
    let rects = call.get_mut("rects").and_then(Value::as_array_mut);
    for rect in rects.into_iter().flatten().filter_map(Value::as_object_mut) {
        rect.entry("a").or_insert(json!(1.0));
    }
    call
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
const WITHOUT_ARGUMENTS: [&str; 18] = [
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
    "system_appearance",
    "system_locale",
];

// ---------------------------------------------------------------------------------------------
// Every variant

/// A `match` over every variant of `$ty`, without a wildcard arm, from the variant to its name on
/// the wire, and the list of those names. A variant added to the Rust type does not compile until
/// it is listed here; [`covers`] then wants the fixtures to carry it.
macro_rules! variants {
    ($name_of:ident, $names:ident: $ty:ty { $($pattern:pat => $name:literal),+ $(,)? }) => {
        fn $name_of(value: &$ty) -> &'static str {
            match value {
                $($pattern => $name,)+
            }
        }

        const $names: &[&str] = &[$($name),+];
    };
}

variants!(command_name, COMMAND_NAMES: PlayerCommand {
    PlayerCommand::TogglePause => "togglePause",
    PlayerCommand::SetPause { .. } => "setPause",
    PlayerCommand::Seek { .. } => "seek",
    PlayerCommand::SetVolume { .. } => "setVolume",
    PlayerCommand::SetMute { .. } => "setMute",
    PlayerCommand::SetSpeed { .. } => "setSpeed",
    PlayerCommand::SelectTrack { .. } => "selectTrack",
    PlayerCommand::SetSubDelay { .. } => "setSubDelay",
    PlayerCommand::SetSubScale { .. } => "setSubScale",
    PlayerCommand::SetAudioDelay { .. } => "setAudioDelay",
    PlayerCommand::SetSubMargin { .. } => "setSubMargin",
    PlayerCommand::PlaylistNext => "playlistNext",
    PlayerCommand::PlaylistPrev => "playlistPrev",
    PlayerCommand::PlaylistPlay { .. } => "playlistPlay",
    PlayerCommand::PlaylistRemove { .. } => "playlistRemove",
    PlayerCommand::PlaylistMove { .. } => "playlistMove",
    PlayerCommand::Screenshot { .. } => "screenshot",
    PlayerCommand::SetFullscreen { .. } => "setFullscreen",
    PlayerCommand::SetOntop { .. } => "setOntop",
    PlayerCommand::Stop => "stop",
});
variants!(seek_mode_name, SEEK_MODE_NAMES: SeekMode {
    SeekMode::Absolute => "absolute",
    SeekMode::Relative => "relative",
    SeekMode::AbsolutePercent => "absolutePercent",
});
variants!(track_kind_name, TRACK_KIND_NAMES: TrackKind {
    TrackKind::Audio => "audio",
    TrackKind::Sub => "sub",
    TrackKind::Video => "video",
});
variants!(screenshot_mode_name, SCREENSHOT_MODE_NAMES: ScreenshotMode {
    ScreenshotMode::Subtitles => "subtitles",
    ScreenshotMode::Video => "video",
    ScreenshotMode::Window => "window",
    ScreenshotMode::EachFrame => "eachFrame",
});
variants!(input_name, INPUT_NAMES: InputEvent {
    InputEvent::KeyDown { .. } => "keyDown",
    InputEvent::KeyUp { .. } => "keyUp",
    InputEvent::MouseMove { .. } => "mouseMove",
    InputEvent::ButtonDown { .. } => "buttonDown",
    InputEvent::ButtonUp { .. } => "buttonUp",
    InputEvent::Wheel { .. } => "wheel",
});
variants!(load_mode_name, LOAD_MODE_NAMES: LoadMode {
    LoadMode::Replace => "replace",
    LoadMode::Append => "append",
});
variants!(dialog_purpose_name, DIALOG_PURPOSE_NAMES: DialogPurpose {
    DialogPurpose::Media => "media",
    DialogPurpose::Subtitle => "subtitle",
});
variants!(source_page_name, SOURCE_PAGE_NAMES: SourcePage {
    SourcePage::Kaleido => "kaleido",
    SourcePage::Libmpv => "libmpv",
});
variants!(layout_name, LAYOUT_NAMES: Layout {
    Layout::Full => "full",
    Layout::Rect { .. } => "rect",
    Layout::Mini { .. } => "mini",
    Layout::Hidden => "hidden",
});
variants!(end_reason_name, END_REASON_NAMES: EndReason {
    EndReason::Eof => "eof",
    EndReason::Stop => "stop",
    EndReason::Quit => "quit",
    EndReason::Error => "error",
    EndReason::Redirect => "redirect",
});
variants!(glass_reason_name, GLASS_REASON_NAMES: GlassReason {
    GlassReason::User => "user",
    GlassReason::System => "system",
    GlassReason::GpuFailure => "gpuFailure",
});
variants!(source_error_name, SOURCE_ERROR_NAMES: SourceError {
    SourceError::NotFound => "notFound",
    SourceError::Protocol => "protocol",
    SourceError::Invalid => "invalid",
});
variants!(paste_outcome_name, PASTE_OUTCOME_NAMES: PasteOutcome {
    PasteOutcome::Played => "played",
    PasteOutcome::Empty => "empty",
});
variants!(settings_error_name, SETTINGS_ERROR_NAMES: SettingsError {
    SettingsError::NotAllowed { .. } => "notAllowed",
    SettingsError::Invalid { .. } => "invalid",
    SettingsError::Io { .. } => "io",
    SettingsError::Unavailable => "unavailable",
});
variants!(binding_source_name, BINDING_SOURCE_NAMES: BindingSource {
    BindingSource::Kaleido => "kaleido",
    BindingSource::User => "user",
    BindingSource::Mpv => "mpv",
    BindingSource::Plugin { .. } => "plugin",
});
variants!(language_name, LANGUAGE_NAMES: Language {
    Language::System => "system",
    Language::Cs => "cs",
    Language::En => "en",
});
variants!(theme_mode_name, THEME_MODE_NAMES: ThemeMode {
    ThemeMode::System => "system",
    ThemeMode::Dark => "dark",
    ThemeMode::Light => "light",
});
variants!(reduce_transparency_name, REDUCE_TRANSPARENCY_NAMES: ReduceTransparency {
    ReduceTransparency::Auto => "auto",
    ReduceTransparency::On => "on",
    ReduceTransparency::Off => "off",
});
// The player's events are untagged, so their names are only these; two of them never reach the UI.
variants!(event_name, EVENT_NAMES: PlayerEvent {
    PlayerEvent::State { .. } => "state",
    PlayerEvent::FileLoaded => "fileLoaded",
    PlayerEvent::EndFile { .. } => "endFile",
    PlayerEvent::Message { .. } => "message",
    PlayerEvent::Log(_) => "log",
    PlayerEvent::ThumbRendered(_) => "thumbRendered",
    PlayerEvent::Shutdown => "shutdown",
});

/// The fixtures use every variant of the type (`all`) and nothing else.
fn covers_names(what: &str, used: impl IntoIterator<Item = &'static str>, all: &[&str]) {
    let used: BTreeSet<&str> = used.into_iter().collect();
    let all: BTreeSet<&str> = all.iter().copied().collect();
    assert_eq!(
        used, all,
        "{what}: the left side is what the fixtures carry, the right side the variants the type has"
    );
}

/// As [`covers_names`], and each name is the one serde writes for the value: under the key `tag`
/// for an enum tagged with it, the plain string for any other.
fn covers<T: Serialize>(
    what: &str,
    values: &[T],
    name_of: fn(&T) -> &'static str,
    all: &[&str],
    tag: Option<&str>,
) {
    for value in values {
        let spelled = match (tag, written(value)) {
            (Some(tag), tagged) => tagged.get(tag).cloned().unwrap_or(Value::Null),
            (None, plain) => plain,
        };
        assert_eq!(
            spelled,
            json!(name_of(value)),
            "{what}: the name is not the one serde writes"
        );
    }
    covers_names(what, values.iter().map(name_of), all);
}

// ---------------------------------------------------------------------------------------------
// The values the fixtures are meant to carry

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

/// Reads the arguments of a command's fixture into the types of the Rust parameters, checks them
/// against the values the fixture is meant to carry, and checks that every variant of every enum
/// among them is in the fixture.
fn check_command(command: &str, calls: &[Value]) {
    if WITHOUT_ARGUMENTS.contains(&command) {
        assert_eq!(calls.to_vec(), vec![json!({})], "{command}");
        return;
    }
    // The names of the arguments are the Rust parameters' in camelCase, copied by hand (see the
    // top of the file).
    match command {
        "player_command" => {
            let commands = column::<PlayerCommand>(command, calls, "cmd");
            assert_eq!(commands, player_commands());
            covers(
                "PlayerCommand",
                &commands,
                command_name,
                COMMAND_NAMES,
                Some("type"),
            );
            let seek_modes: Vec<SeekMode> = commands
                .iter()
                .filter_map(|cmd| match cmd {
                    PlayerCommand::Seek { mode, .. } => Some(*mode),
                    _ => None,
                })
                .collect();
            covers(
                "SeekMode",
                &seek_modes,
                seek_mode_name,
                SEEK_MODE_NAMES,
                None,
            );
            let track_kinds: Vec<TrackKind> = commands
                .iter()
                .filter_map(|cmd| match cmd {
                    PlayerCommand::SelectTrack { kind, .. } => Some(*kind),
                    _ => None,
                })
                .collect();
            covers(
                "TrackKind",
                &track_kinds,
                track_kind_name,
                TRACK_KIND_NAMES,
                None,
            );
            let screenshot_modes: Vec<ScreenshotMode> = commands
                .iter()
                .filter_map(|cmd| match cmd {
                    PlayerCommand::Screenshot { mode } => Some(*mode),
                    _ => None,
                })
                .collect();
            covers(
                "ScreenshotMode",
                &screenshot_modes,
                screenshot_mode_name,
                SCREENSHOT_MODE_NAMES,
                None,
            );
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
            covers("InputEvent", &events, input_name, INPUT_NAMES, Some("type"));
            for event in &events {
                assert!(!input::to_commands(event).is_empty(), "{event:?}");
            }
        }
        "player_load" => {
            let loads = pairs::<Vec<String>, LoadMode>(command, calls, ["sources", "mode"]);
            assert_eq!(
                loads,
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
            );
            let modes: Vec<LoadMode> = loads.iter().map(|(_, mode)| *mode).collect();
            covers("LoadMode", &modes, load_mode_name, LOAD_MODE_NAMES, None);
        }
        "system_open_dialog" => {
            let purposes = column::<DialogPurpose>(command, calls, "purpose");
            assert_eq!(purposes, [DialogPurpose::Media, DialogPurpose::Subtitle]);
            covers(
                "DialogPurpose",
                &purposes,
                dialog_purpose_name,
                DIALOG_PURPOSE_NAMES,
                None,
            );
        }
        "system_open_text" => assert_eq!(
            column::<String>(command, calls, "text"),
            ["https://example.com/watch?v=abc", "  not a link  "]
        ),
        "system_ui_error" => assert_eq!(
            column::<String>(command, calls, "message"),
            [
                "TypeError: Cannot read properties of undefined (reading 'title')\n    at \
                 PlayerPage (PlayerPage.tsx:12:7)\nin components:\n    at PlayerPage\n    at App"
            ]
        ),
        "system_open_source" => {
            let pages = column::<SourcePage>(command, calls, "which");
            assert_eq!(pages, [SourcePage::Kaleido, SourcePage::Libmpv]);
            covers(
                "SourcePage",
                &pages,
                source_page_name,
                SOURCE_PAGE_NAMES,
                None,
            );
            // The addresses are Rust's: the UI names a page and never an address.
            for page in &pages {
                assert!(page.url().starts_with("https://"), "{page:?}");
            }
        }
        "surface_set_layout" => {
            let layouts = column::<Layout>(command, calls, "layout");
            assert_eq!(
                layouts,
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
            );
            covers("Layout", &layouts, layout_name, LAYOUT_NAMES, Some("kind"));
        }
        "surface_set_caption_buttons" => assert_eq!(
            column::<Vec<CaptionButton>>(command, calls, "rects"),
            [
                // The maximise button at the top right of a 1280×720 window.
                vec![CaptionButton {
                    x: 1196.5,
                    y: 16.0,
                    w: 36.0,
                    h: 32.25
                }],
                // None shown (hidden controls, fullscreen).
                Vec::new(),
            ]
        ),
        "glass_set_regions" => assert_eq!(
            column_spelled::<Vec<GlassRect>>(command, calls, "rects", with_default_opacity),
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

// ---------------------------------------------------------------------------------------------
// What Rust sends

/// Serializes `payload` under the fixture `name`.
fn serialized(into: &mut BTreeMap<String, Vec<Value>>, name: &str, payload: &impl Serialize) {
    into.entry(name.to_owned())
        .or_default()
        .push(written(payload));
}

/// What Rust sends to the UI, by the real types: every event's payloads, and what the commands
/// with a structured answer resolve or reject with, keyed by fixture name. Every enum among them
/// has all its variants in the samples.
fn serialized_fixtures() -> BTreeMap<String, Vec<Value>> {
    let mut sent = BTreeMap::new();
    let out = &mut sent;

    // The events of the player. mpv's property values are JSON that Rust passes on as it gets
    // it, so the batches are the fixture's own; what is checked is the shape around them.
    let mut ui_events = Vec::new();
    for sample in samples("player.state") {
        let changes = argument(
            "player.state",
            arguments("player.state", &sample, &["changes"]),
            "changes",
        );
        ui_events.push(PlayerEvent::State { changes });
    }
    ui_events.push(PlayerEvent::FileLoaded);
    let end_reasons = [
        EndReason::Eof,
        EndReason::Stop,
        EndReason::Quit,
        EndReason::Error,
        EndReason::Redirect,
    ];
    // Only an error is told with its file (a string, or null where the playlist no longer has the
    // entry) and with whether mpv goes on by itself; the other ends have neither. The fixture has
    // an error that continues, one that does not, and one without a file.
    let failed_file = || Some(r"C:\Videa\poškozený.mkv".to_owned());
    for reason in end_reasons {
        let error = reason == EndReason::Error;
        ui_events.push(PlayerEvent::EndFile {
            reason,
            error: error.then(|| "loading failed".to_owned()),
            file: if error { failed_file() } else { None },
            continues: error,
        });
    }
    for (file, continues) in [(failed_file(), false), (None, false)] {
        ui_events.push(PlayerEvent::EndFile {
            reason: EndReason::Error,
            error: Some("loading failed".to_owned()),
            file,
            continues,
        });
    }
    covers(
        "EndReason",
        &end_reasons,
        end_reason_name,
        END_REASON_NAMES,
        None,
    );
    for args in [["osd", "volume"], ["osd", "seek"], ["osd", "speed"]] {
        ui_events.push(PlayerEvent::Message {
            args: args.map(str::to_owned).to_vec(),
        });
    }
    for (level, prefix, text) in [
        ("warn", "ffmpeg/video", "Invalid NAL unit size\n"),
        ("error", "vo/gpu-next", "Failed to compile shader\n"),
        ("fatal", "cplayer", "Error initializing\n"),
    ] {
        ui_events.push(PlayerEvent::Log(LogLine {
            level: level.to_owned(),
            prefix: prefix.to_owned(),
            text: text.to_owned(),
        }));
    }
    // Two of the player's events are Rust's own and have no fixture.
    let rust_only = [
        PlayerEvent::ThumbRendered(String::new()),
        PlayerEvent::Shutdown,
    ];
    for event in &rust_only {
        assert_eq!(event.channel(), None, "{event:?} never reaches the UI");
    }
    covers_names(
        "PlayerEvent",
        ui_events.iter().chain(&rust_only).map(event_name),
        EVENT_NAMES,
    );
    for event in &ui_events {
        let channel = event.channel().expect("an event for the UI");
        serialized(out, &fixture_name(channel), event);
    }

    // The other events.
    serialized(
        out,
        &fixture_name(thumbs::READY_EVENT),
        &ThumbReady {
            width: 200,
            height: 112,
            seq: 3,
        },
    );
    for count in [1, 12] {
        serialized(
            out,
            &fixture_name(system::OPEN_REQUEST_EVENT),
            &OpenRequestEvent { count },
        );
    }
    // lib.rs sends `json!({})` for both.
    serialized(out, &fixture_name(system::PASTE_EMPTY_EVENT), &json!({}));
    serialized(out, &fixture_name(system::ERROR_EVENT), &json!({}));
    let glass_states = [
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
    ];
    let glass_reasons: Vec<GlassReason> = glass_states
        .iter()
        .filter_map(|state| state.reason)
        .collect();
    covers(
        "GlassReason",
        &glass_reasons,
        glass_reason_name,
        GLASS_REASON_NAMES,
        None,
    );
    for state in &glass_states {
        serialized(out, &fixture_name(glass::STATE_EVENT), state);
    }
    let all_settings = [
        Settings::default(),
        Settings {
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
        Settings {
            language: Language::En,
            appearance: Appearance {
                mode: ThemeMode::Light,
                reduce_transparency: ReduceTransparency::Off,
                ..Appearance::default()
            },
            ..Settings::default()
        },
    ];
    let languages: Vec<Language> = all_settings.iter().map(|s| s.language).collect();
    covers("Language", &languages, language_name, LANGUAGE_NAMES, None);
    let modes: Vec<ThemeMode> = all_settings.iter().map(|s| s.appearance.mode).collect();
    covers("ThemeMode", &modes, theme_mode_name, THEME_MODE_NAMES, None);
    let reduces: Vec<ReduceTransparency> = all_settings
        .iter()
        .map(|s| s.appearance.reduce_transparency)
        .collect();
    covers(
        "ReduceTransparency",
        &reduces,
        reduce_transparency_name,
        REDUCE_TRANSPARENCY_NAMES,
        None,
    );
    for settings in &all_settings {
        serialized(out, &fixture_name(settings::CHANGED_EVENT), settings);
    }
    // What Windows says: the event and the answer of `system_appearance` are the same payload.
    // Windows 11 as it comes, Windows 10 without transparency, high contrast on a new build.
    let system_appearances = [
        SystemAppearance {
            transparency_effects: true,
            high_contrast: false,
            windows_build: 22631,
        },
        SystemAppearance {
            transparency_effects: false,
            high_contrast: false,
            windows_build: 19045,
        },
        SystemAppearance {
            transparency_effects: true,
            high_contrast: true,
            windows_build: 26200,
        },
    ];
    for appearance in &system_appearances {
        serialized(
            out,
            &fixture_name(themes::APPEARANCE_CHANGED_EVENT),
            appearance,
        );
        serialized(out, "returns.system_appearance", appearance);
    }

    // What commands resolve with.
    let bindings = vec![
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
    ];
    let sources: Vec<BindingSource> = bindings.iter().map(|b| b.source.clone()).collect();
    covers(
        "BindingSource",
        &sources,
        binding_source_name,
        BINDING_SOURCE_NAMES,
        Some("type"),
    );
    serialized(out, "returns.settings_bindings", &bindings);
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
    let outcomes = [PasteOutcome::Played, PasteOutcome::Empty];
    covers(
        "PasteOutcome",
        &outcomes,
        paste_outcome_name,
        PASTE_OUTCOME_NAMES,
        None,
    );
    for outcome in &outcomes {
        serialized(out, "returns.system_paste", outcome);
    }

    // What commands reject with.
    let issue = |source: &str, kind| LoadIssue {
        source: source.to_owned(),
        kind,
    };
    let load_issues = vec![
        issue("C:\\Videa\\chybí.mkv", SourceError::NotFound),
        issue("file:///C:/Videa/film.mkv", SourceError::Protocol),
        issue("", SourceError::Invalid),
    ];
    let text_issues = [
        issue("ftp://example.com/video.mp4", SourceError::Protocol),
        issue("not a link", SourceError::Invalid),
    ];
    let kinds: Vec<SourceError> = load_issues
        .iter()
        .chain(&text_issues)
        .map(|found| found.kind)
        .collect();
    covers(
        "SourceError",
        &kinds,
        source_error_name,
        SOURCE_ERROR_NAMES,
        None,
    );
    serialized(out, "rejects.player_load", &load_issues);
    for found in &text_issues {
        serialized(out, "rejects.system_open_text", found);
    }
    let settings_errors = [
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
    ];
    covers(
        "SettingsError",
        &settings_errors,
        settings_error_name,
        SETTINGS_ERROR_NAMES,
        Some("type"),
    );
    for error in &settings_errors {
        serialized(out, "rejects.settings_set", error);
    }
    sent
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
        assert_same(&format!("{name}.json"), payloads, &samples(name));
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
