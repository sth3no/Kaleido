//! What mpv's own `ytdl_hook` gets from Kaleido (spec 5.2, 9.4; plan decisions 2, 13, 20): the
//! managed yt-dlp, Deno for YouTube's challenges and the cookies of a browser. Both go to the core
//! as `change-list` commands that touch one key each, so the user's other values stay:
//!
//! - `script-opts`: `ytdl_hook-ytdl_path`, only the managed `yt-dlp.exe`, never one from `PATH`
//!   (a non-empty `ytdl_path` replaces the hook's own search). The hook reads its options at run
//!   time (`read_options` with a callback, `player/lua/ytdl_hook.lua` l. 23) and then looks for
//!   yt-dlp again, so this beats a `script-opts` of the user's mpv.conf too;
//! - `ytdl-raw-options`: `js-runtimes` and `cookies-from-browser`, Kaleido's keys only; the hook
//!   passes every pair to yt-dlp as `--<key> <value>`.
//!
//! `append` takes one key and the rest of the text as its value without escapes, so a comma or a
//! colon in a path is fine.
//!
//! The commands go to every core right after it starts, before anything the UI sends, and to the
//! running core whenever they change (see [`Service`](super::Service)).

use std::path::Path;

use super::ToolId;
use crate::paths::AppPaths;

/// `ytdl_hook`'s option for its yt-dlp, as `script-opts` names it.
pub const YTDL_PATH_KEY: &str = "ytdl_hook-ytdl_path";
/// mpv's option whose pairs `ytdl_hook` passes on to yt-dlp.
pub const RAW_OPTIONS: &str = "ytdl-raw-options";
/// The keys of [`RAW_OPTIONS`] that are Kaleido's (plan decision 13): a user's own value for them
/// is replaced or removed, the user's other keys are never touched.
pub const KALEIDO_RAW_KEYS: [&str; 2] = ["js-runtimes", "cookies-from-browser"];
/// What follows the path while the file is not there: the list of the one path. `ytdl_hook`
/// splits `ytdl_path` at `;` on Windows (`ytdl_hook.lua`, l. 954).
const MISSING: &str = ";";
/// What follows the path to make the hook look again ([`hook_commands_for_core`]): the same list.
const AGAIN: &str = ";;";

/// `ytdl_hook`'s yt-dlp:
/// `change-list script-opts append ytdl_hook-ytdl_path=<tools_dir>\yt-dlp.exe`.
///
/// While the file is not there, the path is written with a separator after it (`…\yt-dlp.exe;`),
/// a list of the same one path to the hook. The hook looks for yt-dlp once and keeps what it found,
/// a failure too, until its options change (`ytdl.searched`, l. 951–989): a link opened while
/// yt-dlp was still being downloaded would leave it "not found" for as long as the core runs. The
/// value that changes once the file is there makes it look again. (A `;` in the path itself would
/// split it, by the hook's own rule; the user's folder name is the only place one could come from.)
pub fn hook_commands(paths: &AppPaths) -> Vec<Vec<String>> {
    let exe = paths.tools_dir.join(ToolId::YtDlp.exe_name());
    let spelled = if exe.is_file() { "" } else { MISSING };
    vec![hook_command(&exe, spelled)]
}

/// [`hook_commands`] for a core that runs and has `current` (the tools' options it was given), as
/// a check of the tools left them:
/// - the file is not there: `…\yt-dlp.exe;`, as [`hook_commands`];
/// - it was put in place since the core last heard (`put_in_place`): the path spelled unlike the
///   core's value, `…\yt-dlp.exe` or `…\yt-dlp.exe;;` (the same one path to the hook). The hook
///   may keep a search that failed while the file was gone (the core started, or a link was
///   opened, in between), and only a value it has not seen makes it look again. One change, not
///   two in a row: mpv may hand a script two quick changes of a property as one, the last, which
///   it has seen already;
/// - otherwise: the spelling the core has, or the plain path.
pub fn hook_commands_for_core(
    paths: &AppPaths,
    current: &[Vec<String>],
    put_in_place: bool,
) -> Vec<Vec<String>> {
    let exe = paths.tools_dir.join(ToolId::YtDlp.exe_name());
    if !exe.is_file() {
        return vec![hook_command(&exe, MISSING)];
    }
    let plain = hook_command(&exe, "");
    let again = hook_command(&exe, AGAIN);
    let chosen = match (
        put_in_place,
        current.contains(&plain),
        current.contains(&again),
    ) {
        (true, true, _) => again,
        (true, false, _) | (false, _, false) => plain,
        (false, _, true) => again,
    };
    vec![chosen]
}

