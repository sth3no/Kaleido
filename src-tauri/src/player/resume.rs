//! What a restart of the core takes from the old core to the new one (spec 6.3: after "Použít"
//! the player goes on where it was): the playlist, which entry plays and where, the selected
//! tracks, the subtitles added from files, and the pause. [`capture`] reads it from the old core
//! and [`restore_commands`] gives the new one the commands that put it back.

use mpv_ffi::Mpv;
use serde_json::Value;

use super::load::{NO_FOLDER_PLAYLIST, per_file_option, scheme};

/// The separator of mpv's path lists on Windows (`sub-files`). A `;` inside a path is escaped
/// with a backslash, which mpv takes away again (`get_nextsep` in mpv's `m_option.c`).
const PATH_LIST_SEPARATOR: char = ';';

/// Where the old core was.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResumeState {
    /// The playlist, in order.
    pub entries: Vec<ResumeEntry>,
    /// The index in `entries` of the entry mpv was playing (or loading, or about to play);
    /// `None` when it played none (idle, or at the end of the playlist without `keep-open`).
    pub current: Option<usize>,
    /// Seconds into the current entry; `None` where it is not known (mpv had not got to the
    /// entry, or not loaded it yet): the new core starts it where mpv would.
    pub position: Option<f64>,
    pub paused: bool,
    /// The tracks of the current entry.
    pub tracks: ResumeTracks,
    /// The subtitle files the current entry had besides its own tracks (`sub-add`, mpv's
    /// `sub-auto`), in the order of their track ids, so that the new core numbers them the same.
    pub external_subs: Vec<String>,
    /// The player's volume and mute, not the entry's: they come back before anything loads,
    /// also for an idle player. A new core would start with mpv.conf's (spec 6.3: Apply does not
    /// change the volume). `None` where they could not be read.
    pub volume: Option<f64>,
    pub mute: Option<bool>,
}

/// One entry of the playlist.
#[derive(Debug, Clone, PartialEq)]
pub struct ResumeEntry {
    /// The entry's `filename` exactly as mpv's `playlist` has it (the path or link it was
    /// loaded with, a long path with its `\\?\`).
    pub filename: String,
    /// Per-file options the entry is loaded with again (`ytdl-format` of a chosen quality).
    /// The names are mpv's options; the values are quoted when written.
    pub options: Vec<(String, String)>,
}

/// The audio, subtitle and video track of the current entry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResumeTracks {
    pub aid: TrackChoice,
    pub sid: TrackChoice,
    pub vid: TrackChoice,
}

/// What mpv's `aid`, `sid` or `vid` said.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TrackChoice {
    /// mpv chooses (nothing was selected yet): the new core chooses again.
    #[default]
    Auto,
    /// No track of the kind (`no`).
    Off,
    /// The track with this id.
    Id(i64),
}

impl TrackChoice {
    /// The text of mpv's property, as `get_string` reads it.
    fn parse(text: &str) -> TrackChoice {
        match text {
            "no" => TrackChoice::Off,
            "auto" => TrackChoice::Auto,
            id => id.parse().map_or_else(
                |_| {
                    tracing::warn!("mpv names a track {id:?}; mpv chooses it again");
                    TrackChoice::Auto
                },
                TrackChoice::Id,
            ),
        }
    }

    /// The value of the per-file option; `None` for `Auto`, which sets nothing.
    fn to_mpv(self) -> Option<String> {
        match self {
            TrackChoice::Auto => None,
            TrackChoice::Off => Some("no".to_owned()),
            TrackChoice::Id(id) => Some(id.to_string()),
        }
    }
}

/// Reads where `mpv` is, on the request thread. `entry_options` gives the per-file options each
/// entry is loaded with again, by its `filename`. What cannot be read is left out: an unreadable
/// playlist is an empty one, an unreadable `pause` is playing.
pub fn capture(mpv: &Mpv, entry_options: &dyn Fn(&str) -> Vec<(String, String)>) -> ResumeState {
    capture_with_entry(mpv, entry_options).0
}

