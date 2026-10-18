//! The Tauri commands (thin): the UI's way into the player. They check what they are given and
//! queue it on the engine; none of them waits for mpv on the main thread, where Tauri runs a
//! synchronous command (M0 review), because mpv may be busy.

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::glass::{GlassController, GlassRect, GlassState};
use crate::input::{self, InputEvent};
use crate::paths::AppPaths;
use crate::player::{self, Engine, LoadIssue, LoadMode, PlayerCommand};
use crate::settings::{self, AudioDevice, Binding, Settings, SettingsError, SharedSettings};
use crate::surface::{CaptionButton, Layout, Surface, sync_glass};
use crate::system::diagnostics::{self, License};
use crate::system::{
    self, ROADMAP_URL, Snapshot, SourcePage, clipboard::PasteOutcome, dialog::DialogPurpose,
};
use crate::themes::{self, SystemAppearance};
use crate::thumbs::{self, ThumbStore};

/// Runs a player command. The error is a message for the log; the UI has nothing to correct.
/// A screenshot goes to the glass, which takes the glass out of the picture first (spec 8.2).
#[tauri::command]
pub fn player_command(
    engine: State<'_, Engine>,
    glass: State<'_, GlassController>,
    cmd: PlayerCommand,
) -> Result<(), String> {
    if let PlayerCommand::Screenshot { mode } = cmd {
        glass.screenshot(mode);
        return Ok(());
    }
    player::command::send(&engine, &cmd).map_err(|error| error.to_string())
}

/// Input the UI did not handle (keys, the mouse, the wheel) for mpv. It is queued on the engine,
/// like every command, so that the events stay in the order they came in (a key's down before
/// its up); nothing waits for mpv.
#[tauri::command]
pub fn player_input(engine: State<'_, Engine>, event: InputEvent) {
    if !input::send(&engine, &event) {
        tracing::warn!("input refused: {event:?}");
    }
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

/// The UI listens to the player's events now: what was opened before plays, and the UI gets
/// the player's state. Waits for mpv, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_ui_ready(app: AppHandle) -> Snapshot {
    tauri::async_runtime::spawn_blocking(move || system::ui_ready(&app))
        .await
        .unwrap_or_else(|error| {
            tracing::error!("cannot read the player state for the UI: {error}");
            Snapshot::new()
        })
}

/// Shows the open dialog and returns at once; what is picked opens from the dialog's thread.
#[tauri::command]
pub fn system_open_dialog(app: AppHandle, purpose: DialogPurpose) {
    system::dialog::open(&app, purpose);
}

/// Opens the link on the clipboard. Asynchronous: another program may hold the clipboard for
/// a moment.
#[tauri::command]
pub async fn system_paste(app: AppHandle) -> PasteOutcome {
    system::clipboard::paste(&app)
}

/// Opens the link typed or pasted into the paste field.
#[tauri::command]
pub fn system_open_text(app: AppHandle, text: String) -> Result<(), LoadIssue> {
    system::clipboard::open_text(&app, &text)
}

/// Opens the public roadmap in the browser. Asynchronous: starting the browser may take a
/// moment.
#[tauri::command]
pub async fn system_open_roadmap() {
    if let Err(error) = tauri_plugin_opener::open_url(ROADMAP_URL, None::<&str>) {
        tracing::warn!("cannot open the roadmap: {error}");
    }
}

/// Opens a page about the sources of what Kaleido ships in the browser (spec 11.6): the releases
/// of Kaleido, or the sources of the libmpv build. The UI names the page; the addresses are
/// fixed in Rust, so no command opens a link the UI makes up. Asynchronous: starting the
/// browser may take a moment.
#[tauri::command]
pub async fn system_open_source(which: SourcePage) {
    if let Err(error) = tauri_plugin_opener::open_url(which.url(), None::<&str>) {
        tracing::warn!("cannot open the sources page {which:?}: {error}");
    }
}

/// Where the video goes: the whole window, a frame of the mini-player animation, the mini player
/// in its corner, or nowhere. Synchronous, so it runs on the main thread, which moves mpv's
/// window; that does not wait for mpv's core. The glass follows mpv's window (Ruling R45).
#[tauri::command]
pub fn surface_set_layout(
    surface: State<'_, Surface>,
    glass: State<'_, GlassController>,
    layout: Layout,
) {
    surface.set_layout(layout);
    sync_glass(&surface, &glass);
}

/// The window buttons the UI drew that Windows hit-tests itself (CSS px of the window): today the
/// maximise button, for Snap Layouts (`surface::caption`). An empty list while none is shown.
/// Synchronous, so it runs on the main thread, which owns the windows it places over them.
#[tauri::command]
pub fn surface_set_caption_buttons(surface: State<'_, Surface>, rects: Vec<CaptionButton>) {
    surface.set_caption_buttons(rects);
}

