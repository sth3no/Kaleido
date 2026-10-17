//! A gentle editor for mpv.conf (spec 8.10). Kaleido changes only the keys it is asked to, only
//! in the main section and only their last occurrence there; a key that is missing goes into a
//! marked block at the end of the main section's first part. The main section is what mpv
//! applies at start: the lines before the first `[profile]`, and those after a `[default]`,
//! which goes back to it. Every other line (comments, unknown and unreadable lines, profiles)
//! stays byte for byte, with its line ending, and so does the BOM.
//!
//! Lines are read the way mpv's own parser (`m_config_parse`) reads them: `key=value`, `key`
//! (yes) and `no-key` (no), each also with `--` in front; a value may be quoted as `"…"`, `'…'`
//! or `%N%…` (N bytes).

use super::SettingsError;

/// The line that opens Kaleido's block in the main section.
pub const BLOCK_MARKER: &str = "# --- Kaleido ---";
/// The option that applies a profile where it stands; what follows it overrides the profile.
const PROFILE: &str = "profile";

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
    /// `[name]`: a profile starts, or with `[default]` (`main`) the main section goes on. A
    /// malformed header counts as a profile, so that nothing after it is touched.
    Section {
        main: bool,
    },
    Option(OptionLine<'a>),
    /// A line mpv would refuse (`key value`, an open quote, ...).
    Unreadable,
}

struct OptionLine<'a> {
    /// White space and a `--` before the name, if the line has them.
    lead: &'a str,
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
    if let Some(header) = line.strip_prefix('[') {
        return Parsed::Section {
            main: returns_to_main(header),
        };
    }
    // mpv takes `--key` for `key` in a config file too.
    let body = line.strip_prefix("--").unwrap_or(line);
    let lead = &text[..text.len() - body.len()];
    let name_length = body
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        .count();
    if name_length == 0 {
        return Parsed::Unreadable;
    }
    let (name, after_name) = body.split_at(name_length);
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
        lead,
        name,
        value,
        tail,
    })
}

