//! Kaleido's own settings in `settings.json` (spec 4.3, 8.10): language, appearance and how a
//! file opened during playback is played. The store holds valid settings only: a change is
//! merged in, checked and written atomically, or nothing changes; a file with a bad field keeps
//! its other fields (Ruling R23). It knows nothing of Tauri, so it can be tested on its own;
//! the command layer tells the UI (`settings:changed`).

use std::fs;
use std::io;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{SettingsError, is_hex_color, write_atomic};
use crate::player::LoadMode;

/// The version of the file's layout this Kaleido writes and reads.
pub const SETTINGS_VERSION: u32 = 1;
/// The accent that is not one colour: Kaleido's rainbow.
pub const ACCENT_KALEIDO: &str = "kaleido";

pub const GLASS_OPACITY: RangeInclusive<f64> = 0.3..=0.95;
pub const BLUR: RangeInclusive<f64> = 0.0..=40.0;
pub const SATURATION: RangeInclusive<f64> = 0.5..=2.0;
pub const RADIUS: RangeInclusive<f64> = 0.0..=28.0;
/// Spec 8.9: 90 to 150 %.
pub const UI_SCALE: RangeInclusive<f64> = 0.9..=1.5;

/// A missing key takes its default, so an older file still loads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub language: Language,
    pub appearance: Appearance,
    pub playback: Playback,
    /// Top-level keys of the file this Kaleido does not know (a newer one's, say): kept as they
    /// are. A change cannot add, change or remove them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            version: SETTINGS_VERSION,
            language: Language::default(),
            appearance: Appearance::default(),
            playback: Playback::default(),
            extra: Map::new(),
        }
    }
}

/// `System` follows Windows: Czech for Czech, English otherwise (spec 8.8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    System,
    Cs,
    En,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Dark,
    Light,
}

/// `Auto` follows Windows' transparency effects.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReduceTransparency {
    #[default]
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub mode: ThemeMode,
    /// [`ACCENT_KALEIDO`] or `#RRGGBB`.
    pub accent: String,
    /// `#RRGGBB`.
    pub glass_tint: String,
    /// [`GLASS_OPACITY`].
    pub glass_opacity: f64,
    /// [`BLUR`], px.
    pub blur: f64,
    /// [`SATURATION`].
    pub saturation: f64,
    /// [`RADIUS`], px.
    pub radius: f64,
    pub mica: bool,
    pub reduce_transparency: ReduceTransparency,
    /// [`UI_SCALE`].
    pub ui_scale: f64,
}

