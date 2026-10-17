//! The commands the UI may give the player (spec 4.2, 4.4), and what each one becomes in mpv.
//! The UI cannot send mpv an arbitrary command: every free value is checked here.

use std::fmt;
use std::ops::RangeInclusive;

use serde::Deserialize;

use super::{Engine, Request};

/// How `Seek::target` is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SeekMode {
    Absolute,
    Relative,
    AbsolutePercent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Audio,
    Sub,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotMode {
    Subtitles,
    Video,
    Window,
    EachFrame,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlayerCommand {
    TogglePause,
    SetPause {
        paused: bool,
    },
    Seek {
        target: f64,
        mode: SeekMode,
        /// A precise seek instead of one to the nearest keyframe.
        exact: bool,
    },
    SetVolume {
        volume: f64,
    },
    SetMute {
        muted: bool,
    },
    SetSpeed {
        speed: f64,
    },
    /// `id: None` turns the track kind off.
    SelectTrack {
        kind: TrackKind,
        id: Option<i64>,
    },
    SetSubDelay {
        seconds: f64,
    },
    SetSubScale {
        scale: f64,
    },
    SetAudioDelay {
        seconds: f64,
    },
    SetSubMargin {
        margin: i64,
    },
    PlaylistNext,
    PlaylistPrev,
    PlaylistPlay {
        index: u32,
    },
    PlaylistRemove {
        index: u32,
    },
    /// After the move the entry is at index `to`.
    PlaylistMove {
        from: u32,
        to: u32,
    },
    Screenshot {
        mode: ScreenshotMode,
    },
    SetFullscreen {
        on: bool,
    },
    SetOntop {
        on: bool,
    },
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    /// The value of `field` is not a finite number or lies outside what the field allows.
    Invalid { field: &'static str },
    /// Not an mpv command by itself; the glass controller runs it (it has to take the glass
    /// out of the picture first).
    Routed,
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CommandError::Invalid { field } => write!(f, "invalid value for {field}"),
            CommandError::Routed => f.write_str("the command is handled outside mpv"),
        }
    }
}

impl std::error::Error for CommandError {}

/// Any finite number.
const ANY: RangeInclusive<f64> = f64::MIN..=f64::MAX;
/// Volume in percent; mpv clamps it to `volume-max` anyway.
const VOLUME: RangeInclusive<f64> = 0.0..=1000.0;
const SPEED: RangeInclusive<f64> = 0.01..=100.0;
const SUB_SCALE: RangeInclusive<f64> = 0.1..=10.0;
/// Subtitle and audio delay in seconds, either way.
const DELAY: RangeInclusive<f64> = -600.0..=600.0;
/// `sub-margin-y` in pixels.
const SUB_MARGIN: RangeInclusive<i64> = 0..=720;

/// The mpv commands (each a list of arguments) that carry out `cmd`, in order. Every number is
/// checked first, so that nothing the UI sends can reach mpv unchecked.
pub fn to_mpv(cmd: &PlayerCommand) -> Result<Vec<Vec<String>>, CommandError> {
    use PlayerCommand::*;
    Ok(match cmd {
        TogglePause => command(["cycle", "pause"]),
        SetPause { paused } => set("pause", yes_no(*paused)),
        Seek {
            target,
            mode,
            exact,
        } => {
            let mode = match mode {
                SeekMode::Absolute => "absolute",
                SeekMode::Relative => "relative",
                SeekMode::AbsolutePercent => "absolute-percent",
            };
            let precision = if *exact { "exact" } else { "keyframes" };
            command([
                "seek",
                &number("target", *target, ANY)?,
                &format!("{mode}+{precision}"),
            ])
        }
        SetVolume { volume } => set("volume", &number("volume", *volume, VOLUME)?),
        SetMute { muted } => set("mute", yes_no(*muted)),
        SetSpeed { speed } => set("speed", &number("speed", *speed, SPEED)?),
        SelectTrack { kind, id } => {
            let property = match kind {
                TrackKind::Audio => "aid",
                TrackKind::Sub => "sid",
                TrackKind::Video => "vid",
            };
            match id {
                None => set(property, "no"),
                // Track ids start at 1; 0 and below are not tracks.
                Some(id) if *id >= 1 => set(property, &id.to_string()),
                Some(_) => return Err(CommandError::Invalid { field: "id" }),
            }
        }
        SetSubDelay { seconds } => set("sub-delay", &number("seconds", *seconds, DELAY)?),
        SetSubScale { scale } => set("sub-scale", &number("scale", *scale, SUB_SCALE)?),
        SetAudioDelay { seconds } => set("audio-delay", &number("seconds", *seconds, DELAY)?),
        SetSubMargin { margin } if SUB_MARGIN.contains(margin) => {
            set("sub-margin-y", &margin.to_string())
        }
        SetSubMargin { .. } => return Err(CommandError::Invalid { field: "margin" }),
        PlaylistNext => command(["playlist-next"]),
        PlaylistPrev => command(["playlist-prev"]),
        PlaylistPlay { index } => command(["playlist-play-index", &index.to_string()]),
        PlaylistRemove { index } => command(["playlist-remove", &index.to_string()]),
        PlaylistMove { from, to } if from == to => Vec::new(),
        PlaylistMove { from, to } => {
            // mpv's second index names the entry that takes the place of the moved one, so
            // moving down it is the entry after the target.
            let target = u64::from(*to) + u64::from(from < to);
            command(["playlist-move", &from.to_string(), &target.to_string()])
        }
        Screenshot { .. } => return Err(CommandError::Routed),
        SetFullscreen { on } => set("fullscreen", yes_no(*on)),
        SetOntop { on } => set("ontop", yes_no(*on)),
        Stop => command(["stop"]),
    })
}

