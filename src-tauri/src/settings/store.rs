//! Kaleido's own settings in `settings.json` (spec 4.3, 8.10): language, appearance and how a
//! file opened during playback is played. The store holds valid settings only: a change is
//! merged in, checked and written atomically, or nothing changes. It knows nothing of Tauri, so
//! it can be tested on its own; the command layer tells the UI (`settings:changed`).

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
    /// Top-level keys this Kaleido does not know (a newer one's, say): kept as they are.
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
    /// Every value within its limits; the first that is not is the error.
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
}

impl SettingsStore {
    /// Reads the settings at `path`. A missing file gives the defaults (nothing is written until
    /// something changes). A file that cannot be used (not JSON, wrong types, values out of
    /// range) is moved aside to `settings.json.bad-<unix time>` for the user, and the defaults
    /// are used.
    pub fn load(path: impl Into<PathBuf>) -> SettingsStore {
        let path = path.into();
        let current = match fs::read(&path) {
            Ok(bytes) => match parse(&bytes) {
                Ok(settings) => settings,
                Err(reason) => {
                    set_aside(&path, &reason);
                    Settings::default()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Settings::default(),
            Err(error) => {
                tracing::error!(
                    "cannot read {}: {error}; the default settings are used",
                    path.display()
                );
                Settings::default()
            }
        };
        SettingsStore { path, current }
    }

    pub fn get(&self) -> &Settings {
        &self.current
    }

    /// Merges `patch` into the settings (a JSON merge patch, RFC 7386: objects merge key by key,
    /// `null` removes a key, so a known one takes its default), checks the result and writes it
    /// atomically. On any error the file and the settings stay as they were.
    pub fn update(&mut self, patch: Value) -> Result<Settings, SettingsError> {
        if !patch.is_object() {
            return Err(SettingsError::invalid("", "a change is a JSON object"));
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

/// The settings in a file's bytes, or why there are none.
fn parse(bytes: &[u8]) -> Result<Settings, String> {
    // Notepad may have saved it with a BOM.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if !value.is_object() {
        return Err("not a JSON object".to_owned());
    }
    let settings = from_value(value).map_err(|error| error.to_string())?;
    settings.validate().map_err(|error| error.to_string())?;
    Ok(settings)
}

/// Typed settings from JSON; the error names the top-level key whose value does not fit.
fn from_value(value: Value) -> Result<Settings, SettingsError> {
    match Settings::deserialize(&value) {
        Ok(settings) => Ok(settings),
        Err(error) => Err(SettingsError::invalid(misfit(&value), &error.to_string())),
    }
}

/// The first known top-level key whose value is not of its type.
fn misfit(value: &Value) -> &'static str {
    fn fits<T: DeserializeOwned>(value: &Value, key: &str) -> bool {
        value
            .get(key)
            .is_none_or(|section| T::deserialize(section).is_ok())
    }
    if !fits::<u32>(value, "version") {
        "version"
    } else if !fits::<Language>(value, "language") {
        "language"
    } else if !fits::<Appearance>(value, "appearance") {
        "appearance"
    } else if !fits::<Playback>(value, "playback") {
        "playback"
    } else {
        ""
    }
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

/// Moves a file that cannot be used out of the way, so the user still has it.
fn set_aside(path: &Path, reason: &str) {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".bad-{seconds}"));
    let aside = path.with_file_name(name);
    match fs::rename(path, &aside) {
        Ok(()) => tracing::error!(
            "{} cannot be used ({reason}); it is kept as {} and the default settings are used",
            path.display(),
            aside.display()
        ),
        Err(error) => tracing::error!(
            "{} cannot be used ({reason}) nor moved aside ({error}); the default settings are used",
            path.display()
        ),
    }
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

        // An older file without some keys: they take their defaults.
        fs::write(&path, r#"{ "version": 1, "appearance": { "blur": 10 } }"#).unwrap();
        let store = SettingsStore::load(&path);
        assert_eq!(store.get().appearance.blur, 10.0);
        assert_eq!(store.get().appearance.ui_scale, 1.0);
        assert_eq!(store.get().language, Language::System);
        assert_eq!(store.get().playback.open_while_playing, LoadMode::Replace);
        // A BOM from Notepad is fine.
        fs::write(&path, "\u{feff}{ \"language\": \"cs\" }").unwrap();
        assert_eq!(SettingsStore::load(&path).get().language, Language::Cs);
    }

    #[test]
    fn corrupt_settings_are_kept_aside_and_defaults_used() {
        for broken in [
            "{not json",
            "",
            "[1, 2]",
            r#"{ "language": "de" }"#,
            r#"{ "appearance": { "uiScale": "big" } }"#,
            r#"{ "appearance": { "uiScale": 7 } }"#,
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let path = file(tmp.path());
            fs::write(&path, broken).unwrap();

            let mut store = SettingsStore::load(&path);
            assert_eq!(*store.get(), Settings::default(), "{broken}");
            let found = names(tmp.path());
            assert_eq!(found.len(), 1, "{found:?}");
            let stamp = found[0].strip_prefix("settings.json.bad-").unwrap();
            assert!(
                !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()),
                "{}",
                found[0]
            );
            assert_eq!(
                fs::read_to_string(tmp.path().join(&found[0])).unwrap(),
                broken
            );

            // The next change writes a good file; the bad one stays for the user.
            store.update(json!({ "language": "en" })).unwrap();
            assert_eq!(SettingsStore::load(&path).get().language, Language::En);
            assert_eq!(names(tmp.path()).len(), 2);
        }
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

        // `null` removes a key: an unknown one goes, a known one takes its default.
        let updated = store
            .update(json!({ "updates": null, "appearance": { "uiScale": null } }))
            .unwrap();
        assert_eq!(updated.appearance.ui_scale, 1.0);
        assert!(!updated.extra.contains_key("updates"));
        assert_eq!(updated.extra["plugins"], json!({ "autoUpdate": true }));
        // New unknown keys are kept too.
        let updated = store.update(json!({ "later": { "a": 1 } })).unwrap();
        assert_eq!(updated.extra["later"], json!({ "a": 1 }));
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
            (json!({ "appearance": { "uiScale": "big" } }), "appearance"),
            (json!({ "appearance": { "mode": "dim" } }), "appearance"),
            (json!({ "language": "de" }), "language"),
            (
                json!({ "playback": { "openWhilePlaying": "shuffle" } }),
                "playback",
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
