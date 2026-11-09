//! The essentials: the mpv scripts Kaleido bundles (spec 6.4, plan decision 1). Which ones, from
//! which commit, with which checksums, settings and managed options is pinned in one file,
//! `resources/essentials/essentials.json`. `scripts/fetch-essentials.ps1` downloads the scripts
//! from it, Tauri bundles them as `resources\essentials\<name>\<src>` next to the manifest, and
//! the license list holds the same commits.
//!
//! Before the player core starts ([`super::Plugins::start`]), [`seed`] copies every essential
//! that is not installed yet and that the user has not removed, and [`write_managed`] writes the
//! options Kaleido sets for them into their `script-opts` files; mpv then loads them from
//! `scripts\` with the user's other scripts (plan decision 2).

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;

use super::install::{self, FileSource, InstallPlan, PlannedFile};
use super::registry::{self, PluginRecord, PluginSource, Registry};
use super::scan::{self, Found, Layout};
use super::schema::{Localized, SettingSpec};
use super::script_opts::ScriptOpts;
use crate::paths::AppPaths;
use crate::settings::{UiLanguage, write_atomic};

/// The manifest's file name, in `resources\essentials\` of the installation.
pub const MANIFEST: &str = "essentials.json";

/// What a managed value writes for the helper process the previews are made in: `kaleido-mpv.exe`
/// next to the app.
pub const HELPER: &str = "{helper}";
/// The helper's file name in `exe_dir`.
const HELPER_EXE: &str = "kaleido-mpv.exe";

/// The essential that does not start without its preferences file (plan decision 18).
pub const SUB_SELECT: &str = "sub-select";
/// sub-select's preferences, in `script-opts\`, where the script looks by default (its option
/// `config` is `~~/script-opts`).
pub const SUB_SELECT_PREFS: &str = "sub-select.json";

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

/// The installation's folder of the essentials: the manifest, and `<name>\<src>` for their files.
pub fn bundle_dir(paths: &AppPaths) -> PathBuf {
    paths.resource_dir.join("essentials")
}

/// The installation's manifest.
pub fn manifest_path(paths: &AppPaths) -> PathBuf {
    bundle_dir(paths).join(MANIFEST)
}

/// Installs every essential of `manifest` that is neither in `registry.plugins` nor in
/// `registry.removed` from the installation's bundle, with a `bundled` record, and gives the
/// names it installed, in the manifest's order. One that fails is logged and the others go on.
///
/// - A script the user put there that mpv knows by the same name (`scripts\thumbfast.lua`, a
///   folder of another name, on or off), or anything where the essential's folder would go, is
///   never replaced: that essential is not installed, and the reason is logged. Then mpv runs
///   the user's copy, and the list shows it as theirs.
/// - When sub-select has just been installed and `script-opts\sub-select.json` is not there, it
///   is written with the preferences for `language` ([`sub_select_prefs`]): sub-select does not
///   start without it. A file that is there is the user's and stays (plan decision 18).
/// - A [`refused`](Registry::refused) registry installs nothing: what it would record could not
///   be saved.
pub fn seed(
    paths: &AppPaths,
    registry: &mut Registry,
    manifest: &[Essential],
    language: UiLanguage,
) -> Vec<String> {
    if let Some(reason) = registry.refused() {
        tracing::error!("no essential is installed while plugins.json is left alone: {reason}");
        return Vec::new();
    }
    let found = scan::scan(paths);
    let bundle = bundle_dir(paths);
    let mut seeded = Vec::new();
    for essential in manifest {
        let name = &essential.name;
        if registry.plugins.contains_key(name) || registry.removed.contains(name) {
            continue;
        }
        if let Some(other) = in_the_way(paths, essential, &found) {
            tracing::warn!(
                "the essential {name} is not installed: {} is there already, and mpv would run \
                 both as {}",
                other.display(),
                essential.script_name
            );
            continue;
        }
        let plan = InstallPlan {
            name: name.clone(),
            files: essential
                .files
                .iter()
                .map(|file| PlannedFile {
                    dest: file.dest.clone(),
                    source: FileSource::Path(bundle.join(name).join(&file.src)),
                    sha256: file.sha256.clone(),
                })
                .collect(),
            record: PluginRecord {
                source: PluginSource::Bundled,
                registry_id: None,
                version: Some(essential.version.clone()),
                repo: Some(essential.repo.clone()),
                commit: Some(essential.commit.clone()),
                files: Vec::new(),
                enabled: true,
                installed_at: registry::installed_now(),
            },
        };
        match install::install(paths, registry, plan) {
            Ok(()) => {
                if name == SUB_SELECT {
                    write_sub_select_prefs(paths, language);
                }
                seeded.push(name.clone());
            }
            Err(error) => tracing::error!("the essential {name} is not installed: {error}"),
        }
    }
    seeded
}

