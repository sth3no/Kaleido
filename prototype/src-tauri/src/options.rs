use std::error::Error;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Files the prototype hands to mpv.
pub struct Paths {
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Paths, Box<dyn Error>> {
        let data_dir = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        Ok(Paths { data_dir })
    }
}

/// Set before mpv_initialize. Spec 5.2 subset; `config=no` keeps the user's own mpv config out of M0.
pub fn mpv_options(paths: &Paths) -> Vec<(&'static str, String)> {
    vec![
        ("vo", "gpu-next".into()),
        ("gpu-api", "d3d11".into()),
        ("target-colorspace-hint", "yes".into()),
        ("hwdec", "auto-safe".into()),
        ("keep-open", "yes".into()),
        ("idle", "yes".into()),
        ("force-window", "yes".into()),
        ("osc", "no".into()),
        ("config", "no".into()),
        ("input-default-bindings", "yes".into()),
        ("input-vo-keyboard", "no".into()),
        ("terminal", "no".into()),
        (
            "log-file",
            paths.data_dir.join("mpv.log").display().to_string(),
        ),
    ]
}
