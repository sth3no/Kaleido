use std::error::Error;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::glass;

/// Files the prototype hands to mpv.
pub struct Paths {
    pub data_dir: PathBuf,
    pub click_target: PathBuf,
    pub shader: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Paths, Box<dyn Error>> {
        let data_dir = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let click_target = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-scripts/click-target.lua"
        ));
        // The file stem is the shader name that glsl-shader-opts prefixes target.
        let shader = data_dir.join(format!("{}.glsl", glass::SHADER));
        std::fs::write(&shader, glass::shader_source())?;
        Ok(Paths {
            data_dir,
            click_target,
            shader,
        })
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
        ("scripts", paths.click_target.display().to_string()),
        ("glsl-shaders", paths.shader.display().to_string()),
        ("screenshot-dir", "~~desktop/".into()),
    ]
}
