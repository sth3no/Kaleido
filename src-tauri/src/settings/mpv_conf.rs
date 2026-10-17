//! A gentle editor for mpv.conf (spec 8.10). Kaleido changes only the keys it is asked to, only
//! in the main section (before the first `[profile]`) and only their last occurrence there; a
//! key that is missing goes into a marked block at the end of the main section. Every other
//! line (comments, unknown and unreadable lines, profiles) stays byte for byte, with its line
//! ending, and so does the BOM.
//!
//! Lines are read the way mpv's own parser (`m_config_parse`) reads them: `key=value`, `key`
//! (yes) and `no-key` (no); a value may be quoted as `"…"`, `'…'` or `%N%…` (N bytes).

/// The line that opens Kaleido's block in the main section.
pub const BLOCK_MARKER: &str = "# --- Kaleido ---";

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

/// An mpv.conf as lines. [`MpvConf::render`] gives back the text it was parsed from, byte for
/// byte, until something is set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MpvConf {
    bom: bool,
    lines: Vec<Line>,
}

/// What a line is to mpv.
enum Parsed<'a> {
    /// Empty, white space only or a comment.
    Blank,
    /// `[name]`: a profile starts. A malformed one counts too, so that nothing after it is
    /// touched.
    Section,
    Option(OptionLine<'a>),
    /// A line mpv would refuse (`key value`, an open quote, ...).
    Unreadable,
}

struct OptionLine<'a> {
    /// White space before the name.
    indent: &'a str,
    /// The name as written: `no-osc` for the `no-` form.
    name: &'a str,
    /// The value after `=`, unquoted; `None` without `=`.
    value: Option<String>,
    /// What follows the value (or the name): white space and maybe a comment.
    tail: &'a str,
}

impl OptionLine<'_> {
    /// The value this line gives `key`, if it sets `key` at all.
    fn value_for(&self, key: &str) -> Option<String> {
        if self.name == key {
            return Some(self.value.clone().unwrap_or_else(|| "yes".to_owned()));
        }
        if self.value.is_none() && self.name.strip_prefix("no-") == Some(key) {
            return Some("no".to_owned());
        }
        None
    }
}

/// White space as mpv's `mp_isspace` knows it.
fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c')
}

fn parse_line(text: &str) -> Parsed<'_> {
    let line = text.trim_start_matches(is_space);
    if line.is_empty() || line.starts_with('#') {
        return Parsed::Blank;
    }
    if line.starts_with('[') {
        return Parsed::Section;
    }
    let indent = &text[..text.len() - line.len()];
    let name_length = line
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        .count();
    if name_length == 0 {
        return Parsed::Unreadable;
    }
    let (name, after_name) = line.split_at(name_length);
    let rest = after_name.trim_start_matches(is_space);
    let (value, tail) = match rest.strip_prefix('=') {
        None => (None, after_name),
        Some(after_equals) => match read_value(after_equals.trim_start_matches(is_space)) {
            Some((value, tail)) => (Some(value), tail),
            None => return Parsed::Unreadable,
        },
    };
    let trailing = tail.trim_start_matches(is_space);
    if !trailing.is_empty() && !trailing.starts_with('#') {
        return Parsed::Unreadable;
    }
    Parsed::Option(OptionLine {
        indent,
        name,
        value,
        tail,
    })
}

/// Reads a value as mpv does and returns it with what follows it, or `None` where mpv would
/// refuse the line.
fn read_value(text: &str) -> Option<(String, &str)> {
    if let Some(quote) = text.chars().next().filter(|c| matches!(c, '"' | '\'')) {
        let inner = &text[1..];
        let end = inner.find(quote)?;
        return Some((inner[..end].to_owned(), &inner[end + 1..]));
    }
    if let Some(prefixed) = text.strip_prefix('%') {
        let digits = prefixed.bytes().take_while(u8::is_ascii_digit).count();
        let length: usize = prefixed[..digits].parse().ok()?;
        let body = prefixed[digits..].strip_prefix('%')?;
        let value = body.get(..length)?;
        return Some((value.to_owned(), &body[length..]));
    }
    // Unquoted: up to a comment, without the white space around it.
    let end = text.find('#').unwrap_or(text.len());
    let value = text[..end].trim_end_matches(is_space);
    Some((value.to_owned(), &text[value.len()..]))
}