impl Default for Appearance {
    fn default() -> Appearance {
        Appearance {
            mode: ThemeMode::System,
            accent: ACCENT_KALEIDO.to_owned(),
            glass_tint: "#16161c".to_owned(),
            glass_opacity: 0.55,
            blur: 24.0,
            saturation: 1.4,
            radius: 20.0,
            mica: true,
            reduce_transparency: ReduceTransparency::Auto,
            ui_scale: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Playback {
    /// What a file opened while another plays does (spec 8.10, 9.3).
    pub open_while_playing: LoadMode,
}

impl Default for Playback {
    fn default() -> Playback {
        Playback {
            open_while_playing: LoadMode::Replace,
        }
    }
}

impl Settings {
    /// Every value within its limits; the first that is not is the error, named by its path.
    pub fn validate(&self) -> Result<(), SettingsError> {
        if self.version != SETTINGS_VERSION {
            return Err(SettingsError::invalid(
                "version",
                &format!("this Kaleido knows version {SETTINGS_VERSION}"),
            ));
        }
        let appearance = &self.appearance;
        if appearance.accent != ACCENT_KALEIDO && !is_hex_color(&appearance.accent, &[6]) {
            return Err(SettingsError::invalid(
                "appearance.accent",
                "\"kaleido\" or #RRGGBB",
            ));
        }
        if !is_hex_color(&appearance.glass_tint, &[6]) {
            return Err(SettingsError::invalid("appearance.glassTint", "#RRGGBB"));
        }
        for (key, value, range) in [
            (
                "appearance.glassOpacity",
                appearance.glass_opacity,
                GLASS_OPACITY,
            ),
            ("appearance.blur", appearance.blur, BLUR),
            ("appearance.saturation", appearance.saturation, SATURATION),
            ("appearance.radius", appearance.radius, RADIUS),
            ("appearance.uiScale", appearance.ui_scale, UI_SCALE),
        ] {
            if !range.contains(&value) {
                return Err(SettingsError::invalid(
                    key,
                    &format!("from {} to {}", range.start(), range.end()),
                ));
            }
        }
        Ok(())
    }
}

/// The settings and the file they live in.
pub struct SettingsStore {
    path: PathBuf,
    current: Settings,
    /// Why changes are not saved: the file is there but could not be read or kept safe, and
    /// writing would replace what the user has.
    refused: Option<String>,
}

impl SettingsStore {
    /// Reads the settings at `path` (Ruling R23):
    /// - missing: the defaults; nothing is written until something changes;
    /// - not a JSON object (not JSON at all, an array, ...): moved aside to
    ///   `settings.json.bad-<unix time>`, and the defaults are used;
    /// - a JSON object: read field by field. A field of the wrong type, with an unknown variant
    ///   or out of range (a `version` other than 1 too) takes its default with a warning; the
    ///   other fields, and unknown top-level keys, are kept. The file as it was is copied to
    ///   `settings.json.bad-<unix time>`; it is rewritten at the next change;
    /// - there but unreadable, or a bad file that cannot be moved or copied aside: the defaults,
    ///   and every change is refused, so the user's file is never replaced.
    pub fn load(path: impl Into<PathBuf>) -> SettingsStore {
        let path = path.into();
        let (current, refused) = read(&path);
        SettingsStore {
            path,
            current,
            refused,
        }
    }

    pub fn get(&self) -> &Settings {
        &self.current
    }

    /// Merges `patch` into the settings (a JSON merge patch, RFC 7386: objects merge key by key,
    /// `null` removes a key, so it takes its default), checks the result and writes it
    /// atomically. A key the settings do not have is refused. On any error the file and the
    /// settings stay as they were.
    pub fn update(&mut self, patch: Value) -> Result<Settings, SettingsError> {
        if let Some(reason) = &self.refused {
            return Err(SettingsError::io(reason));
        }
        let Value::Object(changes) = &patch else {
            return Err(SettingsError::invalid("", "a change is a JSON object"));
        };
        if let Some(key) = unknown_key(changes, &known(), "") {
            return Err(SettingsError::NotAllowed { key });
        }
        let mut merged = serde_json::to_value(&self.current).map_err(SettingsError::io)?;
        merge(&mut merged, patch);
        let next = from_value(merged)?;
        next.validate()?;
        let mut text = serde_json::to_string_pretty(&next).map_err(SettingsError::io)?;
        text.push('\n');
        write_atomic(&self.path, text.as_bytes()).map_err(SettingsError::io)?;
        self.current = next.clone();
        Ok(next)
    }
}

/// The settings in the file at `path`, and why changes must be refused, if they must.
fn read(path: &Path) -> (Settings, Option<String>) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return (Settings::default(), None);
        }
        Err(error) => {
            tracing::error!(
                "cannot read {}: {error}; the default settings are used and changes are not saved",
                path.display()
            );
            return (
                Settings::default(),
                Some(format!("settings.json cannot be read: {error}")),
            );
        }
    };
    let object = match json_object(&bytes) {
        Ok(object) => object,
        Err(reason) => {
            // Not settings at all: out of the way, so the user still has it.
            let aside = aside(path);
            return match fs::rename(path, &aside) {
                Ok(()) => {
                    tracing::error!(
                        "{} is not settings ({reason}); it is kept as {} and the default settings \
                         are used",
                        path.display(),
                        aside.display()
                    );
                    (Settings::default(), None)
                }
                Err(error) => {
                    tracing::error!(
                        "{} is not settings ({reason}) and cannot be moved aside ({error}); the \
                         default settings are used and changes are not saved",
                        path.display()
                    );
                    (
                        Settings::default(),
                        Some(format!(
                            "settings.json is not valid and cannot be moved aside: {error}"
                        )),
                    )
                }
            };
        }
    };
    let (settings, fallen) = lenient(object);
    if fallen.is_empty() {
        return (settings, None);
    }
    for key in &fallen {
        tracing::warn!("settings.json: {key} is not valid; it takes its default");
    }
    let aside = aside(path);
    match fs::copy(path, &aside) {
        Ok(_) => {
            tracing::warn!("settings.json as it was is kept as {}", aside.display());
            (settings, None)
        }
        Err(error) => {
            tracing::error!(
                "cannot keep a copy of {} ({error}); the default settings are used and changes \
                 are not saved",
                path.display()
            );
            (
                Settings::default(),
                Some(format!("a copy of settings.json cannot be made: {error}")),
            )
        }
    }
}

