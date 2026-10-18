//! The mpv options Kaleido enforces and the default config it gives the user (spec 5.1, 5.2,
//! plan decision 11).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use mpv_ffi::Mpv;

use super::{Engine, EngineConfig, Request};
use crate::paths::AppPaths;
use crate::settings;

/// Kaleido's default `mpv.conf`: only options the user may change.
pub const DEFAULT_MPV_CONF: &str = include_str!("../../../resources/defaults/mpv.conf");
/// Kaleido's default `input.conf`, the one source of its shortcuts too (spec 5.3).
pub const DEFAULT_INPUT_CONF: &str = include_str!("../../../resources/defaults/input.conf");

/// Enforced options that mpv.conf (directly, through a profile or a conditional profile) or a
/// script can change after they were set, in the order `reassert` puts them back: `gpu-api`
/// before `vo`, so the recreated video output uses it.
const REASSERTED: &[&str] = &[
    "osc",
    "input-default-bindings",
    "input-vo-keyboard",
    "gpu-api",
    "vo",
    "watch-later-dir",
    "screenshot-dir",
    "log-file",
];

/// Set before `initialize`: the options the UI stands on.
pub fn enforced(cfg: &EngineConfig) -> Vec<(&'static str, String)> {
    let paths = &cfg.paths;
    let mut options = vec![
        ("config", "yes".to_owned()),
        ("config-dir", mpv_path(&paths.config_dir)),
    ];
    if let Some(wid) = cfg.wid {
        options.push(("wid", wid.to_string()));
    }
    options.push(("vo", cfg.vo.clone()));
    if let Some(ao) = &cfg.ao {
        options.push(("ao", ao.clone()));
    }
    options.extend([
        ("gpu-api", "d3d11".to_owned()),
        ("osc", "no".to_owned()),
        ("input-default-bindings", "yes".to_owned()),
        ("input-vo-keyboard", "no".to_owned()),
        ("terminal", "no".to_owned()),
        ("force-window", "yes".to_owned()),
        ("idle", "yes".to_owned()),
        ("watch-later-dir", mpv_path(&paths.watch_later_dir)),
        ("screenshot-dir", mpv_path(&paths.desktop_dir)),
        ("log-file", mpv_path(&paths.logs_dir.join("mpv.log"))),
    ]);
    options
}

/// The `REASSERTED` options with their enforced values, in reassert order. The engine watches
/// them for as long as it runs.
pub fn reasserted(cfg: &EngineConfig) -> Vec<(&'static str, String)> {
    let enforced = enforced(cfg);
    REASSERTED
        .iter()
        .filter_map(|&name| enforced.iter().find(|(option, _)| *option == name).cloned())
        .collect()
}

/// After `initialize`, which loads the user's mpv.conf, and whenever a watched option changes:
/// sets back each `REASSERTED` option whose value differs. The user's other options stay.
pub fn reassert(mpv: &Mpv, cfg: &EngineConfig) -> mpv_ffi::Result<()> {
    for (name, wanted) in reasserted(cfg) {
        // Only on a difference: setting `vo` recreates the video output.
        if mpv.get_string(name).ok().as_deref() != Some(wanted.as_str()) {
            mpv.set_property(name, &wanted)?;
        }
    }
    Ok(())
}

/// The helper process thumbfast renders previews in: `kaleido-mpv.exe`, next to `Kaleido.exe`.
fn thumbfast_helper(paths: &AppPaths) -> PathBuf {
    paths.exe_dir.join("kaleido-mpv.exe")
}

/// The bundled thumbfast script (plan decision 4).
fn thumbfast_script(paths: &AppPaths) -> PathBuf {
    paths
        .resource_dir
        .join("essentials")
        .join("thumbfast")
        .join("thumbfast.lua")
}

/// The mpv commands that load thumbfast, to run after `initialize`: its script options, then the
/// script. The options are appended one by one, so that the user's own `script-opts` stay and
/// our values for thumbfast's keys come last; a value with a comma in it, a path, is one item.
pub fn thumbfast_commands(paths: &AppPaths) -> Vec<Vec<String>> {
    let append = |option: String| {
        vec![
            "change-list".to_owned(),
            "script-opts".to_owned(),
            "append".to_owned(),
            option,
        ]
    };
    vec![
        append(format!(
            "thumbfast-mpv_path={}",
            mpv_path(&thumbfast_helper(paths))
        )),
        append("thumbfast-network=no".to_owned()),
        append("thumbfast-tone_mapping=mobius".to_owned()),
        vec!["load-script".to_owned(), mpv_path(&thumbfast_script(paths))],
    ]
}

/// Queues the loading of thumbfast on the engine, in order, before any preview is asked for.
/// Nothing waits for mpv, so this is safe on the main thread.
pub fn load_thumbfast(engine: &Engine, paths: &AppPaths) {
    // Without either, previews do not appear; say why now rather than at the first hover.
    for (what, file) in [
        ("thumbfast", thumbfast_script(paths)),
        ("the preview helper", thumbfast_helper(paths)),
    ] {
        if !file.is_file() {
            tracing::error!(
                "previews will not work: {what} is missing ({})",
                file.display()
            );
        }
    }
    for command in thumbfast_commands(paths) {
        engine.request(Request::Command(command));
    }
}

