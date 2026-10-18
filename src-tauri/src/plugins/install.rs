//! Installing a plugin, all at once or not at all (spec 6.3). Every destination is checked first
//! ([`targets::parse`]); then every file is read and checked against its SHA-256 into a staging
//! folder in the config folder, so that the moves into place are renames on the same volume; only
//! then does anything in `scripts\`, `script-opts\`, `shaders\` or `fonts\` change. If a step
//! fails, what was moved goes back where it was, the staging folder goes, and the plugin, its
//! files and `plugins.json` are as they were.
//!
//! - The plugin's folder is replaced whole: an older version (in `scripts\` or in
//!   `scripts-disabled\`) is moved into the staging folder first and goes with it once the new
//!   one is in place, so no file of it is left beside the new ones.
//! - `script-opts\<name>.conf` that is there already is the user's settings and stays.
//! - A shader or a font of the same name with the same contents is the plugin's file already; one
//!   with other contents belongs to someone else, and the install is refused.
//!
//! An install's staging folder, `.kaleido-staging\<name>-<nanos>\`, holds the new plugin folder in
//! `folder\`, its other new files in `files\`, and the previous version of the plugin's folder in
//! `old\scripts\<name>` or `old\scripts-disabled\<name>`, named by where it came from. When the
//! app ends in the middle of an install, or a rollback cannot put the previous version back, the
//! next start and the next install sweep what is left (`sweep`): a previous version goes back to
//! its place when nothing has taken it since, and is kept otherwise; only the staged new files are
//! deleted.
//!
//! Installs run one at a time: the registry they write is borrowed for the whole install.

use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::registry::{self, FileRecord, PluginRecord, Registry};
use super::targets::{self, Target, TargetError};
use crate::paths::AppPaths;

/// The folder in `config_dir` the installs stage their files in, one folder for each install.
pub const STAGING_DIR: &str = ".kaleido-staging";

/// The parts of a staging folder that hold only new files: never the one copy of anything.
const STAGED_NEW: [&str; 2] = ["folder", "files"];
/// The part of a staging folder that holds the previous version of the plugin's folder.
const STAGED_OLD: &str = "old";

/// The folders a plugin's own folder lives in, with the name the staging folder's `old\` gives
/// them.
fn homes(paths: &AppPaths) -> [(&'static str, &Path); 2] {
    [
        ("scripts", &paths.scripts_dir),
        ("scripts-disabled", &paths.scripts_disabled_dir),
    ]
}

/// Where the bytes of a file come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileSource {
    Bytes(Vec<u8>),
    /// A file on the disk (the installation's bundle, a download).
    Path(PathBuf),
}

/// One file to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    /// Where it goes, under the config folder (see [`targets::parse`]).
    pub dest: String,
    pub source: FileSource,
    /// What the SHA-256 of its bytes must be, as hex.
    pub sha256: String,
}

/// A plugin to install: its name (its folder in `scripts\`), its files and the record
/// `plugins.json` gets for it. The record's `files` are filled in by the install: the files of the
/// plan with the checksums they were installed with, whatever the record held before. The
/// record's `enabled` says whether the folder goes to `scripts\` or to `scripts-disabled\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlan {
    pub name: String,
    pub files: Vec<PlannedFile>,
    pub record: PluginRecord,
}

