//! What yt-dlp says about a link (spec 8.5 point 2, plan decision 11): `yt-dlp -J` runs beside the
//! playback, and the formats it lists are what the UI makes its list of qualities from.
//!
//! The rules of reading the answer are the downloader's (`src/lib/ytdlp.ts` of The Downloader, MIT,
//! Copyright (c) 2021 Raycast, Copyright (c) 2026 Vojtěch Stehlík; plan decision 9): noise before
//! the JSON is skipped (`extractDumpJson`). What is live is narrower than its `isLiveStream`
//! (anything but `null` or `not_live`), because here it is about playing: a link is live while
//! there is no recording to play from its start, that is while `live_status` is `is_live`,
//! `is_upcoming` or `post_live`. `post_live` (the stream has ended and its recording is not
//! processed yet) counts as live: yt-dlp still takes its formats from the live stream's manifests,
//! which hold a window of the last hours and no final duration, and it becomes `was_live` once the
//! recording is there. `was_live` is that recording, a video like any other with a duration and a
//! position to come back to, so it is not live. A link that yt-dlp answers with a playlist (or a
//! `multi_video`, several videos under one link) is not one video.

use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use super::run::{RunError, run};

/// How long `yt-dlp -J` may take.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// The most its answer may be: a long video lists hundreds of formats, a few MB of JSON.
pub const PROBE_LIMIT: usize = 32 * 1024 * 1024;

/// A link as yt-dlp sees it, for the UI (camelCase).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub title: Option<String>,
    /// Seconds; `None` for a live stream and where the site does not say.
    pub duration: Option<f64>,
    /// A live stream, one to come, or one that has ended and has no recording yet (see the
    /// module); a recording of a past stream is not live.
    pub live: bool,
    /// In yt-dlp's order, the worst first. Empty where yt-dlp lists none.
    pub formats: Vec<StreamFormat>,
}

/// One format of a link, with what the list of qualities needs (spec 8.5).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFormat {
    /// What `ytdl-format` names it by.
    pub format_id: String,
    pub ext: String,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub fps: Option<f64>,
    /// The video codec ([`codec`]'s contract: `None` for none, `Some("")` for one not known):
    /// `None` is an audio-only format.
    pub vcodec: Option<String>,
    /// The audio codec, the same way: `None` is a video-only format.
    pub acodec: Option<String>,
    /// `SDR`, `HDR10`, `HLG`, ...
    pub dynamic_range: Option<String>,
    /// Kbit/s.
    pub tbr: Option<f64>,
    /// Bytes.
    pub filesize: Option<u64>,
    /// Bytes, yt-dlp's estimate where it does not know the size.
    pub filesize_approx: Option<u64>,
    /// `https`, `m3u8_native`, `http_dash_segments`, ...
    pub protocol: Option<String>,
}

/// Why there is no [`StreamInfo`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    /// yt-dlp is not there (yet).
    Missing,
    /// yt-dlp failed; the end of what it wrote to stderr, with its `ERROR:` lines.
    Failed { stderr: String },
    /// yt-dlp took longer than [`PROBE_TIMEOUT`].
    Timeout,
    /// The link is a playlist (or several videos, `multi_video`), not a video.
    Playlist,
    /// yt-dlp's answer is not the JSON of a video.
    BadJson(String),
}

impl fmt::Display for ProbeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProbeError::Missing => f.write_str("yt-dlp is not there"),
            ProbeError::Failed { stderr } => write!(f, "yt-dlp failed: {}", stderr.trim()),
            ProbeError::Timeout => f.write_str("yt-dlp took too long"),
            ProbeError::Playlist => f.write_str("the link is a playlist"),
            ProbeError::BadJson(reason) => write!(f, "yt-dlp's answer cannot be read: {reason}"),
        }
    }
}

impl std::error::Error for ProbeError {}

/// The arguments of `yt-dlp -J` for `url`: one video (never the playlist around it), no warnings
/// in the way, Deno for YouTube's challenges and the cookies of a browser when there are any, and
/// the link after `--`, so that a link that starts with `-` is never read as an option.
pub fn probe_args(url: &str, deno: Option<&Path>, cookies: Option<&str>) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-J", "--no-playlist", "--no-warnings"]
        .into_iter()
        .map(OsString::from)
        .collect();
    if let Some(deno) = deno {
        args.push("--js-runtimes".into());
        // `RUNTIME[:PATH]`, split at the first `:`, so a path with a drive letter is fine.
        let mut runtime = OsString::from("deno:");
        runtime.push(deno.as_os_str());
        args.push(runtime);
    }
    if let Some(cookies) = cookies {
        args.push("--cookies-from-browser".into());
        args.push(cookies.into());
    }
    args.push("--".into());
    args.push(url.into());
    args
}

