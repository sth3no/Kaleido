//! Settings (spec 8.10): Kaleido's own in `settings.json` ([`store`]), the mpv options the
//! settings pages manage in mpv.conf ([`mpv_keys`], written gently by [`mpv_conf`]) and the
//! shortcuts in input.conf ([`input_conf`], and [`bindings`] for the list of them). This module
//! wires them up for the commands: reading mpv options and setting them in mpv.conf and live,
//! listing and changing the key bindings, the lists the values are checked against (audio
//! devices, fonts, shaders), and the atomic write the files go through.

pub mod bindings;
pub mod fonts;
pub mod input_conf;
pub(crate) mod lines;
pub mod mpv_conf;
pub mod mpv_keys;
pub mod store;

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use mpv_ffi::Mpv;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::glass::GlassController;
use crate::player::options::DEFAULT_INPUT_CONF;
use crate::player::{Engine, LoadMode, Request};
pub use bindings::{Binding, BindingSource};
pub use fonts::system_fonts;
pub use input_conf::InputConf;
pub use mpv_conf::MpvConf;
pub use mpv_keys::{MPV_SETTINGS, MpvSetting, ValidationCtx, ValueKind, validate_mpv};
pub use store::{
    Appearance, Language, Playback, ReduceTransparency, Settings, SettingsStore, ThemeMode,
    UiLanguage, Updates,
};

/// The event that tells the UI the settings changed; its payload is all of [`Settings`].
pub const CHANGED_EVENT: &str = "settings:changed";
/// Kaleido's settings file in `config_dir` (spec 4.3).
pub const SETTINGS_FILE: &str = "settings.json";
/// mpv's config file in `config_dir`.
pub const MPV_CONF: &str = "mpv.conf";
/// mpv's key bindings in `config_dir`, Kaleido's shortcuts too (spec 5.3).
pub const INPUT_CONF: &str = "input.conf";
/// The user's shaders in `config_dir` (`~~/shaders/` to mpv).
const SHADERS_DIR: &str = "shaders";

/// The store as the app manages it: one change at a time.
pub type SharedSettings = Mutex<SettingsStore>;

pub fn lock(store: &SharedSettings) -> MutexGuard<'_, SettingsStore> {
    // An update replaces the settings in one step, so a panic elsewhere leaves them whole.
    store.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a file opened while another plays does, from the settings. Before the store is
/// managed (it is, in the setup, before anything is handed to the player) the default.
pub fn open_while_playing(app: &AppHandle) -> LoadMode {
    match app.try_state::<SharedSettings>() {
        Some(store) => lock(&store).get().playback.open_while_playing,
        None => Playback::default().open_while_playing,
    }
}

/// The browser whose cookies yt-dlp takes for links, from the settings (`BROWSER[:PROFILE]`,
/// `None` for none): one value for mpv's `ytdl_hook` (the tools' options) and for Kaleido's own
/// `yt-dlp -J`. Before the store is managed (it is, in the setup, before the player starts) none.
pub fn cookies_from_browser(app: &AppHandle) -> Option<String> {
    app.try_state::<SharedSettings>()
        .and_then(|store| lock(&store).get().playback.cookies_from_browser.clone())
}

/// What a change of the settings did to the browser whose cookies yt-dlp takes
/// (`playback.cookiesFromBrowser`): `Some(new choice)`, where `None` is no cookies, when the choice
/// changed, and `None` when it stayed as it was. `settings_set` tells the tools' service when it
/// changed, and the service sends mpv's `ytdl_hook` the cookies as `ytdl-raw-options`, the way
/// every change of the tools' options goes (`tools::mpv::raw_options`).
pub fn cookies_change(before: &Settings, after: &Settings) -> Option<Option<String>> {
    let (before, after) = (
        &before.playback.cookies_from_browser,
        &after.playback.cookies_from_browser,
    );
    (before != after).then(|| after.clone())
}

/// Why a setting was not changed. In every case nothing changed: not the file, not the player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SettingsError {
    /// Not a key the settings may change (an mpv option off the allow-list, a settings.json key
    /// that does not exist), or a value the system does not offer (an audio device, a font or a
    /// shader that is not there).
    NotAllowed { key: String },
    /// A value out of range or of the wrong form. `key` is the mpv option, or the settings.json
    /// path in camelCase (`appearance.uiScale`; a whole section when it is not an object).
    Invalid { key: String, reason: String },
    /// The file could not be read or written, or settings.json could not be read at start and
    /// is not replaced.
    Io { message: String },
    /// The player is not running (yet).
    Unavailable,
}

impl SettingsError {
    pub fn invalid(key: &str, reason: &str) -> SettingsError {
        SettingsError::Invalid {
            key: key.to_owned(),
            reason: reason.to_owned(),
        }
    }