/// Puts Kaleido's default mpv.conf and input.conf into `config_dir`: from the installation's
/// `defaults` folder when it has them, else the copies built into Kaleido. A file that exists
/// belongs to the user and is never replaced.
pub fn ensure_defaults(paths: &AppPaths) -> io::Result<()> {
    for (name, built_in) in [
        (settings::MPV_CONF, DEFAULT_MPV_CONF),
        (settings::INPUT_CONF, DEFAULT_INPUT_CONF),
    ] {
        let target = paths.config_dir.join(name);
        if target.try_exists()? {
            continue;
        }
        let bundled = paths.resource_dir.join("defaults").join(name);
        let contents = if bundled.is_file() {
            fs::read(&bundled)?
        } else {
            built_in.as_bytes().to_vec()
        };
        // Atomically: a half-written file would count as the user's from then on.
        settings::write_atomic(&target, &contents)?;
    }
    Ok(())
}

/// mpv takes UTF-8; a path that is not valid Unicode could not reach it unchanged anyway.
fn mpv_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;

    use mpv_ffi::{Mpv, load_api, locate_libmpv};

    use super::{DEFAULT_INPUT_CONF, DEFAULT_MPV_CONF, ensure_defaults, thumbfast_commands};
    use crate::paths::AppPaths;
    use crate::player::Engine;
    use crate::player::testing::{NoEvents, clip, eventually, headless, temp_paths};

    #[test]
    fn defaults_are_copied_once_and_never_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let mpv_conf = paths.config_dir.join("mpv.conf");
        let input_conf = paths.config_dir.join("input.conf");

        ensure_defaults(&paths).unwrap();
        assert_eq!(fs::read_to_string(&mpv_conf).unwrap(), DEFAULT_MPV_CONF);
        assert_eq!(fs::read_to_string(&input_conf).unwrap(), DEFAULT_INPUT_CONF);

        fs::write(&mpv_conf, "volume=37\n").unwrap();
        ensure_defaults(&paths).unwrap();
        assert_eq!(fs::read_to_string(&mpv_conf).unwrap(), "volume=37\n");
        assert_eq!(fs::read_to_string(&input_conf).unwrap(), DEFAULT_INPUT_CONF);
    }

    #[test]
    fn defaults_come_from_the_installation_when_it_has_them() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let bundled = paths.resource_dir.join("defaults");
        fs::create_dir_all(&bundled).unwrap();
        fs::write(bundled.join("mpv.conf"), "# bundled\n").unwrap();

        ensure_defaults(&paths).unwrap();
        let read = |name| fs::read_to_string(paths.config_dir.join(name)).unwrap();
        assert_eq!(read("mpv.conf"), "# bundled\n");
        // Not in the installation: the copy built into Kaleido.exe.
        assert_eq!(read("input.conf"), DEFAULT_INPUT_CONF);
    }

    #[test]
    fn default_input_conf_routes_kaleido_actions() {
        let bindings: HashMap<&str, &str> = DEFAULT_INPUT_CONF
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| line.split_once(' ').unwrap())
            .collect();
        for (key, mode) in [
            ("s", "subtitles"),
            ("S", "video"),
            ("Ctrl+s", "window"),
            ("Alt+s", "each-frame"),
        ] {
            assert_eq!(
                bindings[key],
                format!("script-message kaleido screenshot {mode}"),
                "{key}"
            );
        }
        assert_eq!(bindings["Ctrl+v"], "script-message kaleido paste");
        assert_eq!(bindings["Ctrl+o"], "script-message kaleido open");
        // Kaleido's indicator replaces mpv's OSD text for these.
        for (keys, osd) in [
            (
                &["RIGHT", "LEFT", "UP", "DOWN", "Shift+RIGHT", "Shift+LEFT"][..],
                "seek",
            ),
            (
                &["9", "0", "/", "*", "WHEEL_UP", "WHEEL_DOWN", "m"][..],
                "volume",
            ),
            (&["[", "]", "{", "}", "BS"][..], "speed"),
        ] {
            for key in keys {
                let command = bindings[key];
                assert!(command.starts_with("no-osd "), "{key}: {command}");
                assert!(
                    command.ends_with(&format!("; script-message kaleido osd {osd}")),
                    "{key}: {command}"
                );
            }
        }
    }

    #[test]
    fn user_config_cannot_turn_off_kaleido_essentials() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let other_log = tmp.path().join("other.log");
        fs::write(
            paths.config_dir.join("mpv.conf"),
            format!(
                "osc=yes\ninput-default-bindings=no\ninput-vo-keyboard=yes\nwatch-later-dir=C:/x\n\
                 log-file={}\n",
                other_log.display()
            ),
        )
        .unwrap();

        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let (osc, default_bindings, vo_keyboard, watch_later, log_file) = engine.call(|mpv| {
            (
                mpv.get_flag("osc").unwrap(),
                mpv.get_flag("input-default-bindings").unwrap(),
                mpv.get_flag("input-vo-keyboard").unwrap(),
                mpv.get_string("watch-later-dir").unwrap(),
                mpv.get_string("log-file").unwrap(),
            )
        });
        assert!(!osc);
        assert!(default_bindings);
        assert!(!vo_keyboard);
        assert_eq!(watch_later, paths.watch_later_dir.to_string_lossy());
        assert_eq!(log_file, paths.logs_dir.join("mpv.log").to_string_lossy());
    }

    #[test]
    fn user_config_cannot_change_the_video_output_or_the_screenshot_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "vo=gpu\ngpu-api=opengl\nscreenshot-dir=C:/y\n",
        )
        .unwrap();

        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let (vo, gpu_api, screenshot_dir) = engine.call(|mpv| {
            (
                mpv.get_string("vo").unwrap(),
                mpv.get_string("gpu-api").unwrap(),
                mpv.get_string("screenshot-dir").unwrap(),
            )
        });
        assert_eq!(vo, "null");
        assert_eq!(gpu_api, "d3d11");
        assert_eq!(screenshot_dir, paths.desktop_dir.to_string_lossy());
    }

    /// mpv's own OSC would draw over Kaleido's controls (spec 5.2).
    #[test]
    fn user_osc_yes_leaves_no_osc_script_running() {
        // The probe sees an OSC that runs: a core where nothing turns it off.
        let control = Mpv::create(load_api(&locate_libmpv()).unwrap()).unwrap();
        for (name, value) in [
            ("vo", "null"),
            ("ao", "null"),
            ("terminal", "no"),
            ("osc", "yes"),
        ] {
            control.set_option(name, value).unwrap();
        }
        control.initialize().unwrap();
        assert!(osc_script_runs(&control));

        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(paths.config_dir.join("mpv.conf"), "osc=yes\n").unwrap();
        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        eventually(&engine, "osc.lua has quit", |mpv| !osc_script_runs(mpv));
    }

    /// `script-message-to` fails when no client of that name exists.
    fn osc_script_runs(mpv: &Mpv) -> bool {
        mpv.command(&["script-message-to", "osc", "kaleido-probe"])
            .is_ok()
    }

    #[test]
    fn static_profile_options_are_reasserted() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "[k]\nosc=yes\nspeed=1.25\n[default]\nprofile=k\n",
        )
        .unwrap();

        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        let (speed, osc) =
            engine.call(|mpv| (mpv.get_f64("speed").unwrap(), mpv.get_flag("osc").unwrap()));
        assert_eq!(speed, 1.25, "profile k was not applied");
        assert!(!osc);
    }

    /// auto_profiles.lua applies conditional profiles on its own thread, at startup and whenever
    /// a condition changes, e.g. on every file load.
    #[test]
    fn conditional_profile_cannot_turn_osc_back_on() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "[k]\nprofile-cond=true\nosc=yes\nspeed=1.25\n\
             [f]\nprofile-cond=filename ~= nil\nosc=yes\nvolume=37\n",
        )
        .unwrap();
        let clip = clip(tmp.path(), 2);

        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        eventually(&engine, "profile k is applied", |mpv| {
            mpv.get_f64("speed").unwrap() == 1.25
        });
        eventually(&engine, "osc is off after start", |mpv| {
            !mpv.get_flag("osc").unwrap()
        });

        engine.command(&["loadfile", &clip.to_string_lossy()]);
        eventually(&engine, "profile f is applied", |mpv| {
            mpv.get_f64("volume").unwrap() == 37.0
        });
        eventually(&engine, "osc is off after the file load", |mpv| {
            !mpv.get_flag("osc").unwrap()
        });
    }

    /// Plan decision 4: the script options first, then the bundled script itself.
    #[test]
    fn thumbfast_is_configured_before_it_is_loaded_from_the_bundle() {
        let paths = AppPaths::from_roots(
            Path::new("Roaming"),
            Path::new("Local"),
            Path::new("Install"),
            Path::new("Desktop"),
            Path::new("Exe"),
        );
        let command = |args: &[&str]| args.iter().map(|&arg| arg.to_owned()).collect::<Vec<_>>();
        let helper = paths.exe_dir.join("kaleido-mpv.exe");
        let script = paths
            .resource_dir
            .join("essentials")
            .join("thumbfast")
            .join("thumbfast.lua");
        assert_eq!(
            thumbfast_commands(&paths),
            [
                command(&[
                    "change-list",
                    "script-opts",
                    "append",
                    &format!("thumbfast-mpv_path={}", helper.display()),
                ]),
                command(&[
                    "change-list",
                    "script-opts",
                    "append",
                    "thumbfast-network=no"
                ]),
                command(&[
                    "change-list",
                    "script-opts",
                    "append",
                    "thumbfast-tone_mapping=mobius",
                ]),
                command(&["load-script", &script.display().to_string()]),
            ]
        );
    }

    #[test]
    fn user_mpv_conf_options_still_apply() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(paths.config_dir.join("mpv.conf"), "volume=37\n").unwrap();

        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        assert_eq!(engine.call(|mpv| mpv.get_f64("volume").unwrap()), 37.0);
    }
}