/// The JSON object in a file's bytes, or why there is none.
fn json_object(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    // Notepad may have saved it with a BOM.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match serde_json::from_slice(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err("not a JSON object".to_owned()),
        Err(error) => Err(error.to_string()),
    }
}

/// The settings in `object`, field by field: a field that does not fit (wrong type, unknown
/// variant, out of range) is taken out, so that it takes its default, and the rest is read
/// again. Returns the settings and the paths of the fields taken out.
fn lenient(mut object: Map<String, Value>) -> (Settings, Vec<String>) {
    let mut fallen = Vec::new();
    loop {
        let bad = match Settings::deserialize(&Value::Object(object.clone())) {
            Ok(settings) => match settings.validate() {
                Ok(()) => return (settings, fallen),
                Err(SettingsError::Invalid { key, .. }) => Some(key),
                Err(_) => None,
            },
            Err(_) => misfit(&object),
        };
        match bad {
            Some(key) if take_out(&mut object, &key) => fallen.push(key),
            // Nothing to take out; cannot happen, as every default fits. Counted as a fallback,
            // so the file is copied before anything replaces it.
            _ => {
                fallen.push("settings".to_owned());
                return (Settings::default(), fallen);
            }
        }
    }
}

/// Typed settings from JSON; the error names the field whose value does not fit.
fn from_value(value: Value) -> Result<Settings, SettingsError> {
    Settings::deserialize(&value).map_err(|error| {
        let key = value.as_object().and_then(misfit).unwrap_or_default();
        SettingsError::invalid(&key, &error.to_string())
    })
}

/// The first known key whose value is not of its type: `version`, `language`, or a field of
/// `appearance` or `playback` (the whole section if it is not an object).
fn misfit(object: &Map<String, Value>) -> Option<String> {
    fn fits<T: DeserializeOwned>(value: &Value) -> bool {
        T::deserialize(value).is_ok()
    }
    /// The field of a section that does not fit when it is read alone.
    fn field<T: DeserializeOwned>(section: &str, value: &Value) -> String {
        let bad = value.as_object().and_then(|fields| {
            fields.iter().find(|&(key, value)| {
                let alone = Map::from_iter([(key.clone(), value.clone())]);
                !fits::<T>(&Value::Object(alone))
            })
        });
        match bad {
            Some((key, _)) => format!("{section}.{key}"),
            None => section.to_owned(),
        }
    }
    let unfit = |key: &str, fits: fn(&Value) -> bool| object.get(key).is_some_and(|v| !fits(v));
    if unfit("version", fits::<u32>) {
        return Some("version".to_owned());
    }
    if unfit("language", fits::<Language>) {
        return Some("language".to_owned());
    }
    if let Some(value) = object.get("appearance")
        && !fits::<Appearance>(value)
    {
        return Some(field::<Appearance>("appearance", value));
    }
    if let Some(value) = object.get("playback")
        && !fits::<Playback>(value)
    {
        return Some(field::<Playback>("playback", value));
    }
    None
}

/// Takes `path` (`key` or `section.key`) out of `object`; whether it was there.
fn take_out(object: &mut Map<String, Value>, path: &str) -> bool {
    match path.split_once('.') {
        None => object.remove(path).is_some(),
        Some((section, key)) => object
            .get_mut(section)
            .and_then(Value::as_object_mut)
            .is_some_and(|fields| fields.remove(key).is_some()),
    }
}

/// Every key the settings have, as the file holds them.
fn known() -> Map<String, Value> {
    match serde_json::to_value(Settings::default()) {
        Ok(Value::Object(known)) => known,
        // Cannot happen; then nothing is known and every change is refused.
        _ => Map::new(),
    }
}

/// The first key of `patch` that `known` does not have, as its path.
fn unknown_key(
    patch: &Map<String, Value>,
    known: &Map<String, Value>,
    prefix: &str,
) -> Option<String> {
    patch.iter().find_map(|(key, value)| {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match (known.get(key), value) {
            (None, _) => Some(path),
            (Some(Value::Object(fields)), Value::Object(changes)) => {
                unknown_key(changes, fields, &path)
            }
            _ => None,
        }
    })
}

