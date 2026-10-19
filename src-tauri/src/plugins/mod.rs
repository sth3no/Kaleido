//! Plugins: plain mpv scripts that Kaleido keeps in the config folder, and the essentials it
//! bundles (spec 6, plan M2).
//!
//! [`Plugins`] is the service the commands use (spec 6.3, 7.3, 10.4): what is installed and
//! whether it runs, turning a plugin on or off, uninstalling it, getting the essentials back, its
//! settings, and "Použít" (Apply), the restart of the player core that makes the changes that wait
//! for it take effect. It holds the registry, the essentials' manifest and the UI's language of
//! the start, read once before the core starts ([`Plugins::start`]); every later start of the core
//! writes the essentials' managed options from it ([`Plugins::write_managed`]).
//!
//! What a plugin is, is what is on the disk ([`scan`]), each script once, under a name of its own
//! that every command takes (see [`PluginInfo::name`]). What waits for Apply (plan decision 3):
//! turning off and uninstalling a plugin that runs, and a change of its settings (scripts read
//! their `script-opts` when they load). Turning on one that does not run loads it at once
//! (`load-script`).

pub mod errors;
pub mod essentials;
pub mod install;
pub mod names;
pub mod recycle;
pub mod registry;
pub mod scan;
pub mod schema;
pub mod script_opts;
pub mod targets;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use errors::PluginErrors;
use essentials::Essential;
use registry::{PluginRecord, PluginSource, Registry};
use scan::{Found, Layout};
use schema::{Localized, SettingSpec};
use script_opts::ScriptOpts;
use targets::Target;

use crate::paths::AppPaths;
use crate::player::{Engine, LogLine, RestartError};
use crate::settings::{UiLanguage, write_atomic};

/// The event that tells the UI the plugins changed; its payload is [`PluginsState`].
pub const CHANGED_EVENT: &str = "plugins:changed";
/// The event that tells the UI a plugin logged its first error of the run; its payload is
/// [`PluginErrorEvent`].
pub const ERROR_EVENT: &str = "plugins:error";

/// One script in the config folder, as the plugins page lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// What the commands call it, one for each script that is found:
    /// - a plugin in `plugins.json` (one Kaleido installed): its key there, which is its folder
    ///   (or, for a record that lists a single file, never an essential's, the file's name
    ///   without its extension);
    /// - any other folder: the folder's name;
    /// - any other file: the file's name with its extension (`my-plugin.lua`), so that the folder
    ///   `x` and the file `x.lua` are two plugins. A user's `thumbfast.lua` where Kaleido's
    ///   `thumbfast\` was is the user's: manual, with `copy_of`, and thumbfast is missing.
    ///
    /// Where that is taken already (the same folder in `scripts\` and in `scripts-disabled\`),
    /// ` (2)`, ` (3)`, … follows, in the order mpv loads them.
    pub name: String,
    /// What mpv calls its client (see [`names`]).
    pub script_name: String,
    /// `manual` for a script `plugins.json` does not know.
    pub source: PluginSource,
    pub version: Option<String>,
    /// What an essential does, from the manifest; `None` for the others.
    pub summary: Option<Localized>,
    /// In `scripts\`, where mpv loads it at the next start of the core.
    pub enabled: bool,
    /// In the core that runs now: loaded at its start or since.
    pub running: bool,
    /// One of the scripts that draw their own interface over the video (spec 6.5).
    pub incompatible: bool,
    /// On, and mpv knows another script that is on by the same name: one of them is numbered
    /// (`thumbfast2`), and both run. Scripts that are off do not run, so they are no duplicates.
    pub duplicate: bool,
    /// The errors it logged in this run of Kaleido (spec 10.4).
    pub errors: u32,
    /// How its settings are edited.
    pub settings: SettingsForm,
    /// The essential mpv knows this script as, when it is not Kaleido's bundled copy of it (a
    /// copy the user put there): Kaleido writes no options for it, so it works with the user's own
    /// `script-opts` (for thumbfast: its previews depend on the user's thumbfast settings, and need
    /// its `mpv_path`).
    pub copy_of: Option<String>,
}

/// How a plugin's settings are edited (spec 6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsForm {
    /// A form from the settings the manifest lists.
    Schema,
    /// Keys and values of its `script-opts` file.
    KeyValue,
}

/// The plugins page's state: what `plugins_list` returns and `plugins:changed` carries.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsState {
    /// In the order mpv loads them.
    pub plugins: Vec<PluginInfo>,
    /// A change waits for Apply: a plugin that runs is off or gone on the disk, or its settings
    /// changed.
    pub restart_needed: bool,
    /// The essentials "Obnovit essentials" brings back, in the manifest's order: the ones the user
    /// removed, and the ones `plugins.json` has whose files are gone.
    pub removed_essentials: Vec<String>,
    /// Apply runs: from the moment it starts until the new core runs (or did not start). The
    /// core's first state batch reports an empty playlist and an idle player before it plays on;
    /// while this is true, that is the restart and not the player having stopped.
    pub applying: bool,
}

/// A plugin's settings: what `plugins_settings` and `plugins_set_setting` return.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettings {
    pub name: String,
    /// The settings the manifest offers (essentials); `None` for a plugin without them, whose
    /// keys are edited as they are.
    pub schema: Option<Vec<SettingSpec>>,
    /// What its `script-opts` file sets, as the script reads it, in the order of the file; without
    /// the `managed` keys, and without keys Kaleido does not write (with a space or an `=`, or the
    /// first key of a file with a BOM, which no script asks for).
    pub entries: Vec<OptEntry>,
    /// The keys Kaleido sets itself at every start of the core; they cannot be set here.
    pub managed: Vec<String>,
}

/// One key and its value in a `script-opts` file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OptEntry {
    pub key: String,
    pub value: String,
}

/// Why a change of the plugins did not happen. In every case nothing changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginError {
    /// No plugin of that name is in the config folder (any more).
    NotFound { name: String },
    /// A setting that cannot be set: a value out of range or of the wrong form, a key that is not
    /// one, or one Kaleido sets itself.
    Invalid { key: String, reason: String },
    /// Apply runs; nothing else changes until it is done.
    Busy,
    /// A file could not be moved, read or written, or `plugins.json` is left alone because it
    /// could not be read at start (see [`Registry::refused`]).
    Io { message: String },
    /// The player is not running (yet), or Apply could not start a new core.
    Unavailable,
}

impl PluginError {
    fn invalid(key: &str, reason: impl fmt::Display) -> PluginError {
        PluginError::Invalid {
            key: key.to_owned(),
            reason: reason.to_string(),
        }
    }

    fn io(error: impl fmt::Display) -> PluginError {
        PluginError::Io {
            message: error.to_string(),
        }
    }
}

impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PluginError::NotFound { name } => write!(f, "no plugin {name}"),
            PluginError::Invalid { key, reason } => write!(f, "{key}: {reason}"),
            PluginError::Busy => write!(f, "the plugins are being applied"),
            PluginError::Io { message } => f.write_str(message),
            PluginError::Unavailable => write!(f, "the player is not running"),
        }
    }
}

impl std::error::Error for PluginError {}

/// The payload of `plugins:error`: the plugin `name` logged its first error of the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginErrorEvent {
    pub name: String,
}

/// What the plugins need of the player: a script loaded into the core that runs now
/// (`load-script`). The engine queues it and returns at once; the tests record it.
pub trait ScriptLoader {
    /// `entry` is the script in `scripts\`: its folder (mpv names a folder's script after the
    /// folder, and finds its `main` itself), or its file.
    fn load_script(&self, entry: &Path);
}

impl ScriptLoader for Engine {
    fn load_script(&self, entry: &Path) {
        self.command(&["load-script", &entry.to_string_lossy()]);
    }
}

/// The plugins service, managed by the app (see the module). One change at a time: every method
/// takes the state's lock, and none waits for the player while it holds it (Apply lets it go for
/// the restart, so that the restart can read it and so that the changes the UI sends meanwhile
/// are told `Busy` instead of waiting).
pub struct Plugins {
    paths: AppPaths,
    inner: Mutex<Inner>,
    /// Apart from `inner`, so that mpv's event thread, which notes the log's errors here, never
    /// waits for a change in progress (an uninstall waits for the Recycle Bin). Taken after
    /// `inner` where both are needed, never before.
    errors: Mutex<ErrorBook>,
}

struct Inner {
    registry: Registry,
    /// Whether a refused registry has been read again once (controller Ruling R6).
    reread: bool,
    /// Empty when the manifest could not be read: the plugins then run without essentials.
    manifest: Vec<Essential>,
    /// The UI's language at the start, for the preferences sub-select gets when it has none.
    language: UiLanguage,
    /// The plugins the core that runs now has loaded, in the order it loaded them: at its start the
    /// ones that were on, then the ones turned on since.
    running: Vec<Running>,
    /// Running plugins whose settings changed since the core started.
    pending_settings: BTreeSet<String>,
    applying: bool,
}

