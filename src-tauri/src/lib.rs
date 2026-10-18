//! Kaleido: the Tauri shell around libmpv.

pub mod commands;
pub mod glass;
pub mod input;
pub mod job;
pub mod paths;
pub mod player;
pub mod settings;
pub mod surface;
pub mod system;
pub mod themes;
pub mod thumbs;

#[cfg(test)]
mod ipc_contract_tests;

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Context;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use glass::{AppHost, GlassController};
use player::command::ScreenshotMode;
use player::{Engine, EngineConfig, EventSink, PlayerEvent, Request, StateLoop};
use surface::{Surface, WindowSync};
use system::OpenThread;
use system::clipboard::PasteOutcome;
use system::dialog::DialogPurpose;
use system::logs::LogGuard;
use system::open_queue::OpenQueue;

/// How long closing the window waits for mpv to save the position and shut down.
const QUIT_TIMEOUT: Duration = Duration::from_secs(2);

pub fn run() {
    // First: every panic goes to the log once there is one, and one that ends the start is told
    // (spec 10.1, Ruling R53).
    system::logs::install_panic_hook();
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
    let built = tauri::Builder::default()
        // First: a later launch hands over its command line and exits before anything else.
        .plugin(system::instance::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OpenQueue::new(system::JOIN_WINDOW))
        .manage(opens)
        // Before the engine: a preview may arrive as soon as thumbfast has started.
        .manage(thumbs::ThumbStore::default())
        // Empty until the setup has made the glass; the appearance events wait for it.
        .manage(themes::ThemeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::player_command,
            commands::player_input,
            commands::player_load,
            commands::system_ui_ready,
            commands::system_open_dialog,
            commands::system_paste,
            commands::system_open_text,
            commands::system_open_roadmap,
            commands::system_open_source,
            commands::surface_set_layout,
            commands::surface_set_caption_buttons,
            commands::glass_set_regions,
            commands::glass_state,
            commands::thumb_request,
            commands::thumb_clear,
            commands::thumb_get,
            commands::settings_get,
            commands::settings_set,
            commands::settings_get_mpv,
            commands::settings_set_mpv,
            commands::settings_audio_devices,
            commands::settings_bindings,
            commands::settings_rebind,
            commands::settings_reset_binding,
            commands::settings_list_shaders,
            commands::system_fonts,
            commands::system_diagnostics,
            commands::system_copy_diagnostics,
            commands::system_open_logs,
            commands::system_licenses,
            commands::system_appearance,
            commands::system_locale,
        ])
        // A failed start is logged with its whole chain of causes and shown in a message box
        // before Tauri turns it into a panic, whose message has nowhere to go (Ruling R53).
        .setup(|app| {
            setup(app).map_err(|error| {
                let reason = system::fatal::describe(&error);
                tracing::error!("Kaleido could not start: {reason}");
                // On disk before the user goes to look; the app ends right after this.
                if let Some(log) = app.try_state::<LogGuard>() {
                    log.flush();
                }
                system::fatal::start_failed(&reason);
                error.into()
            })
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
            // Windows' dark or light theme flipped. Its transparency switch and high contrast
            // do not send this, so the focus looks again too (see `themes::refresh`).
            WindowEvent::ThemeChanged(_) | WindowEvent::Focused(true) => {
                themes::refresh(window.app_handle());
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
        .build(tauri::generate_context!());
    // Before the setup runs (a plugin that cannot start): there is no log yet, only the box.
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            let reason = system::fatal::describe(&error.into());
            tracing::error!("Kaleido could not start: {reason}");
            system::fatal::start_failed(&reason);
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        // The process ends without dropping the managed state, so the log writer is told to
        // write what it still holds.
        if matches!(event, RunEvent::Exit)
            && let Some(log) = app.try_state::<LogGuard>()
        {
            log.flush();
        }
    });
}