/// The glass elements the UI measured (CSS px), nothing for no glass. Synchronous: it only
/// queues the new regions on the engine.
#[tauri::command]
pub fn glass_set_regions(glass: State<'_, GlassController>, rects: Vec<GlassRect>) {
    glass.set_regions(rects);
}

/// Whether the glass is on, as the `glass:state` event says it when the state changes. The UI
/// asks when it starts and after a reload, because it may have missed the event (also the glass
/// that could not start sent none). Reads the controller only.
#[tauri::command]
pub fn glass_state(glass: State<'_, GlassController>) -> GlassState {
    glass.state()
}

/// Asks thumbfast for the timeline preview at `seconds`; it arrives as `player:thumb` and is
/// fetched with `thumb_get`. Synchronous: it only queues the request on the engine.
#[tauri::command]
pub fn thumb_request(engine: State<'_, Engine>, seconds: f64) {
    thumbs::request(&engine, seconds);
}

/// The pointer left the seekbar: thumbfast stops rendering. Synchronous: it only queues the
/// request on the engine.
#[tauri::command]
pub fn thumb_clear(engine: State<'_, Engine>) {
    thumbs::clear(&engine);
}

/// The latest preview as binary data: the width and the height as little-endian `u32`, then the
/// RGBA pixels (empty before the first preview). Reads the stored preview only, so the main
/// thread does not wait for anything.
#[tauri::command]
pub fn thumb_get(store: State<'_, ThumbStore>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(store.latest())
}

/// Runs `job` on a blocking thread: it waits for mpv (or the system), which must hold up
/// neither the main thread nor the async runtime. `None` if it panicked.
async fn on_blocking_thread<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::error!("a task on a blocking thread failed: {error}");
            None
        }
    }
}

/// Windows' transparency effects, high contrast and build, as `system:appearance-changed` says
/// them when they change. What it reads is also what Rust goes by from then on, so that Rust and
/// the UI agree after a reload. Synchronous: it reads one registry value and two system
/// settings.
#[tauri::command]
pub fn system_appearance(app: AppHandle) -> SystemAppearance {
    themes::current(&app)
}

/// What `system_locale` answers where the system names no language.
const DEFAULT_LOCALE: &str = "en-US";

/// What `system_locale` answers for the language `sys-locale` found, if any.
fn locale_or_default(found: Option<String>) -> String {
    found
        .map(|locale| locale.trim().to_owned())
        .filter(|locale| !locale.is_empty())
        .unwrap_or_else(|| DEFAULT_LOCALE.to_owned())
}

/// The system's language as a BCP 47 tag (`cs-CZ`), which the UI turns into Czech or English when
/// the language setting is "system" (spec 8.8). `en-US` where the system gives none. Synchronous:
/// it reads one system setting and never waits for mpv.
#[tauri::command]
pub fn system_locale() -> String {
    locale_or_default(sys_locale::get_locale())
}

/// Kaleido's own settings (settings.json). Reads the store only.
#[tauri::command]
pub fn settings_get(store: State<'_, SharedSettings>) -> Settings {
    settings::lock(&store).get().clone()
}

/// Changes Kaleido's settings: `patch` is merged in (a JSON merge patch), checked and written;
/// on an error nothing changed. The UI hears the new settings as `settings:changed`. A patch
/// that touches the appearance is also applied here: the glass shader on or off, Mica, the
/// window's theme. Synchronous: it writes one small file and never waits for mpv.
#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    store: State<'_, SharedSettings>,
    patch: Value,
) -> Result<Settings, SettingsError> {
    let appearance_changes = themes::touches_appearance(&patch);
    let settings = settings::lock(&store).update(patch)?;
    if let Err(error) = app.emit(settings::CHANGED_EVENT, &settings) {
        tracing::warn!("cannot send {} to the UI: {error}", settings::CHANGED_EVENT);
    }
    // Only for the appearance: setting the same window effect again would flicker, and the
    // other settings have nothing to do with it.
    if appearance_changes {
        themes::on_settings_changed(&app, &settings.appearance);
    }
    Ok(settings)
}

/// Every mpv option the settings manage, from mpv.conf or else the player. Waits for mpv,
/// hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_get_mpv(app: AppHandle) -> BTreeMap<String, Option<String>> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths), Some(glass)) = (
            app.try_state::<Engine>(),
            app.try_state::<AppPaths>(),
            app.try_state::<GlassController>(),
        ) else {
            return BTreeMap::new();
        };
        settings::get_mpv(&engine, &paths.config_dir, glass.shader())
    })
    .await
    .unwrap_or_default()
}

