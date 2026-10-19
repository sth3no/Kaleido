//! `tools.json` in the tools folder (spec 4.3): which yt-dlp and Deno Kaleido installed, with the
//! checksum of the release asset they came from, and when they were last checked or failed to be.
//!
//! `load` never fails and `save` is atomic, as for `plugins.json` (see
//! [`Registry`](crate::plugins::registry::Registry)): top-level keys this Kaleido does not know
//! survive, a file that is not one this Kaleido understands is kept aside as
//! `tools.json.bad-<unix time>`, and one that is there but cannot be read, or cannot be kept aside,
//! is never replaced ([`refused`](ToolsFile::refused)). The tools themselves are only ever
//! downloaded again, so a lost file costs a download and nothing else.
//!
//! The installation's bundled copies (plan decision 7) come with a `tools.json` of the same form,
//! which is only read ([`ToolsFile::read`]).

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::{Channel, ToolId};
use crate::settings::store::aside;
use crate::settings::write_atomic;

/// The file's name in the tools folder, and in the bundled copies' folder.
pub const FILE: &str = "tools.json";
/// The version of the file's layout this Kaleido writes and reads.
pub const VERSION: u32 = 1;

/// The whole of `tools.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolsFile {
    pub version: u32,
    pub tools: BTreeMap<ToolId, ToolRecord>,
    /// Top-level keys of the file this Kaleido does not know: kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
    /// Why `save` is refused (see the module). Not part of the file.
    #[serde(skip)]
    refused: Option<String>,
}

impl Default for ToolsFile {
    fn default() -> ToolsFile {
        ToolsFile {
            version: VERSION,
            tools: BTreeMap::new(),
            extra: Map::new(),
            refused: None,
        }
    }
}

/// One tool. The keys are camelCase in the file; the times are RFC 3339 in UTC, to the second
/// ([`stamp`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRecord {
    /// What the tool's `--version` said after it was installed; `None` when it said nothing
    /// that could be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The SHA-256 of the release asset it came from, as lowercase hex: `yt-dlp.exe` itself, or
    /// Deno's zip. The release's checksum list naming another one means there is a new version.
    /// Empty while nothing was ever installed: the record then only keeps the failed attempts,
    /// so that the next one waits ([`next_try`](ToolRecord::next_try)).
    #[serde(default)]
    pub sha256: String,
    /// The channel it came from; yt-dlp only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<Channel>,
    /// When it was put in place; empty while nothing was ever installed.
    #[serde(default)]
    pub installed_at: String,
    /// The last check that reached the release, whether or not it brought a new version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    /// The checks that failed one after the other since the last one that did not.
    #[serde(default)]
    pub failures: u32,
    /// After a failure: no check before this time, unless one is asked for (spec 10.7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_try: Option<String>,
    /// The times in a row its file was found gone (controller Ruling R10): a virus scanner that
    /// takes it away after every install. The backoff of the next vanishing counts them, so that
    /// it climbs although the downloads that put the file back in between went through; over once
    /// a check finds the file still in place at its start.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub vanished: u32,
    /// The SHA-256 of the file put in place where that is not the release asset itself: Deno's
    /// `deno.exe`, out of its zip (lowercase hex). `None` for yt-dlp, whose file is its asset
    /// ([`sha256`](ToolRecord::sha256)), and in a Deno record from before Kaleido kept it: a check
    /// then cannot verify the file and puts it in place again (final review I-2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_sha256: Option<String>,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

impl ToolRecord {
    /// A record of a tool that was never installed (see [`sha256`](ToolRecord::sha256)).
    pub fn not_installed() -> ToolRecord {
        ToolRecord {
            version: None,
            sha256: String::new(),
            channel: None,
            installed_at: String::new(),
            checked_at: None,
            failures: 0,
            next_try: None,
            vanished: 0,
            exe_sha256: None,
        }
    }

    /// Whether the record describes an installed tool (its file may still be gone).
    pub fn is_installed(&self) -> bool {
        !self.sha256.is_empty()
    }