/// Runs `yt-dlp -J` ([`probe_args`]) with the managed yt-dlp at `exe` (`None` while it is not
/// there): at most [`PROBE_TIMEOUT`] and [`PROBE_LIMIT`]. Blocks for as long as yt-dlp takes: not
/// for the main thread.
pub fn probe(
    exe: Option<&Path>,
    deno: Option<&Path>,
    cookies: Option<&str>,
    url: &str,
) -> Result<StreamInfo, ProbeError> {
    let exe = exe.ok_or(ProbeError::Missing)?;
    let output = run(
        exe,
        &probe_args(url, deno, cookies),
        PROBE_TIMEOUT,
        PROBE_LIMIT,
    )
    .map_err(|error| match error {
        // It went in the meantime (a virus scanner, the user).
        RunError::Spawn(_) if !exe.is_file() => ProbeError::Missing,
        RunError::Spawn(message) => ProbeError::Failed { stderr: message },
        RunError::Timeout => ProbeError::Timeout,
        RunError::TooLarge => ProbeError::BadJson(format!(
            "it is larger than {} MiB",
            PROBE_LIMIT / (1024 * 1024)
        )),
        RunError::Exit { stderr, .. } => ProbeError::Failed { stderr },
    })?;
    parse_info(&String::from_utf8_lossy(&output.stdout))
}

/// Reads what `yt-dlp -J` wrote (see the module): the JSON starts at the first line that starts
/// with `{` (after spaces); a `_type` of `playlist` or `multi_video` is [`ProbeError::Playlist`];
/// no `formats` is an empty list. A field of an unexpected type is as good as missing, and a format
/// without a `format_id` (which nothing could select) is left out.
pub fn parse_info(stdout: &str) -> Result<StreamInfo, ProbeError> {
    let start = json_start(stdout)
        .ok_or_else(|| ProbeError::BadJson("there is no JSON in it".to_owned()))?;
    // Only the first value: what may follow it is noise like what came before.
    let value = serde_json::Deserializer::from_str(&stdout[start..])
        .into_iter::<Value>()
        .next()
        .ok_or_else(|| ProbeError::BadJson("there is no JSON in it".to_owned()))?
        .map_err(|error| ProbeError::BadJson(error.to_string()))?;
    let Value::Object(info) = value else {
        return Err(ProbeError::BadJson("it is not a JSON object".to_owned()));
    };
    if matches!(
        info.get("_type").and_then(Value::as_str),
        Some("playlist" | "multi_video")
    ) {
        return Err(ProbeError::Playlist);
    }
    let formats = info
        .get("formats")
        .and_then(Value::as_array)
        .map(|formats| {
            formats
                .iter()
                .filter_map(Value::as_object)
                .filter_map(format_of)
                .collect()
        })
        .unwrap_or_default();
    Ok(StreamInfo {
        title: text(&info, "title"),
        duration: number(&info, "duration"),
        live: is_live(&info),
        formats,
    })
}

/// Where the JSON starts: the first line whose first character that is not a space is `{`.
fn json_start(stdout: &str) -> Option<usize> {
    let mut at = 0;
    for line in stdout.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('{') {
            return Some(at + line.len() - trimmed.len());
        }
        at += line.len();
    }
    None
}

/// Whether the link plays as a live one (see the module): `live_status` is `is_live`,
/// `is_upcoming` or `post_live`. `not_live`, `was_live`, `null`, no `live_status` at all and one
/// this Kaleido does not know are a video to play from its start.
fn is_live(info: &Map<String, Value>) -> bool {
    matches!(
        info.get("live_status").and_then(Value::as_str),
        Some("is_live" | "is_upcoming" | "post_live")
    )
}

