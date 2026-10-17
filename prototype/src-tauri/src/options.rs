use std::error::Error;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::glass;

/// Files the prototype hands to mpv.
pub struct Paths {
    pub data_dir: PathBuf,
    pub screenshot_dir: PathBuf,
    pub click_target: PathBuf,
    pub shader: PathBuf,
    pub thumbfast: PathBuf,
    pub helper_exe: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Paths, Box<dyn Error>> {
        let data_dir = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let exe = std::env::current_exe()?;
        let resources = exe
            .parent()
            .ok_or("executable directory missing")?
            .join("resources");
        let bundled_click_target = resources.join("click-target.lua");
        let click_target = if bundled_click_target.is_file() {
            bundled_click_target
        } else {
            PathBuf::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/test-scripts/click-target.lua"
            ))
        };
        // The file stem is the shader name that glsl-shader-opts prefixes target.
        let shader = data_dir.join(format!("{}.glsl", glass::SHADER));
        std::fs::write(&shader, glass::shader_source())?;
        let bundled_thumbfast = resources.join("thumbfast.lua");
        let thumbfast = if bundled_thumbfast.is_file() {
            bundled_thumbfast
        } else {
            PathBuf::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../vendor/thumbfast/thumbfast.lua"
            ))
        };
        // Built next to us by `beforeDevCommand` (cargo build -p kaleido-mpv).
        let helper_exe = exe.with_file_name("kaleido-mpv.exe");
        Ok(Paths {
            data_dir,
            screenshot_dir: app.path().desktop_dir()?,
            click_target,
            shader,
            thumbfast,
            helper_exe,
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
        // Windows path-list separator is ';'.
        (
            "scripts",
            format!(
                "{};{}",
                paths.thumbfast.display(),
                paths.click_target.display()
            ),
        ),
        (
            "script-opts",
            format!(
                "thumbfast-mpv_path={},thumbfast-network=no,thumbfast-tone_mapping=mobius",
                paths.helper_exe.display()
            ),
        ),
        ("glsl-shaders", paths.shader.display().to_string()),
        ("screenshot-dir", paths.screenshot_dir.display().to_string()),
    ]
}