    /// The SHA-256 the file of `tool` had when a check put it in place: yt-dlp's is that of its
    /// release asset, Deno's that of the `deno.exe` it unpacked ([`exe_sha256`]). `None` while
    /// nothing is installed, and for a Deno record that does not know it.
    ///
    /// [`exe_sha256`]: ToolRecord::exe_sha256
    pub fn file_sha256(&self, tool: ToolId) -> Option<&str> {
        if !self.is_installed() {
            return None;
        }
        match tool {
            ToolId::YtDlp => Some(&self.sha256),
            ToolId::Deno => self.exe_sha256.as_deref(),
        }
    }
}

/// `at` as the file writes times: RFC 3339 in UTC, to the second (`2026-10-19T12:00:00Z`).
pub fn stamp(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    let at = at.replace_nanosecond(0).unwrap_or(at);
    // A date between the years 0 and 9999 always has an RFC 3339 form.
    at.format(&Rfc3339).unwrap_or_default()
}

/// A time the file wrote; `None` for one that is not RFC 3339.
pub fn parse_time(text: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(text, &Rfc3339).ok()
}

impl ToolsFile {
    /// Reads `tools.json` at `path` (see the module): missing gives an empty one, nothing is
    /// written until the first [`save`](ToolsFile::save).
    pub fn load(path: impl AsRef<Path>) -> ToolsFile {
        let path = path.as_ref();
        ToolsFile::load_keeping_aside_as(path, &aside(path))
    }

    fn load_keeping_aside_as(path: &Path, aside: &Path) -> ToolsFile {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return ToolsFile::default(),
            Err(error) => {
                tracing::error!(
                    "cannot read {}: {error}; the tools start without it and it is not replaced",
                    path.display()
                );
                return ToolsFile::refusing(format!("tools.json cannot be read: {error}"));
            }
        };
        match parse(&bytes) {
            Ok(file) => file,
            Err(reason) => match keep_aside(path, aside, &reason) {
                Ok(()) => ToolsFile::default(),
                Err(error) => ToolsFile::refusing(format!(
                    "tools.json is not a tools file and cannot be kept aside: {error}"
                )),
            },
        }
    }

    /// The bundled copies' `tools.json` (plan decision 7), which is the installation's and only
    /// read: `None` when it is missing or not one this Kaleido understands.
    pub fn read(path: impl AsRef<Path>) -> Option<ToolsFile> {
        let path = path.as_ref();
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::warn!("cannot read {}: {error}", path.display());
                return None;
            }
        };
        parse(&bytes)
            .inspect_err(|reason| {
                tracing::warn!("{} is not a tools file: {reason}", path.display());
            })
            .ok()
    }

    fn refusing(reason: String) -> ToolsFile {
        ToolsFile {
            refused: Some(reason),
            ..ToolsFile::default()
        }
    }

    /// Why the file cannot be saved, if the one it was read from was left alone because it could
    /// not be read or kept safe.
    pub fn refused(&self) -> Option<&str> {
        self.refused.as_deref()
    }

    /// Writes the file to `path` atomically ([`write_atomic`]); the folder must be there. A
    /// [`refused`](ToolsFile::refused) file writes nothing and returns that reason as the error.
    pub fn save(&self, path: impl AsRef<Path>) -> io::Result<()> {
        if let Some(reason) = &self.refused {
            return Err(io::Error::other(reason.clone()));
        }
        let mut text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        text.push('\n');
        write_atomic(path.as_ref(), text.as_bytes())
    }
}

fn parse(bytes: &[u8]) -> Result<ToolsFile, String> {
    // Notepad may have saved it with a BOM.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let file: ToolsFile = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if file.version != VERSION {
        return Err(format!(
            "version {} is not one this Kaleido knows (it knows {VERSION})",
            file.version
        ));
    }
    Ok(file)
}

