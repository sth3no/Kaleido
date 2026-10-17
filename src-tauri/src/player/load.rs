//! Opening files and links (spec 4.4, 9.3). What the UI, the command line or a paste hands in
//! is checked here first: only local paths and http(s) links reach mpv's `loadfile`.

use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

use super::{Engine, Request};

/// Something mpv can be told to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// An existing file or folder.
    File(PathBuf),
    Url(Url),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceError {
    /// No such file or folder.
    NotFound,
    /// A scheme other than http and https (`file://`, `edl://`, `lavfi://`, ...).
    Protocol,
    /// Not usable at all: empty, with control characters, a link that does not parse, or an
    /// option value outside what is allowed.
    Invalid,
}

/// A source that was not opened, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadIssue {
    pub source: String,
    pub kind: SourceError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoadMode {
    /// Start the sources now, in place of what is open.
    Replace,
    /// Add the sources to the playlist; they start if nothing is playing.
    Append,
}

/// Per-file options for the first source.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadOptions {
    /// Where to start, in seconds.
    pub start: Option<f64>,
    /// yt-dlp's format selection for links (`ytdl-format`).
    pub format: Option<String>,
}

/// What a `ytdl-format` may be made of besides ASCII letters and digits: no comma, space or
/// quote, so that it stays one word wherever it is written.
const FORMAT_SYMBOLS: &str = "_+-/*[]<>=!~^$?.:()";
const FORMAT_LENGTH: RangeInclusive<usize> = 1..=200;

impl LoadOptions {
    /// Whether the options may be used: `start` is a finite time from the start of the file
    /// and `format` is a short selection made of the characters above.
    pub fn validate(&self) -> Result<(), SourceError> {
        let start_ok = self
            .start
            .is_none_or(|start| start.is_finite() && start >= 0.0);
        let format_ok = self.format.as_deref().is_none_or(|format| {
            FORMAT_LENGTH.contains(&format.chars().count())
                && format
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || FORMAT_SYMBOLS.contains(c))
        });
        if start_ok && format_ok {
            Ok(())
        } else {
            Err(SourceError::Invalid)
        }
    }

    /// The value of `loadfile`'s options argument, if there is any option. Each value is
    /// written as `%N%value`, which mpv reads for exactly N bytes; nothing in it can end the
    /// option early or start another.
    fn to_mpv(&self) -> Option<String> {
        let quoted = |name: &str, value: &str| format!("{name}=%{}%{value}", value.len());
        let options: Vec<String> = [
            self.start.map(|start| quoted("start", &start.to_string())),
            self.format
                .as_deref()
                .map(|format| quoted("ytdl-format", format)),
        ]
        .into_iter()
        .flatten()
        .collect();
        (!options.is_empty()).then(|| options.join(","))
    }
}

/// From this many UTF-16 units a path no longer fits the classic Windows limit (MAX_PATH is
/// 260 with the terminator, 248 for a folder) and mpv's open fails; the margin is for a name
/// mpv appends when it reads a folder.
const LONG_PATH: usize = 240;

impl Source {
    /// The argument `loadfile` takes.
    fn to_mpv(&self) -> String {
        match self {
            Source::File(path) => mpv_path(path),
            Source::Url(url) => url.as_str().to_owned(),
        }
    }
}

/// `path` as mpv should open it. A long path gets the `\\?\` prefix, which lifts the limit
/// (and, as it switches off the Win32 clean-up of the path, is given a cleaned one).
fn mpv_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if text.encode_utf16().count() < LONG_PATH || text.starts_with(r"\\?\") {
        return text.into_owned();
    }
    let Ok(absolute) = std::path::absolute(path) else {
        return text.into_owned();
    };
    let absolute = absolute.to_string_lossy();
    match absolute.strip_prefix(r"\\") {
        // \\server\share\... → \\?\UNC\server\share\...
        Some(unc) if !unc.starts_with(['?', '.']) => format!(r"\\?\UNC\{unc}"),
        Some(_) => absolute.into_owned(),
        None => format!(r"\\?\{absolute}"),
    }
}

/// The scheme of `text`, if mpv would read it as a URL: letters, digits, `+`, `-` and `.`,
/// starting with a letter, before the first `://` (mpv's own test). `C:\Videa` and
/// `\\server\share` have none.
fn scheme(text: &str) -> Option<&str> {
    let (scheme, _) = text.split_once("://")?;
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    valid.then_some(scheme)
}

