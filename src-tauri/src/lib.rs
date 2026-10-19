//! Kaleido: the Tauri shell around libmpv.

pub mod commands;
pub mod glass;
pub mod input;
pub mod job;
pub mod paths;
pub mod player;
pub mod plugins;
pub mod settings;
pub mod streams;
pub mod surface;
pub mod system;
pub mod themes;
pub mod thumbs;
pub mod tools;

#[cfg(test)]
mod ipc_contract_tests;

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Context;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use glass::{AppHost, GlassController};
use mpv_ffi::Mpv;
use paths::AppPaths;
use player::command::ScreenshotMode;
use player::{
    Engine, EngineConfig, EventSink, PlayerEvent, QUIT_TIMEOUT, Request, Restart, RestartError,
    StateLoop, StreamError,
};
use streams::{StreamFormats, Streams};
use surface::{Surface, WindowSync};
use system::OpenThread;
use system::clipboard::PasteOutcome;
use system::dialog::DialogPurpose;
use system::logs::LogGuard;
use system::open_queue::OpenQueue;
use tools::{Channel, ToolId, ToolStatus};

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
            commands::system_ui_error,
            commands::system_licenses,
            commands::system_appearance,
            commands::system_locale,
            commands::system_browsers,
            commands::plugins_list,
            commands::plugins_set_enabled,
            commands::plugins_uninstall,
            commands::plugins_restore_essentials,
            commands::plugins_settings,
            commands::plugins_set_setting,
            commands::plugins_log,
            commands::plugins_apply,
            commands::tools_status,
            commands::tools_check,
            commands::stream_retry,
            commands::stream_formats,
            commands::player_set_quality,
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
    let paths = AppPaths::resolve(app.handle())?;
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
    // play, and the language the preferences sub-select is first given.
    let store = settings::SettingsStore::load(paths.config_dir.join(settings::SETTINGS_FILE));
    let language = store.get().language.resolve_here();
    app.manage(settings::SharedSettings::new(store));
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
    // Before the engine: mpv loads the scripts in scripts\ as it starts, so the essentials are
    // copied by then and have Kaleido's options in their script-opts (plan decision 2), and what
    // the service says runs is what the core loads.
    app.manage(plugins::Plugins::start(&paths, language));
    // Before the engine: its first requests give ytdl_hook the managed yt-dlp and Deno. What
    // `tools.json` says and the sweep of old files only; nothing is checked until `start` below.
    let tools = tools::Service::new(
        tools::Tools::new(
            &paths,
            Arc::new(tools::http::Web::github()),
            Arc::new(tools::run::Processes),
        ),
        &paths,
        Arc::new(AppTools {
            app: app.handle().clone(),
        }),
    );
    // Before the engine: its first state batch may name a link to probe already.
    app.manage(new_streams(app.handle()));
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
    // mpv makes its idle window shown, soon: hidden the moment it is there (Ruling R56).
    surface::watch_for_first_window(app.handle());
    // Queued, not called: this is the main thread. Requests run in order, so the observations
    // are in place before any file is loaded.
    engine.request(Request::Call(Box::new(|mpv| {
        if let Err(error) = player::observe_all(mpv) {
            tracing::error!("cannot observe the player state: {error}");
        }
    })));
    // Then ytdl_hook's yt-dlp, Deno and the cookies' browser (plan decisions 2 and 13): queued
    // before anything the UI sends, so a link the UI opens finds them in place.
    for command in tools.options_for_new_core() {
        engine.request(Request::Command(command));
    }
    let shader = glass::shader_path(&paths.cache_dir);
    app.manage(paths);
    app.manage(engine);
    app.manage(tools);
    // Once the engine is managed, so that what a check changes reaches the core: a missing tool is
    // downloaded now, at the first start (plan decision 7).
    app.state::<tools::Service>().start();
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

/// Restarts the player core and plays on where it was ("Použít" for plugins, spec 6.3; see
/// [`Engine::restart`]). Blocks until the new core runs: call it on a thread of its own or a
/// blocking task, never on the main thread (it is refused there), and never while holding the
/// plugins' state (`plugins::Plugins::apply` lets it go). The essentials get Kaleido's options
/// first (plan decision 2: the scripts read them when the new core loads them), the new core gets
/// what every core gets ([`prepare_core`]), and the UI hears `player:engine-restarted` once it
/// runs (also when the old core did not end in time: `RestartError::Quit`).
pub fn restart_engine(app: &AppHandle) -> Result<(), RestartError> {
    let (Some(engine), Some(paths)) = (app.try_state::<Engine>(), app.try_state::<AppPaths>())
    else {
        return Err(RestartError::Start("the player is not running".to_owned()));
    };
    if let Some(plugins) = app.try_state::<plugins::Plugins>() {
        plugins.write_managed();
    }
    let logs_dir = paths.logs_dir.clone();
    let restart = Restart {
        events: Box::new(StateLoop::new(AppSink { app: app.clone() })),
        prepare: Box::new({
            let app = app.clone();
            move |mpv| prepare_core(&app, mpv)
        }),
        // The quality chosen for a link (plan decision 10): it loads with it again.
        entry_options: match app.try_state::<Streams>() {
            Some(streams) => streams.entry_options(),
            None => Box::new(|_| Vec::new()),
        },
        before_start: Box::new({
            let app = app.clone();
            move || {
                // The old core has closed mpv.log, and the new one opens it anew (as at start).
                if let Err(error) = system::logs::rotate_mpv_log(&logs_dir, SystemTime::now()) {
                    tracing::warn!("cannot archive the mpv log of the old core: {error}");
                }
                // From before the new core makes its idle window (Ruling R56).
                surface::watch_for_first_window(&app);
            }
        }),
    };
    let result = engine.restart(restart);
    if !matches!(result, Err(RestartError::Start(_)))
        && let Err(error) = app.emit(player::ENGINE_RESTARTED_EVENT, serde_json::json!({}))
    {
        tracing::warn!(
            "cannot send {} to the UI: {error}",
            player::ENGINE_RESTARTED_EVENT
        );
    }
    result
}

