//! Kaleido's command line (spec 9.2): `Kaleido.exe [--append] [--start=<s>] [--format=<f>]
//! <file|folder|url>…`, checked like everything else that is opened.

use std::ffi::OsString;
use std::path::Path;

use crate::player::LoadMode;
use crate::player::load::{LoadOptions, Source, SourceError, parse_source};

/// What a command line asks for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CliRequest {
    /// `Some(Append)` with `--append`; `None` leaves it to the open-while-playing setting.
    pub mode: Option<LoadMode>,
    pub options: LoadOptions,
    pub sources: Vec<Source>,
    /// Arguments that are no source to open, as given, and why.
    pub rejected: Vec<(String, SourceError)>,
}

/// Reads `args` (without the program name). Relative paths are taken from `cwd`; the sources
/// are checked with `parse_source`, which looks at the disk. Until `--`, an argument that
/// starts with `-` is an option; an unknown one is logged and ignored.
pub fn parse(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> CliRequest {
    let mut request = CliRequest::default();
    let mut options_end = false;
    for arg in args {
        // Windows hands over UTF-16; what does not convert cannot name a file mpv would find.
        let Some(text) = arg.to_str() else {
            request
                .rejected
                .push((arg.to_string_lossy().into_owned(), SourceError::Invalid));
            continue;
        };
        if !options_end && text.starts_with('-') {
            if text == "--" {
                options_end = true;
            } else {
                read_option(text, &mut request);
            }
            continue;
        }
        match parse_source(text, cwd) {
            Ok(source) => request.sources.push(source),
            Err(error) => request.rejected.push((text.to_owned(), error)),
        }
    }
    request
}

/// `--append`, `--start=<s>` and `--format=<f>`. A value Kaleido would not pass on to mpv
/// (see [`LoadOptions::validate`]) is dropped like an unknown option: the files still open.
fn read_option(arg: &str, request: &mut CliRequest) {
    let mut options = request.options.clone();
    match arg.split_once('=') {
        None if arg == "--append" => {
            request.mode = Some(LoadMode::Append);
            return;
        }
        // Not a number becomes NaN, which `validate` refuses.
        Some(("--start", value)) => options.start = Some(value.parse().unwrap_or(f64::NAN)),
        Some(("--format", value)) => options.format = Some(value.to_owned()),
        _ => {
            tracing::warn!("unknown command line option ignored: {arg}");
            return;
        }
    }
    if options.validate().is_ok() {
        request.options = options;
    } else {
        tracing::warn!("command line option with an invalid value ignored: {arg}");
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use url::Url;

    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn cli_flags_and_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.mkv");
        fs::write(&file, b"x").unwrap();

        let request = parse(
            args(&[
                "--append",
                "--start=12.5",
                "--format=bv*+ba/b",
                "a.mkv",
                "https://x/y",
            ]),
            tmp.path(),
        );

        assert_eq!(request.mode, Some(LoadMode::Append));
        assert_eq!(
            request.options,
            LoadOptions {
                start: Some(12.5),
                format: Some("bv*+ba/b".into()),
            }
        );
        assert_eq!(
            request.sources,
            [
                Source::File(file),
                Source::Url(Url::parse("https://x/y").unwrap()),
            ]
        );
        assert!(request.rejected.is_empty(), "{:?}", request.rejected);
    }

    #[test]
    fn cli_without_flags_leaves_the_mode_to_the_setting() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.mkv"), b"x").unwrap();
        let request = parse(args(&["a.mkv"]), tmp.path());
        assert_eq!(request.mode, None);
        assert_eq!(request.options, LoadOptions::default());
        assert_eq!(request.sources.len(), 1);
    }

    /// Taken over from the prototype: the shell command is `Kaleido.exe -- "%1"`.
    #[test]
    fn cli_double_dash_allows_dash_names() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("-film.mkv");
        fs::write(&file, b"x").unwrap();
        let dashed = tmp.path().join("--append");
        fs::write(&dashed, b"x").unwrap();

        // Before `--` they are options (an unknown one is ignored).
        let before = parse(args(&["-film.mkv"]), tmp.path());
        assert!(before.sources.is_empty(), "{:?}", before.sources);

        let after = parse(args(&["--", "-film.mkv", "--append"]), tmp.path());
        assert_eq!(after.sources, [Source::File(file), Source::File(dashed)]);
        assert_eq!(after.mode, None, "--append after -- is a file name");
    }

    #[test]
    fn cli_rejects_protocols_but_keeps_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.mkv");
        fs::write(&file, b"x").unwrap();

        let request = parse(args(&["edl://x", "a.mkv"]), tmp.path());

        assert_eq!(request.sources, [Source::File(file)]);
        assert_eq!(
            request.rejected,
            [("edl://x".to_owned(), SourceError::Protocol)]
        );
    }

    /// From the prototype: spaces, diacritics and a path relative to the second process's cwd.
    #[test]
    fn cli_keeps_czech_names_folders_and_relative_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Žluťoučký kůň (zkouška).mkv");
        fs::write(&file, b"x").unwrap();
        let folder = tmp.path().join("Videa čeština");
        fs::create_dir(&folder).unwrap();

        let request = parse(
            args(&[
                "Žluťoučký kůň (zkouška).mkv",
                "Videa čeština",
                "missing.mkv",
            ]),
            tmp.path(),
        );

        assert_eq!(request.sources, [Source::File(file), Source::File(folder)]);
        assert_eq!(
            request.rejected,
            [("missing.mkv".to_owned(), SourceError::NotFound)]
        );
    }

    /// An option value Kaleido would refuse to pass on is dropped; the sources still open.
    #[test]
    fn cli_ignores_unknown_flags_and_bad_option_values() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.mkv"), b"x").unwrap();

        for bad in [
            &["--pause", "a.mkv"][..],
            &["--start=-5", "a.mkv"],
            &["--start=soon", "a.mkv"],
            &["--start=NaN", "a.mkv"],
            &["--format=best,vo=gpu", "a.mkv"],
            &["--format=", "a.mkv"],
            &["--start", "a.mkv"],
        ] {
            let request = parse(args(bad), tmp.path());
            assert_eq!(request.options, LoadOptions::default(), "{bad:?}");
            assert_eq!(request.mode, None, "{bad:?}");
            assert_eq!(request.sources.len(), 1, "{bad:?}");
        }
    }
}