/// [`capture`], and the `id` mpv gave the current playlist entry.
pub(crate) fn capture_with_entry(
    mpv: &Mpv,
    entry_options: &dyn Fn(&str) -> Vec<(String, String)>,
) -> (ResumeState, Option<i64>) {
    let text = |name: &str| {
        mpv.get_string(name)
            .inspect_err(|error| tracing::warn!("cannot read mpv's {name}: {error}"))
            .ok()
    };
    let playlist = text("playlist")
        .map(|playlist| playlist_of(&playlist))
        .unwrap_or_default();
    let entries = playlist
        .filenames
        .into_iter()
        .map(|filename| ResumeEntry {
            options: entry_options(&filename),
            filename,
        })
        .collect();
    let mut state = ResumeState {
        entries,
        current: playlist.current,
        paused: mpv.get_flag("pause").unwrap_or(false),
        volume: mpv
            .get_f64("volume")
            .ok()
            .filter(|volume| volume.is_finite() && *volume >= 0.0),
        mute: mpv.get_flag("mute").ok(),
        ..ResumeState::default()
    };
    // The time and the tracks are the playing file's. Only when the current entry is the one mpv
    // plays are they its own: an entry switch that mpv has not got to yet (a `playlist-next` just
    // before the restart) makes the next entry current while the last one still plays. Then
    // nothing is known of the current entry yet, and the new core starts it as mpv would.
    if state.current.is_some() && playlist.playing {
        // Unavailable until the entry has loaded.
        state.position = mpv
            .get_f64("time-pos")
            .ok()
            .filter(|position| position.is_finite() && *position >= 0.0);
        let track = |name: &str| text(name).map_or(TrackChoice::Auto, |id| TrackChoice::parse(&id));
        state.tracks = ResumeTracks {
            aid: track("aid"),
            sid: track("sid"),
            vid: track("vid"),
        };
        state.external_subs = text("track-list")
            .map(|tracks| external_subs_of(&tracks))
            .unwrap_or_default();
    }
    (state, playlist.current_id)
}

/// The `id` mpv gave the current playlist entry; `None` when none is current.
pub(crate) fn current_entry(mpv: &Mpv) -> Option<i64> {
    let playlist = mpv.get_string("playlist").ok()?;
    playlist_of(&playlist).current_id
}

/// What a restart gave the new core, and the `id` the core gave the entry it started (see
/// [`unsettled`]).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Restored {
    pub entry: i64,
    pub state: ResumeState,
}

/// For `state`, captured from a core whose current entry (`entry`, its id) has not got to where
/// it plays yet: no `playback-restart` since the entry started. Until then mpv's `time-pos` is
/// nothing or 0 (between opening the file and the seek to its start), so the position is not
/// known, and none is given: the entry starts where mpv starts it on its own (its saved position,
/// or 0). If it is the entry the last restart started (`restored`), it is on its way to what that
/// restart gave it, which mpv cannot say yet: the position, the tracks and the subtitle files
/// come from there.
pub(crate) fn unsettled(state: &mut ResumeState, entry: Option<i64>, restored: Option<&Restored>) {
    state.position = None;
    let Some(restored) = restored
        .filter(|restored| entry == Some(restored.entry) && restored.state.current.is_some())
    else {
        return;
    };
    state.position = restored.state.position;
    state.tracks = restored.state.tracks;
    state
        .external_subs
        .clone_from(&restored.state.external_subs);
}

/// The commands that give a new (idle) core the volume and mute of `state`, its playlist, and
/// play its current entry where it was, with its tracks and subtitles, paused or not. Every entry
/// gets [`NO_FOLDER_PLAYLIST`] (Ruling R55) and its own options; the current one its start, its
/// tracks and its subtitle files besides. Values are quoted as `load_commands` quotes them. For an
/// empty playlist only the volume and mute; nothing plays where no entry was current.
pub fn restore_commands(state: &ResumeState) -> Vec<Vec<String>> {
    let mut commands = Vec::new();
    // Before any file loads, so that none starts at mpv.conf's volume.
    if let Some(volume) = state.volume {
        commands.push(args(&["set", "volume", &volume.to_string()]));
    }
    if let Some(mute) = state.mute {
        commands.push(args(&["set", "mute", yes_no(mute)]));
    }
    if state.entries.is_empty() {
        return commands;
    }
    commands.push(args(&["set", "pause", yes_no(state.paused)]));
    for (index, entry) in state.entries.iter().enumerate() {
        let mut options = vec![NO_FOLDER_PLAYLIST.to_owned()];
        options.extend(entry.options.iter().filter_map(|(name, value)| {
            if is_option_name(name) {
                Some(per_file_option(name, value))
            } else {
                tracing::warn!("a per-file option named {name:?} is left out");
                None
            }
        }));
        if state.current == Some(index) {
            options.extend(current_options(state));
        }
        commands.push(vec![
            "loadfile".to_owned(),
            entry.filename.clone(),
            "append".to_owned(),
            // The index placeholder in front of the options.
            "-1".to_owned(),
            options.join(","),
        ]);
    }
    if let Some(current) = state
        .current
        .filter(|&current| current < state.entries.len())
    {
        commands.push(args(&["playlist-play-index", &current.to_string()]));
    }
    commands
}