/// A plugin the core has loaded, by its name in the list and the name mpv gave its client.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Running {
    name: String,
    script_name: String,
}

#[derive(Default)]
struct ErrorBook {
    errors: PluginErrors,
    /// The client names of the running plugins, to their names ([`errors::clients`]).
    clients: BTreeMap<String, String>,
}

/// A script on the disk under its name in the list.
#[derive(Debug, Clone)]
struct Script {
    found: Found,
    name: String,
    /// Whether `name` is its record's key in `plugins.json`.
    registered: bool,
}

impl Script {
    /// Where it is now: in `scripts\` or in `scripts-disabled\`.
    fn home(&self, paths: &AppPaths) -> PathBuf {
        let dir = if self.found.enabled {
            &paths.scripts_dir
        } else {
            &paths.scripts_disabled_dir
        };
        dir.join(self.found.entry_name())
    }
}

/// Where a plugin's settings are and what may be set in them.
struct Options {
    /// The file in `script-opts\`.
    file: String,
    schema: Option<Vec<SettingSpec>>,
    managed: Vec<String>,
}

impl Options {
    fn settings(&self, name: &str, opts: &ScriptOpts) -> PluginSettings {
        PluginSettings {
            name: name.to_owned(),
            schema: self.schema.clone(),
            entries: opts
                .entries()
                .into_iter()
                .filter(|(key, _)| script_opts::is_valid_key(key) && !self.managed.contains(key))
                .map(|(key, value)| OptEntry { key, value })
                .collect(),
            managed: self.managed.clone(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Every change replaces what it changes in one step, and the rest is read from the disk.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Plugins {
    /// Before the core starts (plan decision 2): puts back what an install the app did not finish
    /// left in the staging folder ([`install::sweep_staging`]), reads `plugins.json` and the
    /// installation's manifest, copies the essentials that are not there yet ([`essentials::seed`],
    /// with `language` for the preferences sub-select is first given) and writes their managed
    /// options. The plugins that are on are the ones the core runs. Nothing here fails the start:
    /// what goes wrong is logged, and mpv loads what there is.
    pub fn start(paths: &AppPaths, language: UiLanguage) -> Plugins {
        install::sweep_staging(paths);
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
        let plugins = Plugins {
            paths: paths.clone(),
            inner: Mutex::new(Inner {
                registry,
                reread: false,
                manifest,
                language,
                running: Vec::new(),
                pending_settings: BTreeSet::new(),
                applying: false,
            }),
            errors: Mutex::new(ErrorBook::default()),
        };
        {
            let mut inner = lock(&plugins.inner);
            let running = plugins.enabled(&inner.registry);
            plugins.set_running(&mut inner, running);
        }
        plugins
    }

    /// Writes the essentials' managed options ([`essentials::write_managed`]): before every start
    /// of the core, a restart's too (the scripts read them when they load).
    pub fn write_managed(&self) {
        let inner = lock(&self.inner);
        essentials::write_managed(
            &self.paths,
            &inner.manifest,
            &inner.registry,
            inner.language,
        );
    }

    /// The plugins as they are on the disk now. Works also while Apply runs, and with a registry
    /// that cannot be saved.
    pub fn list(&self) -> PluginsState {
        self.state(&lock(&self.inner))
    }

    /// Turns the plugin `name` on or off (spec 6.3): its folder or file moves between `scripts\`
    /// and `scripts-disabled\`, and its record in `plugins.json` says so. One that is turned on and
    /// does not run is loaded now; one that runs keeps running until Apply when it is turned off,
    /// and is not loaded a second time when it is turned on again before that. Nothing moves when
    /// the other folder has an entry of its name already.
    pub fn set_enabled(
        &self,
        name: &str,
        on: bool,
        player: &impl ScriptLoader,
    ) -> Result<PluginsState, PluginError> {
        let mut inner = self.changing()?;
        let scripts = self.scripts(&inner.registry);
        let script = find(&scripts, name)?;
        let entry = script.found.entry_name();
        let moved = script.found.enabled != on;
        if moved {
            self.move_entry(&entry, on)?;
        }
        let record_says = script
            .registered
            .then(|| inner.registry.plugins.get(name))
            .flatten()
            .map(|record| record.enabled);
        if record_says.is_some_and(|enabled| enabled != on) {
            let mut registry = inner.registry.clone();
            if let Some(record) = registry.plugins.get_mut(name) {
                record.enabled = on;
            }
            if let Err(error) = registry.save(self.registry_path()) {
                if moved && let Err(back) = self.move_entry(&entry, !on) {
                    tracing::error!("cannot move {entry} back after plugins.json failed: {back}");
                }
                return Err(PluginError::io(format_args!(
                    "cannot save plugins.json: {error}"
                )));
            }
            inner.registry = registry;
        }
        if on && !is_running(&inner, name) {
            player.load_script(&self.paths.scripts_dir.join(&entry));
            let mut running = inner.running.clone();
            running.push(Running {
                name: name.to_owned(),
                script_name: script.found.script_name.clone(),
            });
            self.set_running(&mut inner, running);
        }
        Ok(self.state(&inner))
    }

    /// Uninstalls the plugin `name` (plan decision 4): its folder or file, and the shaders and
    /// fonts its record lists that no other plugin's record lists, go to the Recycle Bin; its
    /// `script-opts` stay (the user's settings). Its record goes, and an essential is remembered
    /// as removed, so that the next start does not copy it again. What an install of it left in the
    /// staging folder goes to the Recycle Bin too, so that a later sweep does not bring it back. One
    /// that runs keeps running until Apply.
    pub fn uninstall(&self, name: &str) -> Result<PluginsState, PluginError> {
        let mut inner = self.changing()?;
        let scripts = self.scripts(&inner.registry);
        let script = find(&scripts, name)?;
        let mut doomed = vec![script.home(&self.paths)];
        if script.found.layout == Layout::Folder {
            doomed.extend(install::leftovers_of(
                &self.paths,
                &script.found.entry_name(),
            ));
        }
        let mut registry = inner.registry.clone();
        let record = if script.registered {
            registry.plugins.remove(name)
        } else {
            None
        };
        if let Some(record) = &record {
            doomed.extend(self.own_files(name, record, &registry));
            if record.source == PluginSource::Bundled {
                registry.removed.insert(name.to_owned());
            }
            registry.save(self.registry_path()).map_err(|error| {
                PluginError::io(format_args!("cannot save plugins.json: {error}"))
            })?;
        }
        if let Err(error) = recycle::to_recycle_bin(&doomed) {
            if record.is_some()
                && let Err(back) = inner.registry.save(self.registry_path())
            {
                tracing::error!(
                    "{name} is still there, but plugins.json no longer lists it: {back}"
                );
            }
            return Err(PluginError::io(error));
        }
        inner.registry = registry;
        Ok(self.state(&inner))
    }

    /// "Obnovit essentials": forgets which essentials the user removed, and the records of the ones
    /// whose files are gone, and installs them again ([`essentials::seed`], which leaves out one
    /// that a script of the user's is in the way of), with their managed options. The ones that do
    /// not run are loaded now; one that still runs (removed, and not applied since) is not loaded a
    /// second time.
    pub fn restore_essentials(
        &self,
        player: &impl ScriptLoader,
    ) -> Result<PluginsState, PluginError> {
        let mut inner = self.changing()?;
        let scripts = self.scripts(&inner.registry);
        let mut registry = inner.registry.clone();
        registry.removed.clear();
        for essential in &inner.manifest {
            if registry.plugins.contains_key(&essential.name)
                && !is_found(&scripts, &essential.name)
            {
                registry.plugins.remove(&essential.name);
            }
        }
        if registry != inner.registry {
            registry.save(self.registry_path()).map_err(|error| {
                PluginError::io(format_args!("cannot save plugins.json: {error}"))
            })?;
        }
        let seeded = essentials::seed(&self.paths, &mut registry, &inner.manifest, inner.language);
        essentials::write_managed(&self.paths, &inner.manifest, &registry, inner.language);
        inner.registry = registry;
        let mut running = inner.running.clone();
        for name in seeded {
            if running.iter().any(|plugin| plugin.name == name) {
                continue;
            }
            let Some(essential) = inner.manifest.iter().find(|e| e.name == name) else {
                continue;
            };
            player.load_script(&self.paths.scripts_dir.join(&name));
            running.push(Running {
                script_name: essential.script_name.clone(),
                name,
            });
        }
        self.set_running(&mut inner, running);
        Ok(self.state(&inner))
    }

    /// The settings of the plugin `name`: the essentials' from the manifest, for the others what
    /// their `script-opts\<script name>.conf` sets.
    pub fn settings(&self, name: &str) -> Result<PluginSettings, PluginError> {
        let inner = lock(&self.inner);
        let scripts = self.scripts(&inner.registry);
        let script = find(&scripts, name)?;
        let options = options_of(&inner, script);
        let text = read_options(&self.paths.script_opts_dir, &options.file)?;
        Ok(options.settings(name, &ScriptOpts::parse(&text)))
    }

    /// Sets `key` of the plugin `name` in its `script-opts` file, or takes it out with `None` (the
    /// script's default), gently ([`ScriptOpts`]: the user's other lines stay as they are). With a
    /// schema the key must be one of it and the value is checked against it ([`schema::validate`],
    /// which writes it the way the script reads it); without one, the key must be one Kaleido
    /// writes and the value one line. A managed key is refused. A plugin that runs gets the change
    /// at Apply.
    pub fn set_setting(
        &self,
        name: &str,
        key: &str,
        value: Option<&str>,
    ) -> Result<PluginSettings, PluginError> {
        let mut inner = self.changing()?;
        let scripts = self.scripts(&inner.registry);
        let script = find(&scripts, name)?;
        let options = options_of(&inner, script);
        if options.managed.iter().any(|managed| managed == key) {
            return Err(PluginError::invalid(key, "Kaleido sets this option itself"));
        }
        let written = match &options.schema {
            Some(schema) => {
                let spec = schema
                    .iter()
                    .find(|spec| spec.key == key)
                    .ok_or_else(|| PluginError::invalid(key, "not a setting of this plugin"))?;
                value
                    .map(|raw| schema::validate(spec, raw))
                    .transpose()
                    .map_err(|reason| PluginError::invalid(key, reason))?
            }
            None => value.map(str::to_owned),
        };
        let text = read_options(&self.paths.script_opts_dir, &options.file)?;
        let mut opts = ScriptOpts::parse(&text);
        opts.set(key, written.as_deref())
            .map_err(|error| PluginError::invalid(key, error))?;
        let changed = opts.render();
        if changed != text {
            let path = self.paths.script_opts_dir.join(&options.file);
            fs::create_dir_all(&self.paths.script_opts_dir)
                .and_then(|()| write_atomic(&path, changed.as_bytes()))
                .map_err(|error| {
                    PluginError::io(format_args!(
                        "cannot write script-opts\\{}: {error}",
                        options.file
                    ))
                })?;
            if is_running(&inner, name) {
                inner.pending_settings.insert(name.to_owned());
            }
        }
        Ok(options.settings(name, &opts))
    }

    /// "Použít" (spec 6.3): restarts the core with `restart`, which plays on where it was and loads
    /// the plugins that are on now (the app's is `restart_engine`). `emit` hears the state twice:
    /// with `applying` before the restart, and without it after the restart, also when it failed
    /// or panicked (the panic then goes on to the caller, after `applying` ended). Once the new core
    /// runs, the plugins that are on are the ones that run and no change waits; a core that did not
    /// start is `Unavailable`, and the changes still wait for the next Apply. Another change while
    /// it runs, Apply too, is `Busy`.
    pub fn apply(
        &self,
        restart: impl FnOnce() -> Result<(), RestartError>,
        emit: impl Fn(&PluginsState),
    ) -> Result<PluginsState, PluginError> {
        let before = {
            let mut inner = lock(&self.inner);
            if inner.applying {
                return Err(PluginError::Busy);
            }
            inner.applying = true;
            self.state(&inner)
        };
        // Whatever happens in the restart, a panic too, Apply ends, and the UI hears so.
        let restarted = panic::catch_unwind(AssertUnwindSafe(|| {
            emit(&before);
            restart()
        }));
        let mut inner = lock(&self.inner);
        inner.applying = false;
        let mut panicked = None;
        let outcome = match restarted {
            Ok(Ok(()) | Err(RestartError::Quit)) => {
                let running = self.enabled(&inner.registry);
                self.set_running(&mut inner, running);
                inner.pending_settings.clear();
                Ok(())
            }
            Ok(Err(error)) => {
                tracing::error!("the plugins are not applied: {error}");
                Err(PluginError::Unavailable)
            }
            // The panic hook has logged it; the changes still wait.
            Err(payload) => {
                panicked = Some(payload);
                Err(PluginError::Unavailable)
            }
        };
        let after = self.state(&inner);
        drop(inner);
        emit(&after);
        if let Some(payload) = panicked {
            panic::resume_unwind(payload);
        }
        outcome.map(|()| after)
    }

    /// Takes a line of mpv's log (on mpv's event thread). The name of the plugin it is the first
    /// error of in this run comes back, for `plugins:error`.
    pub fn note_log(&self, line: &LogLine) -> Option<String> {
        let mut book = lock(&self.errors);
        let ErrorBook { errors, clients } = &mut *book;
        errors.note(line, clients)
    }

    /// The last errors the plugin `name` logged in this run, the oldest first.
    pub fn log(&self, name: &str) -> Vec<LogLine> {
        lock(&self.errors).errors.lines(name)
    }

    /// The plugins for the diagnostics (spec 10.8): `<name> <version or -> (<source>)`, in the
    /// list's order, with no paths.
    pub fn diagnostics(&self) -> Vec<String> {
        self.list()
            .plugins
            .iter()
            .map(|plugin| {
                format!(
                    "{} {} ({})",
                    plugin.name,
                    plugin.version.as_deref().unwrap_or("-"),
                    source_name(plugin.source)
                )
            })
            .collect()
    }

    // -----------------------------------------------------------------------------------------

    fn registry_path(&self) -> PathBuf {
        self.paths.config_dir.join(registry::FILE)
    }

    /// The state's lock for a change: none while Apply runs, and none to a registry that cannot
    /// be saved (controller Ruling R6), which is read once more first, in case what kept it from
    /// being read at start (another program holding it) has gone.
    fn changing(&self) -> Result<MutexGuard<'_, Inner>, PluginError> {
        let mut inner = lock(&self.inner);
        if inner.applying {
            return Err(PluginError::Busy);
        }
        if inner.registry.refused().is_some() && !inner.reread {
            inner.reread = true;
            let again = Registry::load(self.registry_path());
            if again.refused().is_none() {
                tracing::info!("plugins.json can be read now");
                inner.registry = again;
            }
        }
        if let Some(reason) = inner.registry.refused() {
            return Err(PluginError::io(reason));
        }
        Ok(inner)
    }

    /// What is on the disk now, by name.
    fn scripts(&self, registry: &Registry) -> Vec<Script> {
        identify(scan::scan(&self.paths), registry)
    }

    /// The plugins that are on, as the core that starts now loads them.
    fn enabled(&self, registry: &Registry) -> Vec<Running> {
        self.scripts(registry)
            .into_iter()
            .filter(|script| script.found.enabled)
            .map(|script| Running {
                name: script.name,
                script_name: script.found.script_name,
            })
            .collect()
    }

    fn set_running(&self, inner: &mut Inner, running: Vec<Running>) {
        let clients = errors::clients(
            running
                .iter()
                .map(|plugin| (plugin.name.as_str(), plugin.script_name.as_str())),
        );
        inner.running = running;
        lock(&self.errors).clients = clients;
    }

    /// Moves the entry `entry` of `scripts-disabled\` into `scripts\` (`on`), or the other way.
    fn move_entry(&self, entry: &str, on: bool) -> Result<(), PluginError> {
        let (from_dir, to_dir) = if on {
            (&self.paths.scripts_disabled_dir, &self.paths.scripts_dir)
        } else {
            (&self.paths.scripts_dir, &self.paths.scripts_disabled_dir)
        };
        let folder = |dir: &Path| {
            dir.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        let to = to_dir.join(entry);
        if to.symlink_metadata().is_ok() {
            return Err(PluginError::io(format_args!(
                "{entry} is in {} already",
                folder(to_dir)
            )));
        }
        fs::create_dir_all(to_dir)
            .and_then(|()| fs::rename(from_dir.join(entry), &to))
            .map_err(|error| {
                PluginError::io(format_args!(
                    "cannot move {entry} into {}: {error}",
                    folder(to_dir)
                ))
            })
    }

    /// The files of `record` (the plugin `name`'s) that an uninstall takes besides the script
    /// itself: its shaders and fonts that are there and that no record of `others` lists too. Its
    /// script folder goes whole anyway, and its `script-opts` stay. A path the record should not
    /// have ([`targets::parse`] refuses it) is left alone.
    fn own_files(&self, name: &str, record: &PluginRecord, others: &Registry) -> Vec<PathBuf> {
        let shared: BTreeSet<String> = others
            .plugins
            .values()
            .flat_map(|other| &other.files)
            .map(|file| file.path.to_lowercase())
            .collect();
        record
            .files
            .iter()
            .filter_map(|file| match targets::parse(&file.path, name) {
                Ok(target @ (Target::Shader(_) | Target::Font(_))) => (!shared
                    .contains(&target.dest().to_lowercase()))
                .then(|| target.path(&self.paths)),
                Ok(_) => None,
                Err(error) => {
                    tracing::warn!("{name}'s record has a file that is not its own: {error}");
                    None
                }
            })
            .filter(|path| path.symlink_metadata().is_ok())
            .collect()
    }

    fn state(&self, inner: &Inner) -> PluginsState {
        let scripts = self.scripts(&inner.registry);
        let on: Vec<Found> = scripts
            .iter()
            .filter(|script| script.found.enabled)
            .map(|script| script.found.clone())
            .collect();
        let duplicated: BTreeSet<String> = scan::duplicates(&on)
            .into_iter()
            .flat_map(|(_, entries)| entries)
            .collect();
        let errors = lock(&self.errors);
        let plugins = scripts
            .iter()
            .map(|script| {
                let record = script
                    .registered
                    .then(|| inner.registry.plugins.get(&script.name))
                    .flatten();
                let essential = essential_of(inner, script);
                let found = &script.found;
                PluginInfo {
                    name: script.name.clone(),
                    script_name: found.script_name.clone(),
                    source: record.map_or(PluginSource::Manual, |record| record.source),
                    version: record.and_then(|record| record.version.clone()),
                    summary: essential.map(|essential| essential.summary.clone()),
                    enabled: found.enabled,
                    running: is_running(inner, &script.name),
                    incompatible: names::is_incompatible(&found.entry_name(), &found.script_name),
                    duplicate: found.enabled && duplicated.contains(&found.entry_name()),
                    errors: errors.errors.count(&script.name),
                    settings: if essential.is_some_and(|essential| !essential.settings.is_empty()) {
                        SettingsForm::Schema
                    } else {
                        SettingsForm::KeyValue
                    },
                    copy_of: if essential.is_some() {
                        None
                    } else {
                        inner
                            .manifest
                            .iter()
                            .find(|essential| essential.script_name == found.script_name)
                            .map(|essential| essential.name.clone())
                    },
                }
            })
            .collect();
        let restart_needed = !inner.pending_settings.is_empty()
            || inner.running.iter().any(|running| {
                !scripts
                    .iter()
                    .any(|script| script.name == running.name && script.found.enabled)
            });
        let removed_essentials = inner
            .manifest
            .iter()
            .filter(|essential| {
                inner.registry.removed.contains(&essential.name)
                    || (inner.registry.plugins.contains_key(&essential.name)
                        && !is_found(&scripts, &essential.name))
            })
            .map(|essential| essential.name.clone())
            .collect();
        PluginsState {
            plugins,
            restart_needed,
            removed_essentials,
            applying: inner.applying,
        }
    }
}

/// Tells the UI the plugins' state (`plugins:changed`).
pub fn emit_changed(app: &AppHandle, state: &PluginsState) {
    if let Err(error) = app.emit(CHANGED_EVENT, state) {
        tracing::warn!("cannot send {CHANGED_EVENT} to the UI: {error}");
    }
}

/// The plugin `name` logged its first error of the run (on mpv's event thread): the UI hears
/// `plugins:error` now, and the new state, with its count of errors, from another thread (the
/// list reads the disk, which mpv's events must not wait for).
pub fn told_error(app: &AppHandle, name: String) {
    if let Err(error) = app.emit(ERROR_EVENT, PluginErrorEvent { name }) {
        tracing::warn!("cannot send {ERROR_EVENT} to the UI: {error}");
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(plugins) = app.try_state::<Plugins>() {
            emit_changed(&app, &plugins.list());
        }
    });
}

/// The name of a source as `plugins.json` writes it.
fn source_name(source: PluginSource) -> &'static str {
    match source {
        PluginSource::Bundled => "bundled",
        PluginSource::Store => "store",
        PluginSource::Url => "url",
        PluginSource::Manual => "manual",
    }
}

fn find<'a>(scripts: &'a [Script], name: &str) -> Result<&'a Script, PluginError> {
    scripts
        .iter()
        .find(|script| script.name == name)
        .ok_or_else(|| PluginError::NotFound {
            name: name.to_owned(),
        })
}

