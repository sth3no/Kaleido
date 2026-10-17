//! The Tauri commands (thin): the UI's way into the player. They check what they are given and
//! queue it on the engine; none of them waits for mpv on the main thread, where Tauri runs a
//! synchronous command (M0 review), because mpv may be busy.

use tauri::{AppHandle, State};

use crate::glass::{GlassController, GlassRect};
use crate::input::{self, InputEvent};
use crate::player::{self, Engine, LoadIssue, LoadMode, PlayerCommand};
use crate::surface::{Layout, Surface};
use crate::system::{self, ROADMAP_URL, Snapshot, clipboard::PasteOutcome, dialog::DialogPurpose};

/// Runs a player command. The error is a message for the log; the UI has nothing to correct.
/// A screenshot goes to the glass, which takes the glass out of the picture first (spec 8.2).
#[tauri::command]
pub fn player_command(
    engine: State<'_, Engine>,
    glass: State<'_, GlassController>,
    cmd: PlayerCommand,
) -> Result<(), String> {
    if let PlayerCommand::Screenshot { mode } = cmd {
        glass.screenshot(mode);
        return Ok(());
    }
    player::command::send(&engine, &cmd).map_err(|error| error.to_string())
}

/// Input the UI did not handle (keys, the mouse, the wheel) for mpv. It is queued on the engine,
/// like every command, so that the events stay in the order they came in (a key's down before
/// its up); nothing waits for mpv.
#[tauri::command]
pub fn player_input(engine: State<'_, Engine>, event: InputEvent) {
    if !input::send(&engine, &event) {
        tracing::warn!("input refused: {event:?}");
    }
}

/// Opens files and links. A source that cannot be opened is reported and the others open.
/// Asynchronous, so that looking for the files (a network share may answer slowly) does not
/// hold up the main thread.
#[tauri::command]
pub async fn player_load(
    engine: State<'_, Engine>,
    sources: Vec<String>,
    mode: LoadMode,
) -> Result<(), Vec<LoadIssue>> {
    // Relative to where Kaleido runs, as for a command line.
    let cwd = std::env::current_dir().unwrap_or_default();
    player::open_sources(&engine, &sources, mode, &cwd)
}

/// The UI listens to the player's events now: what was opened before plays, and the UI gets
/// the player's state. Waits for mpv, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_ui_ready(app: AppHandle) -> Snapshot {
    tauri::async_runtime::spawn_blocking(move || system::ui_ready(&app))
        .await
        .unwrap_or_else(|error| {
            tracing::error!("cannot read the player state for the UI: {error}");
            Snapshot::new()
        })
}

/// Shows the open dialog and returns at once; what is picked opens from the dialog's thread.
#[tauri::command]
pub fn system_open_dialog(app: AppHandle, purpose: DialogPurpose) {
    system::dialog::open(&app, purpose);
}

/// Opens the link on the clipboard. Asynchronous: another program may hold the clipboard for
/// a moment.
#[tauri::command]
pub async fn system_paste(app: AppHandle) -> PasteOutcome {
    system::clipboard::paste(&app)
}

/// Opens the link typed or pasted into the paste field.
#[tauri::command]
pub fn system_open_text(app: AppHandle, text: String) -> Result<(), LoadIssue> {
    system::clipboard::open_text(&app, &text)
}

/// Opens the public roadmap in the browser. Asynchronous: starting the browser may take a
/// moment.
#[tauri::command]
pub async fn system_open_roadmap() {
    if let Err(error) = tauri_plugin_opener::open_url(ROADMAP_URL, None::<&str>) {
        tracing::warn!("cannot open the roadmap: {error}");
    }
}

/// Where the video goes: the whole window, a frame of the mini-player animation, the mini player
/// in its corner, or nowhere. Synchronous, so it runs on the main thread, which moves mpv's
/// window; that does not wait for mpv's core.
#[tauri::command]
pub fn surface_set_layout(surface: State<'_, Surface>, layout: Layout) {
    surface.set_layout(layout);
}

/// The glass elements the UI measured (CSS px), nothing for no glass. Synchronous: it only
/// queues the new regions on the engine.
#[tauri::command]
pub fn glass_set_regions(glass: State<'_, GlassController>, rects: Vec<GlassRect>) {
    glass.set_regions(rects);
}