/// The per-file options of the entry that was playing.
fn current_options(state: &ResumeState) -> Vec<String> {
    let mut options = Vec::new();
    if let Some(position) = state.position {
        options.push(per_file_option("start", &position.to_string()));
    }
    let ResumeTracks { aid, sid, vid } = state.tracks;
    for (name, choice) in [("aid", aid), ("sid", sid), ("vid", vid)] {
        if let Some(value) = choice.to_mpv() {
            options.push(per_file_option(name, &value));
        }
    }
    if !state.external_subs.is_empty() {
        let escaped = format!("\\{PATH_LIST_SEPARATOR}");
        let files: Vec<String> = state
            .external_subs
            .iter()
            .map(|path| path.replace(PATH_LIST_SEPARATOR, &escaped))
            .collect();
        options.push(per_file_option(
            "sub-files",
            &files.join(&PATH_LIST_SEPARATOR.to_string()),
        ));
    }
    options
}

/// An option name that cannot end the option list early: lower-case letters, digits and `-`.
fn is_option_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|&part| part.to_owned()).collect()
}

fn yes_no(on: bool) -> &'static str {
    if on { "yes" } else { "no" }
}

/// The entries of mpv's `playlist` property (JSON text), the current one and its `id`.
#[derive(Debug, Default, PartialEq)]
struct Playlist {
    filenames: Vec<String>,
    current: Option<usize>,
    current_id: Option<i64>,
    /// The current entry is also the one mpv plays (`"playing": true`).
    playing: bool,
}

fn playlist_of(text: &str) -> Playlist {
    let mut playlist = Playlist::default();
    let Some(entries) = json_list("playlist", text) else {
        return playlist;
    };
    for entry in &entries {
        let Some(filename) = entry.get("filename").and_then(Value::as_str) else {
            tracing::warn!("an entry of mpv's playlist has no filename and is left out: {entry}");
            continue;
        };
        let flag = |name: &str| entry.get(name).and_then(Value::as_bool) == Some(true);
        if flag("current") {
            playlist.current = Some(playlist.filenames.len());
            playlist.current_id = entry.get("id").and_then(Value::as_i64);
            playlist.playing = flag("playing");
        }
        playlist.filenames.push(filename.to_owned());
    }
    playlist
}

/// The subtitle files in mpv's `track-list` (JSON text), in the order of their ids. Only files on
/// a disk: a subtitle with a scheme (`edl://`, `memory://`, a link) came with a stream, from
/// `ytdl_hook`, which adds it again when the stream loads.
fn external_subs_of(text: &str) -> Vec<String> {
    let Some(tracks) = json_list("track-list", text) else {
        return Vec::new();
    };
    let mut subs: Vec<(i64, String)> = tracks
        .iter()
        .filter(|track| {
            track.get("type").and_then(Value::as_str) == Some("sub")
                && track.get("external").and_then(Value::as_bool) == Some(true)
        })
        .filter_map(|track| {
            let id = track.get("id").and_then(Value::as_i64)?;
            let file = track.get("external-filename").and_then(Value::as_str)?;
            scheme(file).is_none().then(|| (id, file.to_owned()))
        })
        .collect();
    subs.sort_by_key(|(id, _)| *id);
    subs.into_iter().map(|(_, file)| file).collect()
}

