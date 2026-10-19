//! Links from the clipboard ("Vložit odkaz", Ctrl+V) and from the paste field (spec 8.5).

use std::time::Instant;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use url::Url;

use super::open_queue::OpenRequest;
use crate::player::load::{LoadIssue, Source, SourceError, link_from_text};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PasteOutcome {
    /// The clipboard held a link, which now opens.
    Played,
    /// No link on the clipboard: the UI offers the paste field instead.
    Empty,
}

/// Opens the link on the clipboard, if the clipboard holds exactly one (see [`link_from_text`]).
pub fn paste(app: &AppHandle) -> PasteOutcome {
    // No text on the clipboard (an image, files, nothing) is no link either.
    let text = app.clipboard().read_text().unwrap_or_default();
    match link_from_text(&text) {
        Some(link) => {
            open_link(app, link);
            PasteOutcome::Played
        }
        None => PasteOutcome::Empty,
    }
}

/// Opens `text` from the paste field if it is one link; otherwise says why not.
pub fn open_text(app: &AppHandle, text: &str) -> Result<(), LoadIssue> {
    open_link(app, checked_link(text)?);
    Ok(())
}

/// The link `text` is if it is exactly one (see [`link_from_text`]); otherwise why not. What
/// opens only after this: the paste field, and the retry of a link that failed (which updates
/// yt-dlp first, and not for a text that would not open).
pub fn checked_link(text: &str) -> Result<Url, LoadIssue> {
    link_from_text(text).ok_or_else(|| LoadIssue {
        source: text.to_owned(),
        kind: not_a_link(text),
    })
}

/// `Protocol` for a link with another scheme (`file://`, `edl://`, ...), `Invalid` for text that
/// is no link at all. Files are opened by the dialog or a drop, not typed in (spec 9.2).
fn not_a_link(text: &str) -> SourceError {
    let text = text.trim();
    match Url::parse(text) {
        Ok(url) if text.contains("://") && !matches!(url.scheme(), "http" | "https") => {
            SourceError::Protocol
        }
        _ => SourceError::Invalid,
    }
}

/// Opens `link` as a pasted one opens: through the open queue, and by the open-while-playing
/// setting (spec 8.10).
pub fn open_link(app: &AppHandle, link: Url) {
    let request = OpenRequest {
        sources: vec![Source::Url(link)],
        ..OpenRequest::default()
    };
    super::open(app, Instant::now(), request);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_that_is_no_link_says_why() {
        for text in [
            "edl://x",
            "file:///C:/a.mkv",
            " ftp://example.com/a ",
            "https+evil://x",
        ] {
            assert_eq!(not_a_link(text), SourceError::Protocol, "{text}");
        }
        for text in [
            "",
            "youtu.be/x",
            r"C:\Videa\a.mkv",
            "viz https://youtu.be/x",
            "https://exa mple.com",
            "https://youtu.be/x\nhttps://youtu.be/y",
        ] {
            assert_eq!(not_a_link(text), SourceError::Invalid, "{text:?}");
        }
    }

    /// `stream_retry` opens a link again, after updating yt-dlp if it is asked to; it checks the
    /// text first, so that nothing is updated for what would not open.
    #[test]
    fn retry_refuses_anything_but_http_links() {
        for (text, kind) in [
            ("file:///C:/a.mkv", SourceError::Protocol),
            ("edl://x", SourceError::Protocol),
            ("ftp://example.com/a.mp4", SourceError::Protocol),
            (r"C:\Videa\a.mkv", SourceError::Invalid),
            ("youtu.be/x", SourceError::Invalid),
            (
                "https://youtu.be/x https://youtu.be/y",
                SourceError::Invalid,
            ),
            ("", SourceError::Invalid),
        ] {
            assert_eq!(
                checked_link(text),
                Err(LoadIssue {
                    source: text.to_owned(),
                    kind
                }),
                "{text:?}"
            );
        }
        for text in [
            "https://www.youtube.com/watch?v=abc",
            "  http://example.com/a.mp4\n",
            "HTTPS://EXAMPLE.COM/A",
        ] {
            assert!(checked_link(text).is_ok(), "{text:?}");
        }
        // The link as it is, not as typed.
        assert_eq!(
            checked_link("  https://youtu.be/x\n").unwrap().as_str(),
            "https://youtu.be/x"
        );
    }

    #[test]
    fn paste_outcomes_reach_the_ui_as_camel_case_json() {
        assert_eq!(
            serde_json::to_value(PasteOutcome::Played).unwrap(),
            serde_json::json!("played")
        );
        assert_eq!(
            serde_json::to_value(PasteOutcome::Empty).unwrap(),
            serde_json::json!("empty")
        );
    }
}