    pub fn io(error: impl fmt::Display) -> SettingsError {
        SettingsError::Io {
            message: error.to_string(),
        }
    }
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsError::NotAllowed { key } => write!(f, "{key}: not allowed"),
            SettingsError::Invalid { key, reason } => write!(f, "{key}: expected {reason}"),
            SettingsError::Io { message } => write!(f, "cannot save the settings: {message}"),
            SettingsError::Unavailable => write!(f, "the player is not running"),
        }
    }
}

impl std::error::Error for SettingsError {}

/// `#` and then one of `lengths` hex digits.
pub(crate) fn is_hex_color(value: &str, lengths: &[usize]) -> bool {
    value.strip_prefix('#').is_some_and(|digits| {
        lengths.contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

/// Replaces `path` with `contents` all at once: they go to a temporary file in the same folder,
/// reach the disk, and the temporary file is renamed over `path` (which replaces it on Windows).
/// A crash or a full disk leaves the old file, never half a new one.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let Some(name) = path.file_name() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a file to write has a name",
        ));
    };
    let mut temporary = name.to_os_string();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = path.with_file_name(temporary);
    let written = write_and_rename(&temporary, path, contents);
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

fn write_and_rename(temporary: &Path, path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = File::create(temporary)?;
    file.write_all(contents)?;
    file.flush()?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)
}

// ---------------------------------------------------------------------------------------------
// mpv options

/// One change of mpv.conf (and of the player with it) at a time: two settings changed at once
/// would otherwise each write the file without the other's change, or reach the file and the
/// player in different orders.
static MPV_CONF_WRITES: Mutex<()> = Mutex::new(());

fn mpv_conf_turn() -> MutexGuard<'static, ()> {
    MPV_CONF_WRITES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Sets (or with `None` removes) `key` in `config_dir/mpv.conf`, gently ([`MpvConf`]) and
/// atomically. A missing file is an empty one. A file that is not UTF-8 is left alone.
pub fn write_mpv_conf(
    config_dir: &Path,
    key: &str,
    value: Option<&str>,
) -> Result<(), SettingsError> {
    let _turn = mpv_conf_turn();
    rewrite_mpv_conf(config_dir, key, value)
}

/// [`write_mpv_conf`] for a caller that has the turn already.
fn rewrite_mpv_conf(
    config_dir: &Path,
    key: &str,
    value: Option<&str>,
) -> Result<(), SettingsError> {
    let path = config_dir.join(MPV_CONF);
    let text = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            SettingsError::io("mpv.conf is not UTF-8 text; Kaleido leaves it alone")
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(SettingsError::io(error)),
    };
    let mut conf = MpvConf::parse(&text);
    conf.set(key, value)?;
    let changed = conf.render();
    if changed != text {
        write_atomic(&path, changed.as_bytes()).map_err(SettingsError::io)?;
    }
    Ok(())
}

/// mpv.conf as it is now, for reading: missing or unreadable is empty.
fn read_mpv_conf(config_dir: &Path) -> MpvConf {
    match fs::read(config_dir.join(MPV_CONF)) {
        Ok(bytes) => MpvConf::parse(&String::from_utf8_lossy(&bytes)),
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!("cannot read mpv.conf: {error}");
            }
            MpvConf::default()
        }
    }
}

/// Every key of [`MPV_SETTINGS`] with its value: from mpv.conf's main section where it is set
/// there, else the player's current value (`None` if mpv has none), numbers in the short form
/// mpv.conf has them in. The glass shader is not the user's and never shows in
/// `glsl-shaders`. Waits for mpv, so not on the main thread.
pub fn get_mpv(
    engine: &Engine,
    config_dir: &Path,
    glass_shader: &str,
) -> BTreeMap<String, Option<String>> {
    let conf = read_mpv_conf(config_dir);
    let mut values = BTreeMap::new();
    let mut missing: Vec<&'static MpvSetting> = Vec::new();
    for setting in MPV_SETTINGS {
        match conf.get(setting.key) {
            Some(value) => {
                values.insert(setting.key.to_owned(), Some(value));
            }
            None => missing.push(setting),
        }
    }
    let glass_shader = glass_shader.to_owned();
    let current = engine.call(move |mpv| {
        missing
            .into_iter()
            .map(|setting| {
                let value = mpv.get_string(setting.key).ok();
                let value = match setting.kind {
                    ValueKind::Shaders => value.map(|list| without_glass(&list, &glass_shader)),
                    // mpv prints `55.000000`; mpv.conf and the UI say `55`.
                    ValueKind::Number { .. } => {
                        value.map(|number| mpv_keys::normal_number(&number))
                    }
                    _ => value,
                };
                (setting.key, value)
            })
            .collect::<Vec<_>>()
    });
    values.extend(
        current
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value)),
    );
    values
}

