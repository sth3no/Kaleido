//! The registry of plugins, `plugins.json` in the config folder (spec 6.2): which plugins Kaleido
//! installed, from where, with which files (and their checksums), and whether they are on. A
//! script in `scripts\` that the registry does not know is a manual one (spec 6.2); the registry
//! only ever describes what Kaleido itself put there.
//!
//! `load` never fails and `save` is atomic, as for `settings.json`. The file is Kaleido's, but it
//! is the user's folder: keys this Kaleido does not know survive a load and a save.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::settings::store::aside;
use crate::settings::write_atomic;

/// The registry's file name in `config_dir` (spec 4.3).
pub const FILE: &str = "plugins.json";
/// The version of the file's layout this Kaleido writes and reads.
pub const VERSION: u32 = 1;

/// The whole of `plugins.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Registry {
    pub version: u32,
    /// By plugin name: the folder (or the file without its extension) in `scripts\`.
    pub plugins: BTreeMap<String, PluginRecord>,
    /// Essentials the user removed, so that the next start does not copy them again (plan
    /// decision 4). An extension of the format in spec 6.2: left out of the file while empty.
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub removed: BTreeSet<String>,
    /// Top-level keys of the file this Kaleido does not know (a newer one's, say): kept as they
    /// are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Registry {
    fn default() -> Registry {
        Registry {
            version: VERSION,
            plugins: BTreeMap::new(),
            removed: BTreeSet::new(),
            extra: Map::new(),
        }
    }
}

/// One installed plugin. The keys are camelCase in the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub source: PluginSource,
    /// The id in the store's index; only for `store` (M3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// `owner/name` on GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// What the install put in the config folder, for later checks and a clean uninstall.
    #[serde(default)]
    pub files: Vec<FileRecord>,
    /// On = in `scripts\`, off = in `scripts-disabled\`.
    pub enabled: bool,
    /// RFC 3339, UTC: `2026-10-11T12:00:00Z`.
    pub installed_at: String,
}

/// Where a plugin came from; lowercase in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginSource {
    /// An essential Kaleido ships (spec 6.4).
    Bundled,
    /// From the store's catalog (M3).
    Store,
    /// From an address the user gave (M3).
    Url,
    /// Put into `scripts\` by hand; a record is only made for it if something needs one.
    Manual,
}

/// One file a plugin brought: its path under the config folder, with `/`, and its SHA-256 as
/// lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    pub path: String,
    pub sha256: String,
}

impl Registry {
    /// Reads the registry at `path`:
    /// - missing: an empty one; nothing is written until the first [`save`](Registry::save);
    /// - not a registry this Kaleido understands (not JSON, not an object, a field of the wrong
    ///   type or an unknown `source`, a `version` other than [`VERSION`]): moved aside to
    ///   `plugins.json.bad-<unix time>` as for `settings.json` (Ruling R23), and an empty one
    ///   is used. The scripts themselves are in `scripts\`, so nothing is lost: they show up as
    ///   manual ones until the user installs again;
    /// - there but unreadable: an empty one, with an error in the log.
    pub fn load(path: impl AsRef<Path>) -> Registry {
        let path = path.as_ref();
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Registry::default(),
            Err(error) => {
                tracing::error!(
                    "cannot read {}: {error}; the plugins start without a registry",
                    path.display()
                );
                return Registry::default();
            }
        };
        match parse(&bytes) {
            Ok(registry) => registry,
            Err(reason) => {
                keep_aside(path, &reason);
                Registry::default()
            }
        }
    }

    /// Writes the registry to `path` atomically ([`write_atomic`]); the folder must be there.
    pub fn save(&self, path: impl AsRef<Path>) -> io::Result<()> {
        let mut text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        text.push('\n');
        write_atomic(path.as_ref(), text.as_bytes())
    }
}

/// The registry in a file's bytes, or why there is none.
fn parse(bytes: &[u8]) -> Result<Registry, String> {
    // Notepad may have saved it with a BOM.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let registry: Registry = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if registry.version != VERSION {
        return Err(format!(
            "version {} is not one this Kaleido knows (it knows {VERSION})",
            registry.version
        ));
    }
    Ok(registry)
}