/// What a restarted core gets on the request thread, before it has reported anything and before
/// its playback is restored: the window's fullscreen and always-on-top as they are now, a change
/// made during the restart included (first, so that the observations report them and the window
/// stays as it is; the main thread, which answers, never waits for the request thread), the
/// observations the UI renders, the tools' options for ytdl_hook (before a link of the playlist
/// loads again), and the glass.
fn prepare_core(app: &AppHandle, mpv: &Mpv) {
    for (name, on) in surface::window_flags(app) {
        if let Err(error) = mpv.set_property(name, if on { "yes" } else { "no" }) {
            tracing::warn!("the restarted player does not take the window's {name}: {error}");
        }
    }
    if let Err(error) = player::observe_all(mpv) {
        tracing::error!("cannot observe the player state: {error}");
    }
    let mut commands = Vec::new();
    if let Some(tools) = app.try_state::<tools::Service>() {
        commands.extend(tools.options_for_new_core());
    }
    if let Some(glass) = app.try_state::<GlassController>() {
        commands.extend(glass.after_restart());
    }
    for args in commands {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if let Err(error) = mpv.command(&args) {
            tracing::warn!("the restarted player refuses {args:?}: {error}");
        }
    }
}

/// The qualities of links (plan decisions 10 and 11, Ruling R4): the probe is the managed yt-dlp's
/// `-J` with Deno and the cookies' browser as they are when it runs (a yt-dlp that is not there yet
/// is `Missing`), and what is known of a link reaches the UI as `stream:formats`.
fn new_streams(app: &AppHandle) -> Streams {
    let probe_app = app.clone();
    let probe: streams::Probe = Arc::new(move |url: &str| {
        let (yt_dlp, deno) = match probe_app.try_state::<tools::Service>() {
            Some(tools) => (
                tools.tools().path(ToolId::YtDlp),
                tools.tools().path(ToolId::Deno),
            ),
            None => (None, None),
        };
        let cookies = settings::cookies_from_browser(&probe_app);
        tools::ytdlp::probe(yt_dlp.as_deref(), deno.as_deref(), cookies.as_deref(), url)
    });
    let emit_app = app.clone();
    let emit: streams::Emit = Arc::new(move |formats: &StreamFormats| {
        if let Err(error) = emit_app.emit(streams::FORMATS_EVENT, formats) {
            tracing::warn!("cannot send {} to the UI: {error}", streams::FORMATS_EVENT);
        }
    });
    Streams::new(probe, emit)
}

/// What the tools' service asks of the app: the channel and the cookies' browser of the settings,
/// `tools:status` for the UI, and commands for the running core.
struct AppTools {
    app: AppHandle,
}

impl tools::Host for AppTools {
    fn channel(&self) -> Channel {
        self.app
            .try_state::<settings::SharedSettings>()
            .map(|store| settings::lock(&store).get().updates.ytdlp_channel)
            .unwrap_or_default()
    }

    fn cookies(&self) -> Option<String> {
        settings::cookies_from_browser(&self.app)
    }

    fn status(&self, status: &ToolStatus) {
        if let Err(error) = self.app.emit(tools::STATUS_EVENT, status) {
            tracing::warn!("cannot send {} to the UI: {error}", tools::STATUS_EVENT);
        }
    }