/// Why an install did not happen. In every case nothing changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// A destination (or the plugin's name) is not one a plugin may write to.
    Target(TargetError),
    /// A file is not the one the plan names.
    Checksum {
        dest: String,
        expected: String,
        actual: String,
    },
    /// Another file is where this one would go: a shader or a font of the same name with other
    /// contents, or a second file of the plan with the same destination.
    Conflict { dest: String },
    /// Reading or writing failed, or `plugins.json` may not be written (see
    /// [`Registry::refused`]).
    Io(String),
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InstallError::Target(error) => write!(f, "{error}"),
            InstallError::Checksum {
                dest,
                expected,
                actual,
            } => write!(f, "{dest}: the SHA-256 is {actual}, not {expected}"),
            InstallError::Conflict { dest } => {
                write!(f, "{dest}: another file of that name is in the way")
            }
            InstallError::Io(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for InstallError {}

impl From<TargetError> for InstallError {
    fn from(error: TargetError) -> InstallError {
        InstallError::Target(error)
    }
}

/// An [`InstallError::Io`] that says what was being done.
fn io_error(what: impl fmt::Display, error: io::Error) -> InstallError {
    InstallError::Io(format!("{what}: {error}"))
}

/// The SHA-256 of `bytes` as lowercase hex, as manifests and `plugins.json` write it.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Installs `plan` (see the module), writes its record into `registry` (taking the name off the
/// removed essentials) and saves the registry. On an error nothing changed: not the disk, not
/// `registry`. A [`refused`](Registry::refused) registry installs nothing and touches no file.
pub fn install(
    paths: &AppPaths,
    registry: &mut Registry,
    plan: InstallPlan,
) -> Result<(), InstallError> {
    if let Some(reason) = registry.refused() {
        return Err(InstallError::Io(format!(
            "plugins.json is left as it is, so nothing is installed: {reason}"
        )));
    }
    let InstallPlan {
        name,
        files,
        mut record,
    } = plan;
    targets::check_name(&name).map_err(|refusal| TargetError {
        dest: name.clone(),
        refusal,
    })?;
    // Every destination before anything is read or written.
    let mut planned = Vec::with_capacity(files.len());
    let mut seen = BTreeSet::new();
    for file in files {
        let target = targets::parse(&file.dest, &name)?;
        // Windows does not tell `A.glsl` from `a.glsl`.
        if !seen.insert(target.dest().to_lowercase()) {
            return Err(InstallError::Conflict {
                dest: target.dest(),
            });
        }
        planned.push((target, file.source, file.sha256));
    }

    let staging_root = paths.config_dir.join(STAGING_DIR);
    sweep(paths, &staging_root);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let staging = staging_root.join(format!("{name}-{nanos}"));

    let mut undo = Undo::default();
    let result = stage_and_place(
        paths,
        registry,
        &name,
        planned,
        &mut record,
        &staging,
        &mut undo,
    );
    // The error itself is the caller's to log or to show.
    let restored = match &result {
        Ok(()) => true,
        Err(_) => undo.roll_back(),
    };
    if restored {
        if let Err(error) = remove_dir_all_if_there(&staging) {
            tracing::warn!(
                "cannot remove the staging folder {}: {error}",
                staging.display()
            );
        }
        // Only when it is empty: a leftover the sweep kept stays in it.
        let _ = fs::remove_dir(&staging_root);
    } else {
        tracing::error!(
            "the files {name} had before could not all be put back; what is left of them is in \
             {}, and the next install puts it back when its place is free",
            staging.display()
        );
    }
    result
}

/// What an install changed so far, so that a failure can put it back.
#[derive(Default)]
struct Undo {
    /// Folders made for the install, in the order they were made.
    made: Vec<PathBuf>,
    /// What was moved out of the way, as `(where it is now, where it was)`.
    moved_aside: Vec<(PathBuf, PathBuf)>,
    /// Files and folders the install put in place.
    placed: Vec<PathBuf>,
}

impl Undo {
    /// Takes back what the install did, the last step first. Returns whether everything that
    /// was moved aside is back.
    fn roll_back(self) -> bool {
        for placed in self.placed.iter().rev() {
            let removed = if placed.is_dir() {
                fs::remove_dir_all(placed)
            } else {
                fs::remove_file(placed)
            };
            if let Err(error) = removed {
                tracing::error!(
                    "cannot take back {} after a failed install: {error}",
                    placed.display()
                );
            }
        }
        let mut restored = true;
        for (aside, original) in self.moved_aside.iter().rev() {
            if let Err(error) = fs::rename(aside, original) {
                tracing::error!(
                    "cannot put {} back after a failed install: {error}",
                    original.display()
                );
                restored = false;
            }
        }
        for made in self.made.iter().rev() {
            // Only an empty one: whatever is in it is not the install's.
            let _ = fs::remove_dir(made);
        }
        restored
    }

    /// Makes `dir` and the folders above it that are missing, and remembers the ones it made.
    fn make_dir(&mut self, dir: &Path) -> Result<(), InstallError> {
        let mut missing = Vec::new();
        let mut at = Some(dir);
        while let Some(dir) = at {
            if dir.is_dir() {
                break;
            }
            missing.push(dir.to_path_buf());
            at = dir.parent();
        }
        for dir in missing.into_iter().rev() {
            fs::create_dir(&dir).map_err(|error| {
                io_error(
                    format_args!("cannot make the folder {}", dir.display()),
                    error,
                )
            })?;
            self.made.push(dir);
        }
        Ok(())
    }

    /// Renames `from` to `to` and remembers that `to` was put in place.
    fn place(&mut self, from: &Path, to: &Path) -> Result<(), InstallError> {
        fs::rename(from, to)
            .map_err(|error| io_error(format_args!("cannot move into {}", to.display()), error))?;
        self.placed.push(to.to_path_buf());
        Ok(())
    }

    /// Moves `from` out of the way to `aside` (in the staging folder, whose folders it makes) and
    /// remembers it.
    fn move_aside(&mut self, from: &Path, aside: &Path) -> Result<(), InstallError> {
        let moved = match aside.parent() {
            Some(parent) => fs::create_dir_all(parent),
            None => Ok(()),
        }
        .and_then(|()| fs::rename(from, aside));
        moved.map_err(|error| {
            io_error(format_args!("cannot move {} aside", from.display()), error)
        })?;
        self.moved_aside
            .push((aside.to_path_buf(), from.to_path_buf()));
        Ok(())
    }
}

/// One file read, checked and written into the staging folder.
struct Staged {
    target: Target,
    /// Where it is in the staging folder.
    at: PathBuf,
    sha256: String,
}

/// Steps 2 to 5 of an install: stage, put in place, record. Whatever it changes outside the
/// staging folder is in `undo`.
fn stage_and_place(
    paths: &AppPaths,
    registry: &mut Registry,
    name: &str,
    planned: Vec<(Target, FileSource, String)>,
    record: &mut PluginRecord,
    staging: &Path,
    undo: &mut Undo,
) -> Result<(), InstallError> {
    // The plugin's folder is staged as one folder, so that it goes in with one rename; every
    // other file on its own.
    let [folder, files] = STAGED_NEW;
    let new_folder = staging.join(folder);
    let new_files = staging.join(files);
    let old = staging.join(STAGED_OLD);
    for dir in [staging, new_files.as_path()] {
        fs::create_dir_all(dir).map_err(|error| {
            io_error(
                format_args!("cannot make the folder {}", dir.display()),
                error,
            )
        })?;
    }

    let mut staged = Vec::with_capacity(planned.len());
    for (index, (target, source, expected)) in planned.into_iter().enumerate() {
        let bytes = match source {
            FileSource::Bytes(bytes) => bytes,
            FileSource::Path(path) => fs::read(&path)
                .map_err(|error| io_error(format_args!("cannot read {}", path.display()), error))?,
        };
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(&expected) {
            return Err(InstallError::Checksum {
                dest: target.dest(),
                expected,
                actual,
            });
        }
        let at = match &target {
            Target::ScriptFile { rel, .. } => new_folder.join(rel),
            _ => new_files.join(index.to_string()),
        };
        write_file(&at, &bytes)?;
        staged.push(Staged {
            target,
            at,
            sha256: actual,
        });
    }
    record.files = staged
        .iter()
        .map(|file| FileRecord {
            path: file.target.dest(),
            sha256: file.sha256.clone(),
        })
        .collect();

    // What goes where, and what stays. Nothing has moved yet, so a conflict changes nothing.
    let mut moves = Vec::new();
    for file in staged
        .iter()
        .filter(|file| !matches!(file.target, Target::ScriptFile { .. }))
    {
        let to = file.target.path(paths);
        let there = is_there(&to)?;
        match &file.target {
            // The user's settings.
            Target::ScriptOpts { .. } if there => {}
            Target::Shader(_) | Target::Font(_) if there => {
                let theirs = fs::read(&to).map_err(|error| {
                    io_error(format_args!("cannot read {}", to.display()), error)
                })?;
                if sha256_hex(&theirs) != file.sha256 {
                    return Err(InstallError::Conflict {
                        dest: file.target.dest(),
                    });
                }
            }
            _ => moves.push((file.at.clone(), to)),
        }
    }

    // The plugin's folder: the old one out (wherever it is, on or off, into the part of `old\`
    // named after where it was), the new one in.
    if staged
        .iter()
        .any(|file| matches!(file.target, Target::ScriptFile { .. }))
    {
        for (kind, dir) in homes(paths) {
            let home = dir.join(name);
            if is_there(&home)? {
                undo.move_aside(&home, &old.join(kind).join(name))?;
            }
        }
        let home = if record.enabled {
            paths.scripts_dir.join(name)
        } else {
            paths.scripts_disabled_dir.join(name)
        };
        if let Some(parent) = home.parent() {
            undo.make_dir(parent)?;
        }
        undo.place(&new_folder, &home)?;
    }
    for (from, to) in &moves {
        if let Some(parent) = to.parent() {
            undo.make_dir(parent)?;
        }
        undo.place(from, to)?;
    }

    let before = registry.clone();
    registry.removed.remove(name);
    registry.plugins.insert(name.to_owned(), record.clone());
    if let Err(error) = registry.save(paths.config_dir.join(registry::FILE)) {
        *registry = before;
        return Err(io_error("cannot save plugins.json", error));
    }
    Ok(())
}

/// Whether something is at `path`. A path through a file that is not a folder has nothing at
/// it; any other error is one.
fn is_there(path: &Path) -> Result<bool, InstallError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(io_error(
            format_args!("cannot look at {}", path.display()),
            error,
        )),
    }
}

