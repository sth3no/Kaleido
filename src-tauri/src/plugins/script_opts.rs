//! A gentle editor for a plugin's `script-opts\<name>.conf` (spec 6.1, 7.2): the file a script
//! reads its options from with `mp.options` (`read_options`). Kaleido changes only the keys it
//! is asked to, and every other byte (comments, blank and foreign lines, line endings, a BOM)
//! stays as it is.
//!
//! Lines are read the way `player/lua/options.lua` of the pinned build reads them:
//!
//! - A line whose **first character** is `#` is a comment; there is no other kind of comment
//!   (`a=1 # one` is the value `1 # one`).
//! - Otherwise the key is everything before the first `=` and the value everything after it.
//!   Neither is trimmed: `a= b` gives `a` the value ` b`, and ` a=b` sets the key ` a`.
//! - A line without `=` says nothing and is left alone. There is no quoting.
//! - A `\r` at the end of a line is dropped before all that, so CRLF files read as LF ones.
//! - The last line of a key wins.
//!
//! mpv does not skip a BOM, so a BOM is part of the first line: its key is `\u{feff}key`, which
//! no script asks for. [`ScriptOpts::get`] says so as well, and setting such a key appends a
//! line of its own (which is the one that counts), so that what Kaleido shows is what the script
//! gets.

use std::collections::HashMap;
use std::fmt;

use crate::settings::lines::{self, Line};

/// Why a value was not set. In both cases nothing changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptOptsError {
    /// The key is empty or has something other than `A-Z a-z 0-9 _ -`: with an `=` or a space in
    /// it, the line would not read back as the key.
    BadKey,
    /// The value has a `\r` or a `\n`: it would be more than one line.
    LineBreak,
}

impl fmt::Display for ScriptOptsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScriptOptsError::BadKey => write!(f, "a key of letters, digits, _ and -"),
            ScriptOptsError::LineBreak => write!(f, "a value without line breaks"),
        }
    }
}

impl std::error::Error for ScriptOptsError {}

/// A `script-opts` file as lines. [`ScriptOpts::render`] gives back the text it was parsed from,
/// byte for byte, until something is set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScriptOpts {
    lines: Vec<Line>,
}

/// Whether `key` is one Kaleido writes: letters, digits, `_` and `-`, and not empty. What a
/// script names its options with.
pub fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// The key and the value `mp.options` reads from a line, or `None` where it reads nothing from
/// it (a comment, a line without `=`).
fn read(text: &str) -> Option<(&str, &str)> {
    let text = text.strip_suffix('\r').unwrap_or(text);
    if text.starts_with('#') {
        return None;
    }
    text.split_once('=')
}

impl ScriptOpts {
    pub fn parse(text: &str) -> ScriptOpts {
        ScriptOpts {
            lines: lines::split(text),
        }
    }

    pub fn render(&self) -> String {
        lines::join(&self.lines)
    }

