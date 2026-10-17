//! Shortcuts (spec 8.10): a gentle editor for `input.conf` and the list of bindings the settings
//! page shows, worked out from mpv's `input-bindings` property.
//!
//! The editor changes only the line of the key it is asked about, and only the last one binding
//! that key (mpv takes the last). Every other line (comments, `#@` descriptions, blank and
//! unreadable lines, bindings of other input sections) stays byte for byte, with its line ending,
//! and so does the BOM. New lines go at the end, with the line ending most lines have.
//!
//! A line binds a key the way mpv's parser reads it: the first white-space separated word is the
//! key, the rest of the line is the command. Keys are read case-sensitively (`s` is not `S`).
//! A line of another input section, `KEY {section} command`, is not a binding of the main one
//! and is never edited. A key mpv knows under another spelling (`ctrl+s` for `Ctrl+s`) is a
//! different key here, so the settings page, which uses the names mpv reports, does not find a
//! hand-written line of that spelling to change; the line it appends is the later one and wins.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::SettingsError;
use crate::input::valid_key;
use crate::player::options::DEFAULT_INPUT_CONF;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    /// The last line of a file that does not end with a line break.
    None,
    Lf,
    CrLf,
}

impl Ending {
    fn as_str(self) -> &'static str {
        match self {
            Ending::None => "",
            Ending::Lf => "\n",
            Ending::CrLf => "\r\n",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Line {
    /// Without the line ending.
    text: String,
    ending: Ending,
}

/// An input.conf as lines. [`InputConf::render`] gives back the text it was parsed from, byte
/// for byte, until something is changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InputConf {
    bom: bool,
    lines: Vec<Line>,
}

/// A line that binds a key in the main input section.
struct Bound<'a> {
    /// The white space before the key.
    indent: &'a str,
    key: &'a str,
    command: &'a str,
}

/// A line that binds `key`, with what is needed to rewrite it.
struct Found {
    index: usize,
    indent: String,
    command: String,
}

/// White space as mpv's `mp_isspace` knows it.
fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c')
}

/// The binding a line makes, or `None` for what is not one: blank lines, comments (also `#@`),
/// a key without a command (mpv refuses it) and the bindings of other input sections.
fn parse_binding(text: &str) -> Option<Bound<'_>> {
    let body = text.trim_start_matches(is_space);
    if body.is_empty() || body.starts_with('#') {
        return None;
    }
    let key_end = body.find(is_space).unwrap_or(body.len());
    let (key, rest) = body.split_at(key_end);
    let command = rest.trim_matches(is_space);
    if command.is_empty() {
        return None;
    }
    // `KEY {section} command`. A lone `{` is a key (Kaleido binds it), not a section.
    let section = command.starts_with('{') && command.contains('}');
    let braced_key = key.len() > 1 && key.starts_with('{') && key.ends_with('}');
    if section || braced_key {
        return None;
    }
    Some(Bound {
        indent: &text[..text.len() - body.len()],
        key,
        command,
    })
}

/// A key name the editor writes: one mpv's `keydown` takes ([`valid_key`]) that does not turn
/// its line into a comment (`#`) or into the bindings of another section (`{name}`). `name` is
/// what the error calls it.
pub fn check_key(name: &str, key: &str) -> Result<(), SettingsError> {
    let plain = valid_key(key) && !key.starts_with('#') && !(key.len() > 1 && key.starts_with('{'));
    if plain {
        Ok(())
    } else {
        Err(SettingsError::invalid(
            name,
            "a key name without spaces, at most 32 characters",
        ))
    }
}

/// A command as a line holds it: trimmed, and in one line.
fn check_command(command: &str) -> Result<&str, SettingsError> {
    let trimmed = command.trim_matches(is_space);
    if trimmed.is_empty() || command.contains(['\n', '\r']) {
        return Err(SettingsError::invalid("command", "a command in one line"));
    }
    Ok(trimmed)
}

impl InputConf {
    pub fn parse(text: &str) -> InputConf {
        let (bom, text) = match text.strip_prefix('\u{feff}') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let lines = text
            .split_inclusive('\n')
            .map(|segment| {
                let (text, ending) = if let Some(text) = segment.strip_suffix("\r\n") {
                    (text, Ending::CrLf)
                } else if let Some(text) = segment.strip_suffix('\n') {
                    (text, Ending::Lf)
                } else {
                    (segment, Ending::None)
                };
                Line {
                    text: text.to_owned(),
                    ending,
                }
            })
            .collect();
        InputConf { bom, lines }
    }

    pub fn render(&self) -> String {
        let mut text = String::new();
        if self.bom {
            text.push('\u{feff}');
        }
        for line in &self.lines {
            text.push_str(&line.text);
            text.push_str(line.ending.as_str());
        }
        text
    }

