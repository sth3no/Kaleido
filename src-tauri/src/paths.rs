//! The folders Kaleido uses (spec 4.3). Everything else asks for them here instead of building
//! paths itself, so the layout is defined in one place.

use std::path::{Path, PathBuf};

use anyhow::Context;
use tauri::Manager;

/// Folder under `%APPDATA%` and `%LOCALAPPDATA%` that belongs to Kaleido.
const APP_DIR: &str = "Kaleido";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    /// `%APPDATA%\Kaleido`: the mpv `config-dir` (mpv.conf, input.conf, scripts, settings.json).
    pub config_dir: PathBuf,
    /// `<config_dir>\scripts`: the mpv scripts mpv loads at start (the plugins that are on).
    pub scripts_dir: PathBuf,
    /// `<config_dir>\scripts-disabled`: the plugins that are off; mpv never looks there.
    pub scripts_disabled_dir: PathBuf,
    /// `<config_dir>\script-opts`: the `<script>.conf` files of the scripts' options.
    pub script_opts_dir: PathBuf,
    /// `%LOCALAPPDATA%\Kaleido`.
    pub local_dir: PathBuf,
    /// `<local_dir>\state`.
    pub state_dir: PathBuf,
    /// `<local_dir>\state\watch_later`: mpv `watch-later-dir`.
    pub watch_later_dir: PathBuf,
    /// `<local_dir>\logs`.
    pub logs_dir: PathBuf,
    /// `<local_dir>\cache`.
    pub cache_dir: PathBuf,
    /// `<local_dir>\crash`.
    pub crash_dir: PathBuf,
    /// `resources\` of the installation: `defaults\`, `essentials\<name>\<file>`, ...
    pub resource_dir: PathBuf,
    /// The user's Desktop: mpv `screenshot-dir`.
    pub desktop_dir: PathBuf,
    /// Directory of `Kaleido.exe`; `kaleido-mpv.exe` and `libmpv-2.dll` sit next to it.
    pub exe_dir: PathBuf,
}

impl AppPaths {
    /// Lays out the folders under the given roots. Touches no disk, so it can be tested with
    /// made-up roots. `resources` is Tauri's resource folder, which on Windows is the folder of
    /// the executable; the bundled files sit in its `resources` subfolder (spec 4.3).
    pub fn from_roots(
        roaming: &Path,
        local: &Path,
        resources: &Path,
        desktop: &Path,
        exe_dir: &Path,
    ) -> AppPaths {
        let local_dir = local.join(APP_DIR);
        let state_dir = local_dir.join("state");
        let config_dir = roaming.join(APP_DIR);
        AppPaths {
            scripts_dir: config_dir.join("scripts"),
            scripts_disabled_dir: config_dir.join("scripts-disabled"),
            script_opts_dir: config_dir.join("script-opts"),
            config_dir,
            watch_later_dir: state_dir.join("watch_later"),
            logs_dir: local_dir.join("logs"),
            cache_dir: local_dir.join("cache"),
            crash_dir: local_dir.join("crash"),
            state_dir,
            local_dir,
            resource_dir: resources.join("resources"),
            desktop_dir: desktop.to_path_buf(),
            exe_dir: exe_dir.to_path_buf(),
        }
    }

    /// Asks the OS (through Tauri) where the roots are.
    pub fn resolve(app: &tauri::AppHandle) -> anyhow::Result<AppPaths> {
        let resolver = app.path();
        let exe = std::env::current_exe().context("cannot locate the running executable")?;
        let exe_dir = exe
            .parent()
            .context("the executable has no parent directory")?;
        Ok(AppPaths::from_roots(
            &resolver.data_dir().context("no %APPDATA% folder")?,
            &resolver
                .local_data_dir()
                .context("no %LOCALAPPDATA% folder")?,
            &resolver
                .resource_dir()
                .context("no bundled resources folder")?,
            &resolver.desktop_dir().context("no Desktop folder")?,
            exe_dir,
        ))
    }

    /// Creates the folders Kaleido writes to. Existing folders and the files in them stay as
    /// they are. The resource, Desktop and executable folders are not ours to create, and neither
    /// are `scripts`, `scripts-disabled` and `script-opts`: mpv runs without them, and the first
    /// install of a plugin makes the ones it needs.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [
            &self.config_dir,
            &self.local_dir,
            &self.state_dir,
            &self.watch_later_dir,
            &self.logs_dir,
            &self.cache_dir,
            &self.crash_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::AppPaths;

    #[test]
    fn from_roots_places_every_folder_like_spec_4_3() {
        let p = AppPaths::from_roots(
            Path::new("R"),
            Path::new("L"),
            Path::new("res"),
            Path::new("D"),
            Path::new("E"),
        );
        assert_eq!(p.config_dir, Path::new("R/Kaleido"));
        assert_eq!(p.scripts_dir, Path::new("R/Kaleido/scripts"));
        assert_eq!(
            p.scripts_disabled_dir,
            Path::new("R/Kaleido/scripts-disabled")
        );
        assert_eq!(p.script_opts_dir, Path::new("R/Kaleido/script-opts"));
        assert_eq!(p.local_dir, Path::new("L/Kaleido"));
        assert_eq!(p.state_dir, Path::new("L/Kaleido/state"));
        assert_eq!(p.watch_later_dir, Path::new("L/Kaleido/state/watch_later"));
        assert_eq!(p.logs_dir, Path::new("L/Kaleido/logs"));
        assert_eq!(p.cache_dir, Path::new("L/Kaleido/cache"));
        assert_eq!(p.crash_dir, Path::new("L/Kaleido/crash"));
        assert_eq!(p.resource_dir, Path::new("res/resources"));
        assert_eq!(p.desktop_dir, Path::new("D"));
        assert_eq!(p.exe_dir, Path::new("E"));
    }

    #[test]
    fn ensure_dirs_creates_missing_folders_and_keeps_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let p = AppPaths::from_roots(
            &tmp.path().join("Roaming"),
            &tmp.path().join("Local"),
            &tmp.path().join("res"),
            &tmp.path().join("Desktop"),
            &tmp.path().join("exe"),
        );
        // The user's own file in a folder that already exists must survive.
        std::fs::create_dir_all(&p.config_dir).unwrap();
        let settings = p.config_dir.join("settings.json");
        std::fs::write(&settings, "{\"keep\":true}").unwrap();

        p.ensure_dirs().unwrap();
        p.ensure_dirs().unwrap(); // idempotent

        for dir in [
            &p.config_dir,
            &p.local_dir,
            &p.state_dir,
            &p.watch_later_dir,
            &p.logs_dir,
            &p.cache_dir,
            &p.crash_dir,
        ] {
            assert!(dir.is_dir(), "{} was not created", dir.display());
        }
        assert_eq!(
            std::fs::read_to_string(&settings).unwrap(),
            "{\"keep\":true}"
        );
        // The plugin folders appear with the first install, not before.
        assert!(!p.scripts_dir.exists());
        assert!(!p.scripts_disabled_dir.exists());
        assert!(!p.script_opts_dir.exists());
        // Folders that belong to the installation or the OS are not ours to create.
        assert!(!p.resource_dir.exists());
        assert!(!p.desktop_dir.exists());
        assert!(!p.exe_dir.exists());
    }
}