/// Sets an mpv option from the allow-list in mpv.conf and, if it can be, in the player (`None`
/// takes it out). Waits for mpv (the audio devices), hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_set_mpv(
    app: AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), SettingsError> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths), Some(glass)) = (
            app.try_state::<Engine>(),
            app.try_state::<AppPaths>(),
            app.try_state::<GlassController>(),
        ) else {
            return Err(SettingsError::Unavailable);
        };
        settings::set_mpv(&engine, &glass, &paths.config_dir, &key, value.as_deref())
    })
    .await
    .unwrap_or(Err(SettingsError::Unavailable))
}

/// The audio outputs mpv offers. Waits for mpv, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_audio_devices(app: AppHandle) -> Vec<AudioDevice> {
    on_blocking_thread(move || {
        app.try_state::<Engine>()
            .map(|engine| settings::audio_devices(&engine))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Every key that is bound, with what it does and where that comes from: Kaleido, the user,
/// mpv or a plugin (spec 8.10). Waits for mpv, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_bindings(app: AppHandle) -> Vec<Binding> {
    on_blocking_thread(move || {
        app.try_state::<Engine>()
            .map(|engine| settings::bindings(&engine))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Moves the binding of `key` to `new_key` and silences `key`, in input.conf and in the player.
/// The UI sends keys only; the command is the one the key has. Waits for mpv, hence
/// asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_rebind(
    app: AppHandle,
    key: String,
    new_key: String,
) -> Result<(), SettingsError> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths)) = (app.try_state::<Engine>(), app.try_state::<AppPaths>())
        else {
            return Err(SettingsError::Unavailable);
        };
        settings::rebind(&engine, &paths.config_dir, &key, &new_key)
    })
    .await
    .unwrap_or(Err(SettingsError::Unavailable))
}

/// Puts `key` back to Kaleido's default for it, or to the one of mpv or a plugin. Waits for mpv,
/// hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn settings_reset_binding(app: AppHandle, key: String) -> Result<(), SettingsError> {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths)) = (app.try_state::<Engine>(), app.try_state::<AppPaths>())
        else {
            return Err(SettingsError::Unavailable);
        };
        settings::reset_binding(&engine, &paths.config_dir, &key)
    })
    .await
    .unwrap_or(Err(SettingsError::Unavailable))
}

/// The files in the shaders folder that `glsl-shaders` may name. Lists one local folder.
#[tauri::command]
pub fn settings_list_shaders(paths: State<'_, AppPaths>) -> Vec<String> {
    settings::list_shaders(&paths.config_dir)
}

/// The installed font families (DirectWrite). The first call reads them, which may take a
/// moment, so it is asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_fonts() -> Vec<String> {
    on_blocking_thread(|| settings::system_fonts().to_vec())
        .await
        .unwrap_or_default()
}

/// The diagnostics as text for a bug report: versions, Windows, GPU and plugins, with no file
/// paths and no URLs. Waits for mpv (its versions), hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_diagnostics(app: AppHandle) -> String {
    diagnostics_text(app).await
}

/// Puts the diagnostics (as `system_diagnostics` returns them) on the clipboard. Another program
/// may hold the clipboard, so it can fail; the UI says so.
#[tauri::command]
pub async fn system_copy_diagnostics(app: AppHandle) -> Result<(), String> {
    let text = diagnostics_text(app.clone()).await;
    if text.is_empty() {
        return Err("the diagnostics are not available".to_owned());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

async fn diagnostics_text(app: AppHandle) -> String {
    on_blocking_thread(move || {
        let (Some(engine), Some(paths)) = (app.try_state::<Engine>(), app.try_state::<AppPaths>())
        else {
            return String::new();
        };
        diagnostics::report(&engine, &paths)
    })
    .await
    .unwrap_or_default()
}

/// Shows the logs folder in the file manager. Asynchronous: starting it may take a moment.
#[tauri::command]
pub async fn system_open_logs(app: AppHandle) {
    let Some(paths) = app.try_state::<AppPaths>() else {
        return;
    };
    if let Err(error) = tauri_plugin_opener::open_path(&paths.logs_dir, None::<&str>) {
        tracing::warn!("cannot open the logs folder: {error}");
    }
}

/// The licenses of the third-party software Kaleido ships (spec 11.6). Reads two files from the
/// installation, hence asynchronous and on a blocking thread.
#[tauri::command]
pub async fn system_licenses(app: AppHandle) -> Vec<License> {
    on_blocking_thread(move || {
        app.try_state::<AppPaths>()
            .map(|paths| diagnostics::licenses(&paths.resource_dir.join("licenses")))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_locale_is_passed_on_as_it_is() {
        assert_eq!(locale_or_default(Some("cs-CZ".to_owned())), "cs-CZ");
        assert_eq!(locale_or_default(Some("sk-SK".to_owned())), "sk-SK");
    }

    #[test]
    fn a_missing_or_blank_locale_is_english() {
        assert_eq!(locale_or_default(None), "en-US");
        assert_eq!(locale_or_default(Some(String::new())), "en-US");
        assert_eq!(locale_or_default(Some("  ".to_owned())), "en-US");
    }
}