    /// The command the last line binding `key` gives it.
    pub fn get(&self, key: &str) -> Option<String> {
        self.occurrences(key).pop().map(|found| found.command)
    }

    /// Every bound key with its command (the last line of a key counts), as mpv reads them.
    pub fn commands(&self) -> HashMap<String, String> {
        self.lines
            .iter()
            .filter_map(|line| parse_binding(&line.text))
            .map(|bound| (bound.key.to_owned(), bound.command.to_owned()))
            .collect()
    }

    /// Binds `key` to `command`: the last line binding the key is rewritten (its indentation
    /// stays), or a line is added at the end. A key name or command that cannot be written (see
    /// [`check_key`]; a command with a line break) is an error, and nothing changes.
    pub fn bind(&mut self, key: &str, command: &str) -> Result<(), SettingsError> {
        check_key("key", key)?;
        let command = check_command(command)?;
        match self.occurrences(key).pop() {
            // Already so: the line stays as it was written.
            Some(found) if found.command == command => {}
            Some(found) => {
                self.lines[found.index].text = format!("{}{key} {command}", found.indent);
            }
            None => self.append(format!("{key} {command}")),
        }
        Ok(())
    }

    /// Writes `KEY ignore`: mpv does nothing for the key, not even what it does by default.
    pub fn silence(&mut self, key: &str) -> Result<(), SettingsError> {
        self.bind(key, "ignore")
    }

    /// Puts the key back as the default has it. With a `default` command (Kaleido's own line for
    /// the key) it is the key's only line, with that command. With `None` (the key is one mpv or
    /// a plugin binds, or none at all) every line of the key goes, so that their binding is the
    /// key's again.
    pub fn reset(&mut self, key: &str, default: Option<&str>) -> Result<(), SettingsError> {
        check_key("key", key)?;
        let default = default.map(check_command).transpose()?;
        let mut lines = self.occurrences(key);
        let earlier = match default {
            Some(default) => {
                // The last line is the one that counts, so it takes the default; the lines
                // before it would only have been overridden by it.
                lines.pop();
                self.bind(key, default)?;
                lines
            }
            None => lines,
        };
        for found in earlier.into_iter().rev() {
            self.lines.remove(found.index);
        }
        Ok(())
    }

    /// The lines that bind `key`, in order.
    fn occurrences(&self, key: &str) -> Vec<Found> {
        self.lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                let bound = parse_binding(&line.text)?;
                (bound.key == key).then(|| Found {
                    index,
                    indent: bound.indent.to_owned(),
                    command: bound.command.to_owned(),
                })
            })
            .collect()
    }

    /// A new last line, with the file's usual line ending. The line before it gets one if it
    /// was the last line without.
    fn append(&mut self, text: String) {
        let ending = self.usual_ending();
        if let Some(last) = self.lines.last_mut()
            && last.ending == Ending::None
        {
            last.ending = ending;
        }
        self.lines.push(Line { text, ending });
    }

    /// CRLF if most lines end so, otherwise LF.
    fn usual_ending(&self) -> Ending {
        let count = |wanted| {
            self.lines
                .iter()
                .filter(|line| line.ending == wanted)
                .count()
        };
        if count(Ending::CrLf) > count(Ending::Lf) {
            Ending::CrLf
        } else {
            Ending::Lf
        }
    }
}

/// The command Kaleido's own `input.conf` gives `key`; `None` for a key it does not bind.
pub fn kaleido_default(key: &str) -> Option<String> {
    InputConf::parse(DEFAULT_INPUT_CONF).get(key)
}

// ---------------------------------------------------------------------------------------------
// The list of bindings

/// One entry of mpv's `input-bindings`: a binding of an input section, active or not, also one
/// that another binding of the same key overrides.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RawBinding {
    pub key: String,
    #[serde(default)]
    pub cmd: String,
    /// The section's place among the active ones; negative for a section that is not active.
    #[serde(default)]
    pub priority: i64,
    /// A default of mpv or of a script, which what the user binds overrides.
    #[serde(default)]
    pub is_weak: bool,
    /// The script (its name) that defined the section.
    pub owner: Option<String>,
    /// The `#@` description of the line in input.conf.
    pub comment: Option<String>,
}

/// Parses `input-bindings` as mpv gives it as text (JSON).
pub fn parse_raw(json: &str) -> Result<Vec<RawBinding>, serde_json::Error> {
    serde_json::from_str(json)
}

/// Where a binding comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BindingSource {
    /// A line of Kaleido's own default `input.conf`, as it ships.
    Kaleido,
    /// The user's: a line of input.conf of their own, or one set from the settings.
    User,
    /// One of mpv's built-in bindings.
    Mpv,
    /// A script's; `name` is the script.
    Plugin { name: String },
}

