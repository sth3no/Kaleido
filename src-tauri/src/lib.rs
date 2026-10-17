//! Kaleido: the Tauri shell around libmpv.

pub mod commands;
pub mod job;
pub mod paths;
pub mod player;
pub mod system;

use std::time::{Duration, Instant};

use anyhow::Context;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use player::{Engine, EngineConfig, EventSink, PlayerEvent, Request, StateLoop};
use system::clipboard::PasteOutcome;
use system::dialog::DialogPurpose;
use system::open_queue::OpenQueue;

/// How long closing the window waits for mpv to save the position and shut down.
const QUIT_TIMEOUT: Duration = Duration::from_secs(2);

pub fn run() {
    // Before anything is spawned, so every child process is covered.
    if let Err(error) = job::bind_children_to_this_process() {
        // There is no log file yet; a stray helper after a crash is not worth refusing to start.
        eprintln!("Kaleido: child processes will not end with the app: {error}");
    }
    tauri::Builder::default()
        // First: a later launch hands over its command line and exits before anything else.
        .plugin(system::instance::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OpenQueue::new(system::JOIN_WINDOW))
        .manage(system::OpenThread::start())
        .invoke_handler(tauri::generate_handler![
            commands::player_command,
            commands::player_load,
            commands::system_ui_ready,
            commands::system_open_dialog,
            commands::system_paste,
            commands::system_open_text,
            commands::system_open_roadmap,
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
            // Without it only dropping files fails; the dialog still opens them.
            if let Err(error) = system::drop::install(window.as_ref()) {
                tracing::error!("dropped files will not open: {error:#}");
            }
            // This launch's own command line; it waits in the queue until the UI is ready.
            system::open_command_line(
                app.handle(),
                Instant::now(),
                std::env::args_os().skip(1).collect(),
                std::env::current_dir().unwrap_or_default(),
            );
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
        // Ctrl+V and Ctrl+O in input.conf.
        PlayerEvent::Message { args } => match args.as_slice() {
            [action] if action == "paste" => {
                if system::clipboard::paste(app) == PasteOutcome::Empty
                    && let Err(error) = app.emit("system:paste-empty", serde_json::json!({}))
                {
                    tracing::warn!("cannot send system:paste-empty to the UI: {error}");
                }
                true
            }
            [action] if action == "open" => {
                system::dialog::open(app, DialogPurpose::Media);
                true
            }
            _ => false,
        },
        _ => false,
    }
}