/// `list` (`glsl-shaders` as mpv prints it) without the glass shader, which the controller always
/// keeps as the last entry: its exact path at the end, after whatever separator mpv joins the
/// list with. Nothing is guessed from separators, so a path with a comma or `;` in it is fine.
fn without_glass(list: &str, glass: &str) -> String {
    if list == glass {
        return String::new();
    }
    match list.strip_suffix(glass) {
        Some(rest) if rest.ends_with([';', ',']) => rest[..rest.len() - 1].to_owned(),
        _ => list.to_owned(),
    }
}

/// Changes an mpv option from the settings: checks it ([`validate_mpv`]), writes it to mpv.conf,
/// and sets it in the running player if it is `live`. `None` removes it from mpv.conf and puts
/// mpv's default back. `glsl-shaders` goes through the glass, so that the glass shader stays
/// after the user's. On an error nothing changed. Waits for mpv for some keys (the audio
/// devices), so not on the main thread.
pub fn set_mpv(
    engine: &Engine,
    glass: &GlassController,
    config_dir: &Path,
    key: &str,
    value: Option<&str>,
) -> Result<(), SettingsError> {
    let Some(setting) = mpv_keys::setting(key) else {
        return Err(SettingsError::NotAllowed {
            key: key.to_owned(),
        });
    };
    let ctx = context(setting.kind, engine, config_dir);
    let value = validate_mpv(key, value, &ctx)?;
    // The file and the player change in one turn: quick changes reach both in the same order.
    // Applying only queues on the engine, so the turn is short.
    let _turn = mpv_conf_turn();
    rewrite_mpv_conf(config_dir, setting.key, value.as_deref())?;
    if setting.live {
        apply_live(engine, glass, setting, value);
    }
    Ok(())
}

/// The lists a value of `kind` is checked against; only the one it needs is filled.
fn context(kind: ValueKind, engine: &Engine, config_dir: &Path) -> ValidationCtx {
    let mut ctx = ValidationCtx::default();
    match kind {
        ValueKind::AudioDevice => {
            ctx.audio_devices = audio_devices(engine)
                .into_iter()
                .map(|device| device.name)
                .collect();
        }
        ValueKind::Font => ctx.fonts = system_fonts().to_vec(),
        ValueKind::Shaders => ctx.shaders = list_shaders(config_dir),
        _ => {}
    }
    ctx
}

/// Queued, in order after everything before it; nothing waits for mpv.
fn apply_live(
    engine: &Engine,
    glass: &GlassController,
    setting: &'static MpvSetting,
    value: Option<String>,
) {
    if setting.kind == ValueKind::Shaders {
        let user = mpv_keys::shader_entries(value.as_deref().unwrap_or_default());
        glass.set_user_shaders(&user);
        return;
    }
    let key = setting.key;
    match value {
        Some(value) => engine.request(Request::SetProperty {
            name: key.to_owned(),
            value,
        }),
        None => engine.request(Request::Call(Box::new(move |mpv| {
            reset_to_default(mpv, key);
        }))),
    }
}

/// An option taken out of mpv.conf goes back to what mpv has without it.
fn reset_to_default(mpv: &Mpv, key: &str) {
    let reset = mpv
        .get_string(&format!("option-info/{key}/default-value"))
        .and_then(|default| mpv.set_property(key, &default));
    if let Err(error) = reset {
        tracing::warn!("cannot put {key} back to mpv's default: {error}");
    }
}

/// An audio output from mpv's `audio-device-list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioDevice {
    /// What `audio-device` takes (`auto`, `wasapi/{...}`).
    pub name: String,
    /// What the user reads.
    #[serde(default)]
    pub description: String,
}

/// The audio outputs mpv offers, `auto` first. Waits for mpv, so not on the main thread.
pub fn audio_devices(engine: &Engine) -> Vec<AudioDevice> {
    let list = engine.call(|mpv| {
        mpv.get_string("audio-device-list")
            .map_err(|error| error.to_string())
    });
    // A node property: mpv gives it as JSON text.
    match list.map(|json| serde_json::from_str::<Vec<AudioDevice>>(&json)) {
        Ok(Ok(devices)) => devices,
        Ok(Err(error)) => {
            tracing::warn!("cannot read mpv's audio-device-list: {error}");
            Vec::new()
        }
        Err(error) => {
            tracing::warn!("mpv has no audio-device-list: {error}");
            Vec::new()
        }
    }
}

/// The files directly in `config_dir/shaders` whose names `glsl-shaders` may hold, sorted.
pub fn list_shaders(config_dir: &Path) -> Vec<String> {
    let entries = match fs::read_dir(config_dir.join(SHADERS_DIR)) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!("cannot list the shaders folder: {error}");
            }
            return Vec::new();
        }
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| mpv_keys::is_plain_file_name(name))
        .collect();
    names.sort_by_cached_key(|name| name.to_lowercase());
    names
}