/// What keeps `essential` from being installed, if anything: a script among `found` that mpv
/// knows by the essential's name, or whatever is where its folder would go (in `scripts\` or in
/// `scripts-disabled\`, a script or not).
fn in_the_way(paths: &AppPaths, essential: &Essential, found: &[Found]) -> Option<PathBuf> {
    if let Some(script) = found
        .iter()
        .find(|script| script.script_name == essential.script_name)
    {
        return Some(script.entry.clone());
    }
    [&paths.scripts_dir, &paths.scripts_disabled_dir]
        .into_iter()
        .map(|dir| dir.join(&essential.name))
        .find(|home| home.symlink_metadata().is_ok())
}

/// The language codes of English, which come after the user's own for subtitles.
const ENGLISH: &[&str] = &["en", "eng"];

/// sub-select's preferences (`sub-select.json`) for a user who speaks `language` (plan decision
/// 18). The first that fits the audio picks the subtitles:
/// 1. audio in the user's language: forced subtitles only, else none;
/// 2. any other audio: subtitles in the user's language, then in English.
///
/// Where neither fits (no audio track, no such subtitles), sub-select leaves mpv's choice as it is.
pub fn sub_select_prefs(language: UiLanguage) -> String {
    let own: &[&str] = match language {
        UiLanguage::Cs => &["cs", "cze", "ces"],
        UiLanguage::En => ENGLISH,
    };
    let mut subtitles = own.to_vec();
    subtitles.extend(ENGLISH.iter().copied().filter(|code| !own.contains(code)));
    format!(
        "[\n  {{ \"alang\": {own}, \"slang\": [\"forced\", \"no\"] }},\n  \
         {{ \"alang\": \"*\", \"slang\": {subtitles} }}\n]\n",
        own = json_list(own),
        subtitles = json_list(&subtitles),
    )
}

/// `["a", "b"]`. The codes are plain ASCII letters.
fn json_list(codes: &[&str]) -> String {
    let quoted: Vec<String> = codes.iter().map(|code| format!("\"{code}\"")).collect();
    format!("[{}]", quoted.join(", "))
}

/// Writes `script-opts\sub-select.json` for `language`, unless it is there: the one place
/// [`seed`] and [`write_managed`] write it.
fn write_sub_select_prefs(paths: &AppPaths, language: UiLanguage) {
    let path = paths.script_opts_dir.join(SUB_SELECT_PREFS);
    match path.try_exists() {
        // The user's, whatever it says.
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            tracing::warn!("cannot tell whether {} is there: {error}", path.display());
            return;
        }
    }
    let written = fs::create_dir_all(&paths.script_opts_dir)
        .and_then(|()| write_atomic(&path, sub_select_prefs(language).as_bytes()));
    if let Err(error) = written {
        tracing::error!(
            "sub-select will not start: cannot write {}: {error}",
            path.display()
        );
    }
}