/// Checks `cmd` and queues its mpv commands on the engine, which runs them in order. Nothing is
/// queued for an invalid command, and nothing waits for mpv.
pub fn send(engine: &Engine, cmd: &PlayerCommand) -> Result<(), CommandError> {
    for args in to_mpv(cmd)? {
        engine.request(Request::Command(args));
    }
    Ok(())
}

fn command<const N: usize>(args: [&str; N]) -> Vec<Vec<String>> {
    vec![args.iter().map(|&arg| arg.to_owned()).collect()]
}

fn set(property: &str, value: &str) -> Vec<Vec<String>> {
    command(["set", property, value])
}

fn yes_no(on: bool) -> &'static str {
    if on { "yes" } else { "no" }
}

/// `value` as mpv reads it, if it is a number within `range` (NaN and infinity never are).
fn number(
    field: &'static str,
    value: f64,
    range: RangeInclusive<f64>,
) -> Result<String, CommandError> {
    if value.is_finite() && range.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(CommandError::Invalid { field })
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::*;
    use crate::player::load::{LoadMode, open_sources};
    use crate::player::testing::{NoEvents, eventually, headless, temp_paths};

    fn mpv(cmd: &PlayerCommand) -> Vec<Vec<String>> {
        to_mpv(cmd).unwrap()
    }

    fn one(args: &[&str]) -> Vec<Vec<String>> {
        vec![args.iter().map(|&arg| arg.to_owned()).collect()]
    }

    #[test]
    fn seek_modes_map_to_mpv_flags() {
        let seek = |target, mode, exact| PlayerCommand::Seek {
            target,
            mode,
            exact,
        };
        assert_eq!(
            mpv(&seek(10.0, SeekMode::Relative, true)),
            one(&["seek", "10", "relative+exact"])
        );
        assert_eq!(
            mpv(&seek(-5.5, SeekMode::Relative, false)),
            one(&["seek", "-5.5", "relative+keyframes"])
        );
        assert_eq!(
            mpv(&seek(42.0, SeekMode::Absolute, false)),
            one(&["seek", "42", "absolute+keyframes"])
        );
        assert_eq!(
            mpv(&seek(42.25, SeekMode::Absolute, true)),
            one(&["seek", "42.25", "absolute+exact"])
        );
        assert_eq!(
            mpv(&seek(50.0, SeekMode::AbsolutePercent, false)),
            one(&["seek", "50", "absolute-percent+keyframes"])
        );
    }

    #[test]
    fn simple_commands_map_to_mpv() {
        assert_eq!(mpv(&PlayerCommand::TogglePause), one(&["cycle", "pause"]));
        assert_eq!(
            mpv(&PlayerCommand::SetPause { paused: true }),
            one(&["set", "pause", "yes"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetMute { muted: false }),
            one(&["set", "mute", "no"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetVolume { volume: 80.0 }),
            one(&["set", "volume", "80"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetSpeed { speed: 1.25 }),
            one(&["set", "speed", "1.25"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetSubDelay { seconds: -0.5 }),
            one(&["set", "sub-delay", "-0.5"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetSubScale { scale: 1.5 }),
            one(&["set", "sub-scale", "1.5"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetAudioDelay { seconds: 0.25 }),
            one(&["set", "audio-delay", "0.25"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetSubMargin { margin: 40 }),
            one(&["set", "sub-margin-y", "40"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetFullscreen { on: true }),
            one(&["set", "fullscreen", "yes"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SetOntop { on: false }),
            one(&["set", "ontop", "no"])
        );
        assert_eq!(mpv(&PlayerCommand::Stop), one(&["stop"]));
        assert_eq!(mpv(&PlayerCommand::PlaylistNext), one(&["playlist-next"]));
        assert_eq!(mpv(&PlayerCommand::PlaylistPrev), one(&["playlist-prev"]));
        assert_eq!(
            mpv(&PlayerCommand::PlaylistPlay { index: 3 }),
            one(&["playlist-play-index", "3"])
        );
        assert_eq!(
            mpv(&PlayerCommand::PlaylistRemove { index: 1 }),
            one(&["playlist-remove", "1"])
        );
        assert_eq!(
            mpv(&PlayerCommand::SelectTrack {
                kind: TrackKind::Sub,
                id: Some(2)
            }),
            one(&["set", "sid", "2"])
        );
    }

    #[test]
    fn invalid_numbers_are_rejected() {
        use PlayerCommand::*;
        let invalid = |cmd: PlayerCommand| {
            assert!(
                matches!(to_mpv(&cmd), Err(CommandError::Invalid { .. })),
                "{cmd:?} was accepted"
            );
        };
        let valid = |cmd: PlayerCommand| {
            assert!(to_mpv(&cmd).is_ok(), "{cmd:?} was rejected");
        };
        let seek = |target| Seek {
            target,
            mode: SeekMode::Absolute,
            exact: false,
        };
        invalid(seek(f64::NAN));
        invalid(seek(f64::INFINITY));
        invalid(seek(f64::NEG_INFINITY));
        valid(seek(0.0));

        invalid(SetVolume { volume: f64::NAN });
        invalid(SetVolume { volume: 5000.0 });
        invalid(SetVolume { volume: 1000.5 });
        invalid(SetVolume { volume: -1.0 });
        valid(SetVolume { volume: 0.0 });
        valid(SetVolume { volume: 1000.0 });

        invalid(SetSpeed { speed: 0.0 });
        invalid(SetSpeed { speed: 0.009 });
        invalid(SetSpeed { speed: 100.5 });
        invalid(SetSpeed {
            speed: f64::INFINITY,
        });
        valid(SetSpeed { speed: 0.01 });
        valid(SetSpeed { speed: 100.0 });

        invalid(SetSubScale { scale: 0.0 });
        invalid(SetSubScale { scale: 10.5 });
        invalid(SetSubScale { scale: f64::NAN });
        valid(SetSubScale { scale: 0.1 });
        valid(SetSubScale { scale: 10.0 });

        for seconds in [600.5, -600.5, f64::NAN, f64::INFINITY] {
            invalid(SetSubDelay { seconds });
            invalid(SetAudioDelay { seconds });
        }
        for seconds in [600.0, -600.0, 0.0] {
            valid(SetSubDelay { seconds });
            valid(SetAudioDelay { seconds });
        }

        invalid(SetSubMargin { margin: -1 });
        invalid(SetSubMargin { margin: 721 });
        valid(SetSubMargin { margin: 0 });
        valid(SetSubMargin { margin: 720 });

        invalid(SelectTrack {
            kind: TrackKind::Audio,
            id: Some(0),
        });
        invalid(SelectTrack {
            kind: TrackKind::Audio,
            id: Some(-3),
        });
    }

    #[test]
    fn track_off_maps_to_no() {
        for (kind, property) in [
            (TrackKind::Audio, "aid"),
            (TrackKind::Sub, "sid"),
            (TrackKind::Video, "vid"),
        ] {
            assert_eq!(
                mpv(&PlayerCommand::SelectTrack { kind, id: None }),
                one(&["set", property, "no"])
            );
        }
    }

    #[test]
    fn screenshots_are_routed_not_sent_to_mpv() {
        assert_eq!(
            to_mpv(&PlayerCommand::Screenshot {
                mode: ScreenshotMode::Video
            }),
            Err(CommandError::Routed)
        );
    }

    /// `PlaylistMove { from, to }` leaves the entry at `to`; mpv's second index names the entry
    /// to take the place of, which when moving down is the one after the target.
    #[test]
    fn playlist_move_translates_to_mpv_indexes() {
        let mv = |from, to| mpv(&PlayerCommand::PlaylistMove { from, to });
        assert_eq!(mv(0, 2), one(&["playlist-move", "0", "3"]));
        assert_eq!(mv(1, 2), one(&["playlist-move", "1", "3"]));
        assert_eq!(mv(2, 0), one(&["playlist-move", "2", "0"]));
        assert_eq!(mv(3, 1), one(&["playlist-move", "3", "1"]));
        assert_eq!(mv(2, 2), Vec::<Vec<String>>::new(), "nothing to move");
        assert_eq!(
            mv(0, u32::MAX),
            one(&["playlist-move", "0", "4294967296"]),
            "no overflow"
        );
    }

    /// The UI's JSON (the names Task 13's types repeat).
    #[test]
    fn commands_come_from_the_ui_as_tagged_camel_case_json() {
        let parse = |value| serde_json::from_value::<PlayerCommand>(value).unwrap();
        assert_eq!(
            parse(json!({"type": "togglePause"})),
            PlayerCommand::TogglePause
        );
        assert_eq!(
            parse(
                json!({"type": "seek", "target": 12.5, "mode": "absolutePercent", "exact": true})
            ),
            PlayerCommand::Seek {
                target: 12.5,
                mode: SeekMode::AbsolutePercent,
                exact: true
            }
        );
        assert_eq!(
            parse(json!({"type": "selectTrack", "kind": "sub", "id": null})),
            PlayerCommand::SelectTrack {
                kind: TrackKind::Sub,
                id: None
            }
        );
        assert_eq!(
            parse(json!({"type": "screenshot", "mode": "eachFrame"})),
            PlayerCommand::Screenshot {
                mode: ScreenshotMode::EachFrame
            }
        );
        // A name that is not a command (mpv's own `run`, say) is no command.
        assert!(
            serde_json::from_value::<PlayerCommand>(json!({"type": "run", "command": "calc"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<PlayerCommand>(json!({"type": "playlistPlay", "index": -1}))
                .is_err()
        );
    }

    // The tests below run the commands in a real libmpv (vo=null, ao=null).

    /// An engine playing the playlist [a, b, c] of 10 s clips.
    fn engine_playing_abc(root: &Path) -> Engine {
        let engine = Engine::start(headless(temp_paths(root)), NoEvents).unwrap();
        let raw: Vec<String> = ["a", "b", "c"]
            .into_iter()
            .map(|name| {
                let path = root.join(format!("{name}.y4m"));
                mpv_ffi::testing::write_y4m(&path, 64, 36, 300).unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();
        open_sources(&engine, &raw, LoadMode::Replace, root).unwrap();
        engine
    }

    /// The file names (without extension) in mpv's playlist, in order.
    fn playlist(engine: &Engine) -> Vec<String> {
        engine.call(|mpv| {
            let playlist: serde_json::Value =
                serde_json::from_str(&mpv.get_string("playlist").unwrap()).unwrap();
            playlist
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    let filename = entry["filename"].as_str().unwrap();
                    Path::new(filename)
                        .file_stem()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect()
        })
    }

    /// [a, b, c] and `Move { from: 0, to: 2 }` give [b, c, a] (spec 4.4).
    #[test]
    fn playlist_move_matches_spec_semantics() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = engine_playing_abc(tmp.path());
        let mv = |from, to| send(&engine, &PlayerCommand::PlaylistMove { from, to }).unwrap();

        assert_eq!(playlist(&engine), ["a", "b", "c"]);
        mv(0, 2);
        assert_eq!(playlist(&engine), ["b", "c", "a"]);
        mv(2, 0);
        assert_eq!(playlist(&engine), ["a", "b", "c"]);
        mv(0, 1);
        assert_eq!(playlist(&engine), ["b", "a", "c"]);
        mv(1, 1);
        assert_eq!(playlist(&engine), ["b", "a", "c"]);
        mv(2, 1);
        assert_eq!(playlist(&engine), ["b", "c", "a"]);
    }

    /// Every command name and flag is one this mpv understands, and does what it says.
    #[test]
    fn commands_take_effect_in_mpv() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = engine_playing_abc(tmp.path());
        let run = |cmd| send(&engine, &cmd).unwrap();
        let close = |actual: f64, wanted: f64| (actual - wanted).abs() < 1e-6;
        // A seek needs a file that has loaded; a frame is 33 ms.
        let near = |actual: f64, wanted: f64| (actual - wanted).abs() < 0.1;
        eventually(&engine, "a is playing", |mpv| {
            mpv.get_f64("time-pos").is_ok()
        });

        run(PlayerCommand::SetVolume { volume: 80.0 });
        run(PlayerCommand::SetMute { muted: true });
        run(PlayerCommand::SetSpeed { speed: 2.0 });
        run(PlayerCommand::SetSubDelay { seconds: 0.5 });
        run(PlayerCommand::SetAudioDelay { seconds: -0.25 });
        run(PlayerCommand::SetSubScale { scale: 1.5 });
        run(PlayerCommand::SetSubMargin { margin: 40 });
        eventually(&engine, "the settings are applied", move |mpv| {
            close(mpv.get_f64("volume").unwrap(), 80.0)
                && mpv.get_flag("mute").unwrap()
                && close(mpv.get_f64("speed").unwrap(), 2.0)
                && close(mpv.get_f64("sub-delay").unwrap(), 0.5)
                && close(mpv.get_f64("audio-delay").unwrap(), -0.25)
                && close(mpv.get_f64("sub-scale").unwrap(), 1.5)
                && mpv.get_i64("sub-margin-y").unwrap() == 40
        });

        run(PlayerCommand::SetPause { paused: true });
        run(PlayerCommand::Seek {
            target: 5.0,
            mode: SeekMode::Absolute,
            exact: true,
        });
        eventually(&engine, "paused at 5 s", move |mpv| {
            mpv.get_flag("pause").unwrap()
                && mpv.get_f64("time-pos").is_ok_and(|time| near(time, 5.0))
        });
        run(PlayerCommand::Seek {
            target: 2.0,
            mode: SeekMode::Relative,
            exact: true,
        });
        eventually(&engine, "at 7 s", move |mpv| {
            mpv.get_f64("time-pos").is_ok_and(|time| near(time, 7.0))
        });
        run(PlayerCommand::Seek {
            target: 10.0,
            mode: SeekMode::AbsolutePercent,
            exact: true,
        });
        eventually(&engine, "at 10 %", move |mpv| {
            mpv.get_f64("percent-pos")
                .is_ok_and(|percent| near(percent, 10.0))
        });
        run(PlayerCommand::Seek {
            target: 3.0,
            mode: SeekMode::Absolute,
            exact: false,
        });
        eventually(&engine, "at 3 s", move |mpv| {
            mpv.get_f64("time-pos").is_ok_and(|time| near(time, 3.0))
        });
        run(PlayerCommand::TogglePause);
        eventually(&engine, "playing", |mpv| !mpv.get_flag("pause").unwrap());

        run(PlayerCommand::SelectTrack {
            kind: TrackKind::Video,
            id: None,
        });
        eventually(&engine, "video off", |mpv| {
            mpv.get_string("vid").is_ok_and(|vid| vid == "no")
        });
        run(PlayerCommand::SelectTrack {
            kind: TrackKind::Video,
            id: Some(1),
        });
        eventually(&engine, "video 1", |mpv| mpv.get_i64("vid").ok() == Some(1));

        run(PlayerCommand::PlaylistPlay { index: 2 });
        eventually(&engine, "playing c", |mpv| {
            mpv.get_i64("playlist-pos").ok() == Some(2)
        });
        run(PlayerCommand::PlaylistPrev);
        eventually(&engine, "playing b", |mpv| {
            mpv.get_i64("playlist-pos").ok() == Some(1)
        });
        run(PlayerCommand::PlaylistNext);
        eventually(&engine, "playing c again", |mpv| {
            mpv.get_i64("playlist-pos").ok() == Some(2)
        });
        run(PlayerCommand::PlaylistRemove { index: 0 });
        assert_eq!(playlist(&engine), ["b", "c"]);

        run(PlayerCommand::SetFullscreen { on: true });
        run(PlayerCommand::SetOntop { on: true });
        eventually(&engine, "fullscreen and on top", |mpv| {
            mpv.get_flag("fullscreen").unwrap() && mpv.get_flag("ontop").unwrap()
        });

        run(PlayerCommand::Stop);
        eventually(&engine, "stopped", |mpv| {
            mpv.get_flag("idle-active").unwrap()
        });
    }

    /// A command that is refused leaves mpv alone.
    #[test]
    fn a_refused_command_queues_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = Engine::start(headless(temp_paths(tmp.path())), NoEvents).unwrap();
        let before = engine.call(|mpv| mpv.get_f64("volume").unwrap());

        assert_eq!(
            send(&engine, &PlayerCommand::SetVolume { volume: 5000.0 }),
            Err(CommandError::Invalid { field: "volume" })
        );
        assert_eq!(
            send(
                &engine,
                &PlayerCommand::Screenshot {
                    mode: ScreenshotMode::Video
                }
            ),
            Err(CommandError::Routed)
        );
        assert_eq!(engine.call(|mpv| mpv.get_f64("volume").unwrap()), before);
    }
}
