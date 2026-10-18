//! Errors of plugins, from mpv's log (spec 10.4). mpv logs what a script says under the script's
//! client name (the prefix of the line, `[sub_select] …`), so a line is a plugin's when its
//! prefix is the client of a plugin that runs. Only `error` and `fatal` lines count: a plugin
//! that logs them gets the "reports errors" badge with its lines, and the first one of the run is
//! told once, for the one quiet notice with "Turn off". Nothing is turned off by itself.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::names;
use crate::player::LogLine;

/// How many lines of each plugin are kept for its log in the UI: the last ones.
pub const KEPT_LINES: usize = 50;

/// The errors of the plugins in this run of Kaleido, by plugin name.
#[derive(Debug, Default)]
pub struct PluginErrors {
    reported: BTreeMap<String, Reported>,
    /// The plugins whose first error has been told.
    told: BTreeSet<String>,
}

#[derive(Debug, Default)]
struct Reported {
    count: u32,
    lines: VecDeque<LogLine>,
}

impl PluginErrors {
    /// Takes one line of mpv's log. `by_script_name` maps the client names of the running plugins
    /// to the plugins' names ([`clients`]). A line of level `error` or `fatal` whose prefix is one
    /// of them is that plugin's: it is counted and kept, and its plugin's name comes back if it is
    /// the plugin's first in this run (the notice is shown once). Any other line is not a
    /// plugin's error and changes nothing.
    pub fn note(
        &mut self,
        line: &LogLine,
        by_script_name: &BTreeMap<String, String>,
    ) -> Option<String> {
        if !matches!(line.level.as_str(), "error" | "fatal") {
            return None;
        }
        let name = by_script_name.get(&line.prefix)?;
        let reported = self.reported.entry(name.clone()).or_default();
        reported.count = reported.count.saturating_add(1);
        if reported.lines.len() == KEPT_LINES {
            reported.lines.pop_front();
        }
        reported.lines.push_back(line.clone());
        self.told.insert(name.clone()).then(|| name.clone())
    }

    /// How many errors the plugin `name` has logged in this run.
    pub fn count(&self, name: &str) -> u32 {
        self.reported.get(name).map_or(0, |reported| reported.count)
    }