/// A key and what it does now, for the shortcuts page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub key: String,
    /// The mpv command. A key the user silenced has `ignore`.
    pub command: String,
    pub source: BindingSource,
    pub comment: Option<String>,
}

/// Whether `candidate` beats `current` for the same key, as mpv's own scripts decide it from
/// this list: a binding of the user over a weak one, then the section enabled later. Of two
/// equal ones the first stays.
fn beats(candidate: &RawBinding, current: &RawBinding) -> bool {
    (current.is_weak && !candidate.is_weak)
        || (candidate.is_weak == current.is_weak && candidate.priority > current.priority)
}

/// The script a binding belongs to, if it has one.
fn owner(entry: &RawBinding) -> Option<&str> {
    entry.owner.as_deref().filter(|name| !name.is_empty())
}

fn same_command(a: &str, b: &str) -> bool {
    a.trim_matches(is_space) == b.trim_matches(is_space)
}

/// Where the binding that is active for a key comes from. `weak` is the best default (of mpv or
/// a script) the key has underneath, `kaleido` the command of Kaleido's own line for the key.
fn source_of(
    winner: &RawBinding,
    weak: Option<&RawBinding>,
    kaleido: Option<&str>,
) -> BindingSource {
    let weak_source = |entry: &RawBinding| match owner(entry) {
        Some(name) => BindingSource::Plugin {
            name: name.to_owned(),
        },
        None => BindingSource::Mpv,
    };
    if owner(winner).is_some() || winner.is_weak {
        return weak_source(winner);
    }
    if kaleido.is_some_and(|default| same_command(default, &winner.cmd)) {
        return BindingSource::Kaleido;
    }
    // mpv cannot unbind a key at run time, so putting a key back to the default of mpv or of a
    // script binds the same command by hand: it is still that default.
    match weak {
        Some(weak) if same_command(&weak.cmd, &winner.cmd) => weak_source(weak),
        _ => BindingSource::User,
    }
}

/// One binding per key, the one that is active, in the order mpv lists the keys. Sections that
/// are not active (a script's that is not enabled yet) are left out. `kaleido` has the commands
/// of Kaleido's default input.conf (see [`InputConf::commands`]).
pub fn derive(raw: &[RawBinding], kaleido: &HashMap<String, String>) -> Vec<Binding> {
    let mut keys: Vec<&str> = Vec::new();
    let mut entries: HashMap<&str, Vec<&RawBinding>> = HashMap::new();
    for entry in raw
        .iter()
        .filter(|entry| entry.priority >= 0 && !entry.key.is_empty())
    {
        let same_key = entries.entry(entry.key.as_str()).or_default();
        if same_key.is_empty() {
            keys.push(entry.key.as_str());
        }
        same_key.push(entry);
    }
    keys.into_iter()
        .filter_map(|key| {
            let same_key = entries.get(key)?;
            let winner = pick(same_key.iter().copied(), beats)?;
            let weak = pick(
                same_key.iter().copied().filter(|entry| entry.is_weak),
                |entry, best| entry.priority > best.priority,
            );
            Some(Binding {
                key: key.to_owned(),
                command: winner.cmd.clone(),
                source: source_of(winner, weak, kaleido.get(key).map(String::as_str)),
                comment: winner.comment.clone().filter(|comment| !comment.is_empty()),
            })
        })
        .collect()
}

/// The best of `entries` by `better(entry, best_so_far)`; the first of equal ones.
fn pick<'a>(
    entries: impl Iterator<Item = &'a RawBinding>,
    better: impl Fn(&RawBinding, &RawBinding) -> bool,
) -> Option<&'a RawBinding> {
    entries.fold(None, |best, entry| match best {
        Some(best) if !better(entry, best) => Some(best),
        _ => Some(entry),
    })
}

/// What a key falls back to when the user's binding is taken away: the command of the best
/// default (of mpv or of a script) it has underneath. `None` if the user has no binding on it
/// now (the default is what is active) or there is no default.
pub fn fallback_command(raw: &[RawBinding], key: &str) -> Option<String> {
    let active: Vec<&RawBinding> = raw
        .iter()
        .filter(|entry| entry.key == key && entry.priority >= 0)
        .collect();
    let overridden = active
        .iter()
        .any(|entry| !entry.is_weak && owner(entry).is_none());
    if !overridden {
        return None;
    }
    pick(
        active.iter().copied().filter(|entry| entry.is_weak),
        |entry, best| entry.priority > best.priority,
    )
    .map(|entry| entry.cmd.clone())
}

