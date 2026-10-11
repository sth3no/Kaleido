use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::engine::Engine;
use crate::surface::{Layout, SurfaceState};

pub type CmdResult = Result<(), String>;

fn err(e: mpv_ffi::Error) -> String {
    e.to_string()
}

#[tauri::command]
pub fn open_file(engine: State<'_, Arc<Engine>>, path: String) -> CmdResult {
    engine
        .mpv
        .command(&["loadfile", &path, "replace"])
        .map_err(err)
}

/// Typed player commands; the UI cannot send arbitrary mpv commands (spec 4.4).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlayerCmd {
    TogglePause,
    SeekAbsolute { seconds: f64 },
    SetVolume { value: f64 },
    SetFullscreen { on: bool },
}

#[tauri::command]
pub fn player_command(engine: State<'_, Arc<Engine>>, cmd: PlayerCmd) -> CmdResult {
    let mpv = &engine.mpv;
    match cmd {
        PlayerCmd::TogglePause => mpv.command(&["cycle", "pause"]),
        PlayerCmd::SeekAbsolute { seconds } => {
            mpv.command(&["seek", &seconds.max(0.0).to_string(), "absolute+keyframes"])
        }
        PlayerCmd::SetVolume { value } => {
            mpv.set_property("volume", &value.clamp(0.0, 130.0).to_string())
        }
        PlayerCmd::SetFullscreen { on } => {
            mpv.set_property("fullscreen", if on { "yes" } else { "no" })
        }
    }
    .map_err(err)
}

#[tauri::command]
pub fn surface_set_layout(surface: State<'_, SurfaceState>, layout: Layout) {
    surface.set_layout(layout);
}

#[tauri::command]
pub fn player_input(engine: State<'_, Arc<Engine>>, ev: crate::input::InputEvent) -> CmdResult {
    let Some(args) = crate::input::to_command(&ev) else {
        return Err(format!("rejected input {ev:?}"));
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    engine.mpv.command(&args).map_err(err)
}

#[tauri::command]
pub fn glass_set_regions(
    window: tauri::WebviewWindow,
    engine: State<'_, Arc<Engine>>,
    rects: Vec<crate::glass::GlassRect>,
) -> CmdResult {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    engine.set_glass(rects, scale).map_err(err)
}