// ---------------------------------------------------------------------------------------------
// Shortcuts

/// One change of input.conf (and of the player's bindings with it) at a time, for the reasons
/// of [`MPV_CONF_WRITES`].
static INPUT_CONF_WRITES: Mutex<()> = Mutex::new(());

fn input_conf_turn() -> MutexGuard<'static, ()> {
    INPUT_CONF_WRITES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// A change of input.conf that is worked out but not written yet.
struct InputConfEdit<T> {
    path: PathBuf,
    text: String,
    changed: String,
    result: T,
}

impl<T> InputConfEdit<T> {
    /// Writes the file atomically, unless the edit changed nothing.
    fn write(self) -> Result<T, SettingsError> {
        if self.changed != self.text {
            write_atomic(&self.path, self.changed.as_bytes()).map_err(SettingsError::io)?;
        }
        Ok(self.result)
    }
}

/// Applies `edit` to `config_dir/input.conf`, gently ([`InputConf`]), without writing the file
/// (that is [`InputConfEdit::write`]). A missing file counts as Kaleido's default one, which is
/// what the start puts there: a file of a line or two would take the other shortcuts away. A
/// file that is not UTF-8 is left alone.
fn edit_input_conf<T>(
    config_dir: &Path,
    edit: impl FnOnce(&mut InputConf) -> Result<T, SettingsError>,
) -> Result<InputConfEdit<T>, SettingsError> {
    let path = config_dir.join(INPUT_CONF);
    let text = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            SettingsError::io("input.conf is not UTF-8 text; Kaleido leaves it alone")
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => DEFAULT_INPUT_CONF.to_owned(),
        Err(error) => return Err(SettingsError::io(error)),
    };
    let mut conf = InputConf::parse(&text);
    let result = edit(&mut conf)?;
    Ok(InputConfEdit {
        path,
        changed: conf.render(),
        text,
        result,
    })
}

/// [`edit_input_conf`] and write: the file changes atomically, and only if the edit succeeds and
/// changes something. Gives back what `edit` returns.
fn rewrite_input_conf<T>(
    config_dir: &Path,
    edit: impl FnOnce(&mut InputConf) -> Result<T, SettingsError>,
) -> Result<T, SettingsError> {
    edit_input_conf(config_dir, edit)?.write()
}

/// mpv's `input-bindings`, all of them. Waits for mpv, so not on the main thread.
fn raw_bindings(engine: &Engine) -> Result<Vec<bindings::RawBinding>, SettingsError> {
    // A node property: mpv gives it as JSON text.
    let listed = engine
        .call(|mpv| {
            mpv.get_string("input-bindings")
                .map_err(|error| error.to_string())
        })
        .and_then(|json| bindings::parse_raw(&json).map_err(|error| error.to_string()));
    listed.map_err(|error| {
        tracing::warn!("cannot read mpv's input-bindings: {error}");
        SettingsError::Unavailable
    })
}

/// The commands of Kaleido's own input.conf, by key.
fn kaleido_commands() -> HashMap<String, String> {
    InputConf::parse(DEFAULT_INPUT_CONF).commands()
}

/// The bindings that are active, one for each key, with where each comes from (spec 8.10): the
/// player's, so scripts' too. A key the user silenced is listed with the command `ignore`. Waits
/// for mpv, so not on the main thread.
pub fn bindings(engine: &Engine) -> Vec<Binding> {
    raw_bindings(engine)
        .map(|raw| bindings::derive(&raw, &kaleido_commands()))
        .unwrap_or_default()
}

/// Binds `new_key` to `command` and then `key` to `ignore` in the running player, in one call.
/// `new_key` goes first: mpv's `keybind` refuses a name that is no key (one that passes
/// `valid_key` still may not be), and then `key` is left as it is. `key` is a key that has a
/// binding, so its name is good.
fn move_live(
    engine: &Engine,
    key: &str,
    new_key: &str,
    command: &str,
) -> Result<(), SettingsError> {
    let (key, new_key, command) = (key.to_owned(), new_key.to_owned(), command.to_owned());
    engine.call(move |mpv| -> Result<(), SettingsError> {
        mpv.command(&["keybind", &new_key, &command])
            .map_err(|error| {
                tracing::warn!("mpv does not take {new_key} as a key: {error}");
                SettingsError::invalid("newKey", "a key name mpv knows")
            })?;
        if let Err(error) = mpv.command(&["keybind", &key, "ignore"]) {
            tracing::warn!("cannot silence {key} in the player: {error}");
        }
        Ok(())
    })
}

