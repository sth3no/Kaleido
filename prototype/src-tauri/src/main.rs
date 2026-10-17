#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;
mod glass;
mod input;
mod open_requests;
mod options;
mod surface;
mod thumbs;

use std::sync::Arc;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{Emitter, Manager, WindowEvent};

use engine::Engine;
use open_requests::{OpenRequests, files_from_args, open_files};
use surface::SurfaceState;

fn main() {
    let requests = OpenRequests::default();
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut files = files_from_args(std::env::args_os().skip(1), &cwd);
    if files.is_empty()
        && let Some(path) = std::env::var_os("KALEIDO_M0_OPEN")
    {
        files = files_from_args([path], &cwd);
    }
    requests.submit(files);
    tauri::Builder::default()
        .manage(requests)
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let files = files_from_args(
                args.into_iter().skip(1).map(Into::into),
                std::path::Path::new(&cwd),
            );
            let batches = app.state::<OpenRequests>().submit(files);
            if let Some(engine) = app.try_state::<Arc<Engine>>()
                && let Err(error) = open_files(&engine.mpv, batches)
            {
                let _ = app.emit("player:log", error.to_string());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
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
            commands::player_ready,
            commands::player_command,
            commands::surface_set_layout,
            commands::player_input,
            commands::glass_set_regions,
            commands::thumb_request,
            commands::thumb_clear,
            commands::thumb_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("Kaleido M0 se nepodařilo spustit");
}