/// Before every start of the core: for each essential of `manifest` that is installed (on or off:
/// `registry` has it, and its folder is in `scripts\` or in `scripts-disabled\`), sets its
/// `managed` options in `script-opts\<opts_name>.conf`, gently ([`ScriptOpts`]: the user's other
/// lines stay as they are) and atomically, and only when something changes. `{helper}` in a value
/// is `kaleido-mpv.exe` next to the app. The scripts read the file when they load, so a value the
/// user changed is Kaleido's again at the next start. What fails is logged.
///
/// An essential whose folder is gone gets nothing, also when a script of the user's runs under its
/// name (their own `thumbfast.lua` where `thumbfast\` was): that copy keeps the user's options.
///
/// And when sub-select is installed (on or off) and `script-opts\sub-select.json` is missing (a
/// write that failed, a file the user deleted), it is written for `language`, as [`seed`] does:
/// sub-select does not start without it. One that is there is never replaced.
pub fn write_managed(
    paths: &AppPaths,
    manifest: &[Essential],
    registry: &Registry,
    language: UiLanguage,
) {
    let found = scan::scan(paths);
    let installed = |name: &str| {
        registry.plugins.contains_key(name)
            && found
                .iter()
                .any(|script| script.layout == Layout::Folder && script.name == name)
    };
    if installed(SUB_SELECT) {
        write_sub_select_prefs(paths, language);
    }
    let helper = paths.exe_dir.join(HELPER_EXE);
    for essential in manifest {
        if essential.managed.is_empty() || !installed(&essential.name) {
            continue;
        }
        if essential
            .managed
            .values()
            .any(|value| value.contains(HELPER))
            && !helper.is_file()
        {
            tracing::error!(
                "{} will not work: the helper it runs is missing ({})",
                essential.name,
                helper.display()
            );
        }
        let path = paths
            .script_opts_dir
            .join(format!("{}.conf", essential.opts_name));
        if let Err(error) = write_options(&path, &essential.managed, &helper) {
            tracing::error!(
                "cannot write Kaleido's options of {} into {}: {error}",
                essential.name,
                path.display()
            );
        }
    }
}

