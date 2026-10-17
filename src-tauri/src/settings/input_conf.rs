//! Shortcuts (spec 8.10): a gentle editor for `input.conf`. The list of bindings the settings
//! page shows is worked out in [`super::bindings`].
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

/// Whether a command starts with `{section}`: in `KEY {section} command` that names the input
/// section the binding is for. No mpv command starts with `{`.
fn has_section(command: &str) -> bool {
    command.starts_with('{') && command.contains('}')
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
    // A lone `{` is a key (Kaleido binds it), not a section.
    let braced_key = key.len() > 1 && key.starts_with('{') && key.ends_with('}');
    if has_section(command) || braced_key {
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

/// A command as a line holds it: trimmed, in one line, and not for another input section (a
/// `{section}` in front would make the line one).
fn check_command(command: &str) -> Result<&str, SettingsError> {
    let trimmed = command.trim_matches(is_space);
    if trimmed.is_empty() || command.contains(['\n', '\r']) || has_section(trimmed) {
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
    /// [`check_key`]; a command with a line break or a `{section}`) is an error, and nothing
    /// changes.
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

#[cfg(test)]
mod tests {
    use super::*;

    const KALEIDO_S: &str = "script-message kaleido screenshot subtitles";

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
        for key in bad {
            let mut conf = InputConf::parse("s shot\n");
            let invalid = |error: SettingsError| matches!(error, SettingsError::Invalid { .. });
            assert!(invalid(conf.bind(key, "x").unwrap_err()), "{key:?}");
            assert!(invalid(conf.silence(key).unwrap_err()), "{key:?}");
            assert!(invalid(conf.reset(key, None).unwrap_err()), "{key:?}");
            assert!(invalid(conf.reset(key, Some("x")).unwrap_err()), "{key:?}");
            assert_eq!(conf.render(), "s shot\n", "{key:?}");
        }
        // A command is one line, and not for another section: a line break would write another
        // binding, a `{section}` in front would make this one a binding of that section.
        let mut conf = InputConf::parse("");
        for command in ["", "  ", "a\nb ignore", "a\r", "{sec} quit", " {sec}quit"] {
            assert!(conf.bind("q", command).is_err(), "{command:?}");
            assert!(conf.reset("q", Some(command)).is_err(), "{command:?}");
        }
        assert_eq!(conf.render(), "");
        // A brace later in the command is just a character.
        conf.bind("q", "show-text {x}").unwrap();
        assert_eq!(conf.render(), "q show-text {x}\n");
        // Keys with signs in them are fine, and so are `{` and `}` alone.
        for key in ["Ctrl+Shift+LEFT", "+", "{", "}", "ě", "Ctrl++"] {
            conf.bind(key, "x").unwrap();
        }
    }
}