fn json_list(name: &str, text: &str) -> Option<Vec<Value>> {
    match serde_json::from_str(text) {
        Ok(Value::Array(items)) => Some(items),
        Ok(_) => {
            tracing::warn!("mpv's {name} is not a list: {text}");
            None
        }
        Err(error) => {
            tracing::warn!("mpv's {name} is not JSON ({error}): {text}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::Duration;

    use mpv_ffi::{Event, Mpv};

    use super::*;
    use crate::player::testing::{NoEvents, Recorded, clip, eventually, headless, temp_paths};
    use crate::player::{Engine, Restart};

    fn text(parts: &[&str]) -> Vec<String> {
        args(parts)
    }

    fn entry(filename: &str, options: &[(&str, &str)]) -> ResumeEntry {
        ResumeEntry {
            filename: filename.to_owned(),
            options: options
                .iter()
                .map(|&(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
        }
    }

    /// Two entries, the second (a link with a chosen quality) paused at 12.5 s with the second
    /// subtitle track, the volume at 40.5 and muted: the volume first, then the playlist as it
    /// was, and the second entry plays.
    #[test]
    fn restore_commands_play_the_current_entry_with_its_options() {
        let state = ResumeState {
            entries: vec![
                entry(r"C:\Videa\a.mkv", &[]),
                entry(
                    "https://example.com/watch?v=b",
                    &[("ytdl-format", "bv*[height<=?1080]+ba/b")],
                ),
            ],
            current: Some(1),
            position: Some(12.5),
            paused: true,
            tracks: ResumeTracks {
                sid: TrackChoice::Id(2),
                ..ResumeTracks::default()
            },
            external_subs: Vec::new(),
            volume: Some(40.5),
            mute: Some(true),
        };
        // %N% is the length in bytes of the value that follows: 23 for the format.
        assert_eq!(
            restore_commands(&state),
            [
                text(&["set", "volume", "40.5"]),
                text(&["set", "mute", "yes"]),
                text(&["set", "pause", "yes"]),
                text(&[
                    "loadfile",
                    r"C:\Videa\a.mkv",
                    "append",
                    "-1",
                    "autocreate-playlist=no"
                ]),
                text(&[
                    "loadfile",
                    "https://example.com/watch?v=b",
                    "append",
                    "-1",
                    "autocreate-playlist=no,ytdl-format=%23%bv*[height<=?1080]+ba/b,\
                     start=%4%12.5,sid=%1%2",
                ]),
                text(&["playlist-play-index", "1"]),
            ]
        );
    }

    /// Tracks switched off and subtitle files, one with `,` and one with `;` in its name: the
    /// list is one quoted value, its `;` inside a name escaped. An option name that could end the
    /// list is left out.
    #[test]
    fn restore_commands_quote_subtitle_files_and_tracks_turned_off() {
        let state = ResumeState {
            entries: vec![entry(r"C:\Videa\díl 1.mkv", &[("bad,name", "x")])],
            current: Some(0),
            position: None,
            paused: false,
            tracks: ResumeTracks {
                aid: TrackChoice::Off,
                sid: TrackChoice::Id(3),
                vid: TrackChoice::Id(1),
            },
            external_subs: vec![
                r"C:\Titulky\a, b.srt".to_owned(),
                r"C:\Titulky\díl; 2.srt".to_owned(),
            ],
            // Not read: not set.
            volume: None,
            mute: None,
        };
        let files = r"C:\Titulky\a, b.srt;C:\Titulky\díl\; 2.srt";
        assert_eq!(
            restore_commands(&state),
            [
                text(&["set", "pause", "no"]),
                text(&[
                    "loadfile",
                    r"C:\Videa\díl 1.mkv",
                    "append",
                    "-1",
                    &format!(
                        "autocreate-playlist=no,aid=%2%no,sid=%1%3,vid=%1%1,sub-files=%{}%{files}",
                        files.len()
                    ),
                ]),
                text(&["playlist-play-index", "0"]),
            ]
        );
    }

    #[test]
    fn an_empty_state_restores_nothing() {
        assert!(restore_commands(&ResumeState::default()).is_empty());
        // Paused or not, with tracks or not: no playlist, nothing to do.
        let idle = ResumeState {
            paused: true,
            tracks: ResumeTracks {
                sid: TrackChoice::Off,
                ..ResumeTracks::default()
            },
            ..ResumeState::default()
        };
        assert!(restore_commands(&idle).is_empty());
    }

    /// The volume belongs to the player, not to a file: an idle player gets it back too.
    #[test]
    fn an_idle_player_gets_its_volume_back_and_nothing_else() {
        let idle = ResumeState {
            paused: true,
            volume: Some(37.0),
            mute: Some(false),
            ..ResumeState::default()
        };
        assert_eq!(
            restore_commands(&idle),
            [text(&["set", "volume", "37"]), text(&["set", "mute", "no"])]
        );
    }

    /// The playlist ended (no `keep-open`): it comes back, and nothing plays.
    #[test]
    fn a_playlist_without_a_current_entry_comes_back_without_playing() {
        let state = ResumeState {
            entries: vec![entry(r"C:\Videa\a.mkv", &[]), entry(r"C:\Videa\b.mkv", &[])],
            current: None,
            position: Some(3.0),
            paused: false,
            tracks: ResumeTracks::default(),
            external_subs: vec![r"C:\Titulky\a.srt".to_owned()],
            ..ResumeState::default()
        };
        assert_eq!(
            restore_commands(&state),
            [
                text(&["set", "pause", "no"]),
                text(&[
                    "loadfile",
                    r"C:\Videa\a.mkv",
                    "append",
                    "-1",
                    "autocreate-playlist=no"
                ]),
                text(&[
                    "loadfile",
                    r"C:\Videa\b.mkv",
                    "append",
                    "-1",
                    "autocreate-playlist=no"
                ]),
            ]
        );
    }

    /// The JSON and the words mpv writes for its playlist, its tracks and a track choice.
    #[test]
    fn captured_values_are_read_as_mpv_writes_them() {
        assert_eq!(TrackChoice::parse("no"), TrackChoice::Off);
        assert_eq!(TrackChoice::parse("auto"), TrackChoice::Auto);
        assert_eq!(TrackChoice::parse("3"), TrackChoice::Id(3));
        assert_eq!(TrackChoice::parse("yes"), TrackChoice::Auto);

        let playlist = r#"[
            {"filename": "C:\\Videa\\a.mkv", "id": 4},
            {"filename": "\\\\?\\C:\\Videa\\dlouhá\\b.mkv", "id": 7, "current": true, "playing": true},
            {"id": 8},
            {"filename": "https://example.com/c", "id": 9}
        ]"#;
        assert_eq!(
            playlist_of(playlist),
            Playlist {
                filenames: vec![
                    r"C:\Videa\a.mkv".to_owned(),
                    r"\\?\C:\Videa\dlouhá\b.mkv".to_owned(),
                    "https://example.com/c".to_owned(),
                ],
                current: Some(1),
                current_id: Some(7),
                playing: true,
            }
        );
        // An idle player, and what is not a playlist.
        for nothing in ["[]", "[{", r#"{"filename": "a"}"#] {
            assert_eq!(playlist_of(nothing), Playlist::default(), "{nothing}");
        }
        let ended = r#"[{"filename": "a.mkv", "id": 1}]"#;
        assert_eq!(playlist_of(ended).current, None);
        // A `playlist-next` mpv has not got to: b is current, a still plays.
        let switching = r#"[
            {"filename": "a.mkv", "id": 1, "playing": true},
            {"filename": "b.mkv", "id": 2, "current": true}
        ]"#;
        let switching = playlist_of(switching);
        assert_eq!(
            (switching.current, switching.current_id, switching.playing),
            (Some(1), Some(2), false)
        );

        let tracks = r#"[
            {"id": 1, "type": "video", "external": false},
            {"id": 2, "type": "sub", "external": true, "external-filename": "C:\\Titulky\\b.srt"},
            {"id": 1, "type": "sub", "external": false},
            {"id": 3, "type": "sub", "external": true, "external-filename": "edl://!no_clip;x"},
            {"id": 1, "type": "audio", "external": true, "external-filename": "C:\\Zvuk\\a.mka"},
            {"id": 4, "type": "sub", "external": true, "external-filename": "C:\\Titulky\\a.srt"},
            {"id": 0, "type": "sub", "external": true, "external-filename": "C:\\Titulky\\první.srt"}
        ]"#;
        assert_eq!(
            external_subs_of(tracks),
            [
                r"C:\Titulky\první.srt",
                r"C:\Titulky\b.srt",
                r"C:\Titulky\a.srt"
            ]
        );
        assert!(external_subs_of("[{").is_empty());
    }

    /// A restart while the entry another restart started is still loading takes what that one
    /// gave it. Any other entry that has not started to play has no known position (mpv says 0
    /// while it opens the file): none is given, and mpv starts it where it would.
    #[test]
    fn a_restart_while_the_restored_entry_loads_keeps_what_it_was_given() {
        let restored = Restored {
            entry: 3,
            state: ResumeState {
                entries: vec![entry("a.mkv", &[])],
                current: Some(0),
                position: Some(4.0),
                paused: true,
                tracks: ResumeTracks {
                    sid: TrackChoice::Id(2),
                    ..ResumeTracks::default()
                },
                external_subs: vec!["a.srt".to_owned()],
                ..ResumeState::default()
            },
        };
        // What mpv says while it opens the file: 0, its own choice of tracks, no subtitles yet.
        let loading = ResumeState {
            entries: vec![entry("a.mkv", &[])],
            current: Some(0),
            position: Some(0.0),
            paused: true,
            ..ResumeState::default()
        };

        let mut state = loading.clone();
        unsettled(&mut state, Some(3), Some(&restored));
        assert_eq!(state, restored.state);

        // Another entry (a new one has a new id), none current, or no restart before.
        let unknown = ResumeState {
            position: None,
            ..loading.clone()
        };
        for (entry, restored) in [
            (Some(4), Some(&restored)),
            (None, Some(&restored)),
            (Some(3), None),
        ] {
            let mut state = loading.clone();
            unsettled(&mut state, entry, restored);
            assert_eq!(state, unknown, "{entry:?}");
        }
        // A restart of an idle player has nothing to give.
        let idle = Restored {
            entry: 3,
            state: ResumeState::default(),
        };
        let mut state = loading.clone();
        unsettled(&mut state, Some(3), Some(&idle));
        assert_eq!(state, unknown);
    }

    // The tests below restart a real libmpv (vo=null, ao=null).

    /// `frames` of 64×36 video at 30 frames a second, as `dir\name`.
    fn video(dir: &Path, name: &str, frames: usize) -> PathBuf {
        let path = dir.join(name);
        mpv_ffi::testing::write_y4m(&path, 64, 36, frames).unwrap();
        path
    }

    fn filenames(mpv: &Mpv) -> Vec<String> {
        playlist_of(&mpv.get_string("playlist").unwrap()).filenames
    }

    fn near(mpv: &Mpv, seconds: f64, tolerance: f64) -> bool {
        mpv.get_f64("time-pos")
            .is_ok_and(|position| (position - seconds).abs() <= tolerance)
    }

    /// [a, b, c] of 10 s each, b paused at 4 s, the volume at 40 and muted: the new core has the
    /// same playlist, plays b, from 4 s, paused, as loud and as muted.
    #[test]
    fn restart_resumes_the_playlist_where_it_was() {
        let tmp = tempfile::tempdir().unwrap();
        let clips = ["a.y4m", "b.y4m", "c.y4m"].map(|name| video(tmp.path(), name, 300));
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        for clip in &clips {
            engine.command(&["loadfile", &clip.to_string_lossy(), "append"]);
        }
        engine.command(&["set", "pause", "yes"]);
        engine.command(&["set", "volume", "40"]);
        engine.command(&["set", "mute", "yes"]);
        engine.command(&["playlist-play-index", "1"]);
        eventually(&engine, "b has loaded", |mpv| {
            mpv.get_f64("duration").is_ok()
        });
        engine.command(&["seek", "4", "absolute"]);
        eventually(&engine, "b is at 4 s", |mpv| near(mpv, 4.0, 0.1));
        let before = engine.call(filenames);
        assert_eq!(before.len(), 3);

        assert_eq!(engine.restart(Restart::new(NoEvents)), Ok(()));

        eventually(&engine, "b is at 4 s in the new core", |mpv| {
            mpv.get_f64("duration").is_ok() && near(mpv, 4.0, 0.5)
        });
        assert_eq!(engine.call(filenames), before);
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-pos").unwrap()), 1);
        assert!(engine.call(|mpv| mpv.get_flag("pause").unwrap()));
        let path = clips[1].to_string_lossy().into_owned();
        assert_eq!(engine.call(|mpv| mpv.get_string("path").unwrap()), path);
        assert_eq!(engine.call(|mpv| mpv.get_f64("volume").unwrap()), 40.0);
        assert!(engine.call(|mpv| mpv.get_flag("mute").unwrap()));
    }

    /// With `keep-open` (Kaleido's mpv.conf) a clip played to its end stays loaded, paused on its
    /// last frame. The new core has it there too: the same entry, paused, at the end, not idle.
    #[test]
    fn restart_paused_at_the_end_resumes_there() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(paths.config_dir.join("mpv.conf"), "keep-open=yes\n").unwrap();
        let clip = clip(tmp.path(), 2);
        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        engine.command(&["loadfile", &clip.to_string_lossy()]);
        let at_the_end = |mpv: &Mpv| {
            mpv.get_flag("eof-reached").unwrap_or(false)
                && mpv.get_flag("pause").unwrap()
                && !mpv.get_flag("idle-active").unwrap()
        };
        eventually(
            &engine,
            "the clip ended, paused on its last frame",
            at_the_end,
        );
        let end = engine.call(|mpv| mpv.get_f64("time-pos").unwrap());
        assert!(end > 1.5, "the clip ended at {end}");

        assert_eq!(engine.restart(Restart::new(NoEvents)), Ok(()));

        eventually(&engine, "the new core is at the end, paused", move |mpv| {
            at_the_end(mpv) && near(mpv, end, 0.2)
        });
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-pos").unwrap()), 0);
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-count").unwrap()), 1);
        let path = clip.to_string_lossy().into_owned();
        assert_eq!(engine.call(|mpv| mpv.get_string("path").unwrap()), path);
    }

    const SRT: &str = "1\n00:00:00,000 --> 00:00:10,000\nTitulky\n\n";

    /// The subtitle files of the current entry's tracks, in the order of their ids.
    fn subtitle_files(mpv: &Mpv) -> Vec<String> {
        external_subs_of(&mpv.get_string("track-list").unwrap())
    }

    /// Two subtitle files added to a clip, one with `;` in its name, and the second selected: the
    /// new core has both, once each, and the second is selected.
    #[test]
    fn restart_keeps_external_subtitles_and_the_selected_track() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 10);
        let subs = ["titulky čeština.srt", "druhé; titulky.srt"].map(|name| {
            let path = tmp.path().join(name);
            fs::write(&path, SRT).unwrap();
            path.to_string_lossy().into_owned()
        });
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        engine.command(&["set", "pause", "yes"]);
        engine.command(&["loadfile", &clip.to_string_lossy()]);
        eventually(&engine, "the clip has loaded", |mpv| {
            mpv.get_f64("duration").is_ok()
        });
        for sub in &subs {
            engine.command(&["sub-add", sub]);
        }
        engine.command(&["set", "sid", "2"]);
        let wanted = subs.to_vec();
        eventually(&engine, "both subtitles are there, the second selected", {
            let wanted = wanted.clone();
            move |mpv| subtitle_files(mpv) == wanted && mpv.get_string("sid").unwrap() == "2"
        });

        assert_eq!(engine.restart(Restart::new(NoEvents)), Ok(()));

        eventually(&engine, "both subtitles are back, the second selected", {
            move |mpv| {
                mpv.get_f64("duration").is_ok()
                    && subtitle_files(mpv) == wanted
                    && mpv.get_string("sid").is_ok_and(|sid| sid == "2")
            }
        });
    }

    /// Nothing open: the new core is idle too, with an empty playlist, and starts no file.
    #[test]
    fn restart_of_an_idle_player_stays_idle() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        let events = Recorded::default();

        assert_eq!(engine.restart(Restart::new(events.clone())), Ok(()));

        eventually(&engine, "the new core is idle", |mpv| {
            mpv.get_flag("idle-active").unwrap()
        });
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-count").unwrap()), 0);
        // Time for a file to start, if one were to.
        thread::sleep(Duration::from_millis(300));
        let events = events.events();
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Event::StartFile | Event::FileLoaded)),
            "{events:#?}"
        );
    }
}