/// The value as mpv.conf has to hold it: as it is, or as `%N%value` with N in bytes (mpv
/// counts bytes, Ruling R13) where mpv would read it otherwise: a `#` (a comment), a `"`, white
/// space at either end (stripped), or a `'` or `%` at the start (quoting).
fn encode(value: &str) -> String {
    let quoted = value.contains(['#', '"'])
        || value.starts_with(['\'', '%'])
        || value.starts_with(is_space)
        || value.ends_with(is_space);
    if quoted {
        format!("%{}%{value}", value.len())
    } else {
        value.to_owned()
    }
}

impl MpvConf {
    pub fn parse(text: &str) -> MpvConf {
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
        MpvConf { bom, lines }
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

    /// The value the main section gives `key` (its last occurrence there), as mpv reads it.
    pub fn get(&self, key: &str) -> Option<String> {
        self.occurrences(key).pop().map(|(_, value)| value)
    }

    /// Sets `key` in the main section, or with `None` removes every line of it there.
    /// Profiles are never touched. A value with a line break cannot be written and is ignored;
    /// the values Kaleido writes are checked before (`mpv_keys::validate_mpv`).
    pub fn set(&mut self, key: &str, value: Option<&str>) {
        match value {
            None => {
                for (index, _) in self.occurrences(key).into_iter().rev() {
                    self.lines.remove(index);
                }
            }
            Some(value) if value.contains(['\n', '\r']) => {
                tracing::warn!("mpv.conf cannot hold a line break; {key} stays as it is");
            }
            Some(value) => self.put(key, value),
        }
    }

    fn put(&mut self, key: &str, value: &str) {
        let written = format!("{key}={}", encode(value));
        match self.occurrences(key).pop() {
            // Already so: the line stays as the user wrote it.
            Some((_, current)) if current == value => {}
            Some((index, _)) => {
                let line = &mut self.lines[index];
                line.text = match parse_line(&line.text) {
                    // The indentation and a comment after the value stay.
                    Parsed::Option(option) => format!("{}{written}{}", option.indent, option.tail),
                    _ => written,
                };
            }
            None => {
                let at = self.block_end();
                self.insert(at, written);
            }
        }
    }

    /// Where the main section ends: at the first profile, or at the end of the file.
    fn main_end(&self) -> usize {
        self.lines
            .iter()
            .position(|line| matches!(parse_line(&line.text), Parsed::Section))
            .unwrap_or(self.lines.len())
    }

    /// The lines of the main section that set `key`, with the value each gives it, in order.
    fn occurrences(&self, key: &str) -> Vec<(usize, String)> {
        self.lines[..self.main_end()]
            .iter()
            .enumerate()
            .filter_map(|(index, line)| match parse_line(&line.text) {
                Parsed::Option(option) => option.value_for(key).map(|value| (index, value)),
                _ => None,
            })
            .collect()
    }

    /// Where a missing key goes: after the options of Kaleido's block. Without a block, one is
    /// made after the last line of the main section that is not blank or a comment, so that the
    /// blank lines and comments above a profile stay with it.
    fn block_end(&mut self) -> usize {
        let main_end = self.main_end();
        let marker = self.lines[..main_end]
            .iter()
            .position(|line| line.text.trim_matches(is_space) == BLOCK_MARKER);
        if let Some(marker) = marker {
            let mut at = marker + 1;
            while at < main_end && matches!(parse_line(&self.lines[at].text), Parsed::Option(_)) {
                at += 1;
            }
            return at;
        }
        let at = self.lines[..main_end]
            .iter()
            .rposition(|line| !matches!(parse_line(&line.text), Parsed::Blank))
            .map_or(main_end, |index| index + 1);
        self.insert(at, BLOCK_MARKER.to_owned());
        at + 1
    }

    /// A new line at `at`, with the file's usual line ending. The line before it gets one if it
    /// was the last line without.
    fn insert(&mut self, at: usize, text: String) {
        let ending = self.usual_ending();
        if let Some(before) = at
            .checked_sub(1)
            .and_then(|index| self.lines.get_mut(index))
            && before.ending == Ending::None
        {
            before.ending = ending;
        }
        self.lines.insert(at, Line { text, ending });
    }

    /// CRLF if most lines end so, otherwise LF.
    fn usual_ending(&self) -> Ending {
        let crlf = self
            .lines
            .iter()
            .filter(|line| line.ending == Ending::CrLf)
            .count();
        let lf = self
            .lines
            .iter()
            .filter(|line| line.ending == Ending::Lf)
            .count();
        if crlf > lf { Ending::CrLf } else { Ending::Lf }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changed(text: &str, changes: &[(&str, Option<&str>)]) -> String {
        let mut conf = MpvConf::parse(text);
        for (key, value) in changes {
            conf.set(key, *value);
        }
        conf.render()
    }

    #[test]
    fn mpv_conf_keeps_comments_profiles_and_unknown_lines() {
        let text = "# my config\n\
                    volume=50  # loud enough\n\
                    this is not an option\n\
                    unterminated=\"quote\n\
                    ; not mpv's comment\n\
                    \n\
                    [anime]\n\
                    # profile comment\n\
                    volume=80\n";
        assert_eq!(
            changed(text, &[("volume", Some("70")), ("hwdec", Some("no"))]),
            "# my config\n\
             volume=70  # loud enough\n\
             this is not an option\n\
             unterminated=\"quote\n\
             ; not mpv's comment\n\
             # --- Kaleido ---\n\
             hwdec=no\n\
             \n\
             [anime]\n\
             # profile comment\n\
             volume=80\n"
        );
        // Unreadable lines set nothing.
        let conf = MpvConf::parse(text);
        assert_eq!(conf.get("this"), None);
        assert_eq!(conf.get("unterminated"), None);
    }

    #[test]
    fn mpv_conf_updates_the_last_occurrence_in_the_main_section() {
        let text = "volume=30\nhwdec=no\nvolume=50\n[quiet]\nvolume=10\n";
        let mut conf = MpvConf::parse(text);
        assert_eq!(conf.get("volume").as_deref(), Some("50"));

        conf.set("volume", Some("70"));
        assert_eq!(
            conf.render(),
            "volume=30\nhwdec=no\nvolume=70\n[quiet]\nvolume=10\n"
        );
        assert_eq!(conf.get("volume").as_deref(), Some("70"));
        // The indentation and the comment of the line stay.
        assert_eq!(
            changed("  volume = 50   # mine\n", &[("volume", Some("60"))]),
            "  volume=60   # mine\n"
        );
    }

    #[test]
    fn mpv_conf_never_touches_profile_sections() {
        let text =
            "hwdec=no\n\n[hq]\nprofile-desc=High quality\nvolume=80\nfs\n[default]\nvolume=90\n";
        let mut conf = MpvConf::parse(text);
        assert_eq!(conf.get("volume"), None, "only profiles set it");
        assert_eq!(conf.get("fs"), None);

        conf.set("volume", None);
        assert_eq!(conf.render(), text, "nothing to remove in the main section");
        conf.set("volume", Some("70"));
        assert_eq!(
            conf.render(),
            "hwdec=no\n# --- Kaleido ---\nvolume=70\n\n[hq]\nprofile-desc=High quality\n\
             volume=80\nfs\n[default]\nvolume=90\n"
        );
        // A file that starts with a profile: the block goes before it.
        assert_eq!(
            changed("[hq]\nvolume=80\n", &[("volume", Some("70"))]),
            "# --- Kaleido ---\nvolume=70\n[hq]\nvolume=80\n"
        );
    }

    #[test]
    fn mpv_conf_appends_missing_keys_to_the_kaleido_block() {
        // No block yet: it is made at the end of the main section.
        assert_eq!(
            changed(
                "# defaults\nhwdec=auto-safe\nytdl=yes\n",
                &[("volume", Some("70")), ("slang", Some("cs,en"))]
            ),
            "# defaults\nhwdec=auto-safe\nytdl=yes\n# --- Kaleido ---\nvolume=70\nslang=cs,en\n"
        );
        // An existing block takes the next key; the comment above the profile stays with it.
        assert_eq!(
            changed(
                "hwdec=no\n# --- Kaleido ---\nvolume=70\n\n# mine\n[anime]\nsub-font-size=50\n",
                &[("sub-font-size", Some("40"))]
            ),
            "hwdec=no\n# --- Kaleido ---\nvolume=70\nsub-font-size=40\n\n# mine\n[anime]\n\
             sub-font-size=50\n"
        );
        // An empty file, a file of comments, a file without a final line break.
        assert_eq!(
            changed("", &[("volume", Some("70"))]),
            "# --- Kaleido ---\nvolume=70\n"
        );
        assert_eq!(
            changed("# only words\n", &[("volume", Some("70"))]),
            "# only words\n# --- Kaleido ---\nvolume=70\n"
        );
        assert_eq!(
            changed("ytdl=yes", &[("volume", Some("70"))]),
            "ytdl=yes\n# --- Kaleido ---\nvolume=70\n"
        );
        // New lines end like most lines of the file.
        assert_eq!(
            changed("ytdl=yes\r\nhwdec=no\r\n", &[("volume", Some("70"))]),
            "ytdl=yes\r\nhwdec=no\r\n# --- Kaleido ---\r\nvolume=70\r\n"
        );
    }

    #[test]
    fn mpv_conf_understands_flag_and_no_forms() {
        let text = "fs\nno-osc\nno-border # frameless\n";
        let conf = MpvConf::parse(text);
        assert_eq!(conf.get("fs").as_deref(), Some("yes"));
        assert_eq!(conf.get("osc").as_deref(), Some("no"));
        assert_eq!(conf.get("border").as_deref(), Some("no"));
        // The last line wins, whatever its form.
        assert_eq!(
            MpvConf::parse("osc=yes\nno-osc\n").get("osc").as_deref(),
            Some("no")
        );
        assert_eq!(
            MpvConf::parse("no-osc\nosc\n").get("osc").as_deref(),
            Some("yes")
        );

        assert_eq!(
            changed(text, &[("osc", Some("yes")), ("border", Some("yes"))]),
            "fs\nosc=yes\nborder=yes # frameless\n"
        );
        // What the line says already: it stays as written.
        assert_eq!(
            changed(text, &[("fs", Some("yes")), ("osc", Some("no"))]),
            text
        );
    }

    #[test]
    fn mpv_conf_removing_a_key_deletes_only_main_section_lines() {
        assert_eq!(
            changed(
                "volume=30\n# keep me\nvolume=50 # mine\nhwdec=no\n[quiet]\nvolume=10\n",
                &[("volume", None)]
            ),
            "# keep me\nhwdec=no\n[quiet]\nvolume=10\n"
        );
        // Every form of the key goes; similar keys stay.
        let mut conf = MpvConf::parse("fs\nno-fs\nfs=no\nfs-screen=1\n");
        conf.set("fs", None);
        assert_eq!(conf.render(), "fs-screen=1\n");
        assert_eq!(conf.get("fs"), None);
        // Nothing to remove: nothing changes.
        assert_eq!(changed("hwdec=no", &[("volume", None)]), "hwdec=no");
    }

    #[test]
    fn mpv_conf_quotes_values_with_hash_or_quotes() {
        let mut conf = MpvConf::parse("");
        conf.set("sub-font", Some("a#b"));
        assert_eq!(conf.render(), "# --- Kaleido ---\nsub-font=%3%a#b\n");
        assert_eq!(conf.get("sub-font").as_deref(), Some("a#b"));

        for (value, line) in [
            ("say \"hi\"", "x=%8%say \"hi\""),
            (" lead", "x=%5% lead"),
            ("trail ", "x=%6%trail "),
            ("'single", "x=%7%'single"),
            ("%percent", "x=%8%%percent"),
            // N counts bytes: č and ř are two each.
            ("č#ř", "x=%5%č#ř"),
            ("plain value", "x=plain value"),
            ("it's", "x=it's"),
            ("", "x="),
        ] {
            let text = changed("", &[("x", Some(value))]);
            assert_eq!(text, format!("# --- Kaleido ---\n{line}\n"));
            assert_eq!(
                MpvConf::parse(&text).get("x").as_deref(),
                Some(value),
                "{line}"
            );
        }

        // mpv's other quotings are read too.
        let conf = MpvConf::parse("a=\"x # y\"\nb='z' # c\nc=%2%#c # comment\nd=%9%short\n");
        assert_eq!(conf.get("a").as_deref(), Some("x # y"));
        assert_eq!(conf.get("b").as_deref(), Some("z"));
        assert_eq!(conf.get("c").as_deref(), Some("#c"));
        assert_eq!(conf.get("d"), None, "the length runs past the line");
        // A line break cannot be written.
        assert_eq!(changed("x=1\n", &[("x", Some("a\nb"))]), "x=1\n");
    }

    #[test]
    fn mpv_conf_round_trip_is_byte_identical_without_changes() {
        let text = "\u{feff}# Kaleido\r\nvolume=50\r\n\r\n  indented = spaced  # c\r\n\
                    odd line\nlf only\nlone\rcarriage\n[p]\r\nfs\r\nno final line break";
        assert_eq!(MpvConf::parse(text).render(), text);
        for text in ["", "\u{feff}", "\n", "\r\n", "x", "[only]\n"] {
            assert_eq!(MpvConf::parse(text).render(), text, "{text:?}");
        }

        // A change keeps every other byte, the BOM and the line endings included.
        let mut conf = MpvConf::parse(text);
        conf.set("volume", Some("70"));
        assert_eq!(conf.render(), text.replace("volume=50", "volume=70"));
        conf.set("volume", Some("70"));
        assert_eq!(conf.render(), text.replace("volume=50", "volume=70"));
        conf.set("indented", Some("spaced"));
        assert_eq!(conf.render(), text.replace("volume=50", "volume=70"));
    }
}