/// RFC 7386: `patch` into `target`.
fn merge(target: &mut Value, patch: Value) {
    let Value::Object(patch) = patch else {
        *target = patch;
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    if let Value::Object(target) = target {
        for (key, value) in patch {
            if value.is_null() {
                target.remove(&key);
            } else {
                merge(target.entry(key).or_insert(Value::Null), value);
            }
        }
    }
}

/// Where a bad settings file is kept for the user: `settings.json.bad-<unix time>`. Any file
/// Kaleido keeps aside is named so (`plugins.json` too).
pub(crate) fn aside(path: &Path) -> PathBuf {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".bad-{seconds}"));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn file(dir: &Path) -> PathBuf {
        dir.join("settings.json")
    }

    /// The names of the files in `dir`.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// The one `settings.json.bad-<unix time>` in `dir`, as text.
    fn kept_aside(dir: &Path) -> String {
        let bad: Vec<String> = names(dir)
            .into_iter()
            .filter(|name| name.starts_with("settings.json.bad-"))
            .collect();
        assert_eq!(bad.len(), 1, "{bad:?}");
        let stamp = bad[0].strip_prefix("settings.json.bad-").unwrap();
        assert!(
            !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()),
            "{}",
            bad[0]
        );
        fs::read_to_string(dir.join(&bad[0])).unwrap()
    }

    #[test]
    fn settings_defaults_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = file(tmp.path());
        let store = SettingsStore::load(&path);

        assert_eq!(*store.get(), Settings::default());
        assert!(!path.exists(), "nothing is written until something changes");
        // What the file and the UI see (Ruling R22).
        assert_eq!(
            serde_json::to_value(store.get()).unwrap(),
            json!({
                "version": 1,
                "language": "system",
                "appearance": {
                    "mode": "system",
                    "accent": "kaleido",
                    "glassTint": "#16161c",
                    "glassOpacity": 0.55,
                    "blur": 24.0,
                    "saturation": 1.4,
                    "radius": 20.0,
                    "mica": true,
                    "reduceTransparency": "auto",
                    "uiScale": 1.0
                },
                "playback": { "openWhilePlaying": "replace" }
            })
        );

        // An older file without some keys: they take their defaults, and nothing is copied.
        fs::write(&path, r#"{ "version": 1, "appearance": { "blur": 10 } }"#).unwrap();
        let store = SettingsStore::load(&path);
        assert_eq!(store.get().appearance.blur, 10.0);
        assert_eq!(store.get().appearance.ui_scale, 1.0);
        assert_eq!(store.get().language, Language::System);
        assert_eq!(store.get().playback.open_while_playing, LoadMode::Replace);
        assert_eq!(names(tmp.path()), ["settings.json"]);
        // A BOM from Notepad is fine.
        fs::write(&path, "\u{feff}{ \"language\": \"cs\" }").unwrap();
        assert_eq!(SettingsStore::load(&path).get().language, Language::Cs);
    }

    /// Only a file that is not a JSON object is moved aside (Ruling R23).
    #[test]
    fn corrupt_settings_are_kept_aside_and_defaults_used() {
        for broken in [
            "{not json",
            "",
            "{ \"language\": \"cs\"",
            "[1, 2]",
            "\"settings\"",
            "null",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let path = file(tmp.path());
            fs::write(&path, broken).unwrap();

            let mut store = SettingsStore::load(&path);
            assert_eq!(*store.get(), Settings::default(), "{broken}");
            assert!(!path.exists(), "moved, not copied: {broken}");
            assert_eq!(kept_aside(tmp.path()), broken);

            // The next change writes a good file; the bad one stays for the user.
            store.update(json!({ "language": "en" })).unwrap();
            assert_eq!(SettingsStore::load(&path).get().language, Language::En);
            assert_eq!(kept_aside(tmp.path()), broken);
            assert_eq!(names(tmp.path()).len(), 2);
        }
    }

    #[test]
    fn one_bad_field_takes_its_default_and_keeps_the_others() {
        let tmp = tempfile::tempdir().unwrap();
        let path = file(tmp.path());
        let text = r##"{
            "language": "cs",
            "appearance": { "uiScale": 7, "blur": 10, "accent": "#112233", "radius": 30 },
            "playback": { "openWhilePlaying": "append" },
            "plugins": { "autoUpdate": true }
        }"##;
        fs::write(&path, text).unwrap();

        let mut store = SettingsStore::load(&path);
        let settings = store.get();
        assert_eq!(
            settings.appearance.ui_scale, 1.0,
            "out of range: the default"
        );
        assert_eq!(
            settings.appearance.radius, 20.0,
            "out of range: the default"
        );
        assert_eq!(settings.appearance.blur, 10.0);
        assert_eq!(settings.appearance.accent, "#112233");
        assert_eq!(settings.language, Language::Cs);
        assert_eq!(settings.playback.open_while_playing, LoadMode::Append);
        assert_eq!(settings.extra["plugins"], json!({ "autoUpdate": true }));
        // The file as it was is copied; the file itself stays until the next change.
        assert_eq!(kept_aside(tmp.path()), text);
        assert_eq!(fs::read_to_string(&path).unwrap(), text);

        store
            .update(json!({ "appearance": { "mica": false } }))
            .unwrap();
        let written: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["appearance"]["uiScale"], 1.0);
        assert_eq!(written["appearance"]["blur"], 10.0);
        assert_eq!(written["appearance"]["mica"], false);
        assert_eq!(written["plugins"], json!({ "autoUpdate": true }));
        assert_eq!(kept_aside(tmp.path()), text, "the copy stays as it was");
    }

    #[test]
    fn an_unknown_variant_falls_back_for_that_field_only() {
        let tmp = tempfile::tempdir().unwrap();
        let path = file(tmp.path());
        let text = r##"{
            "language": "de",
            "appearance": { "mode": "dim", "mica": false, "glassTint": "#000000", "uiScale": "big" },
            "playback": "replace"
        }"##;
        fs::write(&path, text).unwrap();

        let store = SettingsStore::load(&path);
        let settings = store.get();
        assert_eq!(settings.language, Language::System);
        assert_eq!(settings.appearance.mode, ThemeMode::System);
        assert_eq!(settings.appearance.ui_scale, 1.0, "wrong type: the default");
        assert!(!settings.appearance.mica, "kept");
        assert_eq!(settings.appearance.glass_tint, "#000000", "kept");
        assert_eq!(settings.playback, Playback::default(), "not an object");
        assert_eq!(kept_aside(tmp.path()), text);
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn a_newer_version_is_read_best_effort_and_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let path = file(tmp.path());
        let text =
            r#"{ "version": 2, "language": "en", "appearance": { "blur": 5 }, "future": [1] }"#;
        fs::write(&path, text).unwrap();

        let mut store = SettingsStore::load(&path);
        assert_eq!(store.get().version, SETTINGS_VERSION);
        assert_eq!(store.get().language, Language::En);
        assert_eq!(store.get().appearance.blur, 5.0);
        assert_eq!(store.get().extra["future"], json!([1]));
        assert_eq!(kept_aside(tmp.path()), text, "the newer file is kept");
        // A change writes version 1; the copy keeps version 2.
        store.update(json!({ "language": "cs" })).unwrap();
        assert_eq!(SettingsStore::load(&path).get().language, Language::Cs);
        assert_eq!(kept_aside(tmp.path()), text);
    }

    /// A file that is there but cannot be read (here a folder of that name, as a sharing
    /// violation would be) is never replaced.
    #[test]
    fn an_unreadable_file_is_never_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let path = file(tmp.path());
        fs::create_dir(&path).unwrap();
        fs::write(path.join("inside"), "the user's").unwrap();

        let mut store = SettingsStore::load(&path);
        assert_eq!(*store.get(), Settings::default());
        assert!(matches!(
            store.update(json!({ "language": "cs" })),
            Err(SettingsError::Io { .. })
        ));
        assert_eq!(*store.get(), Settings::default());
        assert!(path.is_dir());
        assert_eq!(
            fs::read_to_string(path.join("inside")).unwrap(),
            "the user's"
        );
        assert_eq!(
            names(tmp.path()),
            ["settings.json"],
            "nothing moved or copied"
        );
    }

    #[test]
    fn unknown_settings_keys_survive_updates() {
        let tmp = tempfile::tempdir().unwrap();
        let path = file(tmp.path());
        fs::write(
            &path,
            r#"{ "version": 1, "plugins": { "autoUpdate": true }, "updates": "beta", "language": "en" }"#,
        )
        .unwrap();
        let mut store = SettingsStore::load(&path);
        assert_eq!(store.get().extra["plugins"], json!({ "autoUpdate": true }));
        assert_eq!(
            names(tmp.path()),
            ["settings.json"],
            "unknown keys are no fault"
        );

        let updated = store
            .update(json!({ "appearance": { "uiScale": 1.25 } }))
            .unwrap();
        assert_eq!(updated.appearance.ui_scale, 1.25);
        assert_eq!(updated.language, Language::En, "the rest stays");
        assert_eq!(*store.get(), updated);
        let written: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["plugins"], json!({ "autoUpdate": true }));
        assert_eq!(written["updates"], "beta");
        assert_eq!(written["appearance"]["uiScale"], 1.25);
        assert_eq!(*SettingsStore::load(&path).get(), updated, "it loads back");
        assert_eq!(
            names(tmp.path()),
            ["settings.json"],
            "no temporary file left"
        );

        // A change may name only keys the settings have; the unknown ones stay as they are.
        let before = fs::read(&path).unwrap();
        for (patch, key) in [
            (json!({ "later": { "a": 1 } }), "later"),
            (json!({ "updates": null }), "updates"),
            (json!({ "plugins": { "autoUpdate": false } }), "plugins"),
            (
                json!({ "appearance": { "uiScal": 1.2 } }),
                "appearance.uiScal",
            ),
            (
                json!({ "playback": { "shuffle": true } }),
                "playback.shuffle",
            ),
        ] {
            assert_eq!(
                store.update(patch.clone()),
                Err(SettingsError::NotAllowed { key: key.into() }),
                "{patch}"
            );
            assert_eq!(fs::read(&path).unwrap(), before, "{patch}");
        }

        // `null` on a known key: it takes its default.
        let updated = store
            .update(json!({ "appearance": { "uiScale": null } }))
            .unwrap();
        assert_eq!(updated.appearance.ui_scale, 1.0);
        assert_eq!(updated.extra["plugins"], json!({ "autoUpdate": true }));
        assert_eq!(updated.extra["updates"], "beta");
    }

    #[test]
    fn out_of_range_appearance_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let path = file(tmp.path());
        let mut store = SettingsStore::load(&path);
        store
            .update(json!({ "appearance": { "blur": 12 } }))
            .unwrap();
        let before = fs::read(&path).unwrap();

        for (patch, key) in [
            (
                json!({ "appearance": { "uiScale": 2.0 } }),
                "appearance.uiScale",
            ),
            (
                json!({ "appearance": { "uiScale": 0.8 } }),
                "appearance.uiScale",
            ),
            (
                json!({ "appearance": { "glassOpacity": 0.1 } }),
                "appearance.glassOpacity",
            ),
            (
                json!({ "appearance": { "glassOpacity": 0.96 } }),
                "appearance.glassOpacity",
            ),
            (json!({ "appearance": { "blur": 41 } }), "appearance.blur"),
            (
                json!({ "appearance": { "saturation": 0.4 } }),
                "appearance.saturation",
            ),
            (
                json!({ "appearance": { "radius": -1 } }),
                "appearance.radius",
            ),
            (
                json!({ "appearance": { "radius": 29 } }),
                "appearance.radius",
            ),
            (
                json!({ "appearance": { "accent": "rainbow" } }),
                "appearance.accent",
            ),
            (
                json!({ "appearance": { "accent": "#12345" } }),
                "appearance.accent",
            ),
            (
                json!({ "appearance": { "glassTint": "kaleido" } }),
                "appearance.glassTint",
            ),
            (
                json!({ "appearance": { "glassTint": "#16161c80" } }),
                "appearance.glassTint",
            ),
            (
                json!({ "appearance": { "uiScale": "big" } }),
                "appearance.uiScale",
            ),
            (
                json!({ "appearance": { "mode": "dim" } }),
                "appearance.mode",
            ),
            (json!({ "appearance": 5 }), "appearance"),
            (json!({ "language": "de" }), "language"),
            (
                json!({ "playback": { "openWhilePlaying": "shuffle" } }),
                "playback.openWhilePlaying",
            ),
            (json!({ "version": 2 }), "version"),
            (json!("not an object"), ""),
        ] {
            let error = store.update(patch.clone()).unwrap_err();
            assert!(
                matches!(&error, SettingsError::Invalid { key: k, .. } if k == key),
                "{patch}: {error:?}"
            );
            assert_eq!(fs::read(&path).unwrap(), before, "{patch}");
            assert_eq!(store.get().appearance.blur, 12.0, "{patch}");
        }

        // The limits themselves are allowed.
        let edges = store
            .update(json!({ "appearance": {
                "uiScale": 1.5, "glassOpacity": 0.3, "blur": 40, "saturation": 2.0,
                "radius": 0, "accent": "#A1b2C3", "glassTint": "#000000"
            } }))
            .unwrap();
        assert_eq!(edges.appearance.ui_scale, 1.5);
        assert_eq!(edges.appearance.accent, "#A1b2C3");
    }
}