fn is_found(scripts: &[Script], name: &str) -> bool {
    scripts
        .iter()
        .any(|script| script.registered && script.name == name)
}

fn is_running(inner: &Inner, name: &str) -> bool {
    inner.running.iter().any(|running| running.name == name)
}

/// The essential `script` is Kaleido's bundled copy of, if it is one.
fn essential_of<'a>(inner: &'a Inner, script: &Script) -> Option<&'a Essential> {
    let record = inner.registry.plugins.get(&script.name)?;
    (script.registered && record.source == PluginSource::Bundled)
        .then(|| inner.manifest.iter().find(|e| e.name == script.name))
        .flatten()
}

/// Where the settings of `script` are: an essential's in `script-opts\<opts name>.conf`, with
/// its schema and its managed keys; any other script's in `script-opts\<script name>.conf`, the
/// name `read_options` takes by default.
fn options_of(inner: &Inner, script: &Script) -> Options {
    match essential_of(inner, script) {
        Some(essential) => Options {
            file: format!("{}.conf", essential.opts_name),
            schema: (!essential.settings.is_empty()).then(|| essential.settings.clone()),
            managed: essential.managed.keys().cloned().collect(),
        },
        None => Options {
            file: format!("{}.conf", script.found.script_name),
            schema: None,
            managed: Vec::new(),
        },
    }
}