/// `change-list script-opts append ytdl_hook-ytdl_path=<exe><spelled>`.
fn hook_command(exe: &Path, spelled: &str) -> Vec<String> {
    change(
        "script-opts",
        "append",
        &format!("{YTDL_PATH_KEY}={}{spelled}", exe.to_string_lossy()),
    )
}

/// Kaleido's keys of `ytdl-raw-options`: `js-runtimes=deno:<path>` with a Deno yt-dlp can use
/// (plan decision 20; yt-dlp would find the `deno.exe` beside it too, Kaleido says it anyway, spec
/// 5.2), `cookies-from-browser=<spec>` with the browser the user chose (`BROWSER[:PROFILE]`, plan
/// decision 13); each one taken out (`remove`) without.
pub fn raw_options(deno: Option<&Path>, cookies: Option<&str>) -> Vec<Vec<String>> {
    let [js_runtimes, cookies_from_browser] = KALEIDO_RAW_KEYS;
    vec![
        match deno {
            Some(deno) => change(
                RAW_OPTIONS,
                "append",
                &format!("{js_runtimes}=deno:{}", deno.to_string_lossy()),
            ),
            None => change(RAW_OPTIONS, "remove", js_runtimes),
        },
        match cookies {
            Some(spec) => change(
                RAW_OPTIONS,
                "append",
                &format!("{cookies_from_browser}={spec}"),
            ),
            None => change(RAW_OPTIONS, "remove", cookies_from_browser),
        },
    ]
}

