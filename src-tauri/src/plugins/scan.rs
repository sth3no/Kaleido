//! The scripts that are in the config folder, whoever put them there: `scripts\` (on) and
//! `scripts-disabled\` (off, spec 6.3). The list is what is on the disk, with the name mpv knows
//! each script by; whether Kaleido installed it is for the registry to say.
//!
//! What counts as a script is what mpv loads from `scripts\` (`mp_load_scripts` and
//! `list_script_files` in `player/scripting.c`): a file with a script extension, or a folder with
//! a `main.<extension>` in it, and nothing whose name starts with a dot or ends in `.disable`.
//! Anything else in the folder (a `readme.txt`, a folder of libraries without a `main`) mpv
//! ignores or complains about, and Kaleido does not list.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::names;
use crate::paths::AppPaths;

/// How a script sits in its folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// `<folder>\main.lua` or `main.js`, next to the script's own files.
    Folder,
    /// `<name>.lua` or `<name>.js` on its own.
    File,
}

/// One script found on the disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// The folder, or the file without its extension: what the registry calls the plugin.
    pub name: String,
    /// What mpv calls the client of the script (see [`names`]). Two scripts may have the same
    /// one; mpv then numbers the one it loads second.
    pub script_name: String,
    /// The file mpv runs: the script itself, or the `main` in its folder.
    pub entry: PathBuf,
    pub layout: Layout,
    /// In `scripts\` and not in `scripts-disabled\`.
    pub enabled: bool,
}

impl Found {
    /// The name in `scripts\` or `scripts-disabled\`: the folder, or the file with its
    /// extension. This is what mpv sorts by, and what [`names::script_name`] takes.
    pub fn entry_name(&self) -> String {
        let entry = match self.layout {
            Layout::Folder => self.entry.parent(),
            Layout::File => Some(self.entry.as_path()),
        };
        entry
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// Every script in `scripts\` and `scripts-disabled\`, by the name in the folder, upper and lower
/// case alike; the one in `scripts\` first if the same name is in both. A folder that is not there
/// has no scripts.
///
/// mpv means to load them in this order (`list_script_files` sorts with `strcasecmp`), but its
/// `compare_filename` takes `qsort`'s pointers to the names for the names themselves (at the
/// pinned accb7b2821), so it compares where the names are in memory. Only scripts that share a
/// client name see a difference: which of them keeps the name and which is `<name>2` cannot be
/// told from their names, and is a guess here (they are shown as duplicates).
pub fn scan(paths: &AppPaths) -> Vec<Found> {
    let mut found = list(&paths.scripts_dir, true);
    found.extend(list(&paths.scripts_disabled_dir, false));
    found.sort_by_cached_key(|script| (script.entry_name().to_ascii_lowercase(), !script.enabled));
    found
}

/// The scripts in `dir`, in no order.
fn list(dir: &Path, enabled: bool) -> Vec<Found> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!("cannot list the scripts in {}: {error}", dir.display());
            return Vec::new();
        }
    };
    entries
        .filter_map(|entry| match entry {
            Ok(entry) => {
                let file_name = entry.file_name();
                found_at(&entry.path(), &file_name.to_string_lossy(), enabled)
            }
            Err(error) => {
                tracing::warn!("cannot read an entry of {}: {error}", dir.display());
                None
            }
        })
        .collect()
}

/// The extension that makes mpv skip an entry, file or folder, whatever it holds: the way to
/// turn a script off by hand.
const MPV_SKIPS: &str = "disable";

/// The script in the entry `path` called `entry_name`, if mpv would load one from it.
fn found_at(path: &Path, entry_name: &str, enabled: bool) -> Option<Found> {
    // mpv does not look at what starts with a dot (.git, .DS_Store, ...).
    if entry_name.starts_with('.') {
        return None;
    }
    // `foo.disable` is skipped before mpv looks at what it is, a folder with a `main.lua` too.
    if entry_name
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case(MPV_SKIPS))
    {
        return None;
    }
    // As mpv does with `stat`: a link to a folder or a file is the folder or the file.
    let metadata = fs::metadata(path).ok()?;
    let found = if metadata.is_dir() {
        // The first language mpv tries is Lua, then JavaScript.
        let main = names::EXTENSIONS
            .iter()
            .map(|extension| path.join(format!("main.{extension}")))
            .find(|main| fs::metadata(main).is_ok_and(|metadata| metadata.is_file()))?;
        Found {
            name: entry_name.to_owned(),
            script_name: names::folder_script_name(entry_name),
            entry: main,
            layout: Layout::Folder,
            enabled,
        }
    } else if metadata.is_file() {
        let extension = names::extension(entry_name)?;
        Found {
            name: entry_name[..entry_name.len() - extension.len() - 1].to_owned(),
            script_name: names::file_script_name(entry_name),
            entry: path.to_path_buf(),
            layout: Layout::File,
            enabled,
        }
    } else {
        return None;
    };
    // `@.lua` has no name left, and mpv cannot make a client without one: it does not load it.
    (!found.script_name.is_empty()).then_some(found)
}