fn is_http(scheme: &str) -> bool {
    scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
}

/// `text` as an http(s) link with a host.
fn http_url(text: &str) -> Option<Url> {
    Url::parse(text)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
}

/// A local path (absolute, relative to `cwd`, UNC or `\\?\`) that exists as a file or folder,
/// or an http(s) link. Any other scheme (`file://`, `edl://`, `lavfi://`, ...) is refused: it
/// would make mpv open something that is not a file.
pub fn parse_source(raw: &str, cwd: &Path) -> Result<Source, SourceError> {
    let text = raw.trim();
    if text.is_empty() || text.chars().any(char::is_control) {
        return Err(SourceError::Invalid);
    }
    if let Some(scheme) = scheme(text) {
        if !is_http(scheme) {
            return Err(SourceError::Protocol);
        }
        return http_url(text).map(Source::Url).ok_or(SourceError::Invalid);
    }
    // Always absolute: a name that starts with `-` is not mistaken for an option later.
    let path = cwd.join(text);
    if path.is_file() || path.is_dir() {
        Ok(Source::File(path))
    } else {
        Err(SourceError::NotFound)
    }
}

/// The `loadfile` commands for `sources`: the first starts (or, for `Append`, joins the
/// playlist and starts if nothing plays), the rest are appended. A replace is followed by
/// `set pause no`, since opening something means to play it (spec 9.3). `opts` go with the
/// first source only and must have been validated.
pub fn load_commands(sources: &[Source], mode: LoadMode, opts: &LoadOptions) -> Vec<Vec<String>> {
    let mut commands: Vec<Vec<String>> = sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let mut args = vec!["loadfile".to_owned(), source.to_mpv()];
            match (index, mode) {
                (0, LoadMode::Replace) => args.push("replace".to_owned()),
                (0, LoadMode::Append) => args.push("append-play".to_owned()),
                _ => args.push("append".to_owned()),
            }
            if index == 0
                && let Some(options) = opts.to_mpv()
            {
                // -1 is the index placeholder in front of the options.
                args.extend(["-1".to_owned(), options]);
            }
            args
        })
        .collect();
    if mode == LoadMode::Replace && !sources.is_empty() {
        commands.push(["set", "pause", "no"].map(str::to_owned).to_vec());
    }
    commands
}

/// The link in `text` if `text` is exactly one: a single line that, apart from the space
/// around it, is one http(s) link. For what the clipboard holds.
pub fn link_from_text(text: &str) -> Option<Url> {
    let text = text.trim();
    if text.chars().any(|c| c.is_whitespace() || c.is_control())
        || !scheme(text).is_some_and(is_http)
    {
        return None;
    }
    http_url(text)
}