/// Moves the command of the binding that is active for `key` to `new_key` and silences `key`:
/// `new_key <command>` and `key ignore` are bound in the running player and go to input.conf
/// (gently, atomically). The command comes from the binding itself (see
/// [`bindings::move_binding`]); the UI never sends one. A `new_key` that is bound already is
/// overridden: input.conf's last line of a key wins in mpv, and what it had before is then only
/// shadowed (a default of mpv comes back if the line is taken away).
///
/// The player is asked to bind first, and input.conf is written after it: a `new_key` that mpv
/// does not take is an `Invalid { key: "newKey" }` error and nothing changed. (If it is only the
/// file that cannot be written, the running player has the change until the next start.) Waits
/// for mpv, so not on the main thread.
pub fn rebind(
    engine: &Engine,
    config_dir: &Path,
    key: &str,
    new_key: &str,
) -> Result<(), SettingsError> {
    input_conf::check_key("key", key)?;
    input_conf::check_key("newKey", new_key)?;
    // The player is asked inside the turn: a change made just before is queued ahead of the
    // question, so the command moved is the one the key has now.
    let _turn = input_conf_turn();
    let current = bindings::derive(&raw_bindings(engine)?, &kaleido_commands());
    let edit = edit_input_conf(config_dir, |conf| {
        bindings::move_binding(conf, &current, key, new_key)
    })?;
    if let Some(command) = &edit.result {
        move_live(engine, key, new_key, command)?;
    }
    edit.write().map(|_| ())
}

