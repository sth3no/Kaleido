//! Opening files and links (spec 4.4, 9.3). What the UI, the command line or a paste hands in
//! is checked here first: only local paths and http(s) links reach mpv's `loadfile`.

use std::ffi::OsStr;
use std::ops::RangeInclusive;
use std::path::{Component, Path, PathBuf, Prefix};

use mpv_ffi::Mpv;
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
    /// Not usable at all: empty, with control characters, a link that does not parse, a device
    /// path (named pipes), or an option value outside what is allowed.
    Invalid,
}

/// A source that was not opened, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadIssue {
    pub source: String,
    pub kind: SourceError,
}

/// Also the open-while-playing setting (`settings.json`), hence `Serialize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

/// The per-file option every entry Kaleido opens with options gets (Ruling R55). Kaleido's
/// mpv.conf has `autocreate-playlist=filter`, which opens a file through its folder: mpv replaces
/// the entry with the folder's playlist, and the entry it then plays has lost the per-file
/// options.
pub(crate) const NO_FOLDER_PLAYLIST: &str = "autocreate-playlist=no";

/// One per-file option of `loadfile`, written as `name=%N%value`: mpv reads the value for exactly
/// N bytes, so nothing in it can end the option early or start another. `name` is one of mpv's
/// option names, given by Kaleido (never by the user).
pub(crate) fn per_file_option(name: &str, value: &str) -> String {
    format!("{name}=%{}%{value}", value.len())
}

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
    /// written as `%N%value` ([`per_file_option`]).
    ///
    /// With any option, the entry also gets [`NO_FOLDER_PLAYLIST`] (Ruling R55): without it
    /// `--start` gave way to the saved position or to 0. A launch that names a time means this
    /// file at this time, so the folder is not opened around it.
    fn to_mpv(&self) -> Option<String> {
        let mut options: Vec<String> = [
            self.start
                .map(|start| per_file_option("start", &start.to_string())),
            self.format
                .as_deref()
                .map(|format| per_file_option("ytdl-format", format)),
        ]
        .into_iter()
        .flatten()
        .collect();
        if options.is_empty() {
            return None;
        }
        options.push(NO_FOLDER_PLAYLIST.to_owned());
        Some(options.join(","))
    }
}

/// From this many UTF-16 units a path no longer fits the classic Windows limit (MAX_PATH is
/// 260 with the terminator, 248 for a folder) and mpv's open fails; the margin is for a name
/// mpv appends when it reads a folder.
const LONG_PATH: usize = 240;