/// Whether a header (after its `[`) is a well-formed `[default]`: mpv goes back to the main
/// section there.
fn returns_to_main(header: &str) -> bool {
    header.split_once(']').is_some_and(|(name, rest)| {
        let rest = rest.trim_start_matches(is_space);
        name == "default" && (rest.is_empty() || rest.starts_with('#'))
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
    /// Profiles are never touched. A value with a line break cannot be written: an error, and
    /// nothing changes.
    pub fn set(&mut self, key: &str, value: Option<&str>) -> Result<(), SettingsError> {
        match value {
            None => {
                for (index, _) in self.occurrences(key).into_iter().rev() {
                    self.lines.remove(index);
                }
            }
            Some(value) if value.contains(['\n', '\r']) => {
                return Err(SettingsError::invalid(key, "a value without line breaks"));
            }
            Some(value) => self.put(key, value),
        }
        Ok(())
    }

    fn put(&mut self, key: &str, value: &str) {
        let written = format!("{key}={}", encode(value));
        match self.occurrences(key).pop() {
            // Already so: the line stays as the user wrote it.
            Some((_, current)) if current == value => {}
            Some((index, _)) => {
                let line = &mut self.lines[index];
                line.text = match parse_line(&line.text) {
                    // The indentation, a `--` and a comment after the value stay.
                    Parsed::Option(option) => format!("{}{written}{}", option.lead, option.tail),
                    _ => written,
                };
            }
            None => {
                // A profile is a preset: Kaleido's explicit settings after it override it
                // (Ruling R24).
                let at = self.block_position(key == PROFILE);
                self.insert(at, written);
            }
        }
    }

    /// Which lines are in the main section: those before the first profile, and those after a
    /// `[default]` up to the next profile. Headers themselves are not.
    fn main_lines(&self) -> Vec<bool> {
        let mut main = true;
        self.lines
            .iter()
            .map(|line| match parse_line(&line.text) {
                Parsed::Section { main: back } => {
                    main = back;
                    false
                }
                _ => main,
            })
            .collect()
    }

    /// Where the first part of the main section ends: at the first header, or at the end.
    fn first_part_end(&self) -> usize {
        self.lines
            .iter()
            .position(|line| matches!(parse_line(&line.text), Parsed::Section { .. }))
            .unwrap_or(self.lines.len())
    }

    /// The lines of the main section that set `key`, with the value each gives it, in order.
    fn occurrences(&self, key: &str) -> Vec<(usize, String)> {
        self.lines
            .iter()
            .zip(self.main_lines())
            .enumerate()
            .filter(|(_, (_, main))| *main)
            .filter_map(|(index, (line, _))| match parse_line(&line.text) {
                Parsed::Option(option) => option.value_for(key).map(|value| (index, value)),
                _ => None,
            })
            .collect()
    }

    /// Where a missing key goes in Kaleido's block: after its options, or with `first` right
    /// after the marker. Without a block, one is made after the last line of the main section's
    /// first part that is not blank or a comment, so that the blank lines and comments above a
    /// profile stay with it.
    fn block_position(&mut self, first: bool) -> usize {
        let end = self.first_part_end();
        let marker = self.lines[..end]
            .iter()
            .position(|line| line.text.trim_matches(is_space) == BLOCK_MARKER);
        if let Some(marker) = marker {
            let mut at = marker + 1;
            while !first
                && at < end
                && matches!(parse_line(&self.lines[at].text), Parsed::Option(_))
            {
                at += 1;
            }
            return at;
        }
        let at = self.lines[..end]
            .iter()
            .rposition(|line| !matches!(parse_line(&line.text), Parsed::Blank))
            .map_or(end, |index| index + 1);
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
            conf.set(key, *value).unwrap();
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

        conf.set("volume", Some("70")).unwrap();
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
            "hwdec=no\n\n[hq]\nprofile-desc=High quality\nvolume=80\nfs\n[big] # c\nvolume=90\n";
        let mut conf = MpvConf::parse(text);
        assert_eq!(conf.get("volume"), None, "only profiles set it");
        assert_eq!(conf.get("fs"), None);

        conf.set("volume", None).unwrap();
        assert_eq!(conf.render(), text, "nothing to remove in the main section");
        conf.set("volume", Some("70")).unwrap();
        assert_eq!(
            conf.render(),
            "hwdec=no\n# --- Kaleido ---\nvolume=70\n\n[hq]\nprofile-desc=High quality\n\
             volume=80\nfs\n[big] # c\nvolume=90\n"
        );
        // A file that starts with a profile: the block goes before it.
        assert_eq!(
            changed("[hq]\nvolume=80\n", &[("volume", Some("70"))]),
            "# --- Kaleido ---\nvolume=70\n[hq]\nvolume=80\n"
        );
        // Headers that are not quite `[default]` start profiles: nothing after them is read.
        for header in ["[ default ]", "[default] extra", "[Default]", "[default"] {
            let text = format!("{header}\nvolume=5\n");
            assert_eq!(MpvConf::parse(&text).get("volume"), None, "{header}");
            assert_eq!(changed(&text, &[("volume", None)]), text, "{header}");
        }
    }

    /// mpv goes back to the main section at `[default]`: its lines count, and the block stays in
    /// the first part.
    #[test]
    fn mpv_conf_default_section_is_the_main_section() {
        let text =
            "hwdec=no\n[hq]\nvolume=80\n[default] # back\nvolume=90\nfs\n[quiet]\nvolume=10\n";
        let conf = MpvConf::parse(text);
        assert_eq!(conf.get("volume").as_deref(), Some("90"));
        assert_eq!(conf.get("fs").as_deref(), Some("yes"));
        assert_eq!(conf.get("hwdec").as_deref(), Some("no"));

        // The last main occurrence is the one after `[default]`; a new key goes to the block.
        assert_eq!(
            changed(text, &[("volume", Some("70")), ("slang", Some("cs"))]),
            "hwdec=no\n# --- Kaleido ---\nslang=cs\n[hq]\nvolume=80\n[default] # back\n\
             volume=70\nfs\n[quiet]\nvolume=10\n"
        );
        // Removing takes it out of every main part, not out of the profiles.
        assert_eq!(
            changed(
                "volume=1\n[hq]\nvolume=80\n[default]\nvolume=90\n",
                &[("volume", None)]
            ),
            "[hq]\nvolume=80\n[default]\n"
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

    /// A profile is a preset; the settings Kaleido writes after it must win (Ruling R24).
    #[test]
    fn mpv_conf_puts_a_profile_before_the_explicit_settings() {
        assert_eq!(
            changed(
                "ytdl=yes\n",
                &[("hdr-compute-peak", Some("yes")), ("profile", Some("fast"))]
            ),
            "ytdl=yes\n# --- Kaleido ---\nprofile=fast\nhdr-compute-peak=yes\n"
        );
        // Into an existing block too, and a later setting still goes after it.
        assert_eq!(
            changed(
                "# --- Kaleido ---\nvolume=70\ndeinterlace=yes\n",
                &[("profile", Some("high-quality")), ("hwdec", Some("no"))]
            ),
            "# --- Kaleido ---\nprofile=high-quality\nvolume=70\ndeinterlace=yes\nhwdec=no\n"
        );
        // A profile line that is there already is changed where it stands.
        assert_eq!(
            changed(
                "# --- Kaleido ---\nvolume=70\nprofile=fast\n",
                &[("profile", Some("high-quality"))]
            ),
            "# --- Kaleido ---\nvolume=70\nprofile=high-quality\n"
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
    fn mpv_conf_takes_dashed_option_names() {
        let text = "--volume=50\n  --no-osc # c\n--fs\n";
        let conf = MpvConf::parse(text);
        assert_eq!(conf.get("volume").as_deref(), Some("50"));
        assert_eq!(conf.get("osc").as_deref(), Some("no"));
        assert_eq!(conf.get("fs").as_deref(), Some("yes"));
        // Changed in place, as written; removed like any other line.
        assert_eq!(
            changed(text, &[("volume", Some("70")), ("osc", Some("yes"))]),
            "--volume=70\n  --osc=yes # c\n--fs\n"
        );
        assert_eq!(
            changed(text, &[("fs", None)]),
            "--volume=50\n  --no-osc # c\n"
        );
        // `--` alone names nothing.
        assert_eq!(MpvConf::parse("--\n").get(""), None);
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
        conf.set("fs", None).unwrap();
        assert_eq!(conf.render(), "fs-screen=1\n");
        assert_eq!(conf.get("fs"), None);
        // Nothing to remove: nothing changes.
        assert_eq!(changed("hwdec=no", &[("volume", None)]), "hwdec=no");
    }

    #[test]
    fn mpv_conf_quotes_values_with_hash_or_quotes() {
        let mut conf = MpvConf::parse("");
        conf.set("sub-font", Some("a#b")).unwrap();
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
        // A line break cannot be written: an error, and nothing changes.
        for broken in ["a\nb", "a\rb", "\n"] {
            let mut conf = MpvConf::parse("x=1\n");
            assert!(matches!(
                conf.set("x", Some(broken)),
                Err(SettingsError::Invalid { ref key, .. }) if key == "x"
            ));
            assert_eq!(conf.render(), "x=1\n");
        }
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
        conf.set("volume", Some("70")).unwrap();
        assert_eq!(conf.render(), text.replace("volume=50", "volume=70"));
        conf.set("volume", Some("70")).unwrap();
        assert_eq!(conf.render(), text.replace("volume=50", "volume=70"));
        conf.set("indented", Some("spaced")).unwrap();
        assert_eq!(conf.render(), text.replace("volume=50", "volume=70"));
    }
}