/// The scripts of `found` that share a name in mpv, as `(script_name, entries)`: `entries` are
/// the [`Found::entry_name`]s in the order they are in `found` (the order of [`scan`]; one of them
/// keeps the name in mpv and the others are numbered, `<name>2`, but which one mpv does not let
/// their names decide). Sorted by `script_name`; a script that has its name to itself is not
/// listed.
///
/// It goes by `found` as it is given: scripts that are off collide with the ones that are on as
/// soon as one of them is turned on, and are reported with them. Hand it only the enabled ones to
/// see what collides in mpv now.
///
/// It does not know mpv's own clients ([`names::BUILT_IN_CLIENTS`]: the built-in scripts
/// `select`, `commands`, `positioning`, `context_menu`, `console`, `stats`, `ytdl_hook`,
/// `auto_profiles`, and the main handle `main`). A manual script named like one of them is
/// numbered by mpv (`stats2`) without being reported here.
pub fn duplicates(found: &[Found]) -> Vec<(String, Vec<String>)> {
    let mut by_name: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for script in found {
        by_name
            .entry(&script.script_name)
            .or_default()
            .push(script.entry_name());
    }
    by_name
        .into_iter()
        .filter(|(_, entries)| entries.len() > 1)
        .map(|(script_name, entries)| (script_name.to_owned(), entries))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use mpv_ffi::Event;

    use super::*;
    use crate::player::Engine;
    use crate::player::testing::{Recorded, eventually, headless, temp_paths};

    /// Kaleido's folders under `root`, none of them created.
    fn paths_in(root: &Path) -> AppPaths {
        AppPaths::from_roots(
            &root.join("Roaming"),
            &root.join("Local"),
            &root.join("Install"),
            &root.join("Desktop"),
            &root.join("Install"),
        )
    }

    /// A file with `contents` at `path`, whose folders are made.
    fn put(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// `(name, script_name, layout, enabled)` of every script found.
    fn summary(found: &[Found]) -> Vec<(&str, &str, Layout, bool)> {
        found
            .iter()
            .map(|script| {
                (
                    script.name.as_str(),
                    script.script_name.as_str(),
                    script.layout,
                    script.enabled,
                )
            })
            .collect()
    }

    #[test]
    fn scan_finds_files_folders_and_disabled_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths_in(tmp.path());
        // mpv runs without the folders; they come with the first install.
        assert!(scan(&paths).is_empty());

        put(&paths.scripts_dir.join("a.lua"), "-- a\n");
        put(&paths.scripts_dir.join("b").join("main.js"), "// b\n");
        put(
            &paths.scripts_dir.join("c").join("readme.txt"),
            "not a script\n",
        );
        put(
            &paths.scripts_disabled_dir.join("d").join("main.lua"),
            "-- d\n",
        );

        let found = scan(&paths);

        assert_eq!(
            summary(&found),
            [
                ("a", "a", Layout::File, true),
                ("b", "b", Layout::Folder, true),
                ("d", "d", Layout::Folder, false),
            ]
        );
        assert_eq!(found[0].entry, paths.scripts_dir.join("a.lua"));
        assert_eq!(found[1].entry, paths.scripts_dir.join("b").join("main.js"));
        assert_eq!(
            found[2].entry,
            paths.scripts_disabled_dir.join("d").join("main.lua")
        );
        let entries: Vec<_> = found.iter().map(Found::entry_name).collect();
        assert_eq!(entries, ["a.lua", "b", "d"]);
    }

    /// What mpv loads and how it names it: the shapes a user adds by hand.
    #[test]
    fn scan_lists_what_mpv_loads_under_the_names_mpv_gives() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths_in(tmp.path());
        let scripts = &paths.scripts_dir;
        for script in [
            "my.plugin.lua",
            "dot.dir/main.lua",
            "Žluť kůň.lua",
            "@at.lua",
            "Shout.LUA",
            // Lua is tried before JavaScript.
            "both/main.js",
            "both/main.lua",
        ] {
            put(&scripts.join(script), "-- a script\n");
        }
        // What mpv does not load, or not as a script.
        for other in [
            ".hidden.lua",
            ".git/main.lua",
            "notes.txt",
            "no-extension",
            "lib/helper.lua",
            "@.lua",
            // Turned off by hand: mpv skips these before it looks inside.
            "off.disable/main.lua",
            "Off2.DISABLE/main.js",
        ] {
            put(&scripts.join(other), "-- not listed\n");
        }
        fs::create_dir_all(scripts.join("empty")).unwrap();

        let found = scan(&paths);

        // In mpv's order: upper and lower case alike, so Shout is after my.plugin.
        assert_eq!(
            summary(&found),
            [
                ("@at", "at", Layout::File, true),
                ("both", "both", Layout::Folder, true),
                ("dot.dir", "dot_dir", Layout::Folder, true),
                ("my.plugin", "my_plugin", Layout::File, true),
                ("Shout", "Shout", Layout::File, true),
                ("Žluť kůň", "__lu___k____", Layout::File, true),
            ]
        );
        assert_eq!(found[1].entry, scripts.join("both").join("main.lua"));
        // The name asked of the entry in the folder is the one scan found.
        for script in &found {
            assert_eq!(names::script_name(&script.entry_name()), script.script_name);
        }
    }

    #[test]
    fn duplicates_are_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths_in(tmp.path());
        put(&paths.scripts_dir.join("thumbfast").join("main.lua"), "");
        put(&paths.scripts_dir.join("thumbfast.lua"), "");
        put(&paths.scripts_dir.join("other.lua"), "");
        // Different names in the folder, one name to mpv.
        put(&paths.scripts_dir.join("my-plugin.lua"), "");
        put(&paths.scripts_dir.join("my_plugin").join("main.js"), "");

        let found = scan(&paths);

        assert_eq!(found.len(), 5);
        assert_eq!(
            duplicates(&found),
            [
                (
                    "my_plugin".to_owned(),
                    vec!["my-plugin.lua".to_owned(), "my_plugin".to_owned()]
                ),
                (
                    "thumbfast".to_owned(),
                    vec!["thumbfast".to_owned(), "thumbfast.lua".to_owned()]
                ),
            ]
        );
        assert!(duplicates(&[]).is_empty());
        assert!(duplicates(&found[..1]).is_empty());
    }

    #[test]
    fn a_script_that_is_off_is_a_duplicate_of_one_that_is_on() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths_in(tmp.path());
        put(&paths.scripts_dir.join("solo.lua"), "");
        put(
            &paths.scripts_disabled_dir.join("solo").join("main.lua"),
            "",
        );

        let found = scan(&paths);

        assert_eq!(
            summary(&found),
            [
                ("solo", "solo", Layout::Folder, false),
                ("solo", "solo", Layout::File, true),
            ]
        );
        assert_eq!(
            duplicates(&found),
            [(
                "solo".to_owned(),
                vec!["solo".to_owned(), "solo.lua".to_owned()]
            )]
        );
        // The ones that are on, which are all mpv sees, have no duplicate.
        let on: Vec<Found> = found.into_iter().filter(|script| script.enabled).collect();
        assert!(duplicates(&on).is_empty());
    }

    // ---------------------------------------------------------------------------------------
    // A real libmpv

    /// A script that answers `script-message-to <its name> ping` with
    /// `script-message pong <its name> <tag>`, the name being what mpv calls it.
    fn answering(tag: &str) -> String {
        assert!(!tag.contains(['"', '\\', '\n']), "{tag}");
        format!(
            "mp.register_script_message(\"ping\", function()\n  \
             mp.commandv(\"script-message\", \"pong\", mp.get_script_name(), \"{tag}\")\nend)\n"
        )
    }

    /// The `pong`s of the events, as `{script name: tag}`.
    fn pongs(events: &[Event]) -> BTreeMap<String, String> {
        events
            .iter()
            .filter_map(|event| match event {
                Event::ClientMessage { args } => match args.as_slice() {
                    [pong, name, tag] if pong == "pong" => Some((name.clone(), tag.clone())),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }

    /// Puts the scripts `entries` (paths in `scripts\`, each answering with its entry name) in
    /// the config folder of a real core and starts it. Asserts that:
    /// - `scan` finds all of them and nothing else;
    /// - for every script, a client called what `scan` says exists (`script-message-to` fails
    ///   when there is none); the second script of a name is numbered, `<name>2`, and so on;
    /// - every one answers under such a name, and the name it reports is mpv's own
    ///   (`mp.get_script_name()`).
    ///
    /// Returns what `scan` expects (the scripts of a name numbered in its order) and what mpv did,
    /// both as the clients by name with the entry in `scripts\` each one runs. They are the same
    /// unless two scripts share a name: which of those mpv numbers is not up to their names (see
    /// [`scan`]).
    fn mpv_names_the_scripts_as_scan_does(
        entries: &[&str],
    ) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        for entry in entries {
            let entry_name = entry.split('/').next().unwrap();
            put(&paths.scripts_dir.join(entry), &answering(entry_name));
        }
        let found = scan(&paths);
        assert_eq!(found.len(), entries.len(), "{found:#?}");

        // The names the clients should have: the first of a name keeps it, the next ones are
        // numbered 2, 3, ... in the order mpv loads them.
        let mut loaded: BTreeMap<String, usize> = BTreeMap::new();
        let expected: BTreeMap<String, String> = found
            .iter()
            .map(|script| {
                let count = loaded.entry(script.script_name.clone()).or_default();
                *count += 1;
                let client = match *count {
                    1 => script.script_name.clone(),
                    number => format!("{}{number}", script.script_name),
                };
                (client, script.entry_name())
            })
            .collect();
        assert_eq!(expected.len(), entries.len());

        let events = Recorded::default();
        let engine = Engine::start(headless(paths), events.clone()).unwrap();
        for client in expected.keys() {
            let client = client.clone();
            eventually(&engine, &format!("a client called {client}"), move |mpv| {
                mpv.command(&["script-message-to", &client, "ping"]).is_ok()
            });
        }
        events.wait_until(
            "every script has answered",
            Duration::from_secs(10),
            |seen| pongs(seen).keys().eq(expected.keys()),
        );
        let answered = pongs(&events.events());
        (expected, answered)
    }

    /// Spec 6.1 and the review focus on names: the name `scan` shows for a script is the one mpv
    /// gives its client, for the shapes a user adds by hand. Needs a real libmpv.
    #[test]
    fn script_names_match_mpvs_clients() {
        let (clients, answered) = mpv_names_the_scripts_as_scan_does(&[
            "sub-select/main.lua",
            "my.plugin.lua",
            "dot.dir/main.lua",
            "Žluť kůň.lua",
            // The corners of the rule: an @, the case of the extension, a name over the limit.
            "@at.lua",
            "@dir/main.lua",
            "Shout.LUA",
            &format!("{}.lua", "x".repeat(70)),
        ]);
        // No two of them share a name: every one is what `scan` says.
        assert_eq!(answered, clients);
        // The names the task's plan spells out, and one of the corners, as plain facts.
        for client in [
            "sub_select",
            "my_plugin",
            "dot_dir",
            "__lu___k____",
            "at",
            "_dir",
        ] {
            assert!(clients.contains_key(client), "{client}: {clients:#?}");
        }
        assert!(clients.contains_key(&"x".repeat(60)));
    }

    /// Four ways to write one name: all four run, the first mpv loads keeps the name and the others
    /// are numbered. Which one is which is mpv's to say, not their names' (see [`scan`]). Needs a
    /// real libmpv.
    #[test]
    fn a_second_script_of_a_name_is_numbered() {
        let entries = ["a_b.lua", "a.b", "a-b.lua", "a b.lua"];
        let (clients, answered) =
            mpv_names_the_scripts_as_scan_does(&["a_b.lua", "a.b/main.lua", "a-b.lua", "a b.lua"]);
        for found in [&clients, &answered] {
            assert!(
                found.keys().eq(["a_b", "a_b2", "a_b3", "a_b4"]),
                "{found:#?}"
            );
            let mut runs: Vec<&str> = found.values().map(String::as_str).collect();
            runs.sort_unstable();
            let mut all = entries;
            all.sort_unstable();
            assert_eq!(runs, all, "{found:#?}");
        }
    }
}
