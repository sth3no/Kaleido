//! Settings (spec 8.10): Kaleido's own in `settings.json` ([`store`]) and the mpv options the
//! settings pages manage in mpv.conf ([`mpv_keys`], written gently by [`mpv_conf`]). This module
//! wires them up for the commands: reading mpv options and setting them in mpv.conf and live,
//! the lists the values are checked against (audio devices, fonts, shaders), and the atomic
//! write both files go through.

pub mod mpv_conf;
pub mod mpv_keys;
pub mod store;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use mpv_ffi::Mpv;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection,
};
use windows::core::{BOOL, w};

use crate::glass::GlassController;
use crate::player::{Engine, LoadMode, Request};
pub use mpv_conf::MpvConf;
pub use mpv_keys::{MPV_SETTINGS, MpvSetting, ValidationCtx, ValueKind, validate_mpv};
pub use store::{
    Appearance, Language, Playback, ReduceTransparency, Settings, SettingsStore, ThemeMode,
};

/// Kaleido's settings file in `config_dir` (spec 4.3).
pub const SETTINGS_FILE: &str = "settings.json";
/// mpv's config file in `config_dir`.
pub const MPV_CONF: &str = "mpv.conf";
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

/// Why a setting was not changed. In every case nothing changed: not the file, not the player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SettingsError {
    /// Not a key the settings may change, or a value the system does not offer (an audio
    /// device, a font or a shader that is not there).
    NotAllowed { key: String },
    /// A value out of range or of the wrong form. `key` is the mpv option, or the settings.json
    /// path in camelCase (`appearance.uiScale`; a whole section when its type is wrong).
    Invalid { key: String, reason: String },
    /// The file could not be read or written.
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

/// One read-change-write of mpv.conf at a time: two settings changed at once would otherwise
/// each write the file without the other's change.
static MPV_CONF_WRITES: Mutex<()> = Mutex::new(());

/// Sets (or with `None` removes) `key` in `config_dir/mpv.conf`, gently ([`MpvConf`]) and
/// atomically. A missing file is an empty one. A file that is not UTF-8 is left alone.
pub fn write_mpv_conf(
    config_dir: &Path,
    key: &str,
    value: Option<&str>,
) -> Result<(), SettingsError> {
    let _turn = MPV_CONF_WRITES
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let path = config_dir.join(MPV_CONF);
    let text = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            SettingsError::io("mpv.conf is not UTF-8 text; Kaleido leaves it alone")
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(SettingsError::io(error)),
    };
    let mut conf = MpvConf::parse(&text);
    conf.set(key, value);
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
/// there, else the player's current value (`None` if mpv has none). The glass shader is not the
/// user's and never shows in `glsl-shaders`. Waits for mpv, so not on the main thread.
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
                    ValueKind::Shaders => value.map(|list| without_entry(&list, &glass_shader)),
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

/// `list` (`glsl-shaders` as mpv prints it) without `entry`, matched whole. mpv joins a path
/// list with `;` on Windows or with `,`; whichever splits `entry` out is used.
fn without_entry(list: &str, entry: &str) -> String {
    if list == entry {
        return String::new();
    }
    for separator in [';', ','] {
        let parts: Vec<&str> = list.split(separator).collect();
        if parts.contains(&entry) {
            return parts
                .into_iter()
                .filter(|part| *part != entry)
                .collect::<Vec<_>>()
                .join(&separator.to_string());
        }
    }
    list.to_owned()
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
    write_mpv_conf(config_dir, setting.key, value.as_deref())?;
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

/// The font families installed on Windows (DirectWrite), as libass finds them: English names
/// where a family has one, without duplicates, sorted. Read once and kept.
pub fn system_fonts() -> &'static [String] {
    static FONTS: OnceLock<Vec<String>> = OnceLock::new();
    FONTS.get_or_init(|| {
        font_families().unwrap_or_else(|error| {
            tracing::error!("cannot list the system fonts: {error}");
            Vec::new()
        })
    })
}

fn font_families() -> windows::core::Result<Vec<String>> {
    // SAFETY: DirectWrite calls on the interfaces it returned; the out pointer is a local.
    let collection = unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        let mut collection = None;
        factory.GetSystemFontCollection(&mut collection, false)?;
        collection
    };
    let Some(collection) = collection else {
        return Ok(Vec::new());
    };
    // SAFETY: as above.
    let count = unsafe { collection.GetFontFamilyCount() };
    let mut families = BTreeSet::new();
    for index in 0..count {
        match family_name(&collection, index) {
            Ok(name) if !name.is_empty() => {
                families.insert(name);
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("font family {index} has no name: {error}"),
        }
    }
    let mut families: Vec<String> = families.into_iter().collect();
    families.sort_by_cached_key(|name| name.to_lowercase());
    Ok(families)
}

/// The family's en-us name, else its first.
fn family_name(collection: &IDWriteFontCollection, index: u32) -> windows::core::Result<String> {
    // SAFETY: DirectWrite calls on the interfaces it returned; the buffer holds the string's
    // length plus its terminating NUL, as GetString needs.
    unsafe {
        let names = collection.GetFontFamily(index)?.GetFamilyNames()?;
        let mut at = 0;
        let mut exists = BOOL::default();
        names.FindLocaleName(w!("en-us"), &mut at, &mut exists)?;
        if !exists.as_bool() {
            at = 0;
        }
        let length = names.GetStringLength(at)? as usize;
        let mut buffer = vec![0u16; length + 1];
        names.GetString(at, &mut buffer)?;
        Ok(String::from_utf16_lossy(&buffer[..length]))
    }
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

    #[test]
    fn without_entry_takes_out_the_whole_entry_only() {
        let glass = r"C:\Users\a, b\AppData\Local\Kaleido\cache\shaders\kaleido-glass.glsl";
        assert_eq!(without_entry(glass, glass), "");
        assert_eq!(
            without_entry(&format!("~~/shaders/u.glsl;{glass}"), glass),
            "~~/shaders/u.glsl"
        );
        assert_eq!(
            without_entry(&format!("~~/shaders/u.glsl,{glass}"), "x-glass.glsl"),
            format!("~~/shaders/u.glsl,{glass}"),
            "another file stays"
        );
        assert_eq!(
            without_entry("a.glsl,kaleido-glass.glsl,b.glsl", "kaleido-glass.glsl"),
            "a.glsl,b.glsl"
        );
        assert_eq!(without_entry("", glass), "");
    }

    /// DirectWrite needs no window; every Windows has Segoe UI.
    #[test]
    fn system_fonts_are_sorted_unique_and_include_segoe_ui() {
        let fonts = system_fonts();
        assert!(fonts.iter().any(|font| font == "Segoe UI"), "{fonts:?}");
        let mut sorted = fonts.to_vec();
        sorted.sort_by_cached_key(|name| name.to_lowercase());
        assert_eq!(fonts, sorted.as_slice());
        let unique: BTreeSet<&String> = fonts.iter().collect();
        assert_eq!(unique.len(), fonts.len());
        assert!(std::ptr::eq(fonts, system_fonts()), "read once");
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