    /// The last [`KEPT_LINES`] errors of the plugin `name`, the oldest first.
    pub fn lines(&self, name: &str) -> Vec<LogLine> {
        self.reported
            .get(name)
            .map(|reported| reported.lines.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// The client names mpv gives the running plugins, to the plugins' names. `running` is
/// `(name, script_name)` in the order the scripts were loaded. As `mp_new_client` does it (see
/// [`super::names`]), a script gets its name if no client has it yet, and else the first of
/// `<name>2`, `<name>3`, … that none has; mpv's own clients ([`names::BUILT_IN_CLIENTS`]) come
/// first, so a plugin named like one of them (`stats.lua`) is `stats2`, and the built-in script's
/// errors are not the plugin's.
pub fn clients<'a>(
    running: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> BTreeMap<String, String> {
    let mut taken: BTreeSet<String> = names::BUILT_IN_CLIENTS
        .iter()
        .map(|&client| client.to_owned())
        .collect();
    let mut clients = BTreeMap::new();
    for (name, script_name) in running {
        let client = if taken.contains(script_name) {
            (2..)
                .map(|number| format!("{script_name}{number}"))
                .find(|candidate| !taken.contains(candidate))
                .unwrap_or_default()
        } else {
            script_name.to_owned()
        };
        taken.insert(client.clone());
        clients.insert(client, name.to_owned());
    }
    clients
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(level: &str, prefix: &str, text: &str) -> LogLine {
        LogLine {
            level: level.to_owned(),
            prefix: prefix.to_owned(),
            text: text.to_owned(),
        }
    }

    fn sub_select() -> BTreeMap<String, String> {
        clients([("sub-select", "sub_select"), ("thumbfast", "thumbfast")])
    }

    /// Spec 10.4: the prefix of a line is the client name of the script, which is how the line
    /// finds its plugin; the plugin is told of once, and only errors count.
    #[test]
    fn errors_are_attributed_by_script_name_and_told_once() {
        let mut errors = PluginErrors::default();
        let by_script_name = sub_select();
        let first = line(
            "error",
            "sub_select",
            "Lua error: main.lua:12: attempt to index a nil value\n",
        );
        let second = line("error", "sub_select", "stack traceback:\n");

        assert_eq!(
            errors.note(&first, &by_script_name).as_deref(),
            Some("sub-select")
        );
        assert_eq!(errors.note(&second, &by_script_name), None, "told once");
        assert_eq!(errors.count("sub-select"), 2);
        assert_eq!(errors.lines("sub-select"), [first.clone(), second.clone()]);

        // A warning is no error, and a fatal line is one.
        assert_eq!(
            errors.note(&line("warn", "thumbfast", "slow\n"), &by_script_name),
            None
        );
        assert_eq!(errors.count("thumbfast"), 0);
        assert!(errors.lines("thumbfast").is_empty());
        let fatal = line("fatal", "thumbfast", "cannot start\n");
        assert_eq!(
            errors.note(&fatal, &by_script_name).as_deref(),
            Some("thumbfast")
        );
        assert_eq!(errors.lines("thumbfast"), [fatal]);

        // A prefix that is no running plugin's (mpv's own, a script that is not a plugin, the
        // plugin's name instead of its client name) is nobody's.
        for prefix in ["vo/gpu-next", "cplayer", "sub-select", "stats", ""] {
            assert_eq!(
                errors.note(&line("error", prefix, "x\n"), &by_script_name),
                None,
                "{prefix:?}"
            );
        }
        assert_eq!(errors.count("sub-select"), 2);
        assert_eq!(errors.count("nobody"), 0);
        assert!(errors.lines("nobody").is_empty());
    }

    #[test]
    fn only_the_last_lines_are_kept_but_all_are_counted() {
        let mut errors = PluginErrors::default();
        let by_script_name = sub_select();
        for number in 0..KEPT_LINES + 7 {
            errors.note(
                &line("error", "sub_select", &format!("{number}\n")),
                &by_script_name,
            );
        }

        assert_eq!(errors.count("sub-select"), (KEPT_LINES + 7) as u32);
        let kept = errors.lines("sub-select");
        assert_eq!(kept.len(), KEPT_LINES);
        assert_eq!(kept[0].text, "7\n");
        assert_eq!(kept[KEPT_LINES - 1].text, format!("{}\n", KEPT_LINES + 6));
    }

    /// Two scripts mpv knows by one name: the second one loaded is `<name>2` to mpv, and its lines
    /// are its own.
    #[test]
    fn a_second_client_of_a_name_is_numbered() {
        let by_script_name = clients([
            ("thumbfast", "thumbfast"),
            ("thumbfast.lua", "thumbfast"),
            ("my-plugin.lua", "my_plugin"),
            ("my_plugin", "my_plugin"),
            ("other", "my_plugin"),
        ]);
        assert_eq!(
            by_script_name,
            BTreeMap::from(
                [
                    ("thumbfast", "thumbfast"),
                    ("thumbfast2", "thumbfast.lua"),
                    ("my_plugin", "my-plugin.lua"),
                    ("my_plugin2", "my_plugin"),
                    ("my_plugin3", "other"),
                ]
                .map(|(client, name)| (client.to_owned(), name.to_owned()))
            )
        );

        let mut errors = PluginErrors::default();
        errors.note(&line("error", "thumbfast2", "x\n"), &by_script_name);
        assert_eq!(errors.count("thumbfast.lua"), 1);
        assert_eq!(errors.count("thumbfast"), 0);
    }

    /// mpv's own scripts are clients before any plugin: a plugin named like one is numbered after
    /// it, and the built-in's errors are not the plugin's (no false badge, no notice).
    #[test]
    fn a_plugin_named_like_one_of_mpvs_own_scripts_is_numbered_after_it() {
        let by_script_name = clients([
            ("stats.lua", "stats"),
            ("console", "console"),
            // Its own name is the one the first plugin took: the next free one, as mpv does.
            ("stats2.lua", "stats2"),
            ("main.lua", "main"),
        ]);
        assert_eq!(
            by_script_name,
            BTreeMap::from(
                [
                    ("stats2", "stats.lua"),
                    ("console2", "console"),
                    ("stats22", "stats2.lua"),
                    ("main2", "main.lua"),
                ]
                .map(|(client, name)| (client.to_owned(), name.to_owned()))
            )
        );
        for client in names::BUILT_IN_CLIENTS {
            assert!(!by_script_name.contains_key(*client), "{client}");
        }

        let mut errors = PluginErrors::default();
        // The built-in stats and console fail: nobody's.
        for prefix in ["stats", "console", "main"] {
            assert_eq!(
                errors.note(&line("error", prefix, "x\n"), &by_script_name),
                None,
                "{prefix}"
            );
        }
        assert_eq!(errors.count("stats.lua"), 0);
        // The plugin's own line, under the name mpv gave it.
        assert_eq!(
            errors
                .note(&line("error", "stats2", "x\n"), &by_script_name)
                .as_deref(),
            Some("stats.lua")
        );
        assert_eq!(errors.count("stats.lua"), 1);
        assert_eq!(errors.count("stats2.lua"), 0);
    }
}