/// Puts a key back to what it is without the user: with a line in Kaleido's default input.conf,
/// that line (in input.conf and bound in the running player); without, the key's lines go from
/// input.conf, so that the default of mpv or of a script under it is the key's again.
///
/// mpv cannot unbind a key at run time, so the running player is given what the key does
/// without the user's binding (it is listed as that again, see
/// [`bindings::fallback_command`]):
/// - a line of Kaleido's default input.conf: its command is bound;
/// - the user has no binding of their own on the key (mpv's or a plugin's is active already):
///   nothing is bound;
/// - a default of mpv or of a plugin under the user's binding: its command is bound;
/// - none of those (a binding the user made up): `ignore` is bound, so the key does nothing, as
///   it will after the next start. It is listed as `ignore` until then.
///
/// If the player's bindings cannot be read, nothing is bound and the key keeps the user's binding
/// until the next start (the reason is logged); input.conf is right in any case. Waits for mpv,
/// so not on the main thread.
pub fn reset_binding(engine: &Engine, config_dir: &Path, key: &str) -> Result<(), SettingsError> {
    input_conf::check_key("key", key)?;
    let default = input_conf::kaleido_default(key);
    let _turn = input_conf_turn();
    let fallback = match default {
        Some(_) => None,
        // Read before the file changes.
        None => raw_bindings(engine)
            .ok()
            .and_then(|raw| bindings::fallback_command(&raw, key)),
    };
    rewrite_input_conf(config_dir, |conf| conf.reset(key, default.as_deref()))?;
    if let Some(command) = default.or(fallback) {
        engine.command(&["keybind", key, &command]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::glass::{self, GlassHost, GlassReason, GlassState};
    use crate::paths::AppPaths;
    use crate::player::testing::{NoEvents, headless, temp_paths};

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn atomic_writes_replace_the_file_and_leave_no_temporary() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mpv.conf");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(files(tmp.path()), ["mpv.conf"]);

        // Into a folder that is not there: an error, and nothing is left behind.
        assert!(write_atomic(&tmp.path().join("missing").join("x.conf"), b"x").is_err());
        assert_eq!(files(tmp.path()), ["mpv.conf"]);
    }

    /// What `settings_set` does with a change of the browser for yt-dlp's cookies, without the
    /// command: the change is told once with the new choice, and with `raw_options` that is the
    /// change-list mpv gets, the key added or taken out.
    #[test]
    fn cookies_reach_mpvs_raw_options() {
        use crate::tools::mpv::raw_options;
        use serde_json::json;

        let tmp = tempfile::tempdir().unwrap();
        let mut store = SettingsStore::load(tmp.path().join(SETTINGS_FILE));
        // What `settings_set` sees: the settings before the change and after it.
        let mut change = |patch: serde_json::Value| {
            let before = store.get().clone();
            let after = store.update(patch).unwrap();
            cookies_change(&before, &after)
        };
        let command = |operation: &str, value: &str| -> Vec<String> {
            ["change-list", "ytdl-raw-options", operation, value]
                .map(str::to_owned)
                .to_vec()
        };
        let cookies = |spec: &str| json!({ "playback": { "cookiesFromBrowser": spec } });

        // Another setting is no change of the cookies.
        assert_eq!(change(json!({ "language": "cs" })), None);

        // "firefox": told once, and mpv gets the key.
        let told = change(cookies("firefox")).expect("a new choice is told");
        assert_eq!(told.as_deref(), Some("firefox"));
        assert_eq!(
            raw_options(None, told.as_deref())[1],
            command("append", "cookies-from-browser=firefox")
        );
        // The same choice again, or another playback setting: nothing to tell.
        assert_eq!(change(cookies("firefox")), None);
        assert_eq!(
            change(json!({ "playback": { "openWhilePlaying": "append" } })),
            None
        );

        // Another browser, with a profile as it goes to yt-dlp.
        let profile = r"firefox:C:\Users\Jiří Novák\AppData\Roaming\zen\Profiles\x.Default";
        assert_eq!(change(cookies(profile)), Some(Some(profile.to_owned())));
        assert_eq!(
            raw_options(None, Some(profile))[1],
            command("append", &format!("cookies-from-browser={profile}"))
        );

        // `null`: no cookies, and mpv gets the key taken out.
        let told = change(json!({ "playback": { "cookiesFromBrowser": null } }))
            .expect("no cookies is told");
        assert_eq!(told, None);
        assert_eq!(
            raw_options(None, told.as_deref())[1],
            command("remove", "cookies-from-browser")
        );
        assert_eq!(
            change(json!({ "playback": { "cookiesFromBrowser": null } })),
            None
        );
    }

    #[test]
    fn mpv_conf_is_written_gently_or_not_at_all() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(MPV_CONF);

        // Nothing to remove from a missing file: no file appears.
        write_mpv_conf(tmp.path(), "volume", None).unwrap();
        assert!(!path.exists());

        fs::write(&path, "# mine\r\nvolume=37\r\n[p]\r\nvolume=10\r\n").unwrap();
        write_mpv_conf(tmp.path(), "volume", Some("50")).unwrap();
        write_mpv_conf(tmp.path(), "hwdec", Some("no")).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# mine\r\nvolume=50\r\n# --- Kaleido ---\r\nhwdec=no\r\n[p]\r\nvolume=10\r\n"
        );

        // A line break cannot go into the file: refused, and the file stays as it was.
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            write_mpv_conf(tmp.path(), "sub-font", Some("a\nvolume=100")),
            Err(SettingsError::Invalid { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), before);

        // Not UTF-8: refused, and the file stays as it was.
        let latin1 = b"# m\xe9n\nvolume=37\n".to_vec();
        fs::write(&path, &latin1).unwrap();
        assert!(matches!(
            write_mpv_conf(tmp.path(), "volume", Some("50")),
            Err(SettingsError::Io { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), latin1);
        assert_eq!(files(tmp.path()), [MPV_CONF]);
    }

    #[test]
    fn input_conf_is_written_gently_or_not_at_all() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(INPUT_CONF);
        let parsed = || InputConf::parse(&fs::read_to_string(&path).unwrap());

        // Nothing to take away from a missing file: no file appears.
        rewrite_input_conf(tmp.path(), |conf| conf.reset("Ctrl+F11", None)).unwrap();
        assert!(!path.exists());

        // A missing file is Kaleido's default one, so that the other shortcuts stay.
        rewrite_input_conf(tmp.path(), |conf| conf.bind("Ctrl+F11", "show-text hi")).unwrap();
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .starts_with(DEFAULT_INPUT_CONF)
        );
        assert_eq!(parsed().get("Ctrl+F11").as_deref(), Some("show-text hi"));
        assert_eq!(parsed().get("s"), input_conf::kaleido_default("s"));

        // A refused edit and one that changes nothing leave the file as it was.
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            rewrite_input_conf(tmp.path(), |conf| conf.bind("a b", "x")),
            Err(SettingsError::Invalid { .. })
        ));
        rewrite_input_conf(tmp.path(), |conf| conf.bind("Ctrl+F11", "show-text hi")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);

        // Not UTF-8: refused, and the file stays as it was.
        let latin1 = b"# m\xe9n\ns shot\n".to_vec();
        fs::write(&path, &latin1).unwrap();
        assert!(matches!(
            rewrite_input_conf(tmp.path(), |conf| conf.bind("n", "x")),
            Err(SettingsError::Io { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), latin1);
        assert_eq!(files(tmp.path()), [INPUT_CONF]);
    }

    #[test]
    fn shader_list_has_only_plain_files_from_the_shaders_folder() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_shaders(tmp.path()).is_empty(), "no folder, no shaders");

        let dir = tmp.path().join("shaders");
        fs::create_dir_all(dir.join("sub")).unwrap();
        for name in ["b.glsl", "A.hook", "c;d.glsl", "sub/deep.glsl"] {
            fs::write(dir.join(name), "//").unwrap();
        }
        assert_eq!(list_shaders(tmp.path()), ["A.hook", "b.glsl"]);
    }

    /// The glass shader is the last entry; its path may hold a comma or a `;` (a user name).
    #[test]
    fn the_glass_shader_is_taken_off_the_end_of_the_list() {
        for glass in [
            r"C:\Users\Novák, Jan\AppData\Local\Kaleido\cache\shaders\kaleido-glass.glsl",
            r"C:\Users\a;b\AppData\Local\Kaleido\cache\shaders\kaleido-glass.glsl",
        ] {
            assert_eq!(without_glass(glass, glass), "");
            for separator in [";", ","] {
                assert_eq!(
                    without_glass(&format!("~~/shaders/u.glsl{separator}{glass}"), glass),
                    "~~/shaders/u.glsl"
                );
                assert_eq!(
                    without_glass(
                        &format!(
                            "~~/shaders/a, b.glsl{separator}~~/shaders/c.glsl{separator}{glass}"
                        ),
                        glass
                    ),
                    format!("~~/shaders/a, b.glsl{separator}~~/shaders/c.glsl")
                );
            }
            // Without the glass (off, or a script changed the list), nothing is taken.
            assert_eq!(
                without_glass("~~/shaders/u.glsl", glass),
                "~~/shaders/u.glsl"
            );
            assert_eq!(without_glass("", glass), "");
            // Only the whole path counts, not a file that ends the same way.
            let longer = format!("~~/shaders/x{glass}");
            assert_eq!(without_glass(&longer, glass), longer);
        }
    }

    // --- the real libmpv --------------------------------------------------------------------

    struct EngineHost(Arc<Engine>);

    impl GlassHost for EngineHost {
        fn request(&self, request: Request) {
            self.0.request(request);
        }

        fn state_changed(&self, _state: &GlassState) {}
    }

    /// A headless core on `paths` and a glass controller on it.
    fn real(paths: &AppPaths) -> (Arc<Engine>, GlassController) {
        let engine = Arc::new(Engine::start(headless(paths.clone()), NoEvents).unwrap());
        let glass = GlassController::new(
            Arc::new(EngineHost(Arc::clone(&engine))),
            glass::shader_path(&paths.cache_dir),
        );
        (engine, glass)
    }

    fn mpv_conf(paths: &AppPaths) -> String {
        fs::read_to_string(paths.config_dir.join(MPV_CONF)).unwrap()
    }

    fn property(engine: &Engine, name: &'static str) -> String {
        engine.call(move |mpv| mpv.get_string(name).unwrap())
    }

    #[test]
    fn live_settings_apply_without_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join(MPV_CONF),
            "# mine\nvolume=37\n[big]\nsub-font-size=60\n",
        )
        .unwrap();
        let (engine, glass) = real(&paths);
        let set = |key: &str, value: Option<&str>| {
            set_mpv(&engine, &glass, &paths.config_dir, key, value)
        };

        set("sub-font-size", Some("40")).unwrap();
        assert_eq!(
            engine.call(|mpv| mpv.get_f64("sub-font-size").unwrap()),
            40.0
        );
        assert_eq!(
            mpv_conf(&paths),
            "# mine\nvolume=37\n# --- Kaleido ---\nsub-font-size=40\n[big]\nsub-font-size=60\n"
        );
        let values = get_mpv(&engine, &paths.config_dir, glass.shader());
        assert_eq!(values.len(), MPV_SETTINGS.len(), "every key, set or not");
        assert_eq!(values["sub-font-size"].as_deref(), Some("40"));
        assert_eq!(values["volume"].as_deref(), Some("37"), "from mpv.conf");
        assert_eq!(
            values["hwdec"].as_deref(),
            Some(property(&engine, "hwdec").as_str())
        );

        // The default volume is written for the next start; the playing volume does not jump,
        // neither when it changes nor when it goes (Ruling R25).
        let volume = || engine.call(|mpv| mpv.get_f64("volume").unwrap());
        set("volume", Some("80")).unwrap();
        assert!(mpv_conf(&paths).lines().any(|line| line == "volume=80"));
        assert_eq!(volume(), 37.0);
        set("volume", None).unwrap();
        assert!(!mpv_conf(&paths).contains("volume="));
        assert_eq!(volume(), 37.0);
        // From the player now, in mpv.conf's short form (mpv prints 37.000000).
        let values = get_mpv(&engine, &paths.config_dir, glass.shader());
        assert_eq!(values["volume"].as_deref(), Some("37"));

        // Taken out again: the line goes and mpv is back at its default.
        set("sub-font-size", None).unwrap();
        assert!(!mpv_conf(&paths).contains("sub-font-size=40"));
        assert!(
            mpv_conf(&paths).contains("sub-font-size=60"),
            "the profile's"
        );
        let (now, default) = engine.call(|mpv| {
            (
                mpv.get_f64("sub-font-size").unwrap(),
                mpv.get_string("option-info/sub-font-size/default-value")
                    .unwrap(),
            )
        });
        assert_eq!(now, default.parse::<f64>().unwrap());
        let values = get_mpv(&engine, &paths.config_dir, glass.shader());
        assert_eq!(
            values["sub-font-size"].as_deref(),
            Some(mpv_keys::short_number(now).as_str())
        );

        // A profile applies at the next start: written, not applied.
        set("profile", Some("fast")).unwrap();
        assert!(mpv_conf(&paths).lines().any(|line| line == "profile=fast"));
        // A refused value changes nothing.
        let before = mpv_conf(&paths);
        assert!(set("sub-font-size", Some("500")).is_err());
        assert!(set("vo", Some("gpu")).is_err());
        assert_eq!(mpv_conf(&paths), before);
        assert_eq!(property(&engine, "vo"), "null");
    }

    #[test]
    fn audio_device_must_be_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let (engine, glass) = real(&paths);
        let set = |key: &str, value: Option<&str>| {
            set_mpv(&engine, &glass, &paths.config_dir, key, value)
        };

        let devices = audio_devices(&engine);
        assert!(
            devices.iter().any(|device| device.name == "auto"),
            "{devices:?}"
        );

        set("audio-device", Some("auto")).unwrap();
        assert_eq!(property(&engine, "audio-device"), "auto");
        assert!(
            mpv_conf(&paths)
                .lines()
                .any(|line| line == "audio-device=auto")
        );

        let before = mpv_conf(&paths);
        assert_eq!(
            set("audio-device", Some("nic-takoveho")),
            Err(SettingsError::NotAllowed {
                key: "audio-device".into()
            })
        );
        assert_eq!(mpv_conf(&paths), before);
        assert_eq!(property(&engine, "audio-device"), "auto");
    }

    #[test]
    fn user_shaders_keep_the_glass_shader() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let shaders = paths.config_dir.join("shaders");
        fs::create_dir_all(&shaders).unwrap();
        for name in ["user.glsl", "other.glsl"] {
            fs::write(shaders.join(name), "// a user shader\n").unwrap();
        }
        let (engine, glass) = real(&paths);
        let set = |value: Option<&str>| {
            set_mpv(&engine, &glass, &paths.config_dir, "glsl-shaders", value)
        };
        let listed = || property(&engine, "glsl-shaders");
        let shown = || get_mpv(&engine, &paths.config_dir, glass.shader())["glsl-shaders"].clone();

        set(Some("user.glsl;~~/shaders/other.glsl")).unwrap();
        let list = listed();
        let (user, other, ours) = (
            list.find("user.glsl"),
            list.find("other.glsl"),
            list.find("kaleido-glass.glsl"),
        );
        assert!(
            user.is_some() && other.is_some() && ours.is_some(),
            "{list}"
        );
        assert!(user < other && other < ours, "the glass comes last: {list}");
        assert_eq!(list.matches("kaleido-glass.glsl").count(), 1, "{list}");
        assert!(
            mpv_conf(&paths)
                .lines()
                .any(|line| line == "glsl-shaders=~~/shaders/user.glsl;~~/shaders/other.glsl")
        );
        assert_eq!(
            shown().as_deref(),
            Some("~~/shaders/user.glsl;~~/shaders/other.glsl")
        );

        // Fewer: the one taken out goes, the glass stays last.
        set(Some("other.glsl")).unwrap();
        let list = listed();
        assert!(!list.contains("user.glsl"), "{list}");
        assert!(
            list.contains("other.glsl") && list.contains("kaleido-glass.glsl"),
            "{list}"
        );
        assert!(
            list.find("other.glsl") < list.find("kaleido-glass.glsl"),
            "{list}"
        );

        // None: only the glass is left, and the settings do not show it.
        set(None).unwrap();
        let list = listed();
        assert!(!list.contains("other.glsl"), "{list}");
        assert_eq!(list.matches("kaleido-glass.glsl").count(), 1, "{list}");
        assert!(!mpv_conf(&paths).contains("glsl-shaders"));
        assert_eq!(shown().as_deref(), Some(""));

        // Only files from the shaders folder.
        assert!(matches!(
            set(Some("../user.glsl")),
            Err(SettingsError::Invalid { .. })
        ));
        assert!(matches!(
            set(Some("missing.glsl")),
            Err(SettingsError::NotAllowed { .. })
        ));

        // With the glass off the user's shaders are listed alone; back on, it goes after them.
        glass.set_enabled(false, GlassReason::User);
        set(Some("user.glsl")).unwrap();
        let list = listed();
        assert!(
            list.contains("user.glsl") && !list.contains("kaleido-glass"),
            "{list}"
        );
        glass.set_enabled(true, GlassReason::User);
        let list = listed();
        assert!(
            list.contains("user.glsl") && list.contains("kaleido-glass.glsl"),
            "{list}"
        );
        assert!(
            list.find("user.glsl") < list.find("kaleido-glass.glsl"),
            "{list}"
        );
    }
}