/// Moves a file that cannot be used to `aside`, or copies it there where it cannot be moved.
fn keep_aside(path: &Path, aside: &Path, reason: &str) -> io::Result<()> {
    let kept = fs::rename(path, aside).or_else(|_| fs::copy(path, aside).map(|_| ()));
    match &kept {
        Ok(()) => tracing::warn!(
            "{} is not a tools file ({reason}); it is kept as {} and the tools start without it",
            path.display(),
            aside.display()
        ),
        Err(error) => tracing::error!(
            "{} is not a tools file ({reason}) and cannot be kept aside ({error}); the tools \
             start without it and it is not replaced",
            path.display()
        ),
    }
    kept
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn tools_json_round_trips_and_keeps_unknown_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(FILE);
        let example = json!({
            "version": 1,
            "tools": {
                "ytDlp": {
                    "version": "2026.08.19",
                    "sha256": "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a",
                    "channel": "nightly",
                    "installedAt": "2026-10-19T12:00:00Z",
                    "checkedAt": "2026-10-19T13:00:00Z",
                    "failures": 2,
                    "nextTry": "2026-10-19T13:05:00Z",
                    "vanished": 1
                },
                "deno": {
                    "sha256": "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238",
                    "installedAt": "2026-10-19T12:00:00Z",
                    "failures": 0,
                    "exeSha256": "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"
                }
            },
            "futureKey": [1, 2]
        });
        fs::write(&path, example.to_string()).unwrap();

        let file = ToolsFile::load(&path);

        assert_eq!(file.refused(), None);
        let yt = &file.tools[&ToolId::YtDlp];
        assert_eq!(yt.version.as_deref(), Some("2026.08.19"));
        assert_eq!(yt.channel, Some(Channel::Nightly));
        assert_eq!(yt.failures, 2);
        assert_eq!(yt.next_try.as_deref(), Some("2026-10-19T13:05:00Z"));
        assert_eq!(yt.vanished, 1);
        // yt-dlp's file is its asset; it has no checksum of its own.
        assert_eq!(
            yt.exe_sha256, None,
            "left out of the file while there is none"
        );
        assert_eq!(yt.file_sha256(ToolId::YtDlp), Some(&*yt.sha256));
        let deno = &file.tools[&ToolId::Deno];
        assert_eq!(deno.channel, None);
        assert_eq!(deno.checked_at, None);
        assert_eq!(deno.vanished, 0, "left out of the file while there is none");
        assert!(deno.is_installed());
        // Deno's file is what came out of the zip.
        assert_eq!(
            deno.file_sha256(ToolId::Deno),
            Some("66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a")
        );
        assert_eq!(ToolRecord::not_installed().file_sha256(ToolId::YtDlp), None);
        file.save(&path).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved, example);
        assert_eq!(names(tmp.path()), [FILE]);
    }

    #[test]
    fn a_broken_tools_json_is_kept_aside_and_an_unreadable_one_is_never_replaced() {
        for broken in [
            "{nope",
            "[]",
            r#"{ "version": 2 }"#,
            r#"{ "tools": { "ffmpeg": {} } }"#,
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join(FILE);
            fs::write(&path, broken).unwrap();
            let file = ToolsFile::load(&path);
            assert_eq!(file, ToolsFile::default(), "{broken}");
            assert!(!path.exists(), "{broken}");
            let names = names(tmp.path());
            assert_eq!(names.len(), 1);
            assert!(names[0].starts_with("tools.json.bad-"), "{names:?}");
            file.save(&path).unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(FILE);
        // A folder in the place of the file cannot be read.
        fs::create_dir(&path).unwrap();
        let file = ToolsFile::load(&path);
        assert!(file.refused().is_some());
        fs::remove_dir(&path).unwrap();
        assert!(file.save(&path).is_err());
        assert!(names(tmp.path()).is_empty());
        // Read only, as the bundled one is: never moved, never an error.
        fs::write(&path, "{nope").unwrap();
        assert_eq!(ToolsFile::read(&path), None);
        assert_eq!(names(tmp.path()), [FILE]);
        assert_eq!(ToolsFile::read(tmp.path().join("missing.json")), None);
    }

    #[test]
    fn times_are_rfc_3339_utc_to_the_second() {
        let at = OffsetDateTime::from_unix_timestamp_nanos(1_792_411_200_987_654_321).unwrap();
        assert_eq!(stamp(at), "2026-10-19T12:00:00Z");
        let elsewhere = at.to_offset(time::UtcOffset::from_hms(2, 0, 0).unwrap());
        assert_eq!(stamp(elsewhere), "2026-10-19T12:00:00Z");
        assert_eq!(
            parse_time("2026-10-19T12:00:00Z"),
            Some(at.replace_nanosecond(0).unwrap())
        );
        assert_eq!(parse_time("yesterday"), None);
    }
}