/// The app's setup, once the main window is there. An error ends the start (see `run`).
fn setup(app: &mut tauri::App) -> anyhow::Result<()> {
    let paths = paths::AppPaths::resolve(app.handle())?;
    // First, so that everything after is logged. The logs folder is known only from here, so
    // lines logged before are not captured (the job object's failure goes to stderr). It makes
    // the folder itself, and the guard stays managed so that the writer lives as long as the app
    // does.
    let log = system::logs::init(&paths);
    if log.is_writing() {
        system::fatal::logging_to(&paths.logs_dir);
    }
    app.manage(log);
    paths
        .ensure_dirs()
        .context("cannot create Kaleido's folders")?;
    player::options::ensure_defaults(&paths)
        .with_context(|| format!("cannot write mpv.conf in {}", paths.config_dir.display()))?;
    // Before the engine: the open-while-playing setting decides how the first launch's files
    // play.
    app.manage(settings::SharedSettings::new(
        settings::SettingsStore::load(paths.config_dir.join(settings::SETTINGS_FILE)),
    ));
    let window = app
        .get_webview_window("main")
        .context("the main window is missing")?;
    let main = window.hwnd()?.0 as isize;
    // Before the engine starts: its first state batch may already set the window's fullscreen
    // or always-on-top.
    let surface = Surface::new(main);
    let size = window.inner_size()?;
    surface.apply(size.width, size.height, window.scale_factor()?);
    app.manage(surface);
    app.manage(WindowSync::default());
    // Before the engine: mpv opens mpv.log anew, so the last run's log is archived now.
    if let Err(error) = system::logs::rotate_mpv_log(&paths.logs_dir, SystemTime::now()) {
        tracing::warn!("cannot archive the last mpv log: {error}");
    }
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
    )
    .context("cannot start the player")?;
    // Queued, not called: this is the main thread. Requests run in order, so the observations
    // are in place before any file is loaded.
    engine.request(Request::Call(Box::new(|mpv| {
        if let Err(error) = player::observe_all(mpv) {
            tracing::error!("cannot observe the player state: {error}");
        }
    })));
    // Queued behind the observations, before anything the UI asks of thumbfast.
    player::options::load_thumbfast(&engine, &paths);
    let shader = glass::shader_path(&paths.cache_dir);
    app.manage(paths);
    app.manage(engine);
    // After the engine: the glass queues its shader on it. Always managed, also when the shader
    // cannot be written (then it starts off), so the commands find it.
    let glass = GlassController::new(Arc::new(AppHost::new(app.handle().clone())), shader);
    glass.set_scale(window.scale_factor()?);
    // Where mpv's window is: the regions are moved into it (Ruling R45).
    surface::sync_glass(&app.state::<Surface>(), &glass);
    app.manage(glass);
    // After the glass: Windows' transparency and the settings decide whether it runs, and the
    // window gets Mica.
    themes::start(app.handle());
    // Without it only dropping files fails; the dialog still opens them.
    if let Err(error) = system::drop::install(window.as_ref()) {
        tracing::error!("dropped files will not open: {error:#}");
    }
    // WebView2's own caption for the islands (CSS app-region), for the Snap Layouts spike.
    // Without it the islands still move the window (data-tauri-drag-region).
    if let Err(error) = surface::caption::install(window.as_ref()) {
        tracing::warn!("the islands are no WebView2 caption: {error:#}");
    }
    // The queued command lines (this launch's first) are checked from now on.
    app.state::<OpenThread>().attach(app.handle().clone());
    system::fatal::started();
    Ok(())
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

    /// A panic on the mpv event thread (logged by the panic hook): the UI shows a notice.
    fn failed(&self) {
        if let Err(error) = self.app.emit(system::ERROR_EVENT, serde_json::json!({})) {
            tracing::warn!("cannot send {} to the UI: {error}", system::ERROR_EVENT);
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
        // thumbfast finished a timeline preview: Rust checks and stores it, the UI is told.
        PlayerEvent::ThumbRendered(json) => {
            thumbs::rendered(app, json);
            true
        }
        // Ctrl+V and Ctrl+O in input.conf.
        PlayerEvent::Message { args } => match args.as_slice() {
            [action] if action == "paste" => {
                if system::clipboard::paste(app) == PasteOutcome::Empty
                    && let Err(error) = app.emit(system::PASTE_EMPTY_EVENT, serde_json::json!({}))
                {
                    tracing::warn!(
                        "cannot send {} to the UI: {error}",
                        system::PASTE_EMPTY_EVENT
                    );
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
