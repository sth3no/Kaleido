//! What the "About" page shows (spec 10.8, 11.6): the diagnostics the user copies into a bug
//! report, and the licenses of what Kaleido ships. The diagnostics hold no file paths and no URLs
//! (`sanitize`), as the user pastes them into a public issue.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1,
};
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

use crate::paths::AppPaths;
use crate::player::Engine;

/// Shown where a value cannot be found out.
const UNKNOWN: &str = "unknown";

/// The folder of mpv scripts in the config folder.
const SCRIPTS_DIR: &str = "scripts";

/// What a bug report needs to know about the installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostics {
    /// Kaleido's version.
    pub kaleido: String,
    /// mpv's `mpv-version`, which says what libmpv it is.
    pub libmpv: String,
    /// mpv's `ffmpeg-version`.
    pub ffmpeg: String,
    /// `major.minor.build` of Windows, as `RtlGetVersion` reports it (the manifest does not
    /// change it).
    pub windows: String,
    /// The graphics adapters, joined by `; `. Software adapters (WARP) are left out.
    pub gpu: String,
    /// The names of the folders in the config folder's `scripts`: the user's plugins.
    pub scripts: Vec<String>,
}

/// Collects the diagnostics. Waits for mpv, so never on the main thread.
pub fn collect(engine: &Engine, paths: &AppPaths) -> Diagnostics {
    let (libmpv, ffmpeg) = engine.call(|mpv| {
        let read = |name| {
            mpv.get_string(name).unwrap_or_else(|error| {
                tracing::warn!("cannot read {name} for the diagnostics: {error}");
                UNKNOWN.to_owned()
            })
        };
        (read("mpv-version"), read("ffmpeg-version"))
    });
    Diagnostics {
        kaleido: env!("CARGO_PKG_VERSION").to_owned(),
        libmpv,
        ffmpeg,
        windows: windows_version(),
        gpu: gpu_names(),
        scripts: script_folders(&paths.config_dir),
    }
}

/// The text of the diagnostics, line by line. In English whatever the UI language: it goes into
/// a bug report.
pub fn render(diagnostics: &Diagnostics) -> String {
    let scripts = if diagnostics.scripts.is_empty() {
        "none".to_owned()
    } else {
        diagnostics.scripts.join(", ")
    };
    format!(
        "Kaleido: {}\nlibmpv: {}\nFFmpeg: {}\nWindows: {}\nGPU: {}\nScripts: {}\n",
        diagnostics.kaleido,
        diagnostics.libmpv,
        diagnostics.ffmpeg,
        diagnostics.windows,
        diagnostics.gpu,
        scripts
    )
}

/// The diagnostics as the user sees and copies them: collected, rendered and cleaned of paths
/// and URLs. Waits for mpv, so never on the main thread.
pub fn report(engine: &Engine, paths: &AppPaths) -> String {
    sanitize(&render(&collect(engine, paths)))
}

fn windows_version() -> String {
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32,
        ..OSVERSIONINFOW::default()
    };
    // SAFETY: `info` is an OSVERSIONINFOW whose size field is set, which is all the call needs.
    let status = unsafe { RtlGetVersion(&mut info) };
    // NT_SUCCESS: success and informational codes are not negative.
    if status.0 >= 0 {
        format!(
            "{}.{}.{}",
            info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
        )
    } else {
        tracing::warn!("cannot read the Windows version: status {:#x}", status.0);
        UNKNOWN.to_owned()
    }
}

fn gpu_names() -> String {
    let names = hardware_adapters().unwrap_or_else(|error| {
        tracing::warn!("cannot list the graphics adapters: {error}");
        Vec::new()
    });
    if names.is_empty() {
        UNKNOWN.to_owned()
    } else {
        names.join("; ")
    }
}

/// The descriptions of the adapters that are real hardware, in DXGI's order.
fn hardware_adapters() -> windows::core::Result<Vec<String>> {
    // SAFETY: DXGI calls on interfaces this function owns; the description is a plain struct
    // that the call fills in.
    unsafe {
        let factory = CreateDXGIFactory1::<IDXGIFactory1>()?;
        let mut names = Vec::new();
        // The enumeration ends with an error (DXGI_ERROR_NOT_FOUND).
        for index in 0.. {
            let Ok(adapter) = factory.EnumAdapters1(index) else {
                break;
            };
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0.cast_unsigned() != 0 {
                continue;
            }
            let end = desc
                .Description
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(desc.Description.len());
            names.push(String::from_utf16_lossy(&desc.Description[..end]));
        }
        Ok(names)
    }
}