/// Gets a registry that cannot be used out of the way, so that the user still has it: moved, or
/// copied where it cannot be moved. If neither works the next [`Registry::save`] replaces it,
/// which is all right: it only says what Kaleido installed, and the scripts are still there.
fn keep_aside(path: &Path, reason: &str) {
    let aside = aside(path);
    let kept = fs::rename(path, &aside).or_else(|_| fs::copy(path, &aside).map(|_| ()));
    match kept {
        Ok(()) => tracing::warn!(
            "{} is not a plugin registry ({reason}); it is kept as {} and the plugins start \
             without a registry",
            path.display(),
            aside.display()
        ),
        Err(error) => tracing::error!(
            "{} is not a plugin registry ({reason}) and cannot be kept aside ({error}); the \
             plugins start without a registry",
            path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The names of the files in `dir`, sorted.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// The one `plugins.json.bad-<unix time>` in `dir`, as text.
    fn kept_aside(dir: &Path) -> String {
        let bad: Vec<String> = names(dir)
            .into_iter()
            .filter(|name| name.starts_with("plugins.json.bad-"))
            .collect();
        assert_eq!(bad.len(), 1, "{bad:?}");
        let stamp = bad[0].strip_prefix("plugins.json.bad-").unwrap();
        assert!(
            !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()),
            "{}",
            bad[0]
        );
        fs::read_to_string(dir.join(&bad[0])).unwrap()
    }

    /// Spec 6.2's example, with a record of each source, one without the optional keys, a
    /// removed essential and a key a newer Kaleido might add.
    fn spec_example() -> Value {
        json!({
            "version": 1,
            "plugins": {
                "thumbfast": {
                    "source": "bundled",
                    "registryId": "thumbfast",
                    "version": "0f711de",
                    "repo": "po5/thumbfast",
                    "commit": "0f711de3138c9bd6718209d819ac54022c23ded2",
                    "files": [{
                        "path": "scripts/thumbfast/main.lua",
                        "sha256": "a3d08e71eae8b892f6cd39f9593ea219768e709312d176bca883841b156448bf"
                    }],
                    "enabled": true,
                    "installedAt": "2026-10-11T12:00:00Z"
                },
                "fancy": {
                    "source": "store",
                    "registryId": "fancy-id",
                    "version": "1.2.0",
                    "repo": "someone/fancy",
                    "commit": "0123456789abcdef0123456789abcdef01234567",
                    "files": [
                        { "path": "scripts/fancy/main.lua", "sha256": "ab" },
                        { "path": "script-opts/fancy.conf", "sha256": "cd" }
                    ],
                    "enabled": false,
                    "installedAt": "2026-10-12T08:30:00Z"
                },
                "from-a-link": {
                    "source": "url",
                    "files": [{ "path": "scripts/from-a-link/main.js", "sha256": "ef" }],
                    "enabled": true,
                    "installedAt": "2026-10-13T20:15:30Z"
                },
                "mine": {
                    "source": "manual",
                    "files": [],
                    "enabled": true,
                    "installedAt": "2026-10-14T00:00:00Z"
                }
            },
            "removed": ["reload"],
            "futureKey": { "list": [1, 2, 3], "on": true }
        })
    }

    #[test]
    fn registry_round_trips_the_spec_format() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(FILE);
        let example = spec_example();
        fs::write(&path, serde_json::to_string_pretty(&example).unwrap()).unwrap();

        let registry = Registry::load(&path);

        assert_eq!(registry.version, 1);
        assert_eq!(registry.plugins.len(), 4);
        let thumbfast = &registry.plugins["thumbfast"];
        assert_eq!(thumbfast.source, PluginSource::Bundled);
        assert_eq!(thumbfast.registry_id.as_deref(), Some("thumbfast"));
        assert_eq!(thumbfast.repo.as_deref(), Some("po5/thumbfast"));
        assert_eq!(thumbfast.files[0].path, "scripts/thumbfast/main.lua");
        assert!(thumbfast.enabled);
        assert_eq!(thumbfast.installed_at, "2026-10-11T12:00:00Z");
        assert_eq!(registry.plugins["fancy"].source, PluginSource::Store);
        assert!(!registry.plugins["fancy"].enabled);
        assert_eq!(registry.plugins["from-a-link"].source, PluginSource::Url);
        assert_eq!(registry.plugins["from-a-link"].version, None);
        assert_eq!(registry.plugins["mine"].source, PluginSource::Manual);
        assert!(registry.plugins["mine"].files.is_empty());
        assert_eq!(registry.removed, BTreeSet::from(["reload".to_owned()]));
        // A key this Kaleido does not know is kept.
        assert_eq!(
            registry.extra["futureKey"],
            json!({ "list": [1, 2, 3], "on": true })
        );

        // And written back as it was: the same keys and values, nothing added, nothing lost.
        registry.save(&path).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved, example);
        assert_eq!(Registry::load(&path), registry);
        assert_eq!(names(tmp.path()), [FILE], "no temporary file is left");

        // A BOM from Notepad is fine.
        fs::write(&path, format!("\u{feff}{example}")).unwrap();
        assert_eq!(Registry::load(&path), registry);
        assert_eq!(names(tmp.path()), [FILE]);
    }

    #[test]
    fn a_new_registry_is_the_spec_format_and_nothing_more() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(FILE);

        let registry = Registry::load(&path);
        assert_eq!(registry, Registry::default());
        assert_eq!(registry.version, 1);
        assert!(!path.exists(), "nothing is written until something saves");

        registry.save(&path).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved, json!({ "version": 1, "plugins": {} }));
        // A file with only a version is a registry too.
        fs::write(&path, r#"{ "version": 1 }"#).unwrap();
        assert_eq!(Registry::load(&path), Registry::default());
        assert_eq!(names(tmp.path()), [FILE]);
    }

    /// Only a file this Kaleido cannot use is moved aside (Ruling R23).
    #[test]
    fn a_corrupt_registry_is_kept_aside() {
        for broken in [
            "{nope",
            "",
            "{ \"version\": 1, \"plugins\": {",
            "[1, 2]",
            "null",
            // A newer layout.
            r#"{ "version": 2, "plugins": {} }"#,
            // A record of a kind this Kaleido does not know, and one without its required keys.
            r#"{ "version": 1, "plugins": { "a": { "source": "elsewhere", "enabled": true,
                "installedAt": "2026-10-11T12:00:00Z" } } }"#,
            r#"{ "version": 1, "plugins": { "a": { "source": "manual" } } }"#,
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join(FILE);
            fs::write(&path, broken).unwrap();

            let registry = Registry::load(&path);

            assert_eq!(registry, Registry::default(), "{broken}");
            assert!(!path.exists(), "moved, not left: {broken}");
            assert_eq!(kept_aside(tmp.path()), broken);

            // The next save writes a good file; the bad one stays for the user.
            registry.save(&path).unwrap();
            assert_eq!(Registry::load(&path), Registry::default());
            assert_eq!(kept_aside(tmp.path()), broken);
            assert_eq!(names(tmp.path()).len(), 2);
        }
    }
}