impl Source {
    /// The argument `loadfile` (or `sub-add`) takes.
    pub fn to_mpv(&self) -> String {
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
pub(crate) fn scheme(text: &str) -> Option<&str> {
    let (scheme, _) = text.split_once("://")?;
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    valid.then_some(scheme)
}

/// Whether `scheme` (see [`scheme`]) is `http` or `https`, in any case.
pub(crate) fn is_http(scheme: &str) -> bool {
    scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
}

/// `text` as an http(s) link with a host.
fn http_url(text: &str) -> Option<Url> {
    Url::parse(text)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
}

/// Whether `path` is a place on a disk: a drive path (also as `\\?\C:\`), or a share of a
/// server (also as `\\?\UNC\`). A path with no prefix is one only once joined to a `cwd`.
/// The rest is not: `\\.\` is the device namespace and `\\?\` reaches any object (`pipe`,
/// `GLOBALROOT`), and the `pipe`, `mailslot` and `IPC$` shares of a server are its pipes. Named
/// pipes pass `is_file`, and opening one connects to whichever process serves it. So the check
/// goes by name and comes before any call that touches the path (even `is_file` opens it).
/// `Path` reads the prefix the way Windows does, so `//./pipe/x` is no different from
/// `\\.\pipe\x`.
fn is_disk_path(path: &Path) -> bool {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return true;
    };
    let ordinary_share = |server: &OsStr, share: &OsStr| {
        let is = |name: &str| share.eq_ignore_ascii_case(name);
        // `//?/C:/x` is a verbatim path to Windows, and Rust sees a server named `?` in it.
        server != "?" && server != "." && !is("pipe") && !is("mailslot") && !is("ipc$")
    };
    match prefix.kind() {
        Prefix::Disk(_) | Prefix::VerbatimDisk(_) => true,
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            ordinary_share(server, share)
        }
        Prefix::DeviceNS(_) | Prefix::Verbatim(_) => false,
    }
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
    if !is_disk_path(&path) {
        return Err(SourceError::Invalid);
    }
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
    open_checked(engine, &sources, mode, &LoadOptions::default());
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// Queues `sources`, which [`parse_source`] has accepted, on the engine, as [`open_sources`]
/// does; `opts` go with the first one. For the open requests that check their sources
/// themselves (`system`: command line, dialog, paste, drop). Options that do not
/// [`validate`](LoadOptions::validate) are left out.
pub fn open_checked(engine: &Engine, sources: &[Source], mode: LoadMode, opts: &LoadOptions) {
    let opts = if opts.validate().is_ok() {
        opts
    } else {
        tracing::warn!("invalid load options left out: {opts:?}");
        &LoadOptions::default()
    };
    let commands = load_commands(sources, mode, opts);
    match mode {
        LoadMode::Replace => {
            for args in commands {
                engine.request(Request::Command(args));
            }
        }
        LoadMode::Append if !commands.is_empty() => {
            engine.request(Request::Call(Box::new(move |mpv| append(mpv, &commands))));
        }
        LoadMode::Append => {}
    }
}

/// Runs the commands of an append, on the request thread (the engine's queue keeps it in order
/// with everything sent before). Added to a player that plays, the files only join the
/// playlist, and `pause` and the position stay as they are. When nothing plays, the first
/// added file has to start and play (spec 9.3), even if `pause` was left on by a file that
/// ended or was stopped. Nothing plays when the player is idle, and also when the last file
/// ended with keep-open: it stays loaded, paused at its end, so the player is not idle and
/// `append-play` leaves it there. Only here can it be known which of these it is.
fn append(mpv: &Mpv, commands: &[Vec<String>]) {
    let nothing_playing = mpv.get_flag("idle-active").unwrap_or(false)
        || mpv.get_flag("eof-reached").unwrap_or(false);
    // Where the first added entry will be.
    let first_added = mpv.get_i64("playlist-count").unwrap_or(0);
    for args in commands {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(mpv, &args);
    }
    if !nothing_playing {
        return;
    }
    // An idle player has started it by now (`append-play`); one at the end of a file has not.
    if mpv.get_i64("playlist-pos").ok() != Some(first_added) {
        run(mpv, &["playlist-play-index", &first_added.to_string()]);
    }
    run(mpv, &["set", "pause", "no"]);
}

fn run(mpv: &Mpv, args: &[&str]) {
    if let Err(error) = mpv.command(args) {
        tracing::warn!("mpv request failed: {error}");
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
    use crate::player::testing::{Recorded, clip, eventually, headless, temp_paths};

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

        // Device paths are no files, though some exist and pass `is_file`: opening a named pipe
        // would connect to another process. `Invalid` even for a pipe that is not there, so that
        // the answer does not depend on what is running.
        for raw in [
            r"\\.\pipe\InitShutdown",
            r"\\.\pipe\no-such-pipe",
            r"\\.\PIPE\anything",
            "//./pipe/anything",
            r"\/.\pipe\anything",
            r"\\.\C:",
            r"\\.\PhysicalDrive0",
            r"\\.\GLOBALROOT\Device\NamedPipe\anything",
            r"\\.\UNC\localhost\pipe\anything",
            r"\\?\pipe\anything",
            r"\\?\GLOBALROOT\Device\NamedPipe\anything",
            "//?/pipe/anything",
            "//?/C:/Windows/notepad.exe",
            // The pipe service of a (the local) server, by name.
            r"\\localhost\pipe\srvsvc",
            r"\\localhost\PIPE\srvsvc",
            r"\\localhost\mailslot\anything",
            r"\\?\UNC\localhost\pipe\srvsvc",
            // The same pipes through the share every server has for them, which exists on this
            // machine as `IPC$`.
            r"\\localhost\IPC$\srvsvc",
            r"\\localhost\IPC$\InitShutdown",
            r"\\LOCALHOST\ipc$\srvsvc",
            r"\\localhost\ipc$\x",
            r"\\?\UNC\localhost\IPC$\srvsvc",
            r"\\?\UNC\localhost\IPC$\x",
            "//localhost/IPC$/x",
        ] {
            assert_eq!(parse(raw), Err(SourceError::Invalid), "{raw}");
        }

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

    #[test]
    fn only_drive_and_share_paths_are_disk_paths() {
        for path in [
            r"C:\Videa čeština (2026)\a.mkv",
            "C:/Videa/a.mkv",
            r"\\server\share\Videa čeština (2026)\žluťoučký kůň.mkv",
            "//server/share/a.mkv",
            r"\\server\pipelines\a.mkv",
            r"\\?\C:\Videa\a.mkv",
            r"\\?\UNC\server\share\a.mkv",
            r"relative\a.mkv",
            r"\rooted\a.mkv",
        ] {
            assert!(is_disk_path(Path::new(path)), "{path}");
        }
        for path in [
            r"\\.\pipe\x",
            "//./pipe/x",
            r"\\?\pipe\x",
            r"\\server\pipe\x",
            r"\\server\MAILSLOT\x",
            r"\\?\UNC\server\pipe\x",
            r"\\localhost\IPC$\srvsvc",
            r"\\localhost\ipc$\x",
            r"\\?\UNC\localhost\IPC$\x",
            "//localhost/IPC$/x",
        ] {
            assert!(!is_disk_path(Path::new(path)), "{path}");
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
                "start=%3%4.5,ytdl-format=%23%bv*[height<=?1080]+ba/b,autocreate-playlist=no",
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
        assert_eq!(commands[0][4], "ytdl-format=%2%ž,autocreate-playlist=no");
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
                    "start=%2%10,autocreate-playlist=no"
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

    /// The first position mpv reports for the file that plays.
    fn first_position(engine: &Engine) -> f64 {
        loop {
            if let Some(position) = engine.call(|mpv| mpv.get_f64("time-pos").ok()) {
                return position;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn playlist_count(engine: &Engine) -> i64 {
        engine.call(|mpv| mpv.get_i64("playlist-count").unwrap())
    }

    /// Ruling R55. With `autocreate-playlist=filter` (Kaleido's mpv.conf), a folder of two clips
    /// and a position saved for the one opened: opened with a start (the command line's
    /// `--start=3`) it plays from 3 s, on its own; not from the saved 7 s, nor from 0. Without
    /// `autocreate-playlist=no` for the entry, mpv opened it through its folder, and the entry it
    /// played had lost the start (it resumed at 7 s).
    #[test]
    fn a_start_wins_over_the_folder_playlist_and_the_saved_position() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "autocreate-playlist=filter\nkeep-open=yes\n",
        )
        .unwrap();
        let folder = tmp.path().join("Videa");
        fs::create_dir(&folder).unwrap();
        let file = clip(&folder, 10);
        fs::copy(&file, folder.join("další díl.y4m")).unwrap();
        let events = Recorded::default();
        let engine = engine_with(tmp.path(), events.clone());

        // Opened without options, the folder is the playlist; a position is saved at 7 s, as a
        // quit of an earlier session leaves it.
        let source = || vec![Source::File(file.clone())];
        open_checked(
            &engine,
            &source(),
            LoadMode::Replace,
            &LoadOptions::default(),
        );
        events.wait_until("the file loaded", LOAD_TIMEOUT, is_file_loaded);
        assert_eq!(
            playlist_count(&engine),
            2,
            "the folder was not opened around the file"
        );
        engine.command(&["seek", "7", "absolute"]);
        eventually(&engine, "the seek to 7 s", |mpv| {
            mpv.get_f64("time-pos")
                .is_ok_and(|position| position >= 6.9)
        });
        engine.command(&["write-watch-later-config"]);

        let before = loaded(&events);
        let start = LoadOptions {
            start: Some(3.0),
            format: None,
        };
        open_checked(&engine, &source(), LoadMode::Replace, &start);
        events.wait_until("the file loaded again", LOAD_TIMEOUT, |events| {
            events
                .iter()
                .filter(|event| **event == Event::FileLoaded)
                .count()
                > before
        });

        let first = first_position(&engine);
        assert!((2.9..4.5).contains(&first), "playback started at {first}");
        assert_eq!(
            playlist_count(&engine),
            1,
            "this file at this time, on its own"
        );
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

    /// As in Kaleido's default mpv.conf.
    fn keep_open_engine(root: &Path, events: Recorded) -> Engine {
        let paths = temp_paths(root);
        fs::write(paths.config_dir.join("mpv.conf"), "keep-open=yes\n").unwrap();
        Engine::start(headless(paths), events).unwrap()
    }

    fn loaded(events: &Recorded) -> usize {
        events
            .events()
            .iter()
            .filter(|event| **event == Event::FileLoaded)
            .count()
    }

    /// Spec 9.3: a file that is opened plays, also when the last one ended with keep-open,
    /// which leaves the player paused at the end.
    #[test]
    fn opening_a_file_after_the_previous_one_ended_plays_it() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first.y4m");
        mpv_ffi::testing::write_y4m(&first, 64, 36, 15).unwrap();
        let second = tmp.path().join("second.y4m");
        mpv_ffi::testing::write_y4m(&second, 64, 36, 300).unwrap();
        let events = Recorded::default();
        let engine = keep_open_engine(tmp.path(), events.clone());

        let raw = [first.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap();
        eventually(&engine, "the first file ended, paused", |mpv| {
            mpv.get_flag("eof-reached").unwrap_or(false) && mpv.get_flag("pause").unwrap()
        });
        let loaded_before = loaded(&events);

        let raw = [second.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap();
        events.wait_until("the second file loaded", LOAD_TIMEOUT, |_| {
            loaded(&events) > loaded_before
        });

        let second = second.to_string_lossy().into_owned();
        eventually(&engine, "the second file is playing", move |mpv| {
            mpv.get_string("path").is_ok_and(|path| path == second)
                && !mpv.get_flag("pause").unwrap()
                && !mpv.get_flag("eof-reached").unwrap_or(false)
                && mpv.get_f64("time-pos").is_ok_and(|time| time > 0.1)
        });
    }

    /// R14, spec 9.3: nothing is playing, `pause` was left on, and the appended file plays.
    #[test]
    fn appending_to_an_idle_paused_player_plays() {
        let tmp = tempfile::tempdir().unwrap();
        let clip = clip(tmp.path(), 10);
        let events = Recorded::default();
        let engine = keep_open_engine(tmp.path(), events.clone());
        engine.command(&["set", "pause", "yes"]);
        eventually(&engine, "idle and paused", |mpv| {
            mpv.get_flag("idle-active").unwrap() && mpv.get_flag("pause").unwrap()
        });

        let raw = [clip.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Append, tmp.path()).unwrap();
        events.wait_until("the file loaded", LOAD_TIMEOUT, is_file_loaded);

        eventually(&engine, "the appended file is playing", |mpv| {
            !mpv.get_flag("pause").unwrap() && mpv.get_f64("time-pos").is_ok_and(|time| time > 0.1)
        });
        // `append-play` started it; it was not started a second time.
        let starts = |events: &Recorded| {
            events
                .events()
                .iter()
                .filter(|event| **event == Event::StartFile)
                .count()
        };
        assert_eq!(starts(&events), 1, "{:#?}", events.events());
    }

    /// Spec 9.3 again, for an append: the last file has ended with keep-open, so the player is
    /// not idle, it sits paused at the end of the file, and `append-play` alone leaves it there.
    #[test]
    fn appending_after_the_previous_one_ended_plays_it() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first.y4m");
        mpv_ffi::testing::write_y4m(&first, 64, 36, 15).unwrap();
        let second = tmp.path().join("second.y4m");
        mpv_ffi::testing::write_y4m(&second, 64, 36, 300).unwrap();
        let events = Recorded::default();
        let engine = keep_open_engine(tmp.path(), events.clone());

        let raw = [first.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap();
        eventually(&engine, "the first file ended, paused", |mpv| {
            mpv.get_flag("eof-reached").unwrap_or(false) && mpv.get_flag("pause").unwrap()
        });
        assert!(!engine.call(|mpv| mpv.get_flag("idle-active").unwrap()));

        let raw = [second.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Append, tmp.path()).unwrap();

        let second = second.to_string_lossy().into_owned();
        eventually(&engine, "the appended file is playing", move |mpv| {
            mpv.get_string("path").is_ok_and(|path| path == second)
                && !mpv.get_flag("pause").unwrap()
                && !mpv.get_flag("eof-reached").unwrap_or(false)
                && mpv.get_f64("time-pos").is_ok_and(|time| time > 0.1)
        });
        // Added to the playlist, not instead of the first file.
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-count").unwrap()), 2);
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-pos").unwrap()), 1);
    }

    /// The other half of the same rule: while something plays, an append changes nothing about it.
    #[test]
    fn appending_to_a_playing_player_leaves_pause_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first.y4m");
        mpv_ffi::testing::write_y4m(&first, 64, 36, 300).unwrap();
        let second = tmp.path().join("second.y4m");
        mpv_ffi::testing::write_y4m(&second, 64, 36, 300).unwrap();
        let events = Recorded::default();
        let engine = keep_open_engine(tmp.path(), events.clone());

        let raw = [first.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Replace, tmp.path()).unwrap();
        events.wait_until("the file loaded", LOAD_TIMEOUT, is_file_loaded);
        engine.command(&["set", "pause", "yes"]);

        let raw = [second.to_string_lossy().into_owned()];
        open_sources(&engine, &raw, LoadMode::Append, tmp.path()).unwrap();

        // The call is queued behind the pause; once it has run, the playlist holds both.
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-count").unwrap()), 2);
        assert!(engine.call(|mpv| mpv.get_flag("pause").unwrap()));
        assert_eq!(engine.call(|mpv| mpv.get_i64("playlist-pos").unwrap()), 0);
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
                            reason: EndFileReason::Error { .. },
                            ..
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
                        reason: EndFileReason::Error { .. },
                        ..
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