    /// What the file sets, line by line: the index of the line, the key and the value.
    fn settings(&self) -> impl DoubleEndedIterator<Item = (usize, &str, &str)> {
        self.lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| read(&line.text).map(|(key, value)| (index, key, value)))
    }

    /// The value the file gives `key`: that of its last line, as the script gets it.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.settings()
            .rev()
            .find(|&(_, found, _)| found == key)
            .map(|(_, _, value)| value)
    }

    /// Every key the file sets, as the script reads them (so also keys that [`is_valid_key`]
    /// refuses): in the order of their first line, each with the value of its last.
    pub fn entries(&self) -> Vec<(String, String)> {
        let mut entries: Vec<(String, String)> = Vec::new();
        let mut position: HashMap<&str, usize> = HashMap::new();
        for (_, key, value) in self.settings() {
            match position.get(key) {
                Some(&index) => entries[index].1 = value.to_owned(),
                None => {
                    position.insert(key, entries.len());
                    entries.push((key.to_owned(), value.to_owned()));
                }
            }
        }
        entries
    }

    /// Sets `key` (the last line of it changes; a key that is not there yet goes to the end of
    /// the file), or with `None` removes every line of it. A key that is not
    /// [valid](is_valid_key) or a value with a line break is an error, and nothing changes.
    pub fn set(&mut self, key: &str, value: Option<&str>) -> Result<(), ScriptOptsError> {
        if !is_valid_key(key) {
            return Err(ScriptOptsError::BadKey);
        }
        if value.is_some_and(|value| value.contains(['\r', '\n'])) {
            return Err(ScriptOptsError::LineBreak);
        }
        match value {
            None => self
                .lines
                .retain(|line| read(&line.text).is_none_or(|(found, _)| found != key)),
            Some(value) => self.put(key, value),
        }
        Ok(())
    }

    fn put(&mut self, key: &str, value: &str) {
        let last = self
            .settings()
            .rev()
            .find(|&(_, found, _)| found == key)
            .map(|(index, _, current)| (index, current == value));
        match last {
            // Already so: the line stays as the user wrote it.
            Some((_, true)) => {}
            Some((index, false)) => {
                let line = &mut self.lines[index];
                // A `\r` that ends the line is not part of the value: it stays.
                let carriage = if line.text.ends_with('\r') { "\r" } else { "" };
                line.text = format!("{key}={value}{carriage}");
            }
            None => lines::push(&mut self.lines, format!("{key}={value}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changed(text: &str, changes: &[(&str, Option<&str>)]) -> String {
        let mut opts = ScriptOpts::parse(text);
        for (key, value) in changes {
            opts.set(key, *value).unwrap();
        }
        opts.render()
    }

    fn pairs(entries: &[(&str, &str)]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn script_opts_round_trip_is_byte_identical() {
        for text in [
            "",
            "\n",
            "\u{feff}# thumbfast\r\nmax_height=200\r\nbad line\r\n\r\n# comment = 1\r\nspaced = value \r\n",
            "max_height=200\nbad line\n# note\n\nmax_width=400",
            "a=1\r",
            "a=1\r\r\nb=2\r\n",
            "key=ž € 😀\r\n",
            "=\n==\n#\n",
            "a=1\nb=2\r\nc=3\n",
        ] {
            assert_eq!(ScriptOpts::parse(text).render(), text, "{text:?}");
        }
    }

    #[test]
    fn script_opts_change_the_last_occurrence_and_append_new_keys() {
        let text = "a=1\nb=2\na=3\n# a=9\nbad line\n";
        let mut opts = ScriptOpts::parse(text);
        assert_eq!(opts.get("a"), Some("3"));

        opts.set("a", Some("4")).unwrap();
        assert_eq!(opts.render(), "a=1\nb=2\na=4\n# a=9\nbad line\n");
        assert_eq!(opts.get("a"), Some("4"));

        // The value it has already: not a byte changes.
        opts.set("b", Some("2")).unwrap();
        assert_eq!(opts.render(), "a=1\nb=2\na=4\n# a=9\nbad line\n");

        // A new key goes to the end, a comment with the key is not an occurrence of it.
        opts.set("c", Some("x y")).unwrap();
        assert_eq!(opts.render(), "a=1\nb=2\na=4\n# a=9\nbad line\nc=x y\n");
        assert_eq!(opts.get("c"), Some("x y"));
        assert_eq!(opts.get("bad line"), None);

        // The new line ends as the file's lines do, and closes the last line if it was open.
        assert_eq!(
            changed("a=1\r\nb=2\r\n", &[("c", Some("3"))]),
            "a=1\r\nb=2\r\nc=3\r\n"
        );
        assert_eq!(
            changed("a=1\r\nb=2", &[("c", Some("3"))]),
            "a=1\r\nb=2\r\nc=3\r\n"
        );
        assert_eq!(changed("", &[("a", Some("1"))]), "a=1\n");
        // A changed line keeps its own ending, and a CR that ends the file.
        assert_eq!(
            changed("# x\r\na=1\r\nb=2\n", &[("a", Some("2")), ("b", Some("3"))]),
            "# x\r\na=2\r\nb=3\n"
        );
        assert_eq!(changed("a=1\r", &[("a", Some("2"))]), "a=2\r");
        // An empty value is a value.
        assert_eq!(changed("a=1\n", &[("a", Some(""))]), "a=\n");
    }

    #[test]
    fn script_opts_list_keys_in_the_order_of_their_first_line() {
        let opts = ScriptOpts::parse("b=1\n# c=2\na=3\nb=4\nbad line\n\nd=\n");
        assert_eq!(opts.entries(), pairs(&[("b", "4"), ("a", "3"), ("d", "")]));
        assert!(ScriptOpts::parse("").entries().is_empty());
        assert!(ScriptOpts::parse("# only\nthis\n").entries().is_empty());
    }

    #[test]
    fn script_opts_read_a_bom_as_mpv_does() {
        let text = "\u{feff}a=1\nb=2\n";
        let mut opts = ScriptOpts::parse(text);
        // mpv does not skip the BOM: the first line sets another key, which no script asks for.
        assert_eq!(opts.get("a"), None);
        assert_eq!(opts.get("\u{feff}a"), Some("1"));
        assert_eq!(opts.get("b"), Some("2"));

        // So a value for it goes in a line of its own, which is the one that counts.
        opts.set("a", Some("5")).unwrap();
        assert_eq!(opts.render(), "\u{feff}a=1\nb=2\na=5\n");
        assert_eq!(opts.get("a"), Some("5"));
        // The BOM stays in front of everything else.
        assert_eq!(
            changed("\u{feff}# x\r\nb=2\r\n", &[("b", Some("3"))]),
            "\u{feff}# x\r\nb=3\r\n"
        );
    }

    #[test]
    fn script_opts_remove_every_occurrence() {
        let text = "a=1\nb=2\na=3\n# a=9\nbad line\n#a=1\n";
        let mut opts = ScriptOpts::parse(text);
        opts.set("a", None).unwrap();
        assert_eq!(opts.render(), "b=2\n# a=9\nbad line\n#a=1\n");
        assert_eq!(opts.get("a"), None);

        // A key that is not there: not a byte changes.
        opts.set("zzz", None).unwrap();
        assert_eq!(opts.render(), "b=2\n# a=9\nbad line\n#a=1\n");

        assert_eq!(changed("a=1\r\nb=2\r\na=3\r\n", &[("a", None)]), "b=2\r\n");
        assert_eq!(changed("a=1\nb=2", &[("b", None)]), "a=1\n");
        // Gone, and set again, it is a new line at the end.
        assert_eq!(
            changed("a=1\nb=2\n", &[("a", None), ("a", Some("7"))]),
            "b=2\na=7\n"
        );
    }

    #[test]
    fn script_opts_keep_spaces_as_mp_options_reads_them() {
        let opts =
            ScriptOpts::parse("a= b\n c=1\nd =2\ne=f \n# g=3\n #h=4\ni=j=k\nl=#m\nn=1 # x\n");
        assert_eq!(opts.get("a"), Some(" b"));
        assert_eq!(opts.get(" c"), Some("1"));
        assert_eq!(opts.get("c"), None);
        assert_eq!(opts.get("d "), Some("2"));
        assert_eq!(opts.get("d"), None);
        assert_eq!(opts.get("e"), Some("f "));
        // A comment is a line that starts with `#`, not one with white space before it.
        assert_eq!(opts.get("g"), None);
        assert_eq!(opts.get(" #h"), Some("4"));
        // The first `=` splits, and `#` after it is part of the value.
        assert_eq!(opts.get("i"), Some("j=k"));
        assert_eq!(opts.get("l"), Some("#m"));
        assert_eq!(opts.get("n"), Some("1 # x"));
        // A CR before the line break is no part of the value.
        assert_eq!(ScriptOpts::parse("a=1\r\n").get("a"), Some("1"));
        assert_eq!(ScriptOpts::parse("a=1\r").get("a"), Some("1"));

        // A value is written as it is given, spaces too.
        assert_eq!(changed("a= b\n", &[("a", Some(" c "))]), "a= c \n");
        assert_eq!(changed("", &[("a", Some(" x"))]), "a= x\n");
    }

    #[test]
    fn script_opts_refuse_line_breaks_and_bad_keys() {
        let text = "a=1\r\nb=2\r\n";
        let mut opts = ScriptOpts::parse(text);

        for value in ["x\ny", "x\r", "\r\n", "\n"] {
            assert_eq!(
                opts.set("a", Some(value)),
                Err(ScriptOptsError::LineBreak),
                "{value:?}"
            );
            assert_eq!(
                opts.set("new", Some(value)),
                Err(ScriptOptsError::LineBreak),
                "{value:?}"
            );
        }
        for key in ["a=b", "", "a b", " a", "a\n", "ž", "a.b", "a/b", "#a", "a="] {
            assert_eq!(
                opts.set(key, Some("x")),
                Err(ScriptOptsError::BadKey),
                "{key:?}"
            );
            assert_eq!(opts.set(key, None), Err(ScriptOptsError::BadKey), "{key:?}");
        }
        // Both wrong: the key is what is said.
        assert_eq!(opts.set("a b", Some("x\ny")), Err(ScriptOptsError::BadKey));

        assert_eq!(opts.render(), text, "nothing changed");
        assert_eq!(opts, ScriptOpts::parse(text));

        for key in ["max_height", "max-height", "A1", "_", "-"] {
            assert!(is_valid_key(key), "{key}");
            assert_eq!(opts.set(key, Some("1")), Ok(()), "{key}");
        }
    }
}