fn change(option: &str, operation: &str, value: &str) -> Vec<String> {
    ["change-list", option, operation, value]
        .map(str::to_owned)
        .to_vec()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    use mpv_ffi::Event;

    use super::*;
    use crate::player::Engine;
    use crate::player::testing::{NoEvents, Recorded, headless, temp_paths};

    fn args(args: &[&str]) -> Vec<String> {
        args.iter().map(|&arg| arg.to_owned()).collect()
    }

    #[test]
    fn hook_commands_name_only_the_managed_yt_dlp() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let exe = paths.tools_dir.join("yt-dlp.exe");
        let ours = exe.to_string_lossy().into_owned();

        // Not there yet: the same one path, spelled as a list.
        assert_eq!(
            hook_commands(&paths),
            [args(&[
                "change-list",
                "script-opts",
                "append",
                &format!("ytdl_hook-ytdl_path={ours};")
            ])]
        );
        fs::write(&exe, b"yt-dlp").unwrap();
        assert_eq!(
            hook_commands(&paths),
            [args(&[
                "change-list",
                "script-opts",
                "append",
                &format!("ytdl_hook-ytdl_path={ours}")
            ])]
        );
        assert!(ours.ends_with(r"\Kaleido\tools\yt-dlp.exe"), "{ours}");
    }

    /// What a running core gets after a check, from what it has.
    #[test]
    fn the_hook_hears_of_a_yt_dlp_put_in_place_anew() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let exe = paths.tools_dir.join("yt-dlp.exe");
        let ours = exe.to_string_lossy().into_owned();
        let spelled = |suffix: &str| {
            args(&[
                "change-list",
                "script-opts",
                "append",
                &format!("ytdl_hook-ytdl_path={ours}{suffix}"),
            ])
        };
        let (plain, missing, again) = (spelled(""), spelled(";"), spelled(";;"));
        let raw = args(&["change-list", "ytdl-raw-options", "remove", "js-runtimes"]);

        // Not there: missing, whatever came before.
        for put_in_place in [false, true] {
            for current in [&plain, &missing, &again] {
                assert_eq!(
                    hook_commands_for_core(&paths, &[current.clone(), raw.clone()], put_in_place),
                    vec![missing.clone()]
                );
            }
        }

        fs::write(&exe, b"yt-dlp").unwrap();
        for (current, put_in_place, chosen) in [
            // Put in place anew: never the value the core has.
            (&plain, true, &again),
            (&again, true, &plain),
            (&missing, true, &plain),
            // Nothing new: what the core has, or the plain path.
            (&plain, false, &plain),
            (&again, false, &again),
            (&missing, false, &plain),
        ] {
            assert_eq!(
                hook_commands_for_core(&paths, &[raw.clone(), current.clone()], put_in_place),
                vec![chosen.clone()],
                "{current:?} {put_in_place}"
            );
        }
        // A core that has none of them (it was given nothing yet).
        assert_eq!(
            hook_commands_for_core(&paths, &[], true),
            vec![plain.clone()]
        );
        assert_eq!(hook_commands(&paths), [plain]);
    }

    #[test]
    fn raw_options_add_and_remove_only_kaleidos_keys() {
        let deno = PathBuf::from(r"C:\Users\Jiří, Novák\AppData\Local\Kaleido\tools\deno.exe");

        assert_eq!(
            raw_options(Some(&deno), Some("firefox:default-release")),
            [
                args(&[
                    "change-list",
                    "ytdl-raw-options",
                    "append",
                    r"js-runtimes=deno:C:\Users\Jiří, Novák\AppData\Local\Kaleido\tools\deno.exe"
                ]),
                args(&[
                    "change-list",
                    "ytdl-raw-options",
                    "append",
                    "cookies-from-browser=firefox:default-release"
                ]),
            ]
        );
        assert_eq!(
            raw_options(None, None),
            [
                args(&["change-list", "ytdl-raw-options", "remove", "js-runtimes"]),
                args(&[
                    "change-list",
                    "ytdl-raw-options",
                    "remove",
                    "cookies-from-browser"
                ]),
            ]
        );
        assert_eq!(
            raw_options(Some(&deno), None)[1],
            args(&[
                "change-list",
                "ytdl-raw-options",
                "remove",
                "cookies-from-browser"
            ])
        );
        assert_eq!(
            raw_options(None, Some("chrome"))[0],
            args(&["change-list", "ytdl-raw-options", "remove", "js-runtimes"])
        );
        // Never the whole option (`set`, `clr`, `add` of a list): one key of Kaleido's at a time.
        for deno in [None, Some(deno.as_path())] {
            for cookies in [None, Some("edge")] {
                for command in raw_options(deno, cookies) {
                    let [change_list, option, operation, value] = command.as_slice() else {
                        panic!("{command:?}");
                    };
                    assert_eq!(
                        (change_list.as_str(), option.as_str()),
                        ("change-list", RAW_OPTIONS)
                    );
                    let key = match operation.as_str() {
                        "append" => value.split_once('=').unwrap().0,
                        "remove" => value.as_str(),
                        other => panic!("{other}"),
                    };
                    assert!(KALEIDO_RAW_KEYS.contains(&key), "{command:?}");
                }
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // A real libmpv

    /// Runs `commands` on the core, each one checked.
    fn give(engine: &Engine, commands: Vec<Vec<String>>) {
        engine.call(move |mpv| {
            for command in &commands {
                let args: Vec<&str> = command.iter().map(String::as_str).collect();
                if let Err(error) = mpv.command(&args) {
                    panic!("{args:?}: {error}");
                }
            }
        });
    }

    fn property(engine: &Engine, name: &'static str) -> String {
        engine.call(move |mpv| mpv.get_string(name).unwrap_or_default())
    }

    /// The last value of `key` in a key/value list as mpv prints it (`a=1,b=2`); none of the values
    /// here has a comma.
    fn value_of(list: &str, key: &str) -> Option<String> {
        list.split(',')
            .filter_map(|pair| pair.split_once('='))
            .filter(|(name, _)| *name == key)
            .map(|(_, value)| value.to_owned())
            .next_back()
    }

    /// The log lines of `ytdl_hook` among `events` that contain `text`.
    fn hook_lines(events: &[Event], text: &str) -> usize {
        events
            .iter()
            .filter(|event| {
                matches!(event, Event::LogMessage { prefix, text: line, .. }
                    if prefix == "ytdl_hook" && line.contains(text))
            })
            .count()
    }

    /// A YouTube link, through the hook only: with `ytdl://` in front the hook takes it at once,
    /// and mpv cannot open it itself after the hook failed, so nothing goes to the network.
    const LINK: &str = "ytdl://https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    const NOT_FOUND: &str = "youtube-dl failed: not found or not enough permissions";
    const LOAD_TIMEOUT: Duration = Duration::from_secs(20);

    /// Needs a real libmpv.
    #[test]
    fn the_managed_yt_dlp_path_wins_over_mpv_conf() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "script-opts=ytdl_hook-ytdl_path=C:/jiny.exe,myscript-key=1\n",
        )
        .unwrap();
        // A file in its place, so that the value is the plain path.
        let exe = paths.tools_dir.join("yt-dlp.exe");
        fs::write(&exe, b"yt-dlp").unwrap();
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let before = property(&engine, "script-opts");
        assert_eq!(
            value_of(&before, YTDL_PATH_KEY).as_deref(),
            Some("C:/jiny.exe")
        );

        give(&engine, hook_commands(&paths));

        let after = property(&engine, "script-opts");
        assert_eq!(
            value_of(&after, YTDL_PATH_KEY),
            Some(exe.to_string_lossy().into_owned()),
            "{after}"
        );
        assert!(!after.contains("C:/jiny.exe"), "{after}");
        // The user's other script options stay.
        assert_eq!(value_of(&after, "myscript-key").as_deref(), Some("1"));
        // Again: still one value for the key.
        give(&engine, hook_commands(&paths));
        let again = property(&engine, "script-opts");
        assert_eq!(again.matches(YTDL_PATH_KEY).count(), 1, "{again}");
    }

    /// Needs a real libmpv. yt-dlp in `PATH` or not: the managed path replaces the hook's own
    /// search, and the process is never started, so nothing goes to the network.
    #[test]
    fn a_missing_managed_yt_dlp_is_reported_by_the_hook() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        assert!(!paths.tools_dir.join("yt-dlp.exe").exists());
        let events = Recorded::default();
        let engine = Engine::start(headless(paths.clone()), events.clone()).unwrap();
        engine.call(|mpv| mpv.request_log_messages("warn").unwrap());

        give(&engine, hook_commands(&paths));
        engine.command(&["loadfile", LINK]);

        events.wait_until("ytdl_hook says yt-dlp is missing", LOAD_TIMEOUT, |events| {
            hook_lines(events, NOT_FOUND) > 0
        });
        // It looked only where Kaleido said.
        assert_eq!(property(&engine, "user-data/mpv/ytdl/path"), "");
        engine.command(&["stop"]);
    }

    /// Needs a real libmpv; runs a copy of Windows' where.exe as the "yt-dlp" (it refuses yt-dlp's
    /// options and ends at once, without a window). The hook that found nothing looks again once
    /// the file is there.
    #[test]
    fn the_hook_looks_again_once_yt_dlp_is_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let exe = paths.tools_dir.join("yt-dlp.exe");
        let events = Recorded::default();
        let engine = Engine::start(headless(paths.clone()), events.clone()).unwrap();
        engine.call(|mpv| mpv.request_log_messages("warn").unwrap());
        give(&engine, hook_commands(&paths));
        engine.command(&["loadfile", LINK]);
        events.wait_until("the first search fails", LOAD_TIMEOUT, |events| {
            hook_lines(events, NOT_FOUND) > 0
        });

        // The download is done: the file is there, and the core hears it.
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        fs::copy(PathBuf::from(root).join("System32").join("where.exe"), &exe).unwrap();
        give(&engine, hook_commands(&paths));

        // The hook reads its options on its own thread: a load that came first still fails.
        let ours = exe.to_string_lossy().into_owned();
        for _ in 0..10 {
            let failed = hook_lines(&events.events(), "youtube-dl failed");
            engine.command(&["loadfile", LINK]);
            events.wait_until("the hook tried again", LOAD_TIMEOUT, |events| {
                hook_lines(events, "youtube-dl failed") > failed
            });
            if property(&engine, "user-data/mpv/ytdl/path") == ours {
                break;
            }
        }
        assert_eq!(property(&engine, "user-data/mpv/ytdl/path"), ours);
        // where.exe is no yt-dlp: it ran, and failed as a program does.
        events.wait_until("the stand-in ran", LOAD_TIMEOUT, |events| {
            hook_lines(events, "unexpected error occurred") > 0
        });
        engine.command(&["stop"]);
    }

    /// Needs a real libmpv; runs a copy of Windows' where.exe as the "yt-dlp", as above. The file
    /// was there when the core got the plain path, then gone when a link was opened: the hook
    /// keeps that failed search for as long as the value stays, and the spelling that differs
    /// makes it look again.
    #[test]
    fn a_yt_dlp_put_in_place_anew_is_looked_for_again() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let exe = paths.tools_dir.join("yt-dlp.exe");
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let stand_in = PathBuf::from(root).join("System32").join("where.exe");
        fs::copy(&stand_in, &exe).unwrap();
        let events = Recorded::default();
        let engine = Engine::start(headless(paths.clone()), events.clone()).unwrap();
        engine.call(|mpv| mpv.request_log_messages("warn").unwrap());
        let given = hook_commands(&paths);
        give(&engine, given.clone());

        // A virus scanner takes it away, and a link is opened.
        fs::remove_file(&exe).unwrap();
        engine.command(&["loadfile", LINK]);
        events.wait_until("the search fails", LOAD_TIMEOUT, |events| {
            hook_lines(events, NOT_FOUND) > 0
        });
        assert_eq!(property(&engine, "user-data/mpv/ytdl/path"), "");

        // The check puts it in place again: the value differs from the one the core has.
        fs::copy(&stand_in, &exe).unwrap();
        let again = hook_commands_for_core(&paths, &given, true);
        assert_ne!(again, given);
        give(&engine, again);

        let ours = exe.to_string_lossy().into_owned();
        for _ in 0..10 {
            let failed = hook_lines(&events.events(), "youtube-dl failed");
            engine.command(&["loadfile", LINK]);
            events.wait_until("the hook tried again", LOAD_TIMEOUT, |events| {
                hook_lines(events, "youtube-dl failed") > failed
            });
            if property(&engine, "user-data/mpv/ytdl/path") == ours {
                break;
            }
        }
        assert_eq!(property(&engine, "user-data/mpv/ytdl/path"), ours);
        engine.command(&["stop"]);
    }

    /// Needs a real libmpv.
    #[test]
    fn raw_options_reach_mpv() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "ytdl-raw-options=force-ipv4=,js-runtimes=node\n",
        )
        .unwrap();
        let deno = paths.tools_dir.join("deno.exe");
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();

        give(&engine, raw_options(Some(&deno), Some("firefox")));

        let raw = property(&engine, RAW_OPTIONS);
        assert_eq!(
            value_of(&raw, "js-runtimes"),
            Some(format!("deno:{}", deno.to_string_lossy())),
            "{raw}"
        );
        assert_eq!(
            value_of(&raw, "cookies-from-browser").as_deref(),
            Some("firefox")
        );
        // The user's own key stays as it was.
        assert_eq!(value_of(&raw, "force-ipv4").as_deref(), Some(""));

        // Deno and the cookies gone: Kaleido's keys go, the user's stays.
        give(&engine, raw_options(None, None));
        let raw = property(&engine, RAW_OPTIONS);
        assert_eq!(raw, "force-ipv4=");
        // Taking out what is not there is no error.
        give(&engine, raw_options(None, None));
        assert_eq!(property(&engine, RAW_OPTIONS), "force-ipv4=");
    }
}