    /// Queued: during a restart they wait for the new core, which gets them after its own.
    fn send(&self, commands: Vec<Vec<String>>) {
        let Some(engine) = self.app.try_state::<Engine>() else {
            tracing::warn!("the tools' options changed before the player runs");
            return;
        };
        for command in commands {
            engine.request(Request::Command(command));
        }
    }
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
        // The window follows mpv's fullscreen and ontop (spec 5.1); a link that starts to load is
        // probed for its qualities (plan decision 11). The UI gets the batch too.
        PlayerEvent::State { changes } => {
            surface::follow_mpv(app, changes);
            if let Some(path) = changes.get(streams::PATH)
                && let Some(streams) = app.try_state::<Streams>()
            {
                // Looks at what is known and starts a thread: nothing here waits.
                streams.on_path(path.as_str());
            }
            if let Some(osd) = changes.get("osd-dimensions") {
                // mpv says it once it has made its window: a new one gets the layout, hidden
                // while no file is open (Ruling R52).
                surface::mpv_window_reported(app);
                // Where the picture starts in the window (letterbox bars): the glass regions are
                // measured from there.
                if let Some(glass) = app.try_state::<GlassController>() {
                    glass.set_origin(osd);
                }
            }
            false
        }
        // The shader failed: the glass goes off (spec 10.6). A plugin's first error of the run is
        // told once (spec 10.4). The UI hears the line too.
        PlayerEvent::Log(line) => {
            if let Some(glass) = app.try_state::<GlassController>() {
                glass.on_log(line);
            }
            if let Some(plugins) = app.try_state::<plugins::Plugins>()
                && let Some(name) = plugins.note_log(line)
            {
                plugins::told_error(app, name);
            }
            false
        }
        // A link that failed for want of a (newer) yt-dlp: yt-dlp is checked in the background
        // (spec 6.6; `check_yt_dlp` says how). The UI hears the end all the same, and its card
        // offers the update.
        PlayerEvent::EndFile {
            stream_error: Some(class),
            ..
        } => {
            if class.wants_new_yt_dlp() {
                check_yt_dlp(app, *class);
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

/// The least time between two forced checks of yt-dlp that failed links ask for.
const FORCED_CHECK_GAP: Duration = Duration::from_secs(10 * 60);

/// When the last forced check of yt-dlp was asked for by a link (in this run of Kaleido).
static LAST_FORCED_CHECK: Mutex<Option<Instant>> = Mutex::new(None);

/// Whether a link whose extractor is out of date forces the check of yt-dlp at `now`, `last` being
/// when it last did (Ruling R11): the first time, and then once in [`FORCED_CHECK_GAP`], so that a
/// playlist of broken links asks the release once and not for every link.
fn outdated_check_is_forced(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|last| now.saturating_duration_since(last) >= FORCED_CHECK_GAP)
}

/// [`outdated_check_is_forced`] for `now`, noting the time in `last` when it is.
fn claim_forced_check(last: &Mutex<Option<Instant>>, now: Instant) -> bool {
    // A time is replaced in one step, so a panic elsewhere leaves it whole.
    let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
    let forced = outdated_check_is_forced(*last, now);
    if forced {
        *last = Some(now);
    }
    forced
}

/// Checks yt-dlp in the background after a link failed with `class` (`Outdated` or `Missing`;
/// spec 6.6). An out-of-date extractor forces the check (`tools::Service::check_now`: it reads the
/// release's checksum list, and downloads only when there is a newer yt-dlp), but at most once in
/// [`FORCED_CHECK_GAP`]; otherwise, and for a missing yt-dlp, the check is made only when it is due
/// (`tools::Service::check_if_due`: a missing yt-dlp at once, unless a failed attempt still backs
/// off). On a thread of its own: this is the mpv event thread, which waits for nothing, and the
/// check may download. A check that runs already is waited for there.
fn check_yt_dlp(app: &AppHandle, class: StreamError) {
    let forced =
        class == StreamError::Outdated && claim_forced_check(&LAST_FORCED_CHECK, Instant::now());
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("yt-dlp-check".to_owned())
        .spawn(move || {
            if let Some(tools) = app.try_state::<tools::Service>() {
                if forced {
                    tools.check_now(tools::ToolId::YtDlp);
                } else {
                    tools.check_if_due(tools::ToolId::YtDlp);
                }
            }
        });
    if let Err(error) = spawned {
        tracing::warn!("yt-dlp is not checked after the link failed: {error}");
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

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    /// Ruling R11: a link with an out-of-date extractor forces the check of yt-dlp, but not more
    /// than once in ten minutes.
    #[test]
    fn a_forced_check_for_an_outdated_extractor_comes_at_most_every_ten_minutes() {
        let start = Instant::now();
        assert!(outdated_check_is_forced(None, start));
        assert!(!outdated_check_is_forced(Some(start), start));
        assert!(!outdated_check_is_forced(Some(start), start + 9 * MINUTE));
        assert!(outdated_check_is_forced(Some(start), start + 10 * MINUTE));
        assert!(outdated_check_is_forced(Some(start), start + 60 * MINUTE));
        // A time that is before the last one is no reason to force.
        assert!(!outdated_check_is_forced(Some(start + 5 * MINUTE), start));
    }

    /// The first failure claims the forced check, and the ones after it fall back to the check
    /// that is made when it is due, until the gap is over.
    #[test]
    fn a_playlist_of_broken_links_forces_one_check() {
        let last = Mutex::new(None);
        let start = Instant::now();
        assert!(claim_forced_check(&last, start));
        for seconds in [0, 1, 30, 599] {
            assert!(
                !claim_forced_check(&last, start + Duration::from_secs(seconds)),
                "{seconds} s"
            );
        }
        // The gap counts from the check that was forced, not from the failures after it.
        assert!(claim_forced_check(&last, start + 10 * MINUTE));
        assert!(!claim_forced_check(&last, start + 19 * MINUTE));
        assert!(claim_forced_check(&last, start + 20 * MINUTE));
    }
}