/// The text of `script-opts\<file>`, empty when it is not there. One that is not UTF-8 text is
/// not Kaleido's to read or rewrite.
fn read_options(dir: &Path, file: &str) -> Result<String, PluginError> {
    match fs::read(dir.join(file)) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            PluginError::io(format_args!(
                "script-opts\\{file} is not UTF-8 text, and Kaleido leaves it alone"
            ))
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(PluginError::io(format_args!(
            "cannot read script-opts\\{file}: {error}"
        ))),
    }
}

/// Whether `record` is of the single file `entry` (its name in `scripts\`, with the extension):
/// its files list `scripts/<entry>`. Never an essential's record: essentials are folders, and a
/// file of an essential's name where its folder was is the user's own copy.
fn records_file(record: &PluginRecord, entry: &str) -> bool {
    let path = format!("scripts/{entry}");
    record.source != PluginSource::Bundled
        && record
            .files
            .iter()
            .any(|file| file.path.replace('\\', "/").eq_ignore_ascii_case(&path))
}

/// Names the scripts `found` (in [`scan::scan`]'s order) as [`PluginInfo::name`] says:
/// 1. each record of `registry` is the folder of its name, or else a file whose name without its
///    extension it is and which the record lists ([`records_file`]); of two such, the one that is
///    on or off as the record says, or else the first. A record that none is (its files are gone)
///    names nothing;
/// 2. every other script is its folder or its file with the extension, and one whose name is
///    taken gets the first ` (n)` from 2 that is nobody's.
fn identify(found: Vec<Found>, registry: &Registry) -> Vec<Script> {
    let mut names: Vec<Option<String>> = vec![None; found.len()];
    let mut registered = vec![false; found.len()];
    for (key, record) in &registry.plugins {
        let matching = |layout: Layout| -> Vec<usize> {
            (0..found.len())
                .filter(|&index| {
                    let script = &found[index];
                    script.layout == layout
                        && script.name == *key
                        && (layout == Layout::Folder || records_file(record, &script.entry_name()))
                })
                .collect()
        };
        let mut candidates = matching(Layout::Folder);
        if candidates.is_empty() {
            candidates = matching(Layout::File);
        }
        let chosen = candidates
            .iter()
            .copied()
            .find(|&index| found[index].enabled == record.enabled)
            .or_else(|| candidates.first().copied());
        if let Some(index) = chosen {
            names[index] = Some(key.clone());
            registered[index] = true;
        }
    }
    let base = |script: &Found| match script.layout {
        Layout::Folder => script.name.clone(),
        Layout::File => script.entry_name(),
    };
    let bases: BTreeSet<String> = found.iter().map(base).collect();
    let mut used: BTreeSet<String> = names.iter().flatten().cloned().collect();
    for (index, script) in found.iter().enumerate() {
        if names[index].is_some() {
            continue;
        }
        let base = base(script);
        let name = if used.contains(&base) {
            (2..)
                .map(|number| format!("{base} ({number})"))
                .find(|candidate| !used.contains(candidate) && !bases.contains(candidate))
                .unwrap_or_default()
        } else {
            base
        };
        used.insert(name.clone());
        names[index] = Some(name);
    }
    found
        .into_iter()
        .zip(names)
        .zip(registered)
        .map(|((found, name), registered)| Script {
            found,
            name: name.unwrap_or_default(),
            registered,
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use serde_json::{Value, json};

    use super::testing::{put, tree};
    use super::*;
    use crate::player::Restart;
    use crate::player::testing::{NoEvents, clip, eventually, headless, temp_paths};
    use crate::plugins::install::sha256_hex;
    use crate::system::diagnostics::{self, Diagnostics};

    /// The scripts `load-script` was asked for, in order.
    #[derive(Default)]
    struct Loads(Mutex<Vec<PathBuf>>);

    impl ScriptLoader for Loads {
        fn load_script(&self, entry: &Path) {
            self.0.lock().unwrap().push(entry.to_path_buf());
        }
    }

    impl Loads {
        fn seen(&self) -> Vec<PathBuf> {
            self.0.lock().unwrap().clone()
        }
    }

    /// A restart that succeeds without a player: what Apply needs of it, in tests that have no
    /// libmpv.
    fn no_restart() -> Result<(), RestartError> {
        Ok(())
    }

    fn info<'a>(state: &'a PluginsState, name: &str) -> &'a PluginInfo {
        state
            .plugins
            .iter()
            .find(|plugin| plugin.name == name)
            .unwrap_or_else(|| panic!("{name} is not listed: {:#?}", state.plugins))
    }

    fn names(state: &PluginsState) -> Vec<&str> {
        state
            .plugins
            .iter()
            .map(|plugin| plugin.name.as_str())
            .collect()
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn shipped_manifest() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../resources/essentials")
            .join(essentials::MANIFEST)
    }

    /// What the stand-in for an essential's file says.
    fn stand_in(name: &str) -> String {
        format!("-- the stand-in for {name}\n")
    }

    /// The shipped manifest with a [`stand_in`] for every file, as the installation's bundle under
    /// `paths` (where Tauri bundles the real ones).
    fn bundle(paths: &AppPaths) {
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(shipped_manifest()).unwrap()).unwrap();
        let bundle = essentials::bundle_dir(paths);
        for essential in manifest.as_array_mut().unwrap() {
            let name = essential["name"].as_str().unwrap().to_owned();
            for file in essential["files"].as_array_mut().unwrap() {
                let src = file["src"].as_str().unwrap().to_owned();
                let contents = stand_in(&name);
                put(&bundle.join(&name).join(&src), &contents);
                file["sha256"] = json!(sha256_hex(contents.as_bytes()));
            }
        }
        put(&essentials::manifest_path(paths), &manifest.to_string());
    }

    fn registry_on_disk(paths: &AppPaths) -> Registry {
        Registry::load(paths.config_dir.join(registry::FILE))
    }

    /// Writes a record of `name` with `files` (paths under the config folder, with `/`) into
    /// `plugins.json`, as an install would.
    fn register(paths: &AppPaths, name: &str, source: PluginSource, enabled: bool, files: &[&str]) {
        let mut registry = registry_on_disk(paths);
        registry.plugins.insert(
            name.to_owned(),
            PluginRecord {
                source,
                registry_id: None,
                version: Some("1.2.0".to_owned()),
                repo: None,
                commit: None,
                files: files
                    .iter()
                    .map(|path| registry::FileRecord {
                        path: (*path).to_owned(),
                        sha256: sha256_hex(path.as_bytes()),
                    })
                    .collect(),
                enabled,
                installed_at: "2026-10-19T12:00:00Z".to_owned(),
            },
        );
        registry
            .save(paths.config_dir.join(registry::FILE))
            .unwrap();
    }

    fn line(level: &str, prefix: &str) -> LogLine {
        LogLine {
            level: level.to_owned(),
            prefix: prefix.to_owned(),
            text: "Lua error: main.lua:1: attempt to call a nil value\n".to_owned(),
        }
    }

    // ---------------------------------------------------------------------------------------
    // On and off

    /// Spec 6.3: off is in `scripts-disabled\`, a folder or a file alike, and a plugin that runs
    /// keeps running until Apply.
    #[test]
    fn disabling_moves_the_script_and_asks_for_apply() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(
            &paths.scripts_dir.join("folder-x").join("main.lua"),
            "-- x\n",
        );
        put(&paths.scripts_dir.join("file-y.lua"), "-- y\n");
        put(
            &paths.scripts_dir.join("fancy").join("main.lua"),
            "-- fancy\n",
        );
        register(
            &paths,
            "fancy",
            PluginSource::Store,
            true,
            &["scripts/fancy/main.lua"],
        );
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let loads = Loads::default();

        let state = plugins.list();
        assert_eq!(names(&state), ["fancy", "file-y.lua", "folder-x"]);
        for plugin in &state.plugins {
            assert!(plugin.enabled && plugin.running, "{plugin:?}");
        }
        assert!(!state.restart_needed);

        let state = plugins.set_enabled("folder-x", false, &loads).unwrap();
        assert!(
            paths
                .scripts_disabled_dir
                .join("folder-x")
                .join("main.lua")
                .is_file()
        );
        assert!(!paths.scripts_dir.join("folder-x").exists());
        let x = info(&state, "folder-x");
        assert!(!x.enabled && x.running, "{x:?}");
        assert!(state.restart_needed);

        let state = plugins.set_enabled("file-y.lua", false, &loads).unwrap();
        assert_eq!(
            read(&paths.scripts_disabled_dir.join("file-y.lua")),
            "-- y\n"
        );
        assert!(!paths.scripts_dir.join("file-y.lua").exists());
        assert!(!info(&state, "file-y.lua").enabled);

        // One Kaleido installed is off in plugins.json too.
        let state = plugins.set_enabled("fancy", false, &loads).unwrap();
        assert!(
            paths
                .scripts_disabled_dir
                .join("fancy")
                .join("main.lua")
                .is_file()
        );
        assert!(!registry_on_disk(&paths).plugins["fancy"].enabled);
        assert_eq!(info(&state, "fancy").source, PluginSource::Store);
        assert!(state.restart_needed);
        assert!(loads.seen().is_empty(), "nothing is loaded");

        // Off again: nothing to do. A name that is not there: nothing either.
        let before = tree(tmp.path());
        plugins.set_enabled("folder-x", false, &loads).unwrap();
        assert_eq!(
            plugins.set_enabled("nope", false, &loads),
            Err(PluginError::NotFound {
                name: "nope".to_owned()
            })
        );
        assert_eq!(tree(tmp.path()), before);

        // Applied: the new core runs none of them, and nothing waits.
        let state = plugins.apply(no_restart, |_| {}).unwrap();
        assert!(!state.restart_needed);
        for plugin in &state.plugins {
            assert!(!plugin.enabled && !plugin.running, "{plugin:?}");
        }
    }

    /// Plan decision 3: off and on again before Apply is where it was, and the core, which still
    /// runs it, does not get it a second time.
    #[test]
    fn re_enabling_before_apply_loads_nothing_twice() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(&paths.scripts_dir.join("x").join("main.lua"), "-- x\n");
        put(&paths.scripts_dir.join("y.lua"), "-- y\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let loads = Loads::default();

        plugins.set_enabled("x", false, &loads).unwrap();
        assert!(
            plugins
                .set_enabled("y.lua", false, &loads)
                .unwrap()
                .restart_needed
        );
        plugins.set_enabled("x", true, &loads).unwrap();
        let state = plugins.set_enabled("y.lua", true, &loads).unwrap();

        assert!(paths.scripts_dir.join("x").join("main.lua").is_file());
        assert_eq!(read(&paths.scripts_dir.join("y.lua")), "-- y\n");
        assert!(!paths.scripts_disabled_dir.join("x").exists());
        assert!(!paths.scripts_disabled_dir.join("y.lua").exists());
        assert!(loads.seen().is_empty(), "{:?}", loads.seen());
        assert!(!state.restart_needed);
        for plugin in &state.plugins {
            assert!(plugin.enabled && plugin.running, "{plugin:?}");
        }
    }

    /// Spec 6.3: turned on while the player runs, a plugin runs at once: `load-script` with its
    /// folder (mpv names the script after it) or its file, in `scripts\`.
    #[test]
    fn enabling_a_stopped_plugin_loads_it_now() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(
            &paths.scripts_disabled_dir.join("probe").join("main.lua"),
            "-- probe\n",
        );
        put(&paths.scripts_disabled_dir.join("single.js"), "// single\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let loads = Loads::default();
        let state = plugins.list();
        for plugin in &state.plugins {
            assert!(!plugin.enabled && !plugin.running, "{plugin:?}");
        }

        let state = plugins.set_enabled("probe", true, &loads).unwrap();

        assert_eq!(loads.seen(), [paths.scripts_dir.join("probe")]);
        assert!(paths.scripts_dir.join("probe").join("main.lua").is_file());
        let probe = info(&state, "probe");
        assert!(probe.enabled && probe.running, "{probe:?}");
        assert!(!state.restart_needed);

        let state = plugins.set_enabled("single.js", true, &loads).unwrap();
        assert_eq!(
            loads.seen(),
            [
                paths.scripts_dir.join("probe"),
                paths.scripts_dir.join("single.js")
            ]
        );
        assert!(info(&state, "single.js").running);

        // Off and on again before Apply: it runs already.
        plugins.set_enabled("probe", false, &loads).unwrap();
        let state = plugins.set_enabled("probe", true, &loads).unwrap();
        assert_eq!(loads.seen().len(), 2);
        assert!(!state.restart_needed);
    }

    // ---------------------------------------------------------------------------------------
    // Uninstall and the essentials

    /// Plan decision 4: an uninstalled essential is remembered as removed, so that no start copies
    /// it again, and its settings stay. The files go to the Recycle Bin: this puts a stand-in of
    /// reload and a stand-in of an older version into the real bin of whoever runs the tests.
    #[test]
    fn uninstalling_an_essential_remembers_it() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        put(&paths.scripts_dir.join("mine.lua"), "-- mine\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let state = plugins.list();
        assert_eq!(
            names(&state),
            ["mine.lua", "reload", "sub-select", "thumbfast"]
        );
        let options = paths.script_opts_dir.join("reload.conf");
        put(&options, "demuxer_cache_timer_timeout=60\n");
        // An install of reload that did not finish left its previous version, which a sweep would
        // put back once the folder is free.
        let left = paths
            .config_dir
            .join(install::STAGING_DIR)
            .join("reload-1")
            .join("old")
            .join("scripts")
            .join("reload")
            .join("main.lua");
        put(&left, "-- an older reload\n");

        let state = plugins.uninstall("reload").unwrap();

        assert!(!paths.scripts_dir.join("reload").exists());
        assert!(!left.exists(), "it would come back from there");
        assert_eq!(read(&options), "demuxer_cache_timer_timeout=60\n");
        let on_disk = registry_on_disk(&paths);
        assert!(!on_disk.plugins.contains_key("reload"));
        assert!(on_disk.removed.contains("reload"));
        assert_eq!(state.removed_essentials, ["reload"]);
        assert!(!names(&state).contains(&"reload"));
        assert!(state.restart_needed, "it runs until Apply");

        // A manual script goes to the bin the same way, and nothing is remembered of it.
        let state = plugins.uninstall("mine.lua").unwrap();
        assert!(!paths.scripts_dir.join("mine.lua").exists());
        assert_eq!(state.removed_essentials, ["reload"]);
        assert_eq!(names(&state), ["sub-select", "thumbfast"]);

        // The next start does not copy it again.
        let again = Plugins::start(&paths, UiLanguage::En);
        assert!(!paths.scripts_dir.join("reload").exists());
        assert_eq!(again.list().removed_essentials, ["reload"]);
    }

    /// "Obnovit essentials": the removed ones and the ones whose files are gone come back, with
    /// their managed options, and the ones the core does not run are loaded now.
    #[test]
    fn restoring_essentials_brings_them_back() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        let plugins = Plugins::start(&paths, UiLanguage::En);
        plugins.uninstall("reload").unwrap();
        let state = plugins.apply(no_restart, |_| {}).unwrap();
        assert!(!state.restart_needed);
        // thumbfast's folder deleted by hand: its record stays, its files are gone (the core that
        // runs still has it).
        fs::remove_dir_all(paths.scripts_dir.join("thumbfast")).unwrap();
        let conf = paths.script_opts_dir.join("thumbfast.conf");
        fs::remove_file(&conf).unwrap();
        assert_eq!(plugins.list().removed_essentials, ["thumbfast", "reload"]);
        let loads = Loads::default();

        let state = plugins.restore_essentials(&loads).unwrap();

        for name in ["thumbfast", "reload"] {
            assert_eq!(
                read(&paths.scripts_dir.join(name).join("main.lua")),
                stand_in(name),
                "{name}"
            );
            assert_eq!(info(&state, name).source, PluginSource::Bundled);
        }
        assert!(state.removed_essentials.is_empty());
        let on_disk = registry_on_disk(&paths);
        assert!(on_disk.removed.is_empty());
        assert!(on_disk.plugins.contains_key("reload"));
        assert!(read(&conf).contains("network=no\n"), "managed again");
        // reload did not run and is loaded now; thumbfast still runs.
        assert_eq!(loads.seen(), [paths.scripts_dir.join("reload")]);
        assert!(info(&state, "reload").running && info(&state, "thumbfast").running);
        assert!(!state.restart_needed);

        // Nothing removed: nothing to do.
        let before = tree(tmp.path());
        plugins.restore_essentials(&loads).unwrap();
        assert_eq!(tree(tmp.path()), before);
        assert_eq!(loads.seen().len(), 1);
    }

    /// Review focus 1 and the carry of Task 5: the user's own thumbfast beside the essentials is
    /// theirs, says whose copy it is (Kaleido writes no options for it), and is edited as keys and
    /// values.
    #[test]
    fn a_manual_copy_of_an_essential_says_whose_copy_it_is() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        put(
            &paths.scripts_dir.join("thumbfast.lua"),
            "-- my thumbfast\n",
        );
        put(
            &paths.scripts_dir.join("uosc").join("main.lua"),
            "-- uosc\n",
        );
        let plugins = Plugins::start(&paths, UiLanguage::En);

        let state = plugins.list();

        assert_eq!(
            names(&state),
            ["reload", "sub-select", "thumbfast.lua", "uosc"]
        );
        let copy = info(&state, "thumbfast.lua");
        assert_eq!(copy.source, PluginSource::Manual);
        assert_eq!(copy.script_name, "thumbfast");
        assert_eq!(copy.copy_of.as_deref(), Some("thumbfast"));
        assert_eq!(copy.settings, SettingsForm::KeyValue);
        assert_eq!(copy.summary, None);
        assert!(!copy.duplicate && !copy.incompatible);
        let essential = info(&state, "sub-select");
        assert_eq!(essential.copy_of, None);
        assert_eq!(essential.settings, SettingsForm::Schema);
        assert!(essential.summary.is_some() && essential.version.is_some());
        assert!(info(&state, "uosc").incompatible);
        // Never Kaleido's here: nothing to restore, no managed options.
        assert!(state.removed_essentials.is_empty());
        assert!(!paths.script_opts_dir.join("thumbfast.conf").exists());
        let settings = plugins.settings("thumbfast.lua").unwrap();
        assert_eq!(settings.schema, None);
        assert!(settings.managed.is_empty());
    }

    /// Review of Task 7: the user deleted Kaleido's `scripts\thumbfast\` and dropped in their own
    /// `thumbfast.lua`. The file is theirs: manual, a copy of thumbfast, with their own options
    /// (no schema, no managed keys, nothing written for it at a start); thumbfast is missing and
    /// offered by Restore; uninstalling the file leaves thumbfast's record alone. Uses the real
    /// Recycle Bin once (the user's stand-in file).
    #[test]
    fn a_users_file_where_an_essentials_folder_was_is_the_users() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        let plugins = Plugins::start(&paths, UiLanguage::En);
        fs::remove_dir_all(paths.scripts_dir.join("thumbfast")).unwrap();
        put(
            &paths.scripts_dir.join("thumbfast.lua"),
            "-- my thumbfast\n",
        );
        let conf = paths.script_opts_dir.join("thumbfast.conf");
        put(&conf, "max_height=300\n");

        let state = plugins.list();

        assert_eq!(names(&state), ["reload", "sub-select", "thumbfast.lua"]);
        let copy = info(&state, "thumbfast.lua");
        assert_eq!(copy.source, PluginSource::Manual);
        assert_eq!(copy.copy_of.as_deref(), Some("thumbfast"));
        assert_eq!(copy.settings, SettingsForm::KeyValue);
        assert_eq!(copy.version, None);
        assert_eq!(state.removed_essentials, ["thumbfast"]);
        let settings = plugins.settings("thumbfast.lua").unwrap();
        assert_eq!(settings.schema, None);
        assert!(settings.managed.is_empty());
        assert_eq!(
            settings.entries,
            [OptEntry {
                key: "max_height".to_owned(),
                value: "300".to_owned()
            }]
        );
        // mpv_path is the user's to set for their copy.
        plugins
            .set_setting("thumbfast.lua", "mpv_path", Some("mpv"))
            .unwrap();
        assert_eq!(read(&conf), "max_height=300\nmpv_path=mpv\n");

        // Neither before a restart nor at the next start does Kaleido write its options there.
        plugins.write_managed();
        drop(Plugins::start(&paths, UiLanguage::En));
        assert_eq!(read(&conf), "max_height=300\nmpv_path=mpv\n");

        // Uninstalled, the user's file goes; thumbfast's record and the removed list stay as
        // they were.
        let state = plugins.uninstall("thumbfast.lua").unwrap();
        assert!(!paths.scripts_dir.join("thumbfast.lua").exists());
        let on_disk = registry_on_disk(&paths);
        assert!(on_disk.plugins.contains_key("thumbfast"));
        assert!(on_disk.removed.is_empty());
        assert_eq!(state.removed_essentials, ["thumbfast"]);

        // Restore brings Kaleido's back, with its options.
        let state = plugins.restore_essentials(&Loads::default()).unwrap();
        assert_eq!(
            read(&paths.scripts_dir.join("thumbfast").join("main.lua")),
            stand_in("thumbfast")
        );
        assert_eq!(info(&state, "thumbfast").source, PluginSource::Bundled);
        assert!(state.removed_essentials.is_empty());
        assert!(read(&conf).contains("network=no\n"), "{}", read(&conf));
    }

    /// The carry of Task 3: every script is listed once under a name of its own, which every
    /// command takes, and only scripts that are on count as duplicates.
    #[test]
    fn every_script_has_a_name_of_its_own() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        // A folder and a file mpv knows by one name.
        put(&paths.scripts_dir.join("x").join("main.lua"), "-- x\n");
        put(&paths.scripts_dir.join("x.lua"), "-- x too\n");
        // One folder on and off, and a folder named like the second of it.
        put(&paths.scripts_dir.join("twice").join("main.lua"), "-- on\n");
        put(
            &paths.scripts_disabled_dir.join("twice").join("main.lua"),
            "-- off\n",
        );
        put(
            &paths
                .scripts_disabled_dir
                .join("twice (2)")
                .join("main.lua"),
            "-- another\n",
        );
        // A file plugins.json has a record of, by its name without the extension: the record
        // lists the file.
        put(&paths.scripts_dir.join("mine.js"), "// mine\n");
        register(
            &paths,
            "mine",
            PluginSource::Manual,
            true,
            &["scripts/mine.js"],
        );
        // A file of a record's name that the record does not list (it lists a folder, gone): the
        // user's, by its name with the extension.
        put(&paths.scripts_dir.join("other.lua"), "-- mine too\n");
        register(
            &paths,
            "other",
            PluginSource::Store,
            true,
            &["scripts/other/main.lua"],
        );
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let loads = Loads::default();

        let state = plugins.list();

        assert_eq!(
            names(&state),
            [
                "mine",
                "other.lua",
                "twice",
                "twice (3)",
                "twice (2)",
                "x",
                "x.lua"
            ]
        );
        assert!(info(&state, "x").duplicate && info(&state, "x.lua").duplicate);
        for name in ["mine", "twice", "twice (3)", "twice (2)"] {
            assert!(!info(&state, name).duplicate, "{name}");
        }
        assert_eq!(info(&state, "mine").version.as_deref(), Some("1.2.0"));
        assert_eq!(info(&state, "mine").source, PluginSource::Manual);
        assert_eq!(info(&state, "other.lua").source, PluginSource::Manual);
        assert_eq!(info(&state, "other.lua").version, None);
        assert!(!info(&state, "twice (3)").enabled);

        // The second "twice" cannot be turned on beside the first, and can be uninstalled.
        assert!(matches!(
            plugins.set_enabled("twice (3)", true, &loads),
            Err(PluginError::Io { .. })
        ));
        let state = plugins.uninstall("twice (3)").unwrap();
        assert_eq!(
            read(&paths.scripts_dir.join("twice").join("main.lua")),
            "-- on\n"
        );
        assert_eq!(
            names(&state),
            ["mine", "other.lua", "twice", "twice (2)", "x", "x.lua"]
        );

        // Off, the file is no duplicate any more.
        let state = plugins.set_enabled("x.lua", false, &loads).unwrap();
        assert!(!info(&state, "x").duplicate && !info(&state, "x.lua").duplicate);
        // The recorded file keeps its record's name and goes off in the record.
        let state = plugins.set_enabled("mine", false, &loads).unwrap();
        assert!(paths.scripts_disabled_dir.join("mine.js").is_file());
        assert!(!info(&state, "mine").enabled);
        assert!(!registry_on_disk(&paths).plugins["mine"].enabled);
    }

    /// Controller Ruling R6: with a `plugins.json` that could not be read, nothing changes, after
    /// one more try to read it; the list still shows what is there.
    #[test]
    fn a_registry_that_cannot_be_read_refuses_every_change() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(&paths.scripts_dir.join("x").join("main.lua"), "-- x\n");
        put(&paths.scripts_disabled_dir.join("y.lua"), "-- y\n");
        // A folder in its place cannot be read, at the start and at the second try.
        fs::create_dir(paths.config_dir.join(registry::FILE)).unwrap();
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let before = tree(tmp.path());
        let loads = Loads::default();
        let refused = |error: PluginError| {
            assert!(
                matches!(&error, PluginError::Io { message } if message.contains("cannot be read")),
                "{error:?}"
            );
        };

        refused(plugins.set_enabled("x", false, &loads).unwrap_err());
        refused(plugins.set_enabled("y.lua", true, &loads).unwrap_err());
        refused(plugins.uninstall("x").unwrap_err());
        refused(plugins.restore_essentials(&loads).unwrap_err());
        refused(plugins.set_setting("x", "a", Some("1")).unwrap_err());

        assert_eq!(tree(tmp.path()), before);
        assert!(loads.seen().is_empty());
        assert_eq!(names(&plugins.list()), ["x", "y.lua"]);
    }

    // ---------------------------------------------------------------------------------------
    // Settings

    #[test]
    fn managed_keys_cannot_be_set_from_the_ui() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let conf = paths.script_opts_dir.join("thumbfast.conf");
        let before = read(&conf);

        let settings = plugins.settings("thumbfast").unwrap();
        assert_eq!(settings.managed, ["mpv_path", "network", "tone_mapping"]);
        assert!(settings.entries.is_empty(), "{:?}", settings.entries);
        assert_eq!(settings.schema.as_ref().map(Vec::len), Some(4));

        for (key, value) in [
            ("mpv_path", Some(r"C:\mpv\mpv.exe")),
            ("mpv_path", None),
            ("network", Some("yes")),
        ] {
            assert!(
                matches!(
                    plugins.set_setting("thumbfast", key, value),
                    Err(PluginError::Invalid { key: refused, .. }) if refused == key
                ),
                "{key}"
            );
        }
        assert_eq!(read(&conf), before);
        assert!(!plugins.list().restart_needed);
    }

    /// Plan decision 3: scripts read their `script-opts` when they load, so a change of a plugin
    /// that runs waits for Apply, and one of a plugin that does not run waits for nothing.
    #[test]
    fn a_settings_change_of_a_running_plugin_waits_for_apply() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        put(&paths.scripts_dir.join("my-plugin.lua"), "-- mine\n");
        put(&paths.scripts_disabled_dir.join("off.lua"), "-- off\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let conf = paths.script_opts_dir.join("thumbfast.conf");

        let settings = plugins
            .set_setting("thumbfast", "max_height", Some("300"))
            .unwrap();

        assert_eq!(
            settings.entries,
            [OptEntry {
                key: "max_height".to_owned(),
                value: "300".to_owned()
            }]
        );
        assert!(read(&conf).contains("max_height=300\n"), "{}", read(&conf));
        assert!(
            read(&conf).contains("network=no\n"),
            "the managed ones stay"
        );
        assert!(plugins.list().restart_needed);
        // Checked against the schema, and written as the script reads it.
        assert_eq!(
            plugins.set_setting("thumbfast", "max_height", Some("700")),
            Err(PluginError::Invalid {
                key: "max_height".to_owned(),
                reason: "must be at most 600".to_owned()
            })
        );
        assert!(matches!(
            plugins.set_setting("thumbfast", "nope", Some("1")),
            Err(PluginError::Invalid { .. })
        ));
        plugins
            .set_setting("thumbfast", "hwdec", Some("true"))
            .unwrap();
        assert!(read(&conf).contains("hwdec=yes\n"));
        assert!(!plugins.apply(no_restart, |_| {}).unwrap().restart_needed);

        // Without a schema: script-opts\<script name>.conf, keys and values as they are.
        let settings = plugins
            .set_setting("my-plugin.lua", "font_size", Some("20"))
            .unwrap();
        assert_eq!(settings.schema, None);
        assert!(settings.managed.is_empty());
        let mine = paths.script_opts_dir.join("my_plugin.conf");
        assert_eq!(read(&mine), "font_size=20\n");
        assert!(plugins.list().restart_needed);
        assert_eq!(
            plugins.set_setting("my-plugin.lua", "font size", Some("1")),
            Err(PluginError::Invalid {
                key: "font size".to_owned(),
                reason: "a key of letters, digits, _ and -".to_owned()
            })
        );
        assert_eq!(
            plugins.set_setting("my-plugin.lua", "title", Some("a\nb")),
            Err(PluginError::Invalid {
                key: "title".to_owned(),
                reason: "a value without line breaks".to_owned()
            })
        );
        let settings = plugins
            .set_setting("my-plugin.lua", "font_size", None)
            .unwrap();
        assert!(settings.entries.is_empty());
        assert_eq!(read(&mine), "");
        assert!(!plugins.apply(no_restart, |_| {}).unwrap().restart_needed);

        // Not running: it reads the change when it loads, nothing waits.
        plugins.set_setting("off.lua", "a", Some("1")).unwrap();
        assert_eq!(read(&paths.script_opts_dir.join("off.conf")), "a=1\n");
        assert!(!plugins.list().restart_needed);
        // The value it has: nothing changes, nothing waits.
        plugins
            .set_setting("thumbfast", "max_height", Some("300"))
            .unwrap();
        assert!(!plugins.list().restart_needed);
    }

    // ---------------------------------------------------------------------------------------
    // Apply, errors, diagnostics

    /// While the core restarts, the UI may send more; nothing changes until it runs again.
    #[test]
    fn changes_while_applying_are_busy() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(&paths.scripts_dir.join("x").join("main.lua"), "-- x\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let loads = Loads::default();
        let before = tree(tmp.path());
        let heard = RefCell::new(Vec::new());
        let during = RefCell::new(None);

        let state = plugins
            .apply(
                || {
                    *during.borrow_mut() = Some((
                        plugins.set_enabled("x", false, &loads),
                        plugins.uninstall("x"),
                        plugins.restore_essentials(&loads),
                        plugins.set_setting("x", "a", Some("1")),
                        plugins.apply(no_restart, |_| panic!("a refused Apply tells nothing")),
                        plugins.list(),
                    ));
                    Ok(())
                },
                |state| heard.borrow_mut().push(state.applying),
            )
            .unwrap();

        let (off, uninstalled, restored, set, applied, listed) = during.into_inner().unwrap();
        assert_eq!(off, Err(PluginError::Busy));
        assert_eq!(uninstalled, Err(PluginError::Busy));
        assert_eq!(restored, Err(PluginError::Busy));
        assert_eq!(set, Err(PluginError::Busy));
        assert_eq!(applied, Err(PluginError::Busy));
        assert!(listed.applying);
        assert_eq!(names(&listed), ["x"]);
        assert_eq!(tree(tmp.path()), before);
        assert!(loads.seen().is_empty());
        assert_eq!(heard.into_inner(), [true, false]);
        assert!(!state.applying);
        // Done: changes go through again.
        assert!(
            plugins
                .set_enabled("x", false, &loads)
                .unwrap()
                .restart_needed
        );
    }

    /// A restart that panics (on its blocking thread in the app) does not leave Apply running, and
    /// the UI hears that it ended: the second `plugins:changed`, without `applying`, comes before
    /// the panic goes on.
    #[test]
    fn apply_ends_when_the_restart_panics() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(&paths.scripts_dir.join("x").join("main.lua"), "-- x\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let heard = Mutex::new(Vec::new());

        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            plugins.apply(
                || panic!("a deliberate panic in the restart"),
                |state| heard.lock().unwrap().push(state.applying),
            )
        }));

        assert!(result.is_err(), "the panic goes on to the caller");
        assert_eq!(*heard.lock().unwrap(), [true, false]);
        assert!(!plugins.list().applying);
        assert!(plugins.set_enabled("x", false, &Loads::default()).is_ok());
        // A restart that started no core: the changes still wait, and the UI hears both states.
        heard.lock().unwrap().clear();
        let failed = plugins.apply(
            || Err(RestartError::Start("mpv failed".to_owned())),
            |state| heard.lock().unwrap().push(state.applying),
        );
        assert_eq!(failed, Err(PluginError::Unavailable));
        assert_eq!(*heard.lock().unwrap(), [true, false]);
        let state = plugins.list();
        assert!(state.restart_needed && !state.applying);
    }

    /// Spec 10.4 through the service: a running plugin's errors are counted on its row and kept
    /// for its log, and the first one is told once.
    #[test]
    fn plugin_errors_reach_the_list_and_the_log() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        put(&paths.scripts_disabled_dir.join("off.lua"), "-- off\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);

        assert_eq!(
            plugins.note_log(&line("error", "sub_select")).as_deref(),
            Some("sub-select")
        );
        assert_eq!(plugins.note_log(&line("error", "sub_select")), None);
        assert_eq!(plugins.note_log(&line("warn", "thumbfast")), None);
        // One that does not run logs nothing: a line under its name is someone else's.
        assert_eq!(plugins.note_log(&line("error", "off")), None);

        let state = plugins.list();
        assert_eq!(info(&state, "sub-select").errors, 2);
        assert_eq!(info(&state, "thumbfast").errors, 0);
        assert_eq!(info(&state, "off.lua").errors, 0);
        assert_eq!(plugins.log("sub-select").len(), 2);
        assert!(plugins.log("thumbfast").is_empty());

        // Turned on at run time, its lines are its own.
        plugins
            .set_enabled("off.lua", true, &Loads::default())
            .unwrap();
        assert_eq!(
            plugins.note_log(&line("fatal", "off")).as_deref(),
            Some("off.lua")
        );
        assert_eq!(info(&plugins.list(), "off.lua").errors, 1);
    }

    /// Spec 10.8: the diagnostics list every plugin with its version and source, and nothing of
    /// where they are.
    #[test]
    fn diagnostics_list_plugins_without_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        bundle(&paths);
        put(
            &paths.scripts_dir.join("uosc").join("main.lua"),
            "-- uosc\n",
        );
        put(&paths.scripts_disabled_dir.join("Žluť kůň.lua"), "-- off\n");
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let manifest = essentials::load_manifest(&shipped_manifest()).unwrap();
        let version = |name: &str| {
            manifest
                .iter()
                .find(|essential| essential.name == name)
                .unwrap()
                .version
                .clone()
        };

        let listed = plugins.diagnostics();

        assert_eq!(
            listed,
            [
                format!("reload {} (bundled)", version("reload")),
                format!("sub-select {} (bundled)", version("sub-select")),
                format!("thumbfast {} (bundled)", version("thumbfast")),
                "uosc - (manual)".to_owned(),
                "Žluť kůň.lua - (manual)".to_owned(),
            ]
        );
        let text = diagnostics::sanitize(&diagnostics::render(&Diagnostics {
            kaleido: "0.2.0".to_owned(),
            libmpv: "mpv v0.41.0".to_owned(),
            ffmpeg: "7.1".to_owned(),
            windows: "10.0.26200".to_owned(),
            gpu: "Some GPU".to_owned(),
            tools: diagnostics::ToolVersions::default(),
            plugins: listed.clone(),
        }));
        assert!(
            text.ends_with(&format!("Plugins: {}\n", listed.join(", "))),
            "{text}"
        );
        let root = tmp.path().to_string_lossy();
        assert!(!text.contains(root.as_ref()), "{text}");
        for entry in &listed {
            assert!(!entry.contains(['\\', '/', ':']), "{entry}");
        }
    }

    // ---------------------------------------------------------------------------------------
    // A real libmpv

    /// A script that stays loaded and takes `script-message-to <its name> ping`.
    const PROBE: &str = "mp.register_script_message(\"ping\", function() end)\n";

    /// Whether the core has a client called `client` (`script-message-to` fails without one).
    fn answers(engine: &Engine, client: &'static str) -> bool {
        engine.call(move |mpv| mpv.command(&["script-message-to", client, "ping"]).is_ok())
    }

    /// Spec 6.3: a plugin turned on while the player runs is a client of the core at once.
    /// Needs a real libmpv.
    #[test]
    fn a_plugin_enabled_at_run_time_runs_at_once() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(
            &paths.scripts_disabled_dir.join("probe").join("main.lua"),
            PROBE,
        );
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        assert!(!answers(&engine, "probe"), "off, mpv has not loaded it");

        let state = plugins.set_enabled("probe", true, &engine).unwrap();

        let probe = info(&state, "probe");
        assert!(probe.enabled && probe.running, "{probe:?}");
        assert!(!state.restart_needed);
        eventually(&engine, "the probe runs", |mpv| {
            mpv.command(&["script-message-to", "probe", "ping"]).is_ok()
        });
    }

    /// Spec 6.3: a plugin turned off runs until Apply, and the core Apply starts plays on without
    /// it. Needs a real libmpv.
    #[test]
    fn apply_stops_a_disabled_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(&paths.scripts_dir.join("probe").join("main.lua"), PROBE);
        let plugins = Plugins::start(&paths, UiLanguage::En);
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        eventually(&engine, "the probe runs", |mpv| {
            mpv.command(&["script-message-to", "probe", "ping"]).is_ok()
        });
        let path = clip(tmp.path(), 10).to_string_lossy().into_owned();
        engine.command(&["loadfile", &path]);
        eventually(&engine, "the clip plays", |mpv| {
            mpv.get_f64("time-pos").is_ok_and(|time| time > 0.2)
        });

        let state = plugins.set_enabled("probe", false, &engine).unwrap();
        assert!(state.restart_needed);
        assert!(answers(&engine, "probe"), "it runs until Apply");

        let heard = Mutex::new(Vec::new());
        let state = plugins
            .apply(
                || engine.restart(Restart::new(NoEvents)),
                |state| heard.lock().unwrap().push(state.applying),
            )
            .unwrap();

        assert!(!state.applying && !state.restart_needed);
        assert!(!info(&state, "probe").running);
        assert_eq!(*heard.lock().unwrap(), [true, false]);
        eventually(&engine, "the clip plays on in the new core", move |mpv| {
            mpv.get_string("path").is_ok_and(|playing| playing == path)
                && mpv.get_f64("time-pos").is_ok_and(|time| time > 0.2)
                && !mpv.get_flag("idle-active").unwrap_or(true)
        });
        assert!(!answers(&engine, "probe"), "the new core has no probe");
    }
}