/// Changes `conf` to move the command of the active binding of `key` to `new_key` and to silence
/// `key`. Returns that command, for the player to bind live; `None` if `key` and `new_key` are
/// the same and nothing is to be done. The command comes from the binding that is active for
/// `key` (`bindings`) and from nowhere else, so the UI cannot bind a command of its own: a key
/// that has no binding is refused, and so is a silenced one (there is nothing to move).
///
/// `new_key` may be bound already. Its line is then rewritten (the last line of a key wins in
/// mpv), and any default it had under it is simply overridden.
pub fn move_binding(
    conf: &mut InputConf,
    bindings: &[Binding],
    key: &str,
    new_key: &str,
) -> Result<Option<String>, SettingsError> {
    check_key("key", key)?;
    check_key("newKey", new_key)?;
    let current = bindings
        .iter()
        .find(|binding| binding.key == key)
        .filter(|binding| !same_command(&binding.command, "ignore"))
        .ok_or_else(|| SettingsError::NotAllowed {
            key: key.to_owned(),
        })?;
    if key == new_key {
        return Ok(None);
    }
    conf.bind(new_key, &current.command)?;
    conf.silence(key)?;
    Ok(Some(current.command.clone()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::player::Engine;
    use crate::player::options::ensure_defaults;
    use crate::player::testing::{NoEvents, headless, temp_paths};
    use crate::settings::{bindings, rebind, reset_binding};

    const KALEIDO_S: &str = "script-message kaleido screenshot subtitles";

    fn binding(key: &str, command: &str, source: BindingSource) -> Binding {
        Binding {
            key: key.to_owned(),
            command: command.to_owned(),
            source,
            comment: None,
        }
    }

    #[test]
    fn input_conf_round_trip_keeps_comments() {
        // A BOM, both kinds of line ending, comments, a `#@` description, a blank line, a line
        // of another section, a key without a command, odd spacing, no line break at the end.
        let text = "\u{feff}# my keys\r\n\
                    \r\n\
                    #@ jump back\r\n\
                    LEFT seek -5\r\n\
                    \t RIGHT   seek 5   \r\n\
                    x {encode} quit\r\n\
                    lonely\n\
                    q quit";
        let conf = InputConf::parse(text);
        assert_eq!(conf.render(), text);
        assert_eq!(InputConf::parse("").render(), "");
        assert_eq!(InputConf::parse("\n\n").render(), "\n\n");

        // A key is rewritten in its own line (with its indentation); nothing else moves.
        let mut conf = InputConf::parse(text);
        conf.bind("RIGHT", "seek 10").unwrap();
        assert_eq!(
            conf.render(),
            text.replace("\t RIGHT   seek 5   ", "\t RIGHT seek 10")
        );

        // A new key goes to the end, and the last line gets the line break it lacked, in the
        // ending most lines have (CRLF here).
        let mut conf = InputConf::parse(text);
        conf.bind("n", "playlist-next").unwrap();
        assert_eq!(conf.render(), format!("{text}\r\nn playlist-next\r\n"));

        // Binding what is bound already leaves the line as the user wrote it.
        let mut conf = InputConf::parse(text);
        conf.bind("RIGHT", "seek 5").unwrap();
        assert_eq!(conf.render(), text);

        // Keys are case-sensitive, and a section's line or a comment binds nothing.
        let conf = InputConf::parse("s a\nS b\n# s c\n#@ s d\ns {sec} e\nlonely\n");
        assert_eq!(conf.get("s").as_deref(), Some("a"));
        assert_eq!(conf.get("S").as_deref(), Some("b"));
        assert_eq!(conf.get("lonely"), None);
        assert_eq!(conf.get("x"), None);
    }

    #[test]
    fn kaleido_default_lines_are_read_as_bindings() {
        let defaults = InputConf::parse(DEFAULT_INPUT_CONF).commands();
        assert_eq!(defaults["s"], KALEIDO_S);
        assert_eq!(defaults["S"], "script-message kaleido screenshot video");
        // `{` and `}` are keys here, not the start of a section.
        assert_eq!(
            defaults["{"],
            "no-osd multiply speed 0.5; script-message kaleido osd speed"
        );
        assert_eq!(
            defaults["}"],
            "no-osd multiply speed 2.0; script-message kaleido osd speed"
        );
        assert_eq!(
            defaults["RIGHT"],
            "no-osd seek 5; script-message kaleido osd seek"
        );
        assert_eq!(
            kaleido_default("Ctrl+v").as_deref(),
            Some("script-message kaleido paste")
        );
        assert_eq!(kaleido_default("SPACE"), None);
        assert_eq!(
            kaleido_default("Ctrl+o").as_deref(),
            Some("script-message kaleido open")
        );
    }

    #[test]
    fn rebind_moves_the_command_and_silences_the_old_key() {
        let mut conf = InputConf::parse("# keys\ns shot\nx other\n");
        let bindings = [binding("s", "shot", BindingSource::Kaleido)];

        // The command is the one of the active binding; `n` is new, `s` is silenced in place.
        let moved = move_binding(&mut conf, &bindings, "s", "n").unwrap();
        assert_eq!(moved.as_deref(), Some("shot"));
        assert_eq!(conf.render(), "# keys\ns ignore\nx other\nn shot\n");

        // Onto a key that is bound: its line is rewritten, so the old binding is overridden.
        let mut conf = InputConf::parse("# keys\ns shot\nx other\n");
        move_binding(&mut conf, &bindings, "s", "x").unwrap();
        assert_eq!(conf.render(), "# keys\ns ignore\nx shot\n");

        // A binding that no line of input.conf has (mpv's own, a script's) is moved the same
        // way: the new key gets the command, the old key a line that silences it.
        let space = [binding("SPACE", "cycle pause", BindingSource::Mpv)];
        let mut conf = InputConf::parse("# keys\n");
        move_binding(&mut conf, &space, "SPACE", "p").unwrap();
        assert_eq!(conf.render(), "# keys\np cycle pause\nSPACE ignore\n");

        // The same key twice changes nothing.
        let mut conf = InputConf::parse("s shot\n");
        assert_eq!(move_binding(&mut conf, &bindings, "s", "s").unwrap(), None);
        assert_eq!(conf.render(), "s shot\n");

        // A silenced key has nothing to move.
        let silenced = [binding("s", "ignore", BindingSource::User)];
        let mut conf = InputConf::parse("s ignore\n");
        assert_eq!(
            move_binding(&mut conf, &silenced, "s", "n"),
            Err(SettingsError::NotAllowed { key: "s".into() })
        );
        assert_eq!(conf.render(), "s ignore\n");
    }

    #[test]
    fn reset_restores_the_kaleido_default() {
        let default = kaleido_default("s").unwrap();

        // The line the user changed goes back, in place; so does one they silenced.
        let mut conf = InputConf::parse("# keys\ns my-command\nx other\n");
        conf.reset("s", Some(default.as_str())).unwrap();
        assert_eq!(conf.render(), format!("# keys\ns {default}\nx other\n"));
        let mut conf = InputConf::parse("s ignore\r\nx other\r\n");
        conf.reset("s", Some(default.as_str())).unwrap();
        assert_eq!(conf.render(), format!("s {default}\r\nx other\r\n"));

        // A line the user deleted comes back at the end; one that is right is left alone.
        let mut conf = InputConf::parse("x other\n");
        conf.reset("s", Some(default.as_str())).unwrap();
        assert_eq!(conf.render(), format!("x other\ns {default}\n"));
        let right = format!("s   {default}\n");
        let mut conf = InputConf::parse(&right);
        conf.reset("s", Some(default.as_str())).unwrap();
        assert_eq!(conf.render(), right);

        // Earlier lines of the key would only have been overridden: they go.
        let mut conf = InputConf::parse("s one\nx other\ns two\n");
        conf.reset("s", Some(default.as_str())).unwrap();
        assert_eq!(conf.render(), format!("x other\ns {default}\n"));

        // No default (mpv's or a script's binding, or none): every line of the key goes.
        let mut conf =
            InputConf::parse("# keys\nSPACE ignore\nx other\nSPACE cycle pause\nSPACE\n");
        conf.reset("SPACE", None).unwrap();
        assert_eq!(conf.render(), "# keys\nx other\nSPACE\n");
        // Another key's line, a section's line and a comment are not the key's.
        let mut conf = InputConf::parse("# SPACE a\nSPACE {sec} b\nSPACEBAR c\n");
        conf.reset("SPACE", None).unwrap();
        assert_eq!(conf.render(), "# SPACE a\nSPACE {sec} b\nSPACEBAR c\n");
    }

    #[test]
    fn rebinding_an_unknown_key_fails() {
        // The UI sends keys, never a command: a key with no binding has none to move.
        let bindings = [binding("s", "shot", BindingSource::Kaleido)];
        let text = "s shot\n";
        let mut conf = InputConf::parse(text);
        assert_eq!(
            move_binding(&mut conf, &bindings, "F13", "q"),
            Err(SettingsError::NotAllowed { key: "F13".into() })
        );
        assert_eq!(
            move_binding(&mut conf, &[], "s", "q"),
            Err(SettingsError::NotAllowed { key: "s".into() })
        );
        // Keys are case-sensitive here too.
        assert_eq!(
            move_binding(&mut conf, &bindings, "S", "q"),
            Err(SettingsError::NotAllowed { key: "S".into() })
        );
        assert_eq!(conf.render(), text);
    }

    #[test]
    fn invalid_key_names_are_rejected() {
        let long = "x".repeat(33);
        let bad = [
            "",
            "a b",
            "x\ny",
            "\t",
            "#x",
            "{x}",
            "{section",
            long.as_str(),
        ];
        let bindings = [binding("s", "shot", BindingSource::Kaleido)];
        for key in bad {
            let mut conf = InputConf::parse("s shot\n");
            let invalid = |error: SettingsError| matches!(error, SettingsError::Invalid { .. });
            assert!(invalid(conf.bind(key, "x").unwrap_err()), "{key:?}");
            assert!(invalid(conf.silence(key).unwrap_err()), "{key:?}");
            assert!(invalid(conf.reset(key, None).unwrap_err()), "{key:?}");
            assert!(invalid(conf.reset(key, Some("x")).unwrap_err()), "{key:?}");
            assert!(
                invalid(move_binding(&mut conf, &bindings, key, "q").unwrap_err()),
                "{key:?}"
            );
            assert!(
                invalid(move_binding(&mut conf, &bindings, "s", key).unwrap_err()),
                "{key:?}"
            );
            assert_eq!(conf.render(), "s shot\n", "{key:?}");
        }
        // A command is one line: a line break would write another binding.
        let mut conf = InputConf::parse("");
        for command in ["", "  ", "a\nb ignore", "a\r"] {
            assert!(conf.bind("q", command).is_err(), "{command:?}");
            assert!(conf.reset("q", Some(command)).is_err(), "{command:?}");
        }
        assert_eq!(conf.render(), "");
        // Keys with signs in them are fine, and so are `{` and `}` alone.
        for key in ["Ctrl+Shift+LEFT", "+", "{", "}", "ě", "Ctrl++"] {
            conf.bind(key, "x").unwrap();
        }
    }

    fn raw(json: &str) -> Vec<RawBinding> {
        parse_raw(json).unwrap()
    }

    #[test]
    fn bindings_are_worked_out_from_input_bindings() {
        let raw = raw(r#"[
            {"key":"s","cmd":"screenshot","section":"default","priority":0,"is_weak":true},
            {"key":"s","cmd":"script-message kaleido screenshot subtitles","section":"default",
             "priority":0,"is_weak":false},
            {"key":"x","cmd":"add sub-delay +0.1","section":"default","priority":0,"is_weak":true},
            {"key":"x","cmd":"script-binding testbind/test-x","section":"input_testbind",
             "priority":1,"is_weak":true,"owner":"testbind"},
            {"key":"SPACE","cmd":"cycle pause","section":"default","priority":0,"is_weak":true},
            {"key":"F12","cmd":"show-text mine","section":"default","priority":0,
             "is_weak":false,"comment":"my text"},
            {"key":"y","cmd":"later","section":"input_later","priority":-1,"is_weak":true,
             "owner":"later"},
            {"key":"q","cmd":"quit","section":"default","priority":0,"is_weak":true},
            {"key":"q","cmd":"ignore","section":"default","priority":0,"is_weak":false},
            {"key":"m","cmd":"script-binding forced/m","section":"input_forced_forced",
             "priority":2,"is_weak":false,"owner":"forced"},
            {"key":"m","cmd":"cycle mute","section":"default","priority":0,"is_weak":false}
        ]"#);
        let kaleido = InputConf::parse(DEFAULT_INPUT_CONF).commands();
        let listed = derive(&raw, &kaleido);
        let find = |key: &str| listed.iter().find(|b| b.key == key).unwrap();

        // One binding per key, the active one, in the order mpv lists the keys.
        let keys: Vec<&str> = listed.iter().map(|b| b.key.as_str()).collect();
        assert_eq!(keys, ["s", "x", "SPACE", "F12", "q", "m"]);

        // The user's line over mpv's own, and equal to Kaleido's default: Kaleido's.
        assert_eq!(find("s").command, KALEIDO_S);
        assert_eq!(find("s").source, BindingSource::Kaleido);
        // A script's default over mpv's.
        assert_eq!(find("x").command, "script-binding testbind/test-x");
        assert_eq!(
            find("x").source,
            BindingSource::Plugin {
                name: "testbind".into()
            }
        );
        assert_eq!(find("SPACE").source, BindingSource::Mpv);
        // A line of the user's own, with its description.
        assert_eq!(find("F12").source, BindingSource::User);
        assert_eq!(find("F12").comment.as_deref(), Some("my text"));
        assert_eq!(find("SPACE").comment, None);
        // Silenced: listed as what it is.
        assert_eq!(find("q").command, "ignore");
        assert_eq!(find("q").source, BindingSource::User);
        // A script's binding that is not weak, over the user's: the script's.
        assert_eq!(
            find("m").source,
            BindingSource::Plugin {
                name: "forced".into()
            }
        );
        // A section that is not active is not listed.
        assert!(!keys.contains(&"y"));
    }

    #[test]
    fn a_key_put_back_by_hand_is_still_the_default_it_was() {
        // mpv has no unbind, so after a reset the key is bound to the command of the default.
        let raw = raw(r#"[
            {"key":"SPACE","cmd":"cycle pause","priority":0,"is_weak":true},
            {"key":"SPACE","cmd":"cycle pause","priority":0,"is_weak":false},
            {"key":"x","cmd":"script-binding testbind/test-x","priority":1,"is_weak":true,
             "owner":"testbind"},
            {"key":"x","cmd":"script-binding testbind/test-x","priority":0,"is_weak":false},
            {"key":"p","cmd":"cycle pause","priority":0,"is_weak":true},
            {"key":"p","cmd":"cycle mute","priority":0,"is_weak":false}
        ]"#);
        let listed = derive(&raw, &HashMap::new());
        let find = |key: &str| listed.iter().find(|b| b.key == key).unwrap();
        assert_eq!(find("SPACE").source, BindingSource::Mpv);
        assert_eq!(
            find("x").source,
            BindingSource::Plugin {
                name: "testbind".into()
            }
        );
        assert_eq!(find("p").source, BindingSource::User);

        // What a key falls back to: the best default, only where the user's binding is on it.
        assert_eq!(
            fallback_command(&raw, "SPACE").as_deref(),
            Some("cycle pause")
        );
        assert_eq!(
            fallback_command(&raw, "x").as_deref(),
            Some("script-binding testbind/test-x")
        );
        assert_eq!(fallback_command(&raw, "F12"), None);
        let only_default = [raw[0].clone()];
        assert_eq!(fallback_command(&only_default, "SPACE"), None);
    }

    #[test]
    fn bindings_serialize_for_the_ui() {
        let listed = [
            Binding {
                comment: Some("note".into()),
                ..binding("s", "shot", BindingSource::Kaleido)
            },
            binding(
                "x",
                "script-binding p/x",
                BindingSource::Plugin { name: "p".into() },
            ),
            binding("SPACE", "cycle pause", BindingSource::Mpv),
            binding("q", "ignore", BindingSource::User),
        ];
        assert_eq!(
            serde_json::to_value(listed).unwrap(),
            serde_json::json!([
                {"key":"s","command":"shot","source":{"type":"kaleido"},"comment":"note"},
                {"key":"x","command":"script-binding p/x",
                 "source":{"type":"plugin","name":"p"},"comment":null},
                {"key":"SPACE","command":"cycle pause","source":{"type":"mpv"},"comment":null},
                {"key":"q","command":"ignore","source":{"type":"user"},"comment":null}
            ])
        );
    }

    // --- the real libmpv --------------------------------------------------------------------

    /// The bindings of `engine` as the settings page gets them, once `done` accepts them; panics
    /// after 5 s. Scripts add theirs a moment after they were loaded.
    fn wait_for_bindings(
        engine: &Engine,
        what: &str,
        done: impl Fn(&[Binding]) -> bool,
    ) -> Vec<Binding> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let listed = bindings(engine);
            if done(&listed) {
                return listed;
            }
            assert!(Instant::now() < deadline, "timed out waiting until {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn command_of(listed: &[Binding], key: &str) -> Option<String> {
        listed
            .iter()
            .find(|binding| binding.key == key)
            .map(|binding| binding.command.clone())
    }

    fn source_of_key(listed: &[Binding], key: &str) -> Option<BindingSource> {
        listed
            .iter()
            .find(|binding| binding.key == key)
            .map(|binding| binding.source.clone())
    }

    #[test]
    fn bindings_list_marks_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join("input.conf"),
            format!("{DEFAULT_INPUT_CONF}F12 show-text mine\n"),
        )
        .unwrap();
        // A script's own binding; its name is the file's.
        let script = tmp.path().join("testbind.lua");
        fs::write(
            &script,
            "mp.add_key_binding(\"x\", \"test-x\", function() end)\n",
        )
        .unwrap();
        let engine = Engine::start(headless(paths), NoEvents).unwrap();
        engine.command(&["load-script", &script.to_string_lossy()]);

        let listed = wait_for_bindings(&engine, "the script's binding is listed", |listed| {
            matches!(
                source_of_key(listed, "x"),
                Some(BindingSource::Plugin { .. })
            )
        });
        assert_eq!(
            source_of_key(&listed, "x"),
            Some(BindingSource::Plugin {
                name: "testbind".into()
            })
        );
        assert_eq!(
            command_of(&listed, "x").as_deref(),
            Some("script-binding testbind/test-x")
        );
        // Kaleido's line over mpv's own `s`.
        assert_eq!(source_of_key(&listed, "s"), Some(BindingSource::Kaleido));
        assert_eq!(command_of(&listed, "s").as_deref(), Some(KALEIDO_S));
        // Nothing overrides `SPACE`: it is mpv's.
        assert_eq!(source_of_key(&listed, "SPACE"), Some(BindingSource::Mpv));
        // A line of the user's own.
        assert_eq!(source_of_key(&listed, "F12"), Some(BindingSource::User));
        // One entry per key, however many bindings mpv holds for it.
        for key in ["s", "x", "SPACE", "F12"] {
            assert_eq!(listed.iter().filter(|b| b.key == key).count(), 1, "{key}");
        }
    }

    #[test]
    fn keybind_applies_live() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        ensure_defaults(&paths).unwrap();
        let input_conf = paths.config_dir.join("input.conf");
        let file = || InputConf::parse(&fs::read_to_string(&input_conf).unwrap());
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let listed = bindings(&engine);
        assert_eq!(command_of(&listed, "s").as_deref(), Some(KALEIDO_S));
        assert_eq!(command_of(&listed, "Ctrl+F11"), None);

        // Moved to another key: the new key is listed with the command at once, the old one is
        // silenced, and input.conf has both lines for the next start.
        rebind(&engine, &paths.config_dir, "s", "Ctrl+F11").unwrap();
        let listed = bindings(&engine);
        assert_eq!(command_of(&listed, "Ctrl+F11").as_deref(), Some(KALEIDO_S));
        assert_eq!(command_of(&listed, "s").as_deref(), Some("ignore"));
        assert_eq!(source_of_key(&listed, "s"), Some(BindingSource::User));
        assert_eq!(file().get("Ctrl+F11").as_deref(), Some(KALEIDO_S));
        assert_eq!(file().get("s").as_deref(), Some("ignore"));
        // The rest of the file is as it was.
        let text = fs::read_to_string(&input_conf).unwrap();
        assert!(text.starts_with(DEFAULT_INPUT_CONF.lines().next().unwrap()));
        assert_eq!(file().get("S"), kaleido_default("S"));

        // Rebinding a key nothing is bound to is refused; the file stays as it is.
        assert_eq!(
            rebind(&engine, &paths.config_dir, "Ctrl+F10", "q"),
            Err(SettingsError::NotAllowed {
                key: "Ctrl+F10".into()
            })
        );
        assert!(rebind(&engine, &paths.config_dir, "s", "a b").is_err());
        assert_eq!(fs::read_to_string(&input_conf).unwrap(), text);

        // Reset: Kaleido's line is back for `s`, live and in the file.
        reset_binding(&engine, &paths.config_dir, "s").unwrap();
        let listed = bindings(&engine);
        assert_eq!(command_of(&listed, "s").as_deref(), Some(KALEIDO_S));
        assert_eq!(source_of_key(&listed, "s"), Some(BindingSource::Kaleido));
        assert_eq!(file().get("s").as_deref(), Some(KALEIDO_S));
        // The key that got the command has no default: its line goes. mpv cannot unbind it
        // before the next start (documented on `reset_binding`).
        reset_binding(&engine, &paths.config_dir, "Ctrl+F11").unwrap();
        assert_eq!(file().get("Ctrl+F11"), None);
        assert!(reset_binding(&engine, &paths.config_dir, "").is_err());
    }

    #[test]
    fn reset_hands_a_key_back_to_the_binding_mpv_has_for_it() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        ensure_defaults(&paths).unwrap();
        let input_conf = paths.config_dir.join("input.conf");
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let space = command_of(&bindings(&engine), "SPACE").expect("mpv binds SPACE");

        rebind(&engine, &paths.config_dir, "SPACE", "Ctrl+F11").unwrap();
        let listed = bindings(&engine);
        assert_eq!(command_of(&listed, "SPACE").as_deref(), Some("ignore"));
        assert_eq!(command_of(&listed, "Ctrl+F11"), Some(space.clone()));
        assert!(
            InputConf::parse(&fs::read_to_string(&input_conf).unwrap())
                .get("SPACE")
                .is_some()
        );

        // No line of input.conf is left for SPACE, and the player has mpv's binding again.
        reset_binding(&engine, &paths.config_dir, "SPACE").unwrap();
        assert_eq!(
            InputConf::parse(&fs::read_to_string(&input_conf).unwrap()).get("SPACE"),
            None
        );
        let listed = bindings(&engine);
        assert_eq!(command_of(&listed, "SPACE"), Some(space));
        assert_eq!(source_of_key(&listed, "SPACE"), Some(BindingSource::Mpv));
    }
}
