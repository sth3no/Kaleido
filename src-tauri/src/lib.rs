//! Kaleido: the Tauri shell around libmpv.

pub mod commands;
pub mod job;
pub mod paths;
pub mod player;

use std::time::Duration;

use anyhow::Context;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use player::{Engine, EngineConfig, EventSink, PlayerEvent, Request, StateLoop};

/// How long closing the window waits for mpv to save the position and shut down.
const QUIT_TIMEOUT: Duration = Duration::from_secs(2);

pub fn run() {
    // Before anything is spawned, so every child process is covered.
    if let Err(error) = job::bind_children_to_this_process() {
        // There is no log file yet; a stray helper after a crash is not worth refusing to start.
        eprintln!("Kaleido: child processes will not end with the app: {error}");
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::player_command,
            commands::player_load
        ])
        .setup(|app| {
            let paths = paths::AppPaths::resolve(app.handle())?;
            paths.ensure_dirs()?;
            player::options::ensure_defaults(&paths)?;
            let window = app
                .get_webview_window("main")
                .context("the main window is missing")?;
            let engine = Engine::start(
                EngineConfig {
                    paths: paths.clone(),
                    wid: Some(window.hwnd()?.0 as isize),
                    vo: "gpu-next".into(),
                    ao: None,
                },
                StateLoop::new(AppSink {
                    app: app.handle().clone(),
                }),
            )?;
            // Queued, not called: this is the main thread. Requests run in order, so the
            // observations are in place before any file is loaded.
            engine.request(Request::Call(Box::new(|mpv| {
                if let Err(error) = player::observe_all(mpv) {
                    tracing::error!("cannot observe the player state: {error}");
                }
            })));
            app.manage(paths);
            app.manage(engine);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // mpv saves the position first. The wait runs on another thread: this one has
                // to handle what mpv's window, a child of this one, sends while it closes.
                api.prevent_close();
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    if let Some(engine) = app.try_state::<Engine>() {
                        engine.quit(QUIT_TIMEOUT);
                    }
                    app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Kaleido");
}

/// Delivers the player's events: Rust's own handlers first, the UI for the rest.
struct AppSink {
    app: AppHandle,
}

impl EventSink for AppSink {
    fn emit(&self, event: PlayerEvent) {
        if route(&self.app, &event) {
            return;
        }
        if let Some(channel) = event.channel()
            && let Err(error) = self.app.emit(channel, &event)
        {
            tracing::warn!("cannot send {channel} to the UI: {error}");
        }
    }
}

/// Handles the events that are for Rust. Returns whether it did, i.e. the UI does not get the
/// event. Messages from mpv that Rust acts on are added here.
fn route(app: &AppHandle, event: &PlayerEvent) -> bool {
    match event {
        // mpv's own `quit` (the `q` key) ends the app (spec 5.1).
        PlayerEvent::Shutdown => {
            app.exit(0);
            true
        }
        _ => false,
    }
}
