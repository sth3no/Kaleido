//! Kaleido: the Tauri shell around libmpv.

pub mod commands;
pub mod glass;
pub mod input;
pub mod job;
pub mod paths;
pub mod player;
pub mod surface;
pub mod system;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use glass::{AppHost, GlassController};
use player::command::ScreenshotMode;
use player::{Engine, EngineConfig, EventSink, PlayerEvent, Request, StateLoop};
use surface::{Surface, WindowSync};
use system::OpenThread;
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
    // This launch's own command line goes first, before the app is built: from then on a later
    // launch can hand over its own (the single-instance callback runs while the main window is
    // created, before the setup). It waits in the queue until the UI is ready.
    let opens = OpenThread::start();
    system::open_command_line(
        &opens,
        Instant::now(),
        std::env::args_os().skip(1).collect(),
        std::env::current_dir().unwrap_or_default(),
    );
    tauri::Builder::default()
        // First: a later launch hands over its command line and exits before anything else.
        .plugin(system::instance::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OpenQueue::new(system::JOIN_WINDOW))
        .manage(opens)
        .invoke_handler(tauri::generate_handler![
            commands::player_command,
            commands::player_input,
            commands::player_load,
            commands::system_ui_ready,
            commands::system_open_dialog,
            commands::system_paste,
            commands::system_open_text,
            commands::system_open_roadmap,
            commands::surface_set_layout,
            commands::glass_set_regions,
            commands::glass_state,
        ])
        .setup(|app| {
            let paths = paths::AppPaths::resolve(app.handle())?;
            paths.ensure_dirs()?;
            player::options::ensure_defaults(&paths)?;
            let window = app
                .get_webview_window("main")
                .context("the main window is missing")?;
            let main = window.hwnd()?.0 as isize;
            // Before the engine starts: its first state batch may already set the window's
            // fullscreen or always-on-top.
            let surface = Surface::new(main);
            let size = window.inner_size()?;
            surface.apply(size.width, size.height, window.scale_factor()?);
            app.manage(surface);
            app.manage(WindowSync::default());
            let engine = Engine::start(
                EngineConfig {
                    paths: paths.clone(),
                    wid: Some(main),
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
            let shader = glass::shader_path(&paths.cache_dir);
            app.manage(paths);
            app.manage(engine);
            // After the engine: the glass queues its shader on it. Always managed, also when
            // the shader cannot be written (then it starts off), so the commands find it.
            let glass = GlassController::new(Arc::new(AppHost::new(app.handle().clone())), shader);
            glass.set_scale(window.scale_factor()?);
            app.manage(glass);
            // Without it only dropping files fails; the dialog still opens them.
            if let Err(error) = system::drop::install(window.as_ref()) {
                tracing::error!("dropped files will not open: {error:#}");
            }
            // The queued command lines (this launch's first) are checked from now on.
            app.state::<OpenThread>().attach(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Resized(_) => surface::window_resized(window),
            // The UI's layout is in CSS px, so a DPI change moves mpv's window too, and the
            // glass regions (the UI measured the same CSS px) become other physical ones.
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                if let Some(glass) = window.try_state::<GlassController>() {
                    glass.set_scale(*scale_factor);
                }
                surface::window_resized(window);
            }
            WindowEvent::CloseRequested { api, .. } => {
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
            _ => {}
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
        // The window follows mpv's fullscreen and ontop (spec 5.1); the UI gets the batch too.
        PlayerEvent::State { changes } => {
            surface::follow_mpv(app, changes);
            // Where the picture starts in the window (letterbox bars): the glass regions are
            // measured from there.
            if let Some(osd) = changes.get("osd-dimensions")
                && let Some(glass) = app.try_state::<GlassController>()
            {
                glass.set_origin(osd);
            }
            false
        }
        // The shader failed: the glass goes off (spec 10.6). The UI hears the line too.
        PlayerEvent::Log(line) => {
            if let Some(glass) = app.try_state::<GlassController>() {
                glass.on_log(line);
            }
            false
        }
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
            // s, S, Ctrl+s and Alt+s in input.conf: without the glass (spec 8.2).
            [action] if action == "screenshot" => {
                screenshot(app, None);
                true
            }
            [action, mode] if action == "screenshot" => {
                screenshot(app, Some(mode.as_str()));
                true
            }
            _ => false,
        },
        _ => false,
    }
}

/// `script-message kaleido screenshot [mode]`: a binding without a mode takes mpv's default.
fn screenshot(app: &AppHandle, mode: Option<&str>) {
    let parsed = match mode {
        None => Some(ScreenshotMode::Subtitles),
        Some(name) => glass::parse_mode(name),
    };
    match (parsed, app.try_state::<GlassController>()) {
        (Some(mode), Some(glass)) => glass.screenshot(mode),
        (None, _) => tracing::warn!("no such screenshot mode: {mode:?}"),
        (_, None) => tracing::warn!("no screenshot: the glass is not set up yet"),
    }
}