/// The folders in `<config>\scripts`, by name. Single script files are not listed: plugins
/// are folders.
fn script_folders(config_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(config_dir.join(SCRIPTS_DIR)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort_unstable();
    names
}

/// Replaces the file paths and URLs in `text` by `<path>` and `<url>`:
///
/// - URLs with any scheme (`scheme://...`) end at a space;
/// - paths with a drive (`C:\...`, `C:/...`) and UNC paths (`\\server\...`) end at the end of
///   the line, at a quote, at `<`, `>` or `|` (not allowed in a file name) or at a colon that
///   is followed by a space. A space does not end them: folders and files have names with
///   spaces (`C:\Users\Jiří Novák\Videa čeština (2026)\film.mkv`), and part of a path left in
///   the text is still a part of the user's folders. Text that follows a path on its line is
///   therefore gone too, unless the path is quoted. A path in `'...'` or in backticks ends at
///   the closing quote;
/// - POSIX-like paths (`/home/a/b`) start at a word and end at a space. A slash inside a word
///   (`a/b`, `x86_64/msvc`, `10/17/2026`) is no path.
pub fn sanitize(text: &str) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut rest = text;
    let mut before = None;
    while let Some(first) = rest.chars().next() {
        // A match is never empty (it has its first character), but a loop that does not advance
        // would hang the About page, so the guard stays.
        if let Some((len, placeholder)) = hidden_at(rest, before).filter(|&(len, _)| len > 0) {
            clean.push_str(placeholder);
            before = rest[..len].chars().next_back();
            rest = &rest[len..];
        } else {
            clean.push(first);
            before = Some(first);
            rest = &rest[first.len_utf8()..];
        }
    }
    clean
}

/// What `rest` starts with that [`sanitize`] replaces: its length and the placeholder. `before`
/// is the character in front of `rest`, if there is one.
fn hidden_at(rest: &str, before: Option<char>) -> Option<(usize, &'static str)> {
    let first = rest.chars().next()?;
    // Something starts at the beginning of a word, not inside one.
    let word_start = before.is_none_or(|c| !c.is_alphanumeric());
    // A path in single quotes or backticks ends with the quote.
    let quote = before.filter(|c| matches!(c, '\'' | '`'));
    if first.is_ascii_alphabetic() && word_start {
        let scheme = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
            .unwrap_or(rest.len());
        if rest[scheme..].starts_with("://") {
            return Some((token_len(rest, quote, false), "<url>"));
        }
        if matches!(rest.as_bytes(), [_, b':', b'\\' | b'/', ..]) {
            return Some((token_len(rest, quote, true), "<path>"));
        }
    }
    // `\\server`, `\\?\C:\` and `\\.\`: not in the middle of a word or after another backslash.
    if rest.starts_with(r"\\")
        && before.is_none_or(|c| !c.is_alphanumeric() && c != '\\')
        && rest[2..]
            .chars()
            .next()
            .is_some_and(|c| !c.is_whitespace() && c != '\\')
    {
        return Some((token_len(rest, quote, true), "<path>"));
    }
    if first == '/'
        && before.is_none_or(|c| {
            c.is_whitespace() || matches!(c, '(' | '[' | '{' | '"' | '\'' | '`' | '=')
        })
        && rest[1..].chars().next().is_some_and(|c| !c.is_whitespace())
    {
        return Some((token_len(rest, quote, false), "<path>"));
    }
    None
}

/// The length of the token that starts `rest`. It ends at a quote, an angle bracket or a bar,
/// at a line break, at the closing `quote` and at a colon that is followed by a space or the
/// end; at any space unless `spaces_inside`.
fn token_len(rest: &str, quote: Option<char>, spaces_inside: bool) -> usize {
    let mut chars = rest.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        let ends = match c {
            '"' | '<' | '>' | '|' | '\r' | '\n' | '\t' => true,
            ' ' => !spaces_inside,
            ':' => chars.peek().is_none_or(|&(_, next)| next.is_whitespace()),
            c => c.is_whitespace() || Some(c) == quote,
        };
        if ends {
            return at;
        }
    }
    rest.len()
}