/// Sets `managed` in the `script-opts` file at `path` (a missing one is empty). A file that is
/// not UTF-8 text is left alone, and so is the whole file if one value cannot be written.
fn write_options(
    path: &Path,
    managed: &BTreeMap<String, String>,
    helper: &Path,
) -> Result<(), String> {
    let text = match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| "it is not UTF-8 text, and Kaleido leaves it alone".to_owned())?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    let helper = helper.to_string_lossy();
    let mut opts = ScriptOpts::parse(&text);
    for (key, value) in managed {
        let value = value.replace(HELPER, &helper);
        opts.set(key, Some(value.as_str()))
            .map_err(|error| format!("{key} needs {error}"))?;
    }
    let changed = opts.render();
    if changed == text {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    write_atomic(path, changed.as_bytes()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    use super::*;
    use crate::player::Engine;
    use crate::player::testing::{NoEvents, clip, eventually, headless, temp_paths};
    use crate::plugins::Plugins;
    use crate::plugins::install::sha256_hex;
    use crate::plugins::registry::{FILE, FileRecord};
    use crate::plugins::scan::{Layout, scan};
    use crate::plugins::schema::SettingKind;
    use crate::plugins::testing::{put, tree};
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
            // `write_managed` would refuse the whole file for one that cannot be written.
            for (key, value) in &essential.managed {
                assert!(
                    crate::plugins::script_opts::is_valid_key(key),
                    "{}: {key}",
                    essential.name
                );
                assert!(!value.contains(['\r', '\n']), "{}: {key}", essential.name);
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

    // ---------------------------------------------------------------------------------------
    // Seeding and the managed options

    /// What the stand-in for an essential's file says: its name and its file.
    fn stand_in(essential: &str, src: &str) -> String {
        format!("-- {essential} ({src})\n")
    }

    /// The shipped manifest with each file a [`stand_in`], put into the installation's bundle
    /// under `paths`, as Tauri bundles the real ones.
    fn bundled(paths: &AppPaths) -> Vec<Essential> {
        let bundle = bundle_dir(paths);
        manifest()
            .into_iter()
            .map(|mut essential| {
                for file in &mut essential.files {
                    let contents = stand_in(&essential.name, &file.src);
                    put(&bundle.join(&essential.name).join(&file.src), &contents);
                    file.sha256 = sha256_hex(contents.as_bytes());
                }
                essential
            })
            .collect()
    }

    fn registry_file(paths: &AppPaths) -> PathBuf {
        paths.config_dir.join(FILE)
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    /// What Task 7's uninstall does: the folder goes, so does the record, and the essential is
    /// remembered as removed.
    fn uninstall(paths: &AppPaths, registry: &mut Registry, name: &str) {
        fs::remove_dir_all(paths.scripts_dir.join(name)).unwrap();
        registry.plugins.remove(name);
        registry.removed.insert(name.to_owned());
        registry.save(registry_file(paths)).unwrap();
    }

    #[test]
    fn essentials_are_seeded_once_and_never_after_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        let mut registry = Registry::load(registry_file(&paths));

        let seeded = seed(&paths, &mut registry, &manifest, UiLanguage::En);

        assert_eq!(seeded, ["thumbfast", "sub-select", "reload"]);
        for essential in &manifest {
            let name = &essential.name;
            assert_eq!(
                read(&paths.scripts_dir.join(name).join("main.lua")),
                stand_in(name, &essential.files[0].src),
                "{name}"
            );
            let record = &registry.plugins[name];
            assert_eq!(record.source, PluginSource::Bundled, "{name}");
            assert_eq!(record.registry_id, None, "{name}");
            assert_eq!(record.version.as_ref(), Some(&essential.version), "{name}");
            assert_eq!(record.repo.as_ref(), Some(&essential.repo), "{name}");
            assert_eq!(record.commit.as_ref(), Some(&essential.commit), "{name}");
            assert!(record.enabled, "{name}");
            let files: Vec<FileRecord> = essential
                .files
                .iter()
                .map(|file| FileRecord {
                    path: file.dest.clone(),
                    sha256: file.sha256.clone(),
                })
                .collect();
            assert_eq!(record.files, files, "{name}");
            OffsetDateTime::parse(&record.installed_at, &Rfc3339)
                .unwrap_or_else(|error| panic!("{name}: {}: {error}", record.installed_at));
        }
        assert_eq!(Registry::load(registry_file(&paths)), registry, "saved");
        // mpv finds them as the scripts the manifest names.
        let found: Vec<(String, String, Layout, bool)> = scan(&paths)
            .into_iter()
            .map(|script| {
                (
                    script.name,
                    script.script_name,
                    script.layout,
                    script.enabled,
                )
            })
            .collect();
        assert_eq!(
            found,
            [
                ("reload", "reload"),
                ("sub-select", "sub_select"),
                ("thumbfast", "thumbfast"),
            ]
            .map(|(name, script_name)| (
                name.to_owned(),
                script_name.to_owned(),
                Layout::Folder,
                true
            ))
        );

        // The next start: nothing to do, nothing touched.
        let before = tree(tmp.path());
        let mut registry = Registry::load(registry_file(&paths));
        assert!(seed(&paths, &mut registry, &manifest, UiLanguage::En).is_empty());
        assert_eq!(tree(tmp.path()), before);

        // Removed by the user: it does not come back at the next start.
        uninstall(&paths, &mut registry, "reload");
        let mut registry = Registry::load(registry_file(&paths));
        assert!(seed(&paths, &mut registry, &manifest, UiLanguage::En).is_empty());
        assert!(!paths.scripts_dir.join("reload").exists());
        assert!(!registry.plugins.contains_key("reload"));
        assert!(registry.removed.contains("reload"));
    }

    /// "Chyba jednoho se zaloguje a ostatní pokračují": a broken file in the installation keeps
    /// its essential out, not the others, and the next start tries again.
    #[test]
    fn an_essential_that_cannot_be_installed_leaves_the_others_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        let thumbfast = bundle_dir(&paths).join("thumbfast").join("thumbfast.lua");
        let good = read(&thumbfast);
        fs::write(&thumbfast, "-- changed after the build\n").unwrap();
        let mut registry = Registry::default();

        let seeded = seed(&paths, &mut registry, &manifest, UiLanguage::En);

        assert_eq!(seeded, ["sub-select", "reload"]);
        assert!(!paths.scripts_dir.join("thumbfast").exists());
        assert!(!registry.plugins.contains_key("thumbfast"));
        assert!(!registry.removed.contains("thumbfast"));

        fs::write(&thumbfast, good).unwrap();
        assert_eq!(
            seed(&paths, &mut registry, &manifest, UiLanguage::En),
            ["thumbfast"]
        );
    }

    /// Review focus 1: a manual copy of an essential beside the bundled one would load twice
    /// (the second as `thumbfast2`), so the bundled one is not installed, and the user's copy is
    /// never touched.
    #[test]
    fn a_manual_copy_of_an_essential_is_flagged_and_not_seeded_again() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        put(
            &paths.scripts_dir.join("thumbfast.lua"),
            "-- my thumbfast\n",
        );
        // Off, in a folder: mpv would know it as sub_select once it is on.
        put(
            &paths
                .scripts_disabled_dir
                .join("sub-select")
                .join("main.lua"),
            "-- my sub-select\n",
        );
        let users = tree(&paths.config_dir);
        let mut registry = Registry::default();

        let seeded = seed(&paths, &mut registry, &manifest, UiLanguage::Cs);

        assert_eq!(seeded, ["reload"]);
        assert_eq!(registry.plugins.keys().collect::<Vec<_>>(), ["reload"]);
        assert!(!paths.scripts_dir.join("thumbfast").exists());
        assert!(!paths.scripts_dir.join("sub-select").exists());
        assert!(
            !paths.script_opts_dir.join(SUB_SELECT_PREFS).exists(),
            "sub-select was not installed"
        );
        let now = tree(&paths.config_dir);
        for (path, contents) in &users {
            assert_eq!(now.get(path), Some(contents), "the user's {path}");
        }

        // Not at the next start either.
        let before = tree(tmp.path());
        let mut registry = Registry::load(registry_file(&paths));
        assert!(seed(&paths, &mut registry, &manifest, UiLanguage::Cs).is_empty());
        assert_eq!(tree(tmp.path()), before);
    }

    /// Whatever the user has where an essential's folder would go stays, also when it is not a
    /// script mpv would load.
    #[test]
    fn an_essential_never_replaces_a_folder_of_its_name() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        let notes = paths.scripts_dir.join("thumbfast").join("notes.txt");
        put(&notes, "the user's\n");

        let seeded = seed(&paths, &mut Registry::default(), &manifest, UiLanguage::En);

        assert_eq!(seeded, ["sub-select", "reload"]);
        assert_eq!(read(&notes), "the user's\n");
        assert_eq!(
            tree(&paths.scripts_dir.join("thumbfast")).len(),
            1,
            "only the user's file"
        );
    }

    /// Ruling R6: a registry that cannot be saved is not written to, so nothing is installed
    /// that it would not know of.
    #[test]
    fn a_refused_registry_seeds_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        fs::create_dir(registry_file(&paths)).unwrap();
        let mut registry = Registry::load(registry_file(&paths));
        assert!(registry.refused().is_some());
        let before = tree(tmp.path());

        assert!(seed(&paths, &mut registry, &manifest, UiLanguage::En).is_empty());
        assert_eq!(tree(tmp.path()), before);
    }

    #[test]
    fn managed_options_are_rewritten_before_each_start() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let mut manifest = bundled(&paths);
        let mut registry = Registry::default();
        seed(&paths, &mut registry, &manifest, UiLanguage::En);
        let conf = paths.script_opts_dir.join("thumbfast.conf");
        let helper = paths.exe_dir.join("kaleido-mpv.exe");
        let helper = helper.to_string_lossy();

        // The first start: Kaleido's options and nothing else.
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert_eq!(
            read(&conf),
            format!("mpv_path={helper}\nnetwork=no\ntone_mapping=mobius\n")
        );

        // The user changed mpv_path and added max_height, in Notepad.
        fs::write(
            &conf,
            "# mine\r\nmpv_path=C:\\mpv\\mpv.exe\r\nnetwork=no\r\ntone_mapping=mobius\r\n\
             max_height=300\r\n",
        )
        .unwrap();
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert_eq!(
            read(&conf),
            format!(
                "# mine\r\nmpv_path={helper}\r\nnetwork=no\r\ntone_mapping=mobius\r\n\
                 max_height=300\r\n"
            )
        );
        // And once more: nothing to change.
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert!(read(&conf).contains("max_height=300\r\n"));

        // Taken out by the user: back at the end. Off is still installed, and written to.
        fs::write(&conf, "network=yes\nmax_height=150\n").unwrap();
        registry.plugins.get_mut("thumbfast").unwrap().enabled = false;
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert_eq!(
            read(&conf),
            format!("network=no\nmax_height=150\nmpv_path={helper}\ntone_mapping=mobius\n")
        );

        // An essential that is not installed gets no file, one without managed options neither.
        manifest[2].managed.insert("x".to_owned(), "1".to_owned());
        registry.plugins.remove("reload");
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert!(!paths.script_opts_dir.join("reload.conf").exists());
        assert!(!paths.script_opts_dir.join("sub_select.conf").exists());

        // A file that is not UTF-8 is not Kaleido's to rewrite.
        let latin1 = b"# m\xe9n\nmpv_path=mpv\n".to_vec();
        fs::write(&conf, &latin1).unwrap();
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert_eq!(fs::read(&conf).unwrap(), latin1);
    }

    /// The managed options are for Kaleido's own copy: an essential whose folder the user deleted
    /// gets none, also when their own script of its name runs in its place, and neither does
    /// sub-select get its preferences back then. One that is off is still Kaleido's.
    #[test]
    fn managed_options_are_written_only_for_kaleidos_own_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        let mut registry = Registry::default();
        seed(&paths, &mut registry, &manifest, UiLanguage::En);
        let conf = paths.script_opts_dir.join("thumbfast.conf");
        let prefs = paths.script_opts_dir.join(SUB_SELECT_PREFS);
        // Off: moved to scripts-disabled\, written to.
        fs::create_dir_all(&paths.scripts_disabled_dir).unwrap();
        fs::rename(
            paths.scripts_dir.join("thumbfast"),
            paths.scripts_disabled_dir.join("thumbfast"),
        )
        .unwrap();
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert!(read(&conf).contains("network=no\n"));

        // The folders gone by hand, the user's own thumbfast in its place; the records stay.
        fs::remove_dir_all(paths.scripts_disabled_dir.join("thumbfast")).unwrap();
        fs::remove_dir_all(paths.scripts_dir.join(SUB_SELECT)).unwrap();
        put(
            &paths.scripts_dir.join("thumbfast.lua"),
            "-- my thumbfast\n",
        );
        fs::write(&conf, "network=yes\n").unwrap();
        fs::remove_file(&prefs).unwrap();
        assert!(registry.plugins.contains_key("thumbfast"));
        assert!(registry.plugins.contains_key(SUB_SELECT));

        write_managed(&paths, &manifest, &registry, UiLanguage::En);

        assert_eq!(
            read(&conf),
            "network=yes\n",
            "the user's copy, the user's options"
        );
        assert!(!prefs.exists(), "no sub-select of Kaleido's is there");
    }

    #[test]
    fn sub_select_gets_its_preferences_once() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        let prefs = paths.script_opts_dir.join(SUB_SELECT_PREFS);
        let mut registry = Registry::default();

        seed(&paths, &mut registry, &manifest, UiLanguage::Cs);

        let written: Value = serde_json::from_str(&read(&prefs)).unwrap();
        assert_eq!(
            written,
            json!([
                { "alang": ["cs", "cze", "ces"], "slang": ["forced", "no"] },
                { "alang": "*", "slang": ["cs", "cze", "ces", "en", "eng"] }
            ])
        );
        assert_eq!(read(&prefs), sub_select_prefs(UiLanguage::Cs));

        // The user's own preferences from now on, whatever the language of the next start.
        let edited = "[ { \"alang\": \"*\", \"slang\": \"de\" } ]\n";
        fs::write(&prefs, edited).unwrap();
        let mut registry = Registry::load(registry_file(&paths));
        seed(&paths, &mut registry, &manifest, UiLanguage::En);
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert_eq!(read(&prefs), edited);

        // Removed and brought back by "Obnovit essentials" (Task 7: `removed` is emptied, then
        // the essentials are seeded): installed again, and the preferences stay.
        uninstall(&paths, &mut registry, SUB_SELECT);
        registry.removed.clear();
        assert_eq!(
            seed(&paths, &mut registry, &manifest, UiLanguage::Cs),
            [SUB_SELECT]
        );
        assert!(
            paths
                .scripts_dir
                .join(SUB_SELECT)
                .join("main.lua")
                .is_file()
        );
        assert_eq!(read(&prefs), edited);
    }

    /// sub-select fails at every start without its preferences, so a start that finds them
    /// missing (their first write failed, the user deleted them) writes them, on or off, in the
    /// language of that start; one that finds them there leaves them.
    #[test]
    fn sub_select_gets_its_preferences_back_when_they_are_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest = bundled(&paths);
        let prefs = paths.script_opts_dir.join(SUB_SELECT_PREFS);
        let mut registry = Registry::default();
        seed(&paths, &mut registry, &manifest, UiLanguage::Cs);

        fs::remove_file(&prefs).unwrap();
        write_managed(&paths, &manifest, &registry, UiLanguage::En);
        assert_eq!(read(&prefs), sub_select_prefs(UiLanguage::En));

        // There: never replaced.
        let edited = "[ { \"alang\": \"*\", \"slang\": \"de\" } ]\n";
        fs::write(&prefs, edited).unwrap();
        write_managed(&paths, &manifest, &registry, UiLanguage::Cs);
        assert_eq!(read(&prefs), edited);

        // Off is still installed: it needs them as soon as it is on again.
        registry.plugins.get_mut(SUB_SELECT).unwrap().enabled = false;
        fs::remove_file(&prefs).unwrap();
        write_managed(&paths, &manifest, &registry, UiLanguage::Cs);
        assert_eq!(read(&prefs), sub_select_prefs(UiLanguage::Cs));

        // Not installed (removed by the user): nothing is written for it.
        registry.plugins.remove(SUB_SELECT);
        fs::remove_file(&prefs).unwrap();
        write_managed(&paths, &manifest, &registry, UiLanguage::Cs);
        assert!(!prefs.exists());
        // And without a manifest, an installed sub-select still gets them.
        registry = Registry::load(registry_file(&paths));
        write_managed(&paths, &[], &registry, UiLanguage::Cs);
        assert_eq!(read(&prefs), sub_select_prefs(UiLanguage::Cs));
    }

    #[test]
    fn sub_select_prefs_put_the_users_language_first() {
        for (language, own, subtitles) in [
            (
                UiLanguage::Cs,
                json!(["cs", "cze", "ces"]),
                json!(["cs", "cze", "ces", "en", "eng"]),
            ),
            (UiLanguage::En, json!(["en", "eng"]), json!(["en", "eng"])),
        ] {
            let prefs: Value = serde_json::from_str(&sub_select_prefs(language)).unwrap();
            assert_eq!(
                prefs,
                json!([
                    { "alang": own, "slang": ["forced", "no"] },
                    { "alang": "*", "slang": subtitles }
                ]),
                "{language:?}"
            );
        }
        // As the plan writes it.
        assert_eq!(
            sub_select_prefs(UiLanguage::Cs),
            "[\n  { \"alang\": [\"cs\", \"cze\", \"ces\"], \"slang\": [\"forced\", \"no\"] },\n  \
             { \"alang\": \"*\", \"slang\": [\"cs\", \"cze\", \"ces\", \"en\", \"eng\"] }\n]\n"
        );
    }

    // ---------------------------------------------------------------------------------------
    // A real libmpv

    /// A RIFF WAVE of `seconds` of silence: an audio track for sub-select to match.
    fn silence(path: &Path, seconds: u32) {
        let rate: u32 = 8000;
        let data = rate * seconds * 2;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        // PCM, one channel, the rate, bytes a second, bytes a frame, bits a sample.
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data.to_le_bytes());
        wav.resize(wav.len() + data as usize, 0);
        fs::write(path, wav).unwrap();
    }

    /// Plan decision 18: without `sub-select.json` sub-select fails as it loads. Seeded from the
    /// real script (`vendor/essentials`, skipped without it), it runs, and it picks subtitles by
    /// the preferences Kaleido gave it: with Czech ones, the Czech track over the English one
    /// listed first. Needs a real libmpv.
    #[test]
    fn sub_select_starts_with_kaleidos_preferences() {
        let vendored = repo_root().join("vendor/essentials/sub-select/sub-select.lua");
        if !vendored.is_file() {
            eprintln!(
                "skipped: {} is missing (run scripts/fetch-essentials.ps1)",
                vendored.display()
            );
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let manifest: Vec<Essential> = manifest()
            .into_iter()
            .filter(|essential| essential.name == SUB_SELECT)
            .collect();
        let bundled = bundle_dir(&paths).join(SUB_SELECT);
        fs::create_dir_all(&bundled).unwrap();
        fs::copy(&vendored, bundled.join(&manifest[0].files[0].src)).unwrap();
        let mut registry = Registry::default();
        assert_eq!(
            seed(&paths, &mut registry, &manifest, UiLanguage::Cs),
            [SUB_SELECT]
        );
        assert!(paths.script_opts_dir.join(SUB_SELECT_PREFS).is_file());

        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        // The script has a client: its `assert(io.open(...))` and its checks of the JSON passed.
        eventually(&engine, "sub_select runs", |mpv| {
            mpv.command(&["script-message-to", "sub_select", "select-subtitles"])
                .is_ok()
        });

        // A clip with an audio track in no language and subtitles in English, then in Czech.
        let media = tmp.path().join("media");
        fs::create_dir_all(&media).unwrap();
        let video = clip(&media, 10);
        let audio = media.join("silence.wav");
        silence(&audio, 10);
        let english = media.join("english.srt");
        let czech = media.join("czech.srt");
        fs::write(&english, "1\n00:00:00,000 --> 00:00:09,000\nHello\n\n").unwrap();
        fs::write(&czech, "1\n00:00:00,000 --> 00:00:09,000\nAhoj\n\n").unwrap();
        let path = |path: &Path| path.to_string_lossy().into_owned();
        engine.command(&["set", "pause", "yes"]);
        // Neither mpv nor sub-select (which turns itself off with it at a file's load) picks a
        // track of its own: only the `select-subtitles` below does, whenever the script handles
        // the file's load.
        engine.command(&["set", "track-auto-selection", "no"]);
        engine.command(&["loadfile", &path(&video)]);
        eventually(&engine, "the clip is open", |mpv| {
            mpv.get_i64("track-list/count")
                .is_ok_and(|count| count >= 1)
        });
        engine.command(&["audio-add", &path(&audio), "select", "silence"]);
        engine.command(&["sub-add", &path(&english), "auto", "English", "eng"]);
        engine.command(&["sub-add", &path(&czech), "auto", "Czech", "cze"]);
        engine.command(&["set", "sid", "no"]);
        eventually(&engine, "the tracks are added", |mpv| {
            mpv.get_i64("track-list/count")
                .is_ok_and(|count| count == 4)
                && mpv.get_string("current-tracks/sub/lang").is_err()
        });

        // sub-select reads the track list as it changes; asked until it has.
        eventually(&engine, "sub-select picks the Czech subtitles", |mpv| {
            let _ = mpv.command(&["script-message-to", "sub_select", "select-subtitles"]);
            mpv.get_string("current-tracks/sub/lang")
                .is_ok_and(|lang| lang == "cze")
        });
    }

    /// The whole start (`Plugins::start`): an essential from the installation's manifest is
    /// copied into `scripts\`, gets its managed options in its `script-opts` file over what the
    /// user wrote there, and mpv runs it with them. Needs a real libmpv.
    #[test]
    fn seeded_scripts_run_with_kaleidos_options() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let probe = "local o = { greeting = \"x\" }\n\
                     require(\"mp.options\").read_options(o, \"probe\")\n\
                     mp.set_property_native(\"user-data/probe/greeting\", o.greeting)\n";
        put(&bundle_dir(&paths).join("probe").join("probe.lua"), probe);
        let manifest = json!([{
            "name": "probe",
            "scriptName": "probe",
            "optsName": "probe",
            "repo": "kaleido/probe",
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "version": "0123456",
            "license": "MIT",
            "summary": { "en": "Says what it was told." },
            "files": [{
                "src": "probe.lua",
                "dest": "scripts/probe/main.lua",
                "sha256": sha256_hex(probe.as_bytes())
            }],
            "managed": { "greeting": "kaleido" }
        }]);
        put(&manifest_path(&paths), &manifest.to_string());
        put(&paths.script_opts_dir.join("probe.conf"), "greeting=mine\n");

        let plugins = Plugins::start(&paths, UiLanguage::En);

        let state = plugins.list();
        assert_eq!(state.plugins.len(), 1);
        assert_eq!(state.plugins[0].name, "probe");
        assert_eq!(state.plugins[0].source, PluginSource::Bundled);
        assert!(state.plugins[0].running);
        assert_eq!(
            read(&paths.scripts_dir.join("probe").join("main.lua")),
            probe
        );
        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        // mpv prints a `user-data` value as JSON: the string comes quoted.
        eventually(&engine, "the probe has Kaleido's greeting", |mpv| {
            mpv.get_string("user-data/probe/greeting")
                .is_ok_and(|printed| {
                    serde_json::from_str::<String>(&printed)
                        .is_ok_and(|greeting| greeting == "kaleido")
                })
        });
    }
}
