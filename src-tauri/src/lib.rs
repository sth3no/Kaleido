//! Kaleido: the Tauri shell around libmpv.

pub mod job;
pub mod paths;
pub mod player;

use std::time::Duration;

use anyhow::Context;
use mpv_ffi::{Event, Mpv};
use tauri::{AppHandle, Manager, WindowEvent};

use player::{Engine, EngineConfig, EventLoop};

/// How long closing the window waits for mpv to save the position and shut down.
const QUIT_TIMEOUT: Duration = Duration::from_secs(2);

pub fn run() {
    // Before anything is spawned, so every child process is covered.
    if let Err(error) = job::bind_children_to_this_process() {
        // There is no log file yet; a stray helper after a crash is not worth refusing to start.
        eprintln!("Kaleido: child processes will not end with the app: {error}");
    }
    tauri::Builder::default()
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
                AppEvents {
                    app: app.handle().clone(),
                },
            )?;
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

/// mpv's own `quit` (the `q` key) ends the app (spec 5.1).
struct AppEvents {
    app: AppHandle,
}

impl EventLoop for AppEvents {
    fn on_event(&mut self, _mpv: &Mpv, event: Event) {
        if event == Event::Shutdown {
            self.app.exit(0);
        }
    }

    fn on_idle(&mut self, _mpv: &Mpv) -> Option<Duration> {
        None
    }
}