/// Checks every source in `raw` and queues the valid ones on the engine; the others come back
/// as issues and do not keep the rest from opening. Looks at the disk, never waits for mpv.
pub fn open_sources(
    engine: &Engine,
    raw: &[String],
    mode: LoadMode,
    cwd: &Path,
) -> Result<(), Vec<LoadIssue>> {
    let mut sources = Vec::new();
    let mut issues = Vec::new();
    for text in raw {
        match parse_source(text, cwd) {
            Ok(source) => sources.push(source),
            Err(kind) => issues.push(LoadIssue {
                source: text.clone(),
                kind,
            }),
        }
    }
    for args in load_commands(&sources, mode, &LoadOptions::default()) {
        engine.request(Request::Command(args));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    use mpv_ffi::{EndFileReason, Event};

    use super::*;
    use crate::player::Request;
    use crate::player::testing::{Recorded, clip, headless, temp_paths};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn text(args: &[&str]) -> Vec<String> {
        args.iter().map(|&arg| arg.to_owned()).collect()
    }

    #[test]
    fn sources_accept_only_local_paths_and_http_urls() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let file = cwd.join("clip.y4m");
        fs::write(&file, b"x").unwrap();
        let folder = cwd.join("Videa čeština (2026)");
        fs::create_dir(&folder).unwrap();
        let parse = |raw: &str| parse_source(raw, cwd);

        // Links.
        assert_eq!(
            parse("https://youtu.be/x"),
            Ok(Source::Url(url("https://youtu.be/x")))
        );
        assert_eq!(
            parse("http://example.com/a.mkv?t=3"),
            Ok(Source::Url(url("http://example.com/a.mkv?t=3")))
        );
        assert_eq!(
            parse("  HTTPS://Example.com/a \n"),
            Ok(Source::Url(url("https://example.com/a")))
        );

        // Everything else with a scheme: mpv would open it as a protocol.
        for raw in [
            "file:///C:/Windows/notepad.exe",
            "FILE:///C:/a.mkv",
            "edl://!no_clip;%5%file.mkv",
            "lavfi://[testsrc]",
            "ytdl://https://youtu.be/x",
            "av://lavfi:testsrc",
            "memory://data",
            "fd://0",
            "dvd://1",
            "ftp://example.com/a.mkv",
            "smb://server/share/a.mkv",
            "https+evil://example.com",
        ] {
            assert_eq!(parse(raw), Err(SourceError::Protocol), "{raw}");
        }

        // Local paths.
        assert_eq!(parse("clip.y4m"), Ok(Source::File(file.clone())));
        assert_eq!(
            parse(&file.to_string_lossy()),
            Ok(Source::File(file.clone()))
        );
        assert_eq!(
            parse("Videa čeština (2026)"),
            Ok(Source::File(folder.clone()))
        );
        let verbatim = format!(r"\\?\{}", file.display());
        assert_eq!(parse(&verbatim), Ok(Source::File(PathBuf::from(&verbatim))));
        assert_eq!(parse("missing.mkv"), Err(SourceError::NotFound));
        assert_eq!(
            parse(r"C:\Kaleido\no\such\žluťoučký kůň.mkv"),
            Err(SourceError::NotFound)
        );
        assert_eq!(parse("--no-config"), Err(SourceError::NotFound));

        // Nothing to open.
        for raw in [
            "",
            "   ",
            "a\nb.mkv",
            "clip\u{0}.y4m",
            "http://",
            "https://exa mple.com",
        ] {
            assert_eq!(parse(raw), Err(SourceError::Invalid), "{raw:?}");
        }
    }

    /// UNC paths (`\\server\share\...`) hold no `://`; they are paths like any other. The
    /// administrative share of this very machine stands in for a server.
    #[test]
    fn unc_paths_are_paths_not_protocols() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Žluťoučký kůň (zkouška).mkv");
        fs::write(&file, b"x").unwrap();
        let missing =
            r"\\localhost\C$\Kaleido\no-such-folder\Videa čeština (2026)\žluťoučký kůň.mkv";
        assert_eq!(
            parse_source(missing, tmp.path()),
            Err(SourceError::NotFound)
        );
        let path = file.to_string_lossy();
        if let Some((drive, rest)) = path.split_once(":\\") {
            let unc = format!(r"\\localhost\{drive}$\{rest}");
            // Where the administrative share is off (or not reachable) there is nothing to open.
            if Path::new(&unc).is_file() {
                assert_eq!(
                    parse_source(&unc, tmp.path()),
                    Ok(Source::File(PathBuf::from(unc)))
                );
            }
        }
    }

    /// A file called `--pause` is made absolute, so nothing downstream can read it as an option.
    #[test]
    fn relative_sources_become_absolute_paths() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("--pause"), b"x").unwrap();
        let Ok(Source::File(path)) = parse_source("--pause", tmp.path()) else {
            panic!("the file was not found");
        };
        assert!(path.is_absolute());
        assert_eq!(path, tmp.path().join("--pause"));
    }

    #[test]
    fn percent_quoting_keeps_valid_formats_intact() {
        let opts = LoadOptions {
            start: Some(4.5),
            format: Some("bv*[height<=?1080]+ba/b".into()),
        };
        assert_eq!(opts.validate(), Ok(()));
        let commands = load_commands(
            &[Source::Url(url("https://youtu.be/x"))],
            LoadMode::Append,
            &opts,
        );
        // %N% is the length in bytes of the value that follows: 23 for the format.
        assert_eq!(
            commands,
            [text(&[
                "loadfile",
                "https://youtu.be/x",
                "append-play",
                "-1",
                "start=%3%4.5,ytdl-format=%23%bv*[height<=?1080]+ba/b",
            ])]
        );
    }

    #[test]
    fn formats_that_could_inject_options_are_rejected() {
        let format = |format: &str| LoadOptions {
            start: None,
            format: Some(format.to_owned()),
        };
        for bad in [
            "best,vo=gpu",
            "a b",
            "\"x\"",
            "'x'",
            "",
            "%5%x",
            "a;b",
            "a|b",
            "a&b",
            "bestč",
            "a\nb",
            &"b".repeat(201),
        ] {
            assert_eq!(format(bad).validate(), Err(SourceError::Invalid), "{bad:?}");
        }
        for good in [
            "b",
            "best",
            "bv*[height<=?1080]+ba/b",
            "worst[ext=mp4]/bestvideo[height!=720]+bestaudio",
            "(bv+ba/b)[protocol^=http]~$.:_-",
            &"b".repeat(200),
        ] {
            assert_eq!(format(good).validate(), Ok(()), "{good:?}");
        }
    }

    #[test]
    fn start_must_be_a_finite_non_negative_time() {
        let start = |start| LoadOptions {
            start: Some(start),
            format: None,
        };
        for bad in [-0.1, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(start(bad).validate(), Err(SourceError::Invalid), "{bad}");
        }
        for good in [0.0, 4.0, 3600.5] {
            assert_eq!(start(good).validate(), Ok(()), "{good}");
        }
        assert_eq!(LoadOptions::default().validate(), Ok(()));
    }

    /// The value of an option is read for as many bytes as `%N%` says, so even a value that
    /// holds `,` or `=` could not start another option.
    #[test]
    fn quoting_counts_bytes_not_characters() {
        let opts = LoadOptions {
            start: None,
            format: Some("ž".into()),
        };
        let commands = load_commands(&[Source::File("a.mkv".into())], LoadMode::Append, &opts);
        assert_eq!(commands[0][4], "ytdl-format=%2%ž");
    }

    /// mpv cannot open a path of 260 characters or more as it is (R5): it gets the `\\?\` form.
    #[test]
    fn long_paths_are_given_to_mpv_with_the_verbatim_prefix() {
        let long = "x".repeat(250);
        let mpv = |path: String| Source::File(PathBuf::from(path)).to_mpv();

        let short = r"C:\Videa čeština (2026)\a.mkv";
        assert_eq!(mpv(short.to_owned()), short);
        assert_eq!(
            mpv(format!(r"C:\Videa\{long}\a.mkv")),
            format!(r"\\?\C:\Videa\{long}\a.mkv")
        );
        // The prefix turns off the clean-up Windows does, so it is done first.
        assert_eq!(
            mpv(format!("C:/Videa/{long}/../{long}/./a.mkv")),
            format!(r"\\?\C:\Videa\{long}\a.mkv")
        );
        assert_eq!(
            mpv(format!(r"\\server\share\{long}\a.mkv")),
            format!(r"\\?\UNC\server\share\{long}\a.mkv")
        );
        let verbatim = format!(r"\\?\C:\Videa\{long}\a.mkv");
        assert_eq!(mpv(verbatim.clone()), verbatim);
        // 239 UTF-16 units still pass as they are, 240 do not.
        let name = |length: usize| format!(r"C:\{}", "ž".repeat(length - 3));
        assert_eq!(mpv(name(239)), name(239));
        assert_eq!(mpv(name(240)), format!(r"\\?\{}", name(240)));
    }

    #[test]
    fn replace_starts_the_first_source_appends_the_rest_and_resumes() {
        let sources = [
            Source::File(PathBuf::from(r"C:\Videa\a.mkv")),
            Source::Url(url("https://example.com/b.mp4")),
            Source::File(PathBuf::from(r"C:\Videa\c.mkv")),
        ];
        assert_eq!(
            load_commands(&sources, LoadMode::Replace, &LoadOptions::default()),
            [
                text(&["loadfile", r"C:\Videa\a.mkv", "replace"]),
                text(&["loadfile", "https://example.com/b.mp4", "append"]),
                text(&["loadfile", r"C:\Videa\c.mkv", "append"]),
                text(&["set", "pause", "no"]),
            ]
        );
    }

    #[test]
    fn append_adds_to_the_playlist_and_leaves_pause_alone() {
        let sources = [
            Source::File(PathBuf::from(r"C:\Videa\a.mkv")),
            Source::File(PathBuf::from(r"C:\Videa\b.mkv")),
        ];
        let opts = LoadOptions {
            start: Some(10.0),
            format: None,
        };
        // The options belong to the first source only.
        assert_eq!(
            load_commands(&sources, LoadMode::Append, &opts),
            [
                text(&[
                    "loadfile",
                    r"C:\Videa\a.mkv",
                    "append-play",
                    "-1",
                    "start=%2%10"
                ]),
                text(&["loadfile", r"C:\Videa\b.mkv", "append"]),
            ]
        );
    }

    #[test]
    fn nothing_to_open_sends_nothing() {
        for mode in [LoadMode::Replace, LoadMode::Append] {
            assert!(load_commands(&[], mode, &LoadOptions::default()).is_empty());
        }
    }

    #[test]
    fn link_from_text_takes_one_clean_http_link() {
        assert_eq!(
            link_from_text("  https://youtu.be/x \n"),
            Some(url("https://youtu.be/x"))
        );
        assert_eq!(
            link_from_text("http://example.com/a?b=c#d"),
            Some(url("http://example.com/a?b=c#d"))
        );
        assert_eq!(
            link_from_text("https://youtu.be/x\r\n"),
            Some(url("https://youtu.be/x"))
        );
        for text in [
            "viz https://x",
            "https://x viz",
            "https://youtu.be/x\nhttps://youtu.be/y",
            "https://youtu.be/x\r\n\r\nhttps://youtu.be/y\r\n",
            "file:///C:/a",
            "edl://x",
            "ftp://example.com/a",
            "C:\\Videa\\a.mkv",
            "youtu.be/x",
            "https://",
            "https://exa mple.com",
            "https://example.com/a b",
            "",
            "   \n ",
        ] {
            assert_eq!(link_from_text(text), None, "{text:?}");
        }
    }

    // The tests below open files in a real libmpv (vo=null, ao=null).

    const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

    fn engine_with(tmp: &Path, events: Recorded) -> Engine {
        Engine::start(headless(temp_paths(tmp)), events).unwrap()
    }

    fn is_file_loaded(events: &[Event]) -> bool {
        events.contains(&Event::FileLoaded)
    }

    /// `ytdl-format` and the quoting are the ones mpv accepts: a wrong length would make
    /// `loadfile` fail, and the file would never load.
    #[test]
    fn start_option_starts_playback_there() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 10);
        let events = Recorded::default();
        let engine = engine_with(tmp.path(), events.clone());

        let opts = LoadOptions {
            start: Some(4.0),
            format: Some("bv*[height<=?1080]+ba/b".into()),
        };
        for args in load_commands(&[Source::File(clip)], LoadMode::Replace, &opts) {
            engine.request(Request::Command(args));
        }
        events.wait_until("the file loaded", LOAD_TIMEOUT, is_file_loaded);

        // The first position mpv reports; from 0 it would be far below 3.9.
        let first = loop {
            if let Some(position) = engine.call(|mpv| mpv.get_f64("time-pos").ok()) {
                break position;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(first >= 3.9, "playback started at {first}");
        assert!(first < 6.0, "playback started at {first}");
    }

    /// A new open request means play, even after pause (taken over from the prototype).
    #[test]
    fn opening_a_file_resumes_a_paused_player() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 10);
        let events = Recorded::default();
        let engine = engine_with(tmp.path(), events.clone());
        engine.command(&["set", "pause", "yes"]);
        assert!(engine.call(|mpv| mpv.get_flag("pause").unwrap()));

        let raw = [clip.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap();
        events.wait_until("the file loaded", LOAD_TIMEOUT, is_file_loaded);

        assert!(
            !engine.call(|mpv| mpv.get_flag("pause").unwrap()),
            "a new file must start playing"
        );
    }

    #[test]
    fn opens_paths_with_czech_characters_spaces_and_long_names() {
        let tmp = tempfile::tempdir().unwrap();
        let events = Recorded::default();
        let engine = engine_with(tmp.path(), events.clone());

        let czech = tmp.path().join("Videa čeština (2026)");
        fs::create_dir(&czech).unwrap();
        let short = czech.join("žluťoučký kůň.y4m");
        mpv_ffi::testing::write_y4m(&short, 64, 36, 30).unwrap();

        let mut long = czech.clone();
        for _ in 0..2 {
            long.push(format!("{} dlouhá složka", "ě".repeat(100)));
        }
        fs::create_dir_all(&long).unwrap();
        long.push("příliš žluťoučký kůň úpěl ďábelské ódy.y4m");
        mpv_ffi::testing::write_y4m(&long, 64, 36, 30).unwrap();
        let length = long.to_string_lossy().chars().count();
        assert!(length > 260, "the path has only {length} characters");

        for (name, path) in [("czech", short), ("long", long)] {
            let loaded_before = events
                .events()
                .iter()
                .filter(|event| **event == Event::FileLoaded)
                .count();
            let raw = [path.to_string_lossy().into_owned()];
            open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap();
            events.wait_until(&format!("the {name} path loaded"), LOAD_TIMEOUT, |events| {
                let loaded = events.iter().filter(|e| **e == Event::FileLoaded).count();
                let failed = events.iter().any(|event| {
                    matches!(
                        event,
                        Event::EndFile {
                            reason: EndFileReason::Error { .. }
                        }
                    )
                });
                assert!(!failed, "mpv could not open the {name} path: {events:#?}");
                loaded > loaded_before
            });
        }
    }

    /// A file that cannot be played does not stop the playlist (Review Focus 4).
    #[test]
    fn playlist_continues_after_a_broken_file() {
        let tmp = tempfile::tempdir().unwrap();
        let broken = tmp.path().join("poškozený.mkv");
        fs::write(
            &broken,
            (0..4096u32)
                .map(|i| (i * 7919 % 251) as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let good = clip(tmp.path(), 5);
        let events = Recorded::default();
        let engine = engine_with(tmp.path(), events.clone());

        let raw = [
            broken.to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
        ];
        open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap();

        events.wait_until("the second file loaded", LOAD_TIMEOUT, |events| {
            let error = events.iter().position(|event| {
                matches!(
                    event,
                    Event::EndFile {
                        reason: EndFileReason::Error { .. }
                    }
                )
            });
            let loaded = events.iter().position(|event| *event == Event::FileLoaded);
            matches!((error, loaded), (Some(error), Some(loaded)) if error < loaded)
        });
    }

    /// One source that cannot be opened is reported; the others still play.
    #[test]
    fn a_bad_source_does_not_keep_the_others_from_opening() {
        let tmp = tempfile::tempdir().unwrap();
        let good = clip(tmp.path(), 5);
        let events = Recorded::default();
        let engine = engine_with(tmp.path(), events.clone());

        let raw = [
            tmp.path()
                .join("missing.mkv")
                .to_string_lossy()
                .into_owned(),
            "file:///C:/Windows/notepad.exe".to_owned(),
            good.to_string_lossy().into_owned(),
        ];
        let issues = open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap_err();

        assert_eq!(
            issues,
            [
                LoadIssue {
                    source: raw[0].clone(),
                    kind: SourceError::NotFound
                },
                LoadIssue {
                    source: raw[1].clone(),
                    kind: SourceError::Protocol
                },
            ]
        );
        events.wait_until("the good file loaded", LOAD_TIMEOUT, is_file_loaded);
    }

    #[test]
    fn nothing_valid_opens_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = engine_with(tmp.path(), Recorded::default());
        let raw = ["edl://x".to_owned()];
        // Not even `set pause no`.
        engine.command(&["set", "pause", "yes"]);
        assert_eq!(
            open_sources(&engine, &raw, LoadMode::Replace, tmp.path()),
            Err(vec![LoadIssue {
                source: "edl://x".into(),
                kind: SourceError::Protocol
            }])
        );
        assert!(engine.call(|mpv| mpv.get_flag("pause").unwrap()));
    }

    #[test]
    fn issues_reach_the_ui_as_camel_case_json() {
        let issue = LoadIssue {
            source: "edl://x".into(),
            kind: SourceError::NotFound,
        };
        assert_eq!(
            serde_json::to_value(issue).unwrap(),
            serde_json::json!({"source": "edl://x", "kind": "notFound"})
        );
        assert_eq!(
            serde_json::from_value::<LoadMode>(serde_json::json!("replace")).unwrap(),
            LoadMode::Replace
        );
    }
}
