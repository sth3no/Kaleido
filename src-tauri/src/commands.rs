//! The Tauri commands (thin): the UI's way into the player. They check what they are given and
//! queue it on the engine; none of them waits for mpv, because Tauri runs a synchronous command
//! on the main thread (M0 review) and mpv may be busy.

use tauri::State;

use crate::player::{self, Engine, LoadIssue, LoadMode, PlayerCommand};

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
