//! Plugins: plain mpv scripts that Kaleido keeps in the config folder, and the essentials it
//! bundles (spec 6, plan M2).

pub mod essentials;
pub mod install;
pub mod names;
pub mod recycle;
pub mod registry;
pub mod scan;
pub mod schema;
pub mod script_opts;
pub mod targets;

use essentials::Essential;
use registry::Registry;

use crate::paths::AppPaths;
use crate::settings::UiLanguage;

/// What the plugins are when the player core starts: the registry and the essentials' manifest,
/// read and acted on before mpv loads the scripts in `scripts\` (plan decision 2). The app
/// manages it; every later start of the core (a restart) writes the managed options from it
/// again ([`essentials::write_managed`]).
pub struct Startup {
    pub registry: Registry,
    /// Empty when the manifest could not be read: the plugins then run without essentials.
    pub manifest: Vec<Essential>,
    /// The UI's language at the start, for the preferences sub-select gets when it has none.
    pub language: UiLanguage,
}

impl Startup {
    /// Before the core starts: reads `plugins.json` and the installation's manifest, copies the
    /// essentials that are not there yet ([`essentials::seed`], with `language` for the
    /// preferences sub-select is first given) and writes their managed options. Nothing here
    /// fails the start: what goes wrong is logged, and mpv loads what there is.
    pub fn prepare(paths: &AppPaths, language: UiLanguage) -> Startup {
        let mut registry = Registry::load(paths.config_dir.join(registry::FILE));
        let manifest =
            essentials::load_manifest(&essentials::manifest_path(paths)).unwrap_or_else(|error| {
                tracing::error!("the plugins start without essentials: {error:#}");
                Vec::new()
            });
        let seeded = essentials::seed(paths, &mut registry, &manifest, language);
        if !seeded.is_empty() {
            tracing::info!("essentials installed: {}", seeded.join(", "));
        }
        essentials::write_managed(paths, &manifest, &registry, language);
        Startup {
            registry,
            manifest,
            language,
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    /// A file with `contents` at `path`, whose folders are made.
    pub fn put(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// Everything under `root`, by its path from there with `/`: a file with its bytes, a folder
    /// with `None`. Two trees are equal when nothing was added, changed or removed.
    pub fn tree(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
        let mut found = BTreeMap::new();
        walk(root, "", &mut found);
        found
    }

    fn walk(dir: &Path, prefix: &str, found: &mut BTreeMap<String, Option<Vec<u8>>>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries {
            let entry = entry.unwrap();
            let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
            let path = entry.path();
            if path.is_dir() {
                found.insert(name.clone(), None);
                walk(&path, &format!("{name}/"), found);
            } else {
                found.insert(name, Some(fs::read(&path).unwrap()));
            }
        }
    }
}