/// One entry of the license list in the "About" page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct License {
    pub name: String,
    pub version: String,
    /// The SPDX expression, or the name of the license.
    pub license: String,
    /// Where to read about it or get its source.
    pub url: String,
}

/// The lists in `<resources>\licenses`: what Kaleido ships by hand (`extra.json`: libmpv and
/// thumbfast) and what the build generated (`third-party.json`: Rust crates and npm packages,
/// `scripts/generate-licenses.ps1`).
const LICENSE_LISTS: [&str; 2] = ["extra.json", "third-party.json"];

/// The licenses of everything Kaleido ships, the hand-written list first. A list that is
/// missing or does not read is logged and left out; the other still counts.
pub fn licenses(licenses_dir: &Path) -> Vec<License> {
    LICENSE_LISTS
        .iter()
        .flat_map(|list| read_licenses(&licenses_dir.join(list)))
        .collect()
}

fn read_licenses(path: &Path) -> Vec<License> {
    let read = || -> anyhow::Result<Vec<License>> {
        Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
    };
    read().unwrap_or_else(|error| {
        tracing::error!("cannot read the licenses in {}: {error}", path.display());
        Vec::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::testing::{NoEvents, headless, temp_paths};

    #[test]
    fn diagnostics_contain_no_paths_or_urls() {
        let text = [
            r"Playing C:\Users\a\b.mkv",
            r"Share \\nas\x",
            "Link https://y/z",
            // Spaces, diacritics and brackets are in real names (review focus 1).
            r"Open \\server\share\Videa čeština (2026)\žluťoučký kůň.mkv",
            r"Open C:\Users\Jiří Novák\Videa\a b.mkv",
            "Open D:/Videa/film.mkv",
            "Script /home/a/b.lua loaded",
            "Open file:///C:/Users/a/b.mkv or edl://x;y now",
            r"Long \\?\C:\Users\a\very long\b.mkv",
        ]
        .join("\n");

        let clean = sanitize(&text);

        assert_eq!(
            clean,
            [
                "Playing <path>",
                "Share <path>",
                "Link <url>",
                "Open <path>",
                "Open <path>",
                "Open <path>",
                "Script <path> loaded",
                "Open <url> or <url> now",
                "Long <path>",
            ]
            .join("\n")
        );
        for secret in [
            "Users",
            "nas",
            "y/z",
            "https",
            "server",
            "čeština",
            "žluťoučký",
            "Novák",
            "Videa",
            "home",
            "film",
            "edl",
        ] {
            assert!(!clean.contains(secret), "{secret} is left in: {clean}");
        }
    }

    #[test]
    fn a_quoted_path_ends_at_its_quote_and_a_sentence_colon_ends_a_path() {
        assert_eq!(
            sanitize(r"Opening 'C:\a b\c.mkv' for reading"),
            "Opening '<path>' for reading"
        );
        assert_eq!(
            sanitize(r#"Cannot open "C:\a b\c.mkv" (gone)"#),
            r#"Cannot open "<path>" (gone)"#
        );
        assert_eq!(
            sanitize(r"`\\nas\share\a b.mkv` is slow"),
            "`<path>` is slow"
        );
        assert_eq!(
            sanitize(r"C:\a\b.mkv: No such file"),
            "<path>: No such file"
        );
        assert_eq!(
            sanitize("Two links https://a/b and https://c/d."),
            "Two links <url> and <url>"
        );
    }

    #[test]
    fn ordinary_text_with_slashes_and_colons_is_kept() {
        for text in [
            "a/b",
            "x86_64/msvc",
            "10/17/2026",
            "and/or",
            "100% / 200%",
            "Windows: 10.0.26200",
            "libmpv: mpv v0.40.0-123-gaccb7b2821",
            "FFmpeg: N-123456-gabcdef0123",
            "GPU: NVIDIA GeForce RTX 4070; Intel(R) UHD Graphics 770",
            "Scripts: thumbfast, uosc",
            "C: is a drive",
            "12:30:45",
            "key:value",
            "see www.example.com",
            "Čeština, žluťoučký kůň",
            "",
        ] {
            assert_eq!(sanitize(text), text);
        }
    }

    #[test]
    fn diagnostics_report_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        let scripts = paths.config_dir.join("scripts");
        for folder in ["uosc", "evafast"] {
            fs::create_dir_all(scripts.join(folder)).unwrap();
        }
        // A single file is not a plugin folder.
        fs::write(scripts.join("single.lua"), "").unwrap();
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();

        let diagnostics = collect(&engine, &paths);

        // The real libmpv.
        assert!(diagnostics.libmpv.starts_with("mpv "), "{diagnostics:?}");
        assert_ne!(diagnostics.ffmpeg, UNKNOWN);
        assert!(!diagnostics.ffmpeg.is_empty());
        assert_eq!(diagnostics.kaleido, env!("CARGO_PKG_VERSION"));
        // Windows 10 and 11 both report 10.0.<build>.
        let build = diagnostics.windows.strip_prefix("10.0.").unwrap();
        assert!(build.parse::<u32>().is_ok(), "{}", diagnostics.windows);
        // No hardware adapter (a runner with WARP only) is "unknown", never empty.
        assert!(!diagnostics.gpu.is_empty());
        assert_eq!(diagnostics.scripts, ["evafast", "uosc"]);

        let text = render(&diagnostics);
        assert!(text.starts_with("Kaleido: "), "{text}");
        assert!(text.contains(&format!("libmpv: {}\n", diagnostics.libmpv)));
        assert!(text.ends_with("Scripts: evafast, uosc\n"), "{text}");
    }

    #[test]
    fn the_report_has_no_paths_even_when_a_value_has_one() {
        let diagnostics = Diagnostics {
            kaleido: "0.1.0".to_owned(),
            libmpv: "mpv v0.40.0".to_owned(),
            ffmpeg: r"7.1 built in C:\build\ffmpeg".to_owned(),
            windows: "10.0.26200".to_owned(),
            gpu: "Some GPU".to_owned(),
            scripts: Vec::new(),
        };

        let text = sanitize(&render(&diagnostics));

        assert_eq!(
            text,
            "Kaleido: 0.1.0\nlibmpv: mpv v0.40.0\nFFmpeg: 7.1 built in <path>\nWindows: 10.0.26200\nGPU: Some GPU\nScripts: none\n"
        );
    }

    fn entry(name: &str) -> License {
        License {
            name: name.to_owned(),
            version: "1.0".to_owned(),
            license: "MIT".to_owned(),
            url: format!("https://example.com/{name}"),
        }
    }

    #[test]
    fn licenses_come_from_both_lists_and_a_bad_list_does_not_hide_the_other() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let write = |name: &str, licenses: &[License]| {
            fs::write(dir.join(name), serde_json::to_string(licenses).unwrap()).unwrap();
        };
        write("extra.json", &[entry("libmpv")]);
        write("third-party.json", &[entry("serde"), entry("tauri")]);
        assert_eq!(
            licenses(dir),
            [entry("libmpv"), entry("serde"), entry("tauri")]
        );

        fs::write(dir.join("third-party.json"), "{ not json").unwrap();
        assert_eq!(licenses(dir), [entry("libmpv")]);

        fs::remove_file(dir.join("third-party.json")).unwrap();
        fs::remove_file(dir.join("extra.json")).unwrap();
        assert!(licenses(dir).is_empty());
    }

    /// The lists in the repository are what the installation holds (`bundle.resources`).
    #[test]
    fn the_shipped_license_lists_read() {
        let extra: Vec<License> =
            serde_json::from_str(include_str!("../../../resources/licenses/extra.json")).unwrap();
        let third_party: Vec<License> =
            serde_json::from_str(include_str!("../../../resources/licenses/third-party.json"))
                .unwrap();

        let find = |name: &str| extra.iter().find(|entry| entry.name == name).unwrap();
        assert!(find("libmpv").license.contains("GPL"));
        assert_eq!(find("thumbfast").license, "MPL-2.0");
        assert!(third_party.iter().any(|entry| entry.name == "tauri"));
        assert!(third_party.iter().any(|entry| entry.name == "react"));
        for entry in extra.iter().chain(&third_party) {
            assert!(
                !entry.name.is_empty() && !entry.version.is_empty() && !entry.license.is_empty(),
                "{entry:?}"
            );
        }
    }
}