/// Writes `bytes` to the new file `path` (making its folders), through to the disk: the rename
/// into place must not move a file that is not all there.
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), InstallError> {
    let written = (|| {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    written.map_err(|error| io_error(format_args!("cannot write {}", path.display()), error))
}

/// [`sweep`] of the config folder's staging folder, which goes too once it is empty: what the
/// start of the plugins runs before the essentials are seeded, so that a previous version an
/// install left there when the app ended is back in its place before mpv loads the scripts.
pub(crate) fn sweep_staging(paths: &AppPaths) -> Vec<PathBuf> {
    let staging_root = paths.config_dir.join(STAGING_DIR);
    let kept = sweep(paths, &staging_root);
    // Only when it is empty: a leftover the sweep kept stays in it.
    let _ = fs::remove_dir(&staging_root);
    kept
}

/// The previous versions of the plugin folder `name` that installs left in the staging folder
/// (`<leftover>\old\scripts\<name>`, `<leftover>\old\scripts-disabled\<name>`): what the next
/// sweep would put back. An uninstall takes them with the plugin, so that the plugin does not come
/// back from there.
pub(crate) fn leftovers_of(paths: &AppPaths, name: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(paths.config_dir.join(STAGING_DIR)) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for leftover in entries.flatten() {
        for (kind, _) in homes(paths) {
            let aside = leftover.path().join(STAGED_OLD).join(kind).join(name);
            if aside.symlink_metadata().is_ok() {
                found.push(aside);
            }
        }
    }
    found.sort();
    found
}

/// Clears what installs that did not finish left in the staging folder (the app ended in the
/// middle of one, or its rollback could not put the previous version back). For each leftover:
/// the staged new files go; a previous version in `old\<folder>\<name>` goes back to
/// `<folder>\<name>` when nothing is there, and stays where it is otherwise; the leftover goes once
/// it is empty. Returns the leftovers that are kept, each of which is logged.
fn sweep(paths: &AppPaths, staging_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(staging_root) else {
        return Vec::new();
    };
    let mut kept = Vec::new();
    for entry in entries.flatten() {
        let leftover = entry.path();
        tracing::warn!(
            "{} is left from an install that did not finish",
            leftover.display()
        );
        if !sweep_one(paths, &leftover) {
            tracing::warn!(
                "{} is kept: a previous version of a plugin in it cannot go back to its place, \
                 or a part of it cannot be removed",
                leftover.display()
            );
            kept.push(leftover);
        }
    }
    kept
}

/// [`sweep`] for one leftover. Returns whether it is gone.
fn sweep_one(paths: &AppPaths, leftover: &Path) -> bool {
    // An install makes only folders here.
    if !leftover.is_dir() {
        return fs::remove_file(leftover).is_ok();
    }
    for own in STAGED_NEW {
        if let Err(error) = remove_dir_all_if_there(&leftover.join(own)) {
            tracing::warn!("cannot remove {}: {error}", leftover.join(own).display());
        }
    }
    let old = leftover.join(STAGED_OLD);
    for (kind, dir) in homes(paths) {
        let asides = old.join(kind);
        let Ok(entries) = fs::read_dir(&asides) else {
            continue;
        };
        for entry in entries.flatten() {
            put_back(&entry.path(), dir, &entry.file_name().to_string_lossy());
        }
        // Only when everything in it went back.
        let _ = fs::remove_dir(&asides);
    }
    let _ = fs::remove_dir(&old);
    fs::remove_dir(leftover).is_ok()
}

/// Moves the previous version `aside` of the plugin `name` back into `dir`, if nothing is in its
/// place and the name is one an install could have made.
fn put_back(aside: &Path, dir: &Path, name: &str) {
    if targets::check_name(name).is_err() {
        tracing::warn!(
            "{} is not a plugin folder an install moved aside; it stays",
            aside.display()
        );
        return;
    }
    let home = dir.join(name);
    if !matches!(is_there(&home), Ok(false)) {
        tracing::warn!(
            "{} cannot go back to {}: something else is there",
            aside.display(),
            home.display()
        );
        return;
    }
    match fs::create_dir_all(dir).and_then(|()| fs::rename(aside, &home)) {
        Ok(()) => tracing::warn!(
            "{} is back from an install that did not finish",
            home.display()
        ),
        Err(error) => tracing::warn!(
            "cannot put {} back to {}: {error}",
            aside.display(),
            home.display()
        ),
    }
}

fn remove_dir_all_if_there(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::player::testing::temp_paths;
    use crate::plugins::registry::PluginSource;
    use crate::plugins::targets::Refusal;
    use crate::plugins::testing::{put, tree};

    fn record(version: &str) -> PluginRecord {
        PluginRecord {
            source: PluginSource::Store,
            registry_id: Some("x-id".to_owned()),
            version: Some(version.to_owned()),
            repo: Some("someone/x".to_owned()),
            commit: None,
            files: Vec::new(),
            enabled: true,
            installed_at: "2026-10-18T12:00:00Z".to_owned(),
        }
    }

    fn file(dest: &str, contents: &str) -> PlannedFile {
        PlannedFile {
            dest: dest.to_owned(),
            source: FileSource::Bytes(contents.as_bytes().to_vec()),
            sha256: sha256_hex(contents.as_bytes()),
        }
    }

    fn plan(version: &str, files: Vec<PlannedFile>) -> InstallPlan {
        InstallPlan {
            name: "x".to_owned(),
            files,
            record: record(version),
        }
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn registry_on_disk(paths: &AppPaths) -> Registry {
        Registry::load(paths.config_dir.join(registry::FILE))
    }

    /// Review focus 4: refused before anything is written, also when the other files of the
    /// plan are fine.
    #[test]
    fn install_refuses_targets_outside_the_allowed_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        // The user's own files, which a plugin must not reach.
        put(&paths.config_dir.join("mpv.conf"), "volume=37\n");
        put(
            &paths.scripts_dir.join("other").join("a.lua"),
            "-- theirs\n",
        );
        let before = tree(tmp.path());
        let mut registry = Registry::default();

        for (dest, refusal) in [
            ("scripts/x/../../mpv.conf", Refusal::DotPart),
            ("C:/a.lua", Refusal::Colon),
            (r"\\srv\s\a.lua", Refusal::EmptyPart),
            ("/abs.lua", Refusal::EmptyPart),
            ("scripts/x/a.lua:evil", Refusal::Colon),
            ("scripts/x/CON.lua", Refusal::ReservedName),
            ("scripts/x/a. ", Refusal::TrailingDotOrSpace),
            ("shaders/../a", Refusal::DotPart),
            ("scripts/other/a.lua", Refusal::Outside),
            ("input.conf", Refusal::Outside),
        ] {
            let result = install(
                &paths,
                &mut registry,
                plan(
                    "1",
                    vec![
                        file("scripts/x/main.lua", "-- x\n"),
                        file(dest, "-- evil\n"),
                    ],
                ),
            );
            assert_eq!(
                result,
                Err(InstallError::Target(TargetError {
                    dest: dest.to_owned(),
                    refusal
                })),
                "{dest:?}"
            );
            assert_eq!(
                tree(tmp.path()),
                before,
                "nothing new on the disk: {dest:?}"
            );
        }
        // A name that is not one folder is refused the same way.
        let mut bad = plan("1", vec![file("shaders/a.glsl", "//\n")]);
        bad.name = "..".to_owned();
        assert!(matches!(
            install(&paths, &mut registry, bad),
            Err(InstallError::Target(_))
        ));
        assert_eq!(tree(tmp.path()), before);
        assert_eq!(registry, Registry::default());
    }

    #[test]
    fn a_checksum_mismatch_installs_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let before = tree(tmp.path());
        let mut registry = Registry::default();
        let mut second = file("scripts/x/lib.lua", "-- lib\n");
        second.sha256 = sha256_hex(b"something else");

        let result = install(
            &paths,
            &mut registry,
            plan(
                "1",
                vec![file("scripts/x/main.lua", "-- x\n"), second.clone()],
            ),
        );

        assert_eq!(
            result,
            Err(InstallError::Checksum {
                dest: "scripts/x/lib.lua".to_owned(),
                expected: second.sha256,
                actual: sha256_hex(b"-- lib\n"),
            })
        );
        // No file of the plugin, no registry, no staging folder.
        assert_eq!(tree(tmp.path()), before);
        assert!(!paths.config_dir.join(STAGING_DIR).exists());
        assert_eq!(registry, Registry::default());
        assert!(!paths.config_dir.join(registry::FILE).exists());
    }

    #[test]
    fn an_install_puts_every_file_in_place_and_records_it() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let bundled = tmp.path().join("bundle.lua");
        put(&bundled, "-- from a file\n");
        let mut registry = Registry::default();
        registry.removed.insert("x".to_owned());

        let mut files = vec![
            file("scripts/x/main.lua", "-- x\n"),
            file(r"scripts\x\lib\util.lua", "-- util\n"),
            file("script-opts/x.conf", "a=1\n"),
            file("shaders/x.glsl", "// shader\n"),
            file("fonts/x.ttf", "font"),
        ];
        files.push(PlannedFile {
            dest: "scripts/x/bundled.lua".to_owned(),
            source: FileSource::Path(bundled),
            sha256: sha256_hex(b"-- from a file\n").to_uppercase(),
        });
        install(&paths, &mut registry, plan("1", files)).unwrap();

        let x = paths.scripts_dir.join("x");
        assert_eq!(read(&x.join("main.lua")), "-- x\n");
        assert_eq!(read(&x.join("lib").join("util.lua")), "-- util\n");
        assert_eq!(read(&x.join("bundled.lua")), "-- from a file\n");
        assert_eq!(read(&paths.script_opts_dir.join("x.conf")), "a=1\n");
        assert_eq!(
            read(&paths.config_dir.join("shaders").join("x.glsl")),
            "// shader\n"
        );
        assert_eq!(read(&paths.config_dir.join("fonts").join("x.ttf")), "font");
        assert!(!paths.config_dir.join(STAGING_DIR).exists());

        let recorded = &registry.plugins["x"];
        let files: Vec<(&str, &str)> = recorded
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.sha256.as_str()))
            .collect();
        let util = sha256_hex(b"-- util\n");
        let bundled = sha256_hex(b"-- from a file\n");
        assert_eq!(
            files,
            [
                ("scripts/x/main.lua", sha256_hex(b"-- x\n").as_str()),
                ("scripts/x/lib/util.lua", util.as_str()),
                ("script-opts/x.conf", sha256_hex(b"a=1\n").as_str()),
                ("shaders/x.glsl", sha256_hex(b"// shader\n").as_str()),
                ("fonts/x.ttf", sha256_hex(b"font").as_str()),
                ("scripts/x/bundled.lua", bundled.as_str()),
            ]
        );
        assert_eq!(recorded.version.as_deref(), Some("1"));
        assert!(registry.removed.is_empty(), "installed, so not removed");
        assert_eq!(registry_on_disk(&paths), registry);

        // Off: the folder goes to scripts-disabled.
        let mut off = plan("2", vec![file("scripts/x/main.lua", "-- x 2\n")]);
        off.record.enabled = false;
        install(&paths, &mut registry, off).unwrap();
        assert!(!x.exists());
        assert_eq!(
            read(&paths.scripts_disabled_dir.join("x").join("main.lua")),
            "-- x 2\n"
        );
        assert!(!registry.plugins["x"].enabled);
    }

    #[test]
    fn reinstall_replaces_the_script_folder_and_keeps_the_users_script_opts() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let mut registry = Registry::default();
        install(
            &paths,
            &mut registry,
            plan(
                "1",
                vec![
                    file("scripts/x/main.lua", "-- x 1\n"),
                    file("scripts/x/old.lua", "-- only in 1\n"),
                    file("script-opts/x.conf", "a=1\n"),
                    file("shaders/x.glsl", "// same\n"),
                ],
            ),
        )
        .unwrap();
        let opts = paths.script_opts_dir.join("x.conf");
        fs::write(&opts, "a=5\n# mine\n").unwrap();

        install(
            &paths,
            &mut registry,
            plan(
                "2",
                vec![
                    file("scripts/x/main.lua", "-- x 2\n"),
                    file("script-opts/x.conf", "a=2\nb=2\n"),
                    // The same shader as before is no conflict.
                    file("shaders/x.glsl", "// same\n"),
                ],
            ),
        )
        .unwrap();

        let x = paths.scripts_dir.join("x");
        assert_eq!(read(&x.join("main.lua")), "-- x 2\n");
        assert!(
            !x.join("old.lua").exists(),
            "the folder is replaced, not merged"
        );
        assert_eq!(read(&opts), "a=5\n# mine\n", "the user's settings stay");
        assert_eq!(registry.plugins["x"].version.as_deref(), Some("2"));
        assert_eq!(registry.plugins["x"].files.len(), 3);
        assert_eq!(registry_on_disk(&paths), registry);
        assert!(!paths.config_dir.join(STAGING_DIR).exists());

        // A version that was turned off is replaced too, and stays off.
        let disabled = paths.scripts_disabled_dir.join("x");
        fs::create_dir_all(&paths.scripts_disabled_dir).unwrap();
        fs::rename(&x, &disabled).unwrap();
        let mut off = plan("3", vec![file("scripts/x/main.lua", "-- x 3\n")]);
        off.record.enabled = false;
        install(&paths, &mut registry, off).unwrap();
        assert_eq!(read(&disabled.join("main.lua")), "-- x 3\n");
        assert!(!x.exists());
    }

    #[test]
    fn a_shader_of_the_same_name_with_other_contents_is_a_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        put(
            &paths.config_dir.join("shaders").join("x.glsl"),
            "// theirs\n",
        );
        let before = tree(tmp.path());
        let mut registry = Registry::default();

        // Found before anything moves: not even the plugin's folder appears.
        let result = install(
            &paths,
            &mut registry,
            plan(
                "1",
                vec![
                    file("scripts/x/main.lua", "-- x\n"),
                    file("shaders/x.glsl", "// mine\n"),
                ],
            ),
        );
        assert_eq!(
            result,
            Err(InstallError::Conflict {
                dest: "shaders/x.glsl".to_owned()
            })
        );
        assert_eq!(tree(tmp.path()), before);

        // Two files of the plan to one place.
        let result = install(
            &paths,
            &mut registry,
            plan(
                "1",
                vec![file("fonts/a.ttf", "a"), file(r"fonts\A.ttf", "b")],
            ),
        );
        assert_eq!(
            result,
            Err(InstallError::Conflict {
                dest: "fonts/A.ttf".to_owned()
            })
        );
        assert_eq!(tree(tmp.path()), before);
        assert!(registry.plugins.is_empty());
    }

    /// The previous version must come back whichever step fails. Two ways a move fails for
    /// certain: a file of the old folder another program holds open (Windows does not move a
    /// folder with an open file in it), and a folder that cannot be made because a file is in its
    /// place, after the old folder has been moved aside already.
    #[cfg(windows)]
    #[test]
    fn a_failed_move_restores_the_previous_version() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let mut registry = Registry::default();
        install(
            &paths,
            &mut registry,
            plan("1", vec![file("scripts/x/main.lua", "-- x 1\n")]),
        )
        .unwrap();
        let main = paths.scripts_dir.join("x").join("main.lua");
        let installed = registry.clone();
        let before = tree(tmp.path());

        // 1. The old version is open without sharing.
        let holder = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&main)
            .unwrap();
        let result = install(
            &paths,
            &mut registry,
            plan("2", vec![file("scripts/x/main.lua", "-- x 2\n")]),
        );
        assert!(matches!(result, Err(InstallError::Io(_))), "{result:?}");
        drop(holder);
        assert_eq!(read(&main), "-- x 1\n");
        assert_eq!(registry, installed);
        assert_eq!(registry_on_disk(&paths), installed);
        assert_eq!(tree(tmp.path()), before, "no staging folder, nothing new");

        // 2. `shaders` is a file: the shader cannot go in after the folder was swapped.
        put(&paths.config_dir.join("shaders"), "not a folder");
        let before = tree(tmp.path());
        let result = install(
            &paths,
            &mut registry,
            plan(
                "2",
                vec![
                    file("scripts/x/main.lua", "-- x 2\n"),
                    file("scripts/x/new.lua", "-- new in 2\n"),
                    file("script-opts/x.conf", "a=2\n"),
                    file("shaders/x.glsl", "// 2\n"),
                ],
            ),
        );
        assert!(matches!(result, Err(InstallError::Io(_))), "{result:?}");
        assert_eq!(read(&main), "-- x 1\n");
        assert_eq!(registry, installed);
        assert_eq!(registry_on_disk(&paths), installed);
        assert_eq!(
            tree(tmp.path()),
            before,
            "the old folder, no new files, no staging"
        );
    }

    #[test]
    fn a_refused_registry_installs_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        // A folder where plugins.json should be cannot be read: the registry is refused.
        fs::create_dir(paths.config_dir.join(registry::FILE)).unwrap();
        let mut registry = registry_on_disk(&paths);
        assert!(registry.refused().is_some());
        let before = tree(tmp.path());

        let result = install(
            &paths,
            &mut registry,
            plan("1", vec![file("scripts/x/main.lua", "-- x\n")]),
        );

        assert!(matches!(result, Err(InstallError::Io(_))), "{result:?}");
        assert_eq!(tree(tmp.path()), before);
        assert!(registry.plugins.is_empty());
    }

    /// An install of another plugin, `y`, which sweeps the staging folder first.
    fn install_another(paths: &AppPaths) {
        let mut other = plan("1", vec![file("scripts/y/main.lua", "-- y\n")]);
        other.name = "y".to_owned();
        install(paths, &mut Registry::default(), other).unwrap();
        assert_eq!(
            read(&paths.scripts_dir.join("y").join("main.lua")),
            "-- y\n"
        );
    }

    /// The app ended between moving the previous versions aside and moving the new ones in: the
    /// next install, of anything, puts them back, `x` (on) and `z` (off) each where it was.
    #[test]
    fn a_leftover_previous_version_goes_back_when_its_place_is_free() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let root = paths.config_dir.join(STAGING_DIR);
        let x = root.join("x-1");
        put(
            &x.join("old").join("scripts").join("x").join("main.lua"),
            "-- x 1\n",
        );
        put(
            &x.join("old")
                .join("scripts")
                .join("x")
                .join("lib")
                .join("util.lua"),
            "-- util 1\n",
        );
        put(&x.join("folder").join("main.lua"), "-- x 2\n");
        put(&x.join("files").join("0"), "a=2\n");
        let z = root.join("sub-select-2");
        put(
            &z.join("old")
                .join("scripts-disabled")
                .join("sub-select")
                .join("main.lua"),
            "-- sub-select 1, off\n",
        );

        install_another(&paths);

        let back = paths.scripts_dir.join("x");
        assert_eq!(read(&back.join("main.lua")), "-- x 1\n");
        assert_eq!(read(&back.join("lib").join("util.lua")), "-- util 1\n");
        assert_eq!(
            read(
                &paths
                    .scripts_disabled_dir
                    .join("sub-select")
                    .join("main.lua")
            ),
            "-- sub-select 1, off\n"
        );
        assert!(
            !paths.script_opts_dir.exists(),
            "the staged files are not placed"
        );
        assert!(!root.exists(), "nothing left to keep");
    }

    /// The new version got in before the app ended (or a rollback failed and something took
    /// the place since): the previous version is the only copy of it, so it stays, through every
    /// later install, and only the staged new files go.
    #[test]
    fn a_leftover_previous_version_whose_place_is_taken_is_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let root = paths.config_dir.join(STAGING_DIR);
        let left = root.join("x-1");
        let aside = left.join("old").join("scripts").join("x").join("main.lua");
        put(&aside, "-- x 1\n");
        put(&left.join("folder").join("main.lua"), "-- x 2\n");
        put(&paths.scripts_dir.join("x").join("main.lua"), "-- x 2\n");

        assert_eq!(sweep(&paths, &root), std::slice::from_ref(&left));

        assert_eq!(read(&aside), "-- x 1\n");
        assert!(!left.join("folder").exists(), "the staged new files go");
        assert_eq!(
            read(&paths.scripts_dir.join("x").join("main.lua")),
            "-- x 2\n"
        );

        // A later install keeps it as well, and the staging folder with it.
        install_another(&paths);
        assert_eq!(read(&aside), "-- x 1\n");
        assert_eq!(
            read(&paths.scripts_dir.join("x").join("main.lua")),
            "-- x 2\n"
        );
        assert_eq!(
            tree(&root).keys().collect::<Vec<_>>(),
            [
                "x-1",
                "x-1/old",
                "x-1/old/scripts",
                "x-1/old/scripts/x",
                "x-1/old/scripts/x/main.lua",
            ]
        );
    }

    /// A leftover that holds only new files (the app ended while they were staged) goes whole.
    #[test]
    fn a_leftover_with_only_new_files_is_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let root = paths.config_dir.join(STAGING_DIR);
        let left = root.join("x-123");
        put(&left.join("folder").join("main.lua"), "-- half\n");
        put(&left.join("files").join("0"), "a=1\n");
        fs::create_dir_all(left.join("old")).unwrap();

        assert!(sweep(&paths, &root).is_empty());
        assert!(!left.exists());
        assert!(!paths.scripts_dir.exists(), "nothing was put anywhere");

        // At the next install, as the installs sweep.
        put(&left.join("folder").join("main.lua"), "-- half\n");
        let mut registry = Registry::default();
        install(
            &paths,
            &mut registry,
            plan("1", vec![file("scripts/x/main.lua", "-- x\n")]),
        )
        .unwrap();

        assert!(!root.exists());
        assert_eq!(
            tree(&paths.scripts_dir),
            BTreeMap::from([
                ("x".to_owned(), None),
                ("x/main.lua".to_owned(), Some(b"-- x\n".to_vec())),
            ])
        );
    }
}
