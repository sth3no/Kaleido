//! The mpv options Kaleido enforces and the default config it gives the user (spec 5.1, 5.2,
//! plan decision 11).

use std::fs;
use std::io;
use std::path::Path;

use mpv_ffi::Mpv;

use super::EngineConfig;
use crate::paths::AppPaths;

/// Kaleido's default `mpv.conf`: only options the user may change.
pub const DEFAULT_MPV_CONF: &str = include_str!("../../../resources/defaults/mpv.conf");
/// Kaleido's default `input.conf`, the one source of its shortcuts too (spec 5.3).
pub const DEFAULT_INPUT_CONF: &str = include_str!("../../../resources/defaults/input.conf");

/// Enforced options the user's mpv.conf can override during `initialize`, in the order
/// `reassert` puts them back: `gpu-api` before `vo`, so the recreated video output uses it.
const REASSERTED: &[&str] = &[
    "osc",
    "input-default-bindings",
    "input-vo-keyboard",
    "gpu-api",
    "vo",
    "watch-later-dir",
    "screenshot-dir",
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

/// After `initialize`, which loads the user's mpv.conf: sets back each `REASSERTED` option
/// whose value mpv.conf changed. The user's other options stay.
pub fn reassert(mpv: &Mpv, cfg: &EngineConfig) -> mpv_ffi::Result<()> {
    let enforced = enforced(cfg);
    for &name in REASSERTED {
        let Some((_, wanted)) = enforced.iter().find(|(option, _)| *option == name) else {
            continue;
        };
        // Only on a difference: setting `vo` recreates the video output.
        if mpv.get_string(name).ok().as_ref() != Some(wanted) {
            mpv.set_property(name, wanted)?;
        }
    }
    Ok(())
}

/// Puts Kaleido's default mpv.conf and input.conf into `config_dir`: from the installation's
/// `defaults` folder when it has them, else the copies built into Kaleido. A file that exists
/// belongs to the user and is never replaced.
pub fn ensure_defaults(paths: &AppPaths) -> io::Result<()> {
    for (name, built_in) in [
        ("mpv.conf", DEFAULT_MPV_CONF),
        ("input.conf", DEFAULT_INPUT_CONF),
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
        // Through a temporary file: a half-written file would count as the user's from then on.
        let temporary = paths.config_dir.join(format!("{name}.tmp"));
        fs::write(&temporary, contents)?;
        fs::rename(&temporary, &target)?;
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

    use super::{DEFAULT_INPUT_CONF, DEFAULT_MPV_CONF, ensure_defaults};
    use crate::player::Engine;
    use crate::player::testing::{NoEvents, headless, temp_paths};

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
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "osc=yes\ninput-default-bindings=no\ninput-vo-keyboard=yes\nwatch-later-dir=C:/x\n",
        )
        .unwrap();

        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let (osc, default_bindings, vo_keyboard, watch_later) = engine.call(|mpv| {
            (
                mpv.get_flag("osc").unwrap(),
                mpv.get_flag("input-default-bindings").unwrap(),
                mpv.get_flag("input-vo-keyboard").unwrap(),
                mpv.get_string("watch-later-dir").unwrap(),
            )
        });
        assert!(!osc);
        assert!(default_bindings);
        assert!(!vo_keyboard);
        assert_eq!(watch_later, paths.watch_later_dir.to_string_lossy());
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
