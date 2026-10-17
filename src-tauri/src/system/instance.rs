//! One Kaleido at a time (spec 9.3): a later launch hands its command line to the running one
//! and exits; the running one opens it and comes to the front.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Instant;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Wry};

/// The single-instance plugin. Register it before every other plugin: a later launch has to
/// exit before the rest of the setup runs. Not called for the first launch, whose own command
/// line goes through [`super::open_command_line`] in the setup.
pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_single_instance::init(|app, args, cwd| {
        let arrived = Instant::now();
        // As `std::env::args_os` collects them: the program comes first.
        let args = args.into_iter().skip(1).map(OsString::from).collect();
        super::open_command_line(app, arrived, args, PathBuf::from(cwd));
        bring_to_front(app);
    })
}

/// Restores, shows and activates the main window. The later launch has let this process take
/// the foreground (`AllowSetForegroundWindow`) before handing over.
fn bring_to_front(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    for (step, result) in [
        ("restore", window.unminimize()),
        ("show", window.show()),
        ("activate", window.set_focus()),
    ] {
        if let Err(error) = result {
            tracing::warn!("cannot {step} the window for a later launch: {error}");
        }
    }
}