fn format_of(format: &Map<String, Value>) -> Option<StreamFormat> {
    Some(StreamFormat {
        format_id: text(format, "format_id").filter(|id| !id.is_empty())?,
        ext: text(format, "ext").unwrap_or_default(),
        height: whole(format, "height").and_then(|height| u32::try_from(height).ok()),
        width: whole(format, "width").and_then(|width| u32::try_from(width).ok()),
        fps: number(format, "fps"),
        vcodec: codec(format, "vcodec"),
        acodec: codec(format, "acodec"),
        dynamic_range: text(format, "dynamic_range"),
        tbr: number(format, "tbr"),
        filesize: whole(format, "filesize"),
        filesize_approx: whole(format, "filesize_approx"),
        protocol: text(format, "protocol"),
    })
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// A codec as the UI gets it (final review minor 2; `src/streams/formats.ts` reads it):
/// - `None` where yt-dlp says `none`: the format has no such stream;
/// - `Some("")` where yt-dlp does not know it (`null`, no key, an empty or a non-text value): a
///   plain HLS format whose playlist has no `CODECS` attribute, which may well have the stream;
/// - the codec where yt-dlp names one.
fn codec(object: &Map<String, Value>, key: &str) -> Option<String> {
    match object.get(key).and_then(Value::as_str) {
        Some("none") => None,
        Some(codec) => Some(codec.to_owned()),
        None => Some(String::new()),
    }
}

fn number(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// A count that is not negative; yt-dlp writes some as floats (`filesize_approx` of a few
/// extractors).
fn whole(object: &Map<String, Value>, key: &str) -> Option<u64> {
    let value = object.get(key)?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= 0.0)
            // Saturates at u64::MAX, which no real size reaches.
            .map(|number| number.round() as u64)
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn probe_args_carry_deno_and_cookies_only_when_set() {
        let url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
        let deno = PathBuf::from(r"C:\Users\Jiří Novák\AppData\Local\Kaleido\tools\deno.exe");

        assert_eq!(
            strings(&probe_args(url, None, None)),
            ["-J", "--no-playlist", "--no-warnings", "--", url]
        );
        assert_eq!(
            strings(&probe_args(url, Some(&deno), None)),
            [
                "-J",
                "--no-playlist",
                "--no-warnings",
                "--js-runtimes",
                r"deno:C:\Users\Jiří Novák\AppData\Local\Kaleido\tools\deno.exe",
                "--",
                url
            ]
        );
        assert_eq!(
            strings(&probe_args(url, None, Some("firefox"))),
            [
                "-J",
                "--no-playlist",
                "--no-warnings",
                "--cookies-from-browser",
                "firefox",
                "--",
                url
            ]
        );
        assert_eq!(
            strings(&probe_args(url, Some(&deno), Some("chrome:Profile 1"))),
            [
                "-J",
                "--no-playlist",
                "--no-warnings",
                "--js-runtimes",
                r"deno:C:\Users\Jiří Novák\AppData\Local\Kaleido\tools\deno.exe",
                "--cookies-from-browser",
                "chrome:Profile 1",
                "--",
                url
            ]
        );
    }

    #[test]
    fn the_url_comes_after_a_double_dash() {
        for url in ["-x", "--exec=calc.exe", "--", "https://example.com/v"] {
            let args = strings(&probe_args(url, None, Some("--exec")));
            let dash = args.iter().position(|arg| arg == "--").unwrap();
            // The first `--` is the end of the options, and only the link follows it.
            assert_eq!(&args[dash + 1..], [url], "{args:?}");
            assert_eq!(dash, args.len() - 2, "{args:?}");
            // An option's value stays the value of its option.
            let cookies = args
                .iter()
                .position(|arg| arg == "--cookies-from-browser")
                .unwrap();
            assert_eq!(args[cookies + 1], "--exec");
        }
    }

    /// The cases of the downloader's `extractDumpJson` tests.
    #[test]
    fn info_skips_noise_before_the_json() {
        let json = json!({ "title": "Hello", "duration": 42, "formats": [] }).to_string();
        let hello = |stdout: &str| parse_info(stdout).unwrap().title;

        assert_eq!(hello(&json).as_deref(), Some("Hello"));
        assert_eq!(
            hello(&format!(
                "[debug] 2026-05-21 12:00:00 loading plugin\n{json}"
            ))
            .as_deref(),
            Some("Hello")
        );
        assert_eq!(
            hello(&format!(
                "[youtube] WARNING: Falling back to web client\n{json}"
            ))
            .as_deref(),
            Some("Hello")
        );
        assert_eq!(
            hello(&format!(
                "[debug] foo\r\n[warning] bar\r\n[info] baz\r\n{json}\r\n"
            ))
            .as_deref(),
            Some("Hello")
        );
        let pretty = serde_json::to_string_pretty(
            &json!({ "title": "Hello", "formats": [{ "format_id": "18", "ext": "mp4" }] }),
        )
        .unwrap();
        let info = parse_info(&format!("[debug] header\n{pretty}")).unwrap();
        assert_eq!(info.title.as_deref(), Some("Hello"));
        assert_eq!(info.formats.len(), 1);
        assert_eq!(hello(&format!("   {json}")).as_deref(), Some("Hello"));
        // Noise after the JSON as well.
        assert_eq!(
            hello(&format!("{json}\n[debug] done\n")).as_deref(),
            Some("Hello")
        );

        let info = parse_info(&json).unwrap();
        assert_eq!(info.duration, Some(42.0));
        assert!(!info.live);
        assert!(info.formats.is_empty());

        for stdout in [
            "",
            "[error] Sign in to confirm you're not a bot",
            "[debug] {not json\n",
        ] {
            assert!(
                matches!(parse_info(stdout), Err(ProbeError::BadJson(_))),
                "{stdout:?}"
            );
        }
        assert!(matches!(
            parse_info("{\"title\": \"cut in the mid"),
            Err(ProbeError::BadJson(_))
        ));
    }

    /// The cases of the downloader's `isLiveStream` tests, and the other states yt-dlp knows:
    /// live is a stream with no recording to play from its start (see the module), so a recording
    /// of a past stream (`was_live`) is a video, unlike in the downloader.
    #[test]
    fn live_status_decides_live() {
        let live = |status: Value| {
            let mut info = json!({ "title": "t", "duration": 1, "formats": [] });
            info["live_status"] = status;
            parse_info(&info.to_string()).unwrap().live
        };
        for status in ["is_live", "is_upcoming", "post_live"] {
            assert!(live(json!(status)), "{status}");
        }
        for status in [
            json!("not_live"),
            json!("was_live"),
            json!(null),
            json!("some_future_state"),
            json!(true),
        ] {
            assert!(!live(status.clone()), "{status}");
        }
        // No `live_status` at all.
        let info = parse_info(&json!({ "title": "t", "formats": [] }).to_string()).unwrap();
        assert!(!info.live);
        assert_eq!(info.duration, None);
    }

    #[test]
    fn a_playlist_is_not_a_video() {
        let playlist = json!({
            "_type": "playlist",
            "title": "Mix",
            "entries": [{ "_type": "url", "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ" }]
        });
        assert_eq!(parse_info(&playlist.to_string()), Err(ProbeError::Playlist));
        // Several videos under one link (a post with two clips) are no one video either.
        let several = json!({
            "_type": "multi_video",
            "title": "Two clips",
            "entries": [{ "title": "One" }, { "title": "Two" }]
        });
        assert_eq!(parse_info(&several.to_string()), Err(ProbeError::Playlist));
        // One video is `_type: video`, or has no `_type`.
        let video = json!({ "_type": "video", "title": "One" });
        assert_eq!(
            parse_info(&video.to_string()).unwrap().title.as_deref(),
            Some("One")
        );
        assert!(matches!(parse_info("[1, 2]"), Err(ProbeError::BadJson(_))));
    }

    #[test]
    fn formats_keep_what_the_quality_list_needs() {
        let info = json!({
            "title": "Big Buck Bunny",
            "duration": 634.5,
            "live_status": "not_live",
            "formats": [
                {
                    "format_id": "251", "ext": "webm", "vcodec": "none", "acodec": "opus",
                    "tbr": 129.483, "filesize": 10_283_475, "protocol": "https",
                    "height": null, "width": null, "fps": null, "dynamic_range": null
                },
                {
                    "format_id": "313", "ext": "webm", "vcodec": "vp9", "acodec": "none",
                    "height": 2160, "width": 3840, "fps": 60, "dynamic_range": "SDR",
                    "tbr": 17_500.2, "filesize_approx": 1_388_000_000.0, "protocol": "https"
                },
                {
                    "format_id": "337", "ext": "webm", "vcodec": "vp09.02.51.10.01.09.16.09.00",
                    "acodec": "none", "height": 2160, "width": 3840, "fps": 59.94,
                    "dynamic_range": "HDR10", "filesize_approx": 1_903_000_123_u64,
                    "protocol": "http_dash_segments"
                },
                // What nothing could select, and what is not a format at all.
                { "ext": "mp4", "height": 720 },
                "garbage",
                // Fields of the wrong type are as good as missing.
                { "format_id": "sb0", "ext": "mhtml", "height": "tall", "fps": "fast", "vcodec": 7 }
            ]
        });

        let info = parse_info(&info.to_string()).unwrap();

        assert_eq!(info.title.as_deref(), Some("Big Buck Bunny"));
        assert_eq!(info.duration, Some(634.5));
        assert!(!info.live);
        let ids: Vec<&str> = info.formats.iter().map(|f| f.format_id.as_str()).collect();
        assert_eq!(ids, ["251", "313", "337", "sb0"]);
        let audio = &info.formats[0];
        assert_eq!(audio.vcodec, None, "\"none\" is no video");
        assert_eq!(audio.acodec.as_deref(), Some("opus"));
        assert_eq!((audio.height, audio.width, audio.fps), (None, None, None));
        assert_eq!(audio.filesize, Some(10_283_475));
        assert_eq!(audio.tbr, Some(129.483));
        assert_eq!(
            info.formats[1],
            StreamFormat {
                format_id: "313".to_owned(),
                ext: "webm".to_owned(),
                height: Some(2160),
                width: Some(3840),
                fps: Some(60.0),
                vcodec: Some("vp9".to_owned()),
                acodec: None,
                dynamic_range: Some("SDR".to_owned()),
                tbr: Some(17_500.2),
                filesize: None,
                filesize_approx: Some(1_388_000_000),
                protocol: Some("https".to_owned()),
            }
        );
        let hdr = &info.formats[2];
        assert_eq!(hdr.dynamic_range.as_deref(), Some("HDR10"));
        assert_eq!(hdr.fps, Some(59.94));
        assert_eq!(hdr.filesize_approx, Some(1_903_000_123));
        assert_eq!(hdr.protocol.as_deref(), Some("http_dash_segments"));
        // Fields of the wrong type are as good as missing: a codec then is one that is not known.
        let odd = &info.formats[3];
        assert_eq!((odd.height, odd.fps), (None, None));
        assert_eq!(odd.vcodec.as_deref(), Some(""));

        // What the UI gets: camelCase.
        assert_eq!(
            serde_json::to_value(&info.formats[2]).unwrap(),
            json!({
                "formatId": "337", "ext": "webm", "height": 2160, "width": 3840, "fps": 59.94,
                "vcodec": "vp09.02.51.10.01.09.16.09.00", "acodec": null,
                "dynamicRange": "HDR10", "tbr": null, "filesize": null,
                "filesizeApprox": 1_903_000_123_u64, "protocol": "http_dash_segments"
            })
        );
        assert_eq!(
            serde_json::to_value(&info).unwrap()["formats"][0]["formatId"],
            "251"
        );
    }

    /// Final review minor 2: yt-dlp's `null` codec (it does not know it: a plain HLS playlist
    /// without `CODECS`) is not its `none` (no such stream). The UI gets `""` for the first and
    /// `null` for the second, and counts a format with a height and an unknown codec as video.
    #[test]
    fn an_unknown_codec_is_not_no_stream() {
        let info = json!({
            "title": "A plain HLS stream",
            "formats": [
                {
                    "format_id": "hls-audio", "ext": "mp4", "protocol": "m3u8_native",
                    "vcodec": "none", "acodec": "mp4a.40.2"
                },
                {
                    "format_id": "hls-2128", "ext": "mp4", "protocol": "m3u8_native",
                    "height": 720, "width": 1280, "tbr": 2128.0, "vcodec": null, "acodec": null
                },
                // No codec keys at all, and an empty one: not known either.
                { "format_id": "hls-4400", "ext": "mp4", "height": 1080, "width": 1920 },
                { "format_id": "hls-x", "ext": "mp4", "vcodec": "", "acodec": "none" }
            ]
        });

        let info = parse_info(&info.to_string()).unwrap();

        let codecs: Vec<(Option<&str>, Option<&str>)> = info
            .formats
            .iter()
            .map(|format| (format.vcodec.as_deref(), format.acodec.as_deref()))
            .collect();
        assert_eq!(
            codecs,
            [
                (None, Some("mp4a.40.2")),
                (Some(""), Some("")),
                (Some(""), Some("")),
                (Some(""), None),
            ]
        );
        assert_eq!(info.formats[1].height, Some(720));
        let value = serde_json::to_value(&info.formats[1]).unwrap();
        assert_eq!(
            (&value["vcodec"], &value["acodec"]),
            (&json!(""), &json!(""))
        );
        let value = serde_json::to_value(&info.formats[0]).unwrap();
        assert_eq!(value["vcodec"], Value::Null);
    }

    #[test]
    fn a_missing_yt_dlp_is_missing() {
        assert_eq!(
            probe(None, None, None, "https://example.com/v"),
            Err(ProbeError::Missing)
        );
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            probe(
                Some(&tmp.path().join("yt-dlp.exe")),
                None,
                None,
                "https://example.com/v"
            ),
            Err(ProbeError::Missing)
        );
    }
}
