//! The essentials: the mpv scripts Kaleido bundles (spec 6.4, plan decision 1). Which ones, from
//! which commit, with which checksums, settings and managed options is pinned in one file,
//! `resources/essentials/essentials.json`. `scripts/fetch-essentials.ps1` downloads the scripts
//! from it, Tauri bundles them as `resources\essentials\<name>\<src>` next to the manifest, and
//! the license list holds the same commits.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::Context;
use serde::Deserialize;

use super::schema::{Localized, SettingSpec};

/// The manifest's file name, in `resources\essentials\` of the installation.
pub const MANIFEST: &str = "essentials.json";

/// One essential, as the manifest pins it. A key this does not know is an error, so that a
/// misspelled one cannot drop an option without a word.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Essential {
    /// The folder in `scripts\` and the key in `plugins.json`.
    pub name: String,
    /// The name mpv knows the script by (its client name): `script-message-to` and the log use it.
    pub script_name: String,
    /// The identifier the script gives `read_options`: its options are in
    /// `script-opts\<opts_name>.conf`.
    pub opts_name: String,
    /// The GitHub repository, `owner/name`.
    pub repo: String,
    /// The full commit the files are pinned to.
    pub commit: String,
    /// What the license list and the UI show: the commit, shortened.
    pub version: String,
    /// The SPDX identifier of the script's license.
    pub license: String,
    pub summary: Localized,
    pub files: Vec<EssentialFile>,
    /// The options the UI may offer to change.
    #[serde(default)]
    pub settings: Vec<SettingSpec>,
    /// The options Kaleido writes itself on every start of the player; the UI does not offer
    /// them. `{helper}` stands for `kaleido-mpv.exe` next to the app.
    #[serde(default)]
    pub managed: BTreeMap<String, String>,
}

/// One file of an essential.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EssentialFile {
    /// The path in the repository at the pinned commit, and under `resources\essentials\<name>\`
    /// in the installation.
    pub src: String,
    /// Where it goes in the config folder, with `/`: `scripts/<name>/…` or
    /// `script-opts/<opts_name>.conf`.
    pub dest: String,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
}

