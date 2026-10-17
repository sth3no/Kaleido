//! The Tauri commands (thin): the UI's way into the player. They check what they are given and
//! queue it on the engine; none of them waits for mpv on the main thread, where Tauri runs a
//! synchronous command (M0 review), because mpv may be busy.

use tauri::{AppHandle, State};

use crate::player::{self, Engine, LoadIssue, LoadMode, PlayerCommand};
use crate::system::{self, ROADMAP_URL, Snapshot, clipboard::PasteOutcome, dialog::DialogPurpose};

/// Runs a player command. The error is a message for the log; the UI has nothing to correct.
#[tauri::command]
pub fn player_command(engine: State<'_, Engine>, cmd: PlayerCommand) -> Result<(), String> {
    player::command::send(&engine, &cmd).map_err(|error| error.to_string())
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
