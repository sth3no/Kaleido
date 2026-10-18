//! A text file as lines, the model of Kaleido's gentle editors (mpv.conf, input.conf and the
//! `script-opts` files of plugins). Every line keeps its own line ending, so [`join`] gives back
//! the text [`split`] was given, byte for byte, until a line is changed.

/// How a line ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ending {
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
pub(crate) struct Line {
    /// Without the line ending.
    pub(crate) text: String,
    pub(crate) ending: Ending,
}

/// The lines of `text`, cut at `\n`; a `\r` right before it belongs to the ending. Nothing is
/// trimmed and a BOM stays in the first line, so it is up to the caller what to make of it.
pub(crate) fn split(text: &str) -> Vec<Line> {
    text.split_inclusive('\n')
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
        .collect()
}

/// The lines as the text they were split from.
pub(crate) fn join(lines: &[Line]) -> String {
    let mut text = String::new();
    for line in lines {
        text.push_str(&line.text);
        text.push_str(line.ending.as_str());
    }
    text
}

/// A new line at `at`, with the file's usual line ending. The line before it gets one if it was
/// the last line without.
pub(crate) fn insert(lines: &mut Vec<Line>, at: usize, text: String) {
    let ending = usual_ending(lines);
    if let Some(before) = at.checked_sub(1).and_then(|index| lines.get_mut(index))
        && before.ending == Ending::None
    {
        before.ending = ending;
    }
    lines.insert(at, Line { text, ending });
}

/// A new last line, as [`insert`] makes it.
pub(crate) fn push(lines: &mut Vec<Line>, text: String) {
    insert(lines, lines.len(), text);
}

/// CRLF if most lines end so, otherwise LF.
fn usual_ending(lines: &[Line]) -> Ending {
    let count = |wanted| lines.iter().filter(|line| line.ending == wanted).count();
    if count(Ending::CrLf) > count(Ending::Lf) {
        Ending::CrLf
    } else {
        Ending::Lf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_join_back_into_the_text_they_were_split_from() {
        for text in [
            "",
            "\n",
            "a",
            "a\n",
            "a\r\nb\nc",
            "\u{feff}a\r\n\r\nb\r\n",
            "a\r",
            "a\r\r\nb\n\n",
        ] {
            assert_eq!(join(&split(text)), text, "{text:?}");
        }
        let lines = split("a\r\nb\nc");
        assert_eq!(
            lines.iter().map(|line| line.ending).collect::<Vec<_>>(),
            [Ending::CrLf, Ending::Lf, Ending::None]
        );
        assert_eq!(lines[0].text, "a");
        // A BOM is not cut off: it is part of the first line.
        assert_eq!(split("\u{feff}a")[0].text, "\u{feff}a");
    }

    #[test]
    fn a_new_line_ends_as_most_lines_do_and_closes_the_one_before() {
        let mut lines = split("a\r\nb\r\nc");
        push(&mut lines, "d".to_owned());
        assert_eq!(join(&lines), "a\r\nb\r\nc\r\nd\r\n");

        let mut lines = split("a\nb\r\nc\n");
        insert(&mut lines, 1, "x".to_owned());
        assert_eq!(join(&lines), "a\nx\nb\r\nc\n");

        let mut lines = Vec::new();
        push(&mut lines, "a".to_owned());
        assert_eq!(join(&lines), "a\n");
    }
}