/// Reads the manifest, in the order the UI lists the essentials.
pub fn load_manifest(path: &Path) -> anyhow::Result<Vec<Essential>> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("cannot read the essentials manifest {}", path.display()))?;
    serde_json::from_str(&text)
        .with_context(|| format!("the essentials manifest {} is not valid", path.display()))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    use sha2::{Digest, Sha256};

    use super::*;
    use crate::plugins::schema::SettingKind;
    use crate::system::diagnostics::License;

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn manifest() -> Vec<Essential> {
        load_manifest(&repo_root().join("resources/essentials").join(MANIFEST)).unwrap()
    }

    fn is_lower_hex(text: &str, length: usize) -> bool {
        text.len() == length && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }

    #[test]
    fn the_manifest_lists_the_three_essentials() {
        // (name, script_name, opts_name), in the order the UI shows them. evafast is not one of
        // them: it has no license (plan decision 17).
        let listed: Vec<_> = manifest()
            .into_iter()
            .map(|e| (e.name, e.script_name, e.opts_name))
            .collect();
        let expected = [
            ("thumbfast", "thumbfast", "thumbfast"),
            ("sub-select", "sub_select", "sub_select"),
            ("reload", "reload", "reload"),
        ]
        .map(|(a, b, c)| (a.to_owned(), b.to_owned(), c.to_owned()));
        assert_eq!(listed, expected);
    }

    #[test]
    fn every_essential_file_goes_to_its_own_script_folder() {
        for essential in manifest() {
            let folder = format!("scripts/{}/", essential.name);
            let options = format!("script-opts/{}.conf", essential.opts_name);
            for file in &essential.files {
                let inside = file
                    .dest
                    .strip_prefix(&folder)
                    .is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/'));
                assert!(
                    inside || file.dest == options,
                    "{}: {} is outside {folder} and is not {options}",
                    essential.name,
                    file.dest
                );
                assert!(
                    !file.dest.contains("..") && !file.dest.contains('\\'),
                    "{}: {}",
                    essential.name,
                    file.dest
                );
            }
            // mpv loads a script folder through its main file.
            let main = format!("{folder}main.lua");
            assert!(
                essential.files.iter().any(|file| file.dest == main),
                "{} has no {main}",
                essential.name
            );
        }
    }

    #[test]
    fn commits_and_checksums_are_pinned_in_full() {
        for essential in manifest() {
            assert!(
                is_lower_hex(&essential.commit, 40),
                "{}: {}",
                essential.name,
                essential.commit
            );
            assert_eq!(
                essential.version,
                essential.commit[..7],
                "{}: the version is the short commit",
                essential.name
            );
            assert!(!essential.files.is_empty(), "{}", essential.name);
            for file in &essential.files {
                assert!(
                    is_lower_hex(&file.sha256, 64),
                    "{}/{}: {}",
                    essential.name,
                    file.src,
                    file.sha256
                );
            }
        }
    }

    /// Spec 6.4: a license that can be passed on under the GPL-3.0-or-later of Kaleido. And the
    /// hand-written list of licenses (`extra.json`, the About page) has the same entry.
    #[test]
    fn every_essential_has_a_gpl_compatible_license_entry() {
        const COMPATIBLE: [&str; 7] = [
            "MPL-2.0",
            "MIT",
            "Unlicense",
            "GPL-3.0-or-later",
            "GPL-2.0-or-later",
            "BSD-2-Clause",
            "ISC",
        ];
        let extra = fs::read_to_string(repo_root().join("resources/licenses/extra.json")).unwrap();
        let extra: Vec<License> = serde_json::from_str(&extra).unwrap();

        for essential in manifest() {
            assert!(
                COMPATIBLE.contains(&essential.license.as_str()),
                "{}: {}",
                essential.name,
                essential.license
            );
            let entry = extra
                .iter()
                .find(|entry| entry.name == essential.name)
                .unwrap_or_else(|| panic!("extra.json has no {}", essential.name));
            assert_eq!(entry.license, essential.license, "{}", essential.name);
            assert_eq!(entry.version, essential.version, "{}", essential.name);
            assert_eq!(
                entry.url,
                format!(
                    "https://github.com/{}/tree/{}",
                    essential.repo, essential.commit
                ),
                "{}",
                essential.name
            );
        }
    }

    /// Needs `scripts/fetch-essentials.ps1` to have run; without `vendor/essentials` it says
    /// so and passes, so that a checkout without the downloads can still run the other tests.
    #[test]
    fn vendored_files_match_the_manifest() {
        let vendor = repo_root().join("vendor/essentials");
        if !vendor.is_dir() {
            eprintln!(
                "skipped: {} is missing (run scripts/fetch-essentials.ps1)",
                vendor.display()
            );
            return;
        }
        for essential in manifest() {
            for file in &essential.files {
                let path = vendor.join(&essential.name).join(&file.src);
                let bytes = fs::read(&path).unwrap_or_else(|error| {
                    panic!(
                        "cannot read {} (run scripts/fetch-essentials.ps1): {error}",
                        path.display()
                    )
                });
                assert_eq!(
                    format!("{:x}", Sha256::digest(&bytes)),
                    file.sha256,
                    "{}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn settings_and_managed_keys_do_not_overlap() {
        for essential in manifest() {
            let mut seen = BTreeSet::new();
            for setting in &essential.settings {
                assert!(
                    seen.insert(setting.key.as_str()),
                    "{}: {} is offered twice",
                    essential.name,
                    setting.key
                );
                assert!(
                    !essential.managed.contains_key(&setting.key),
                    "{}: {} is both offered and managed",
                    essential.name,
                    setting.key
                );
            }
        }
    }

    /// A hand-written default of the wrong type would only show when the UI draws the setting.
    #[test]
    fn every_setting_default_has_the_type_of_its_kind() {
        for essential in manifest() {
            for setting in &essential.settings {
                let default = &setting.default;
                let fits = match &setting.kind {
                    SettingKind::Bool => default.is_boolean(),
                    SettingKind::Int { min, max } => default.as_i64().is_some_and(|n| {
                        min.is_none_or(|min| n >= min) && max.is_none_or(|max| n <= max)
                    }),
                    SettingKind::Float { min, max } => default.as_f64().is_some_and(|n| {
                        min.is_none_or(|min| n >= min) && max.is_none_or(|max| n <= max)
                    }),
                    SettingKind::String | SettingKind::Color => default.is_string(),
                    SettingKind::Enum { values } => default
                        .as_str()
                        .is_some_and(|value| values.iter().any(|v| v == value)),
                };
                assert!(
                    fits,
                    "{}: the default of {} is {default} for {:?}",
                    essential.name, setting.key, setting.kind
                );
            }
        }
    }

    #[test]
    fn a_missing_or_broken_manifest_is_an_error_that_names_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join(MANIFEST);
        let error = load_manifest(&missing).unwrap_err();
        assert!(format!("{error:#}").contains(MANIFEST), "{error:#}");

        fs::write(&missing, "[{ \"name\": \"thumbfast\" }]").unwrap();
        let error = load_manifest(&missing).unwrap_err();
        assert!(format!("{error:#}").contains(MANIFEST), "{error:#}");
    }

    /// A misspelled key would otherwise be dropped without a word, and the option it should
    /// have carried would never be written or checked.
    #[test]
    fn a_manifest_with_a_misspelled_key_is_refused() {
        let shipped =
            fs::read_to_string(repo_root().join("resources/essentials").join(MANIFEST)).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(MANIFEST);

        // The control: the shipped text itself loads from here.
        fs::write(&path, &shipped).unwrap();
        load_manifest(&path).unwrap();

        // An essential's key and a file's key.
        for (key, misspelled) in [("\"managed\"", "\"manged\""), ("\"sha256\"", "\"sha265\"")] {
            let broken = shipped.replacen(key, misspelled, 1);
            assert_ne!(broken, shipped, "{key} is in the manifest");
            fs::write(&path, broken).unwrap();
            let error = format!("{:#}", load_manifest(&path).unwrap_err());
            assert!(
                error.contains(&misspelled.replace('"', "")),
                "{misspelled}: {error}"
            );
        }
    }
}
