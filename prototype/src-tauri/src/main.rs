#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;
mod options;
mod surface;

use std::sync::Arc;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{Manager, WindowEvent};

use engine::Engine;
use surface::SurfaceState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing")?;
            let parent = match window.window_handle()?.as_raw() {
                RawWindowHandle::Win32(handle) => handle.hwnd.get(),
                other => return Err(format!("unsupported window handle {other:?}").into()),
            };
            let paths = options::Paths::resolve(app.handle())?;
            // mpv creates its own child window inside the top-level window (see SurfaceState).
            let engine =
                Engine::start(app.handle().clone(), parent, &options::mpv_options(&paths))?;
            let surface = SurfaceState::new(parent);
            let size = window.inner_size()?;
            surface.apply(size.width, size.height, window.scale_factor()?);
            // M0 dev hook: open a file without the dialog, once the UI listens for events.
            if let Some(path) = std::env::var_os("KALEIDO_M0_OPEN") {
                let engine = Arc::clone(&engine);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = engine
                        .mpv
                        .command(&["loadfile", &path.to_string_lossy(), "replace"]);
                });
            }
            app.manage(surface);
            app.manage(engine);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                if let (Some(surface), Ok(size), Ok(scale)) = (
                    window.try_state::<SurfaceState>(),
                    window.inner_size(),
                    window.scale_factor(),
                ) {
                    surface.apply(size.width, size.height, scale);
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                // mpv shuts down first; the event thread exits the app on SHUTDOWN.
                if let Some(engine) = window.try_state::<Arc<Engine>>() {
                    api.prevent_close();
                    let _ = engine.mpv.command(&["quit"]);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::player_command,
            commands::surface_set_layout,
        ])
        .run(tauri::generate_context!())
        .expect("Kaleido M0 se nepodařilo spustit");
}
