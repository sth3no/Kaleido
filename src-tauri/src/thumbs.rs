//! Timeline previews (spec 4.1, plan decision 4). thumbfast renders them in a `kaleido-mpv`
//! process and reports each one with `thumbfast-render`: a JSON that says where in the temp
//! folder the raw BGRA image is. Rust checks that message (any script can send it), keeps the
//! latest preview and tells the UI, which fetches it as RGBA.
//!
//! Nothing here waits for mpv: asking for a preview only queues a request on the engine, and the
//! UI reads what is already stored.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::player::{Engine, Request};

/// Largest thumbnail side we accept from thumbfast.
pub const MAX_SIDE: u32 = 1024;

/// The event that tells the UI a new preview can be fetched.
pub const READY_EVENT: &str = "player:thumb";

/// Bytes in front of the pixels `thumb_get` returns: the width and the height, each a
/// little-endian `u32`.
pub const HEADER_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbError {
    Json,
    Size,
    Path,
    Read,
    Length,
}

/// The fields of thumbfast's `thumbfast-render` JSON we use.
#[derive(Debug, Deserialize)]
pub struct RenderInfo {
    pub width: u32,
    pub height: u32,
    pub thumbnail: String,
}

pub struct Thumb {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Thumb {
    /// What `thumb_get` returns: [`HEADER_LEN`] bytes with the width and the height, then the
    /// RGBA pixels.
    pub fn frame(&self) -> Vec<u8> {
        let mut frame = Vec::with_capacity(HEADER_LEN + self.rgba.len());
        frame.extend_from_slice(&self.width.to_le_bytes());
        frame.extend_from_slice(&self.height.to_le_bytes());
        frame.extend_from_slice(&self.rgba);
        frame
    }
}

/// The folder thumbfast writes its images to. Its Lua reads `TEMP` (`thumbfast.lua:256`), while
/// `std::env::temp_dir()` prefers `TMP`; where the two differ, the images would be refused as
/// coming from outside the temp folder.
pub fn thumbfast_temp_dir() -> PathBuf {
    temp_dir_from(|name| std::env::var_os(name))
}

fn temp_dir_from(var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    var("TEMP").map_or_else(std::env::temp_dir, PathBuf::from)
}

/// Checks a `thumbfast-render` payload; returns the `.bgra` file to read.
/// Any script can send this message, so the path must be thumbfast's own temp file.
pub fn validate(json: &str, temp_dir: &Path) -> Result<(RenderInfo, PathBuf), ThumbError> {
    let info: RenderInfo = serde_json::from_str(json).map_err(|_| ThumbError::Json)?;
    if info.width == 0 || info.height == 0 || info.width > MAX_SIDE || info.height > MAX_SIDE {
        return Err(ThumbError::Size);
    }
    let file = PathBuf::from(format!("{}.bgra", info.thumbnail));
    let named_like_thumbfast = file
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("thumbfast"));
    let in_temp = file.parent().is_some_and(|dir| same_dir(dir, temp_dir));
    if !named_like_thumbfast || !in_temp {
        return Err(ThumbError::Path);
    }
    Ok((info, file))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// Bytes of a `width` × `height` image with four bytes a pixel.
fn pixel_bytes(width: u32, height: u32) -> usize {
    width as usize * height as usize * 4
}

pub fn bgra_to_rgba(mut data: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, ThumbError> {
    if data.len() != pixel_bytes(width, height) {
        return Err(ThumbError::Length);
    }
    for px in data.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        px[3] = 255;
    }
    Ok(data)
}

/// Validates the message and reads the image it names. The file's size is checked before a byte
/// of it is read: the sides are at most [`MAX_SIDE`], so what is read is at most 4 MiB, whatever
/// the file is.
pub fn load(json: &str, temp_dir: &Path) -> Result<Thumb, ThumbError> {
    let (info, file) = validate(json, temp_dir)?;
    let expected = pixel_bytes(info.width, info.height);
    let size = std::fs::metadata(&file)
        .map_err(|_| ThumbError::Read)?
        .len();
    if size != expected as u64 {
        return Err(ThumbError::Size);
    }
    // Bounded again: a file that grew since the check is cut off and then refused by the
    // conversion, which counts the bytes.
    let mut data = Vec::with_capacity(expected);
    std::fs::File::open(&file)
        .and_then(|image| image.take(expected as u64 + 1).read_to_end(&mut data))
        .map_err(|_| ThumbError::Read)?;
    let rgba = bgra_to_rgba(data, info.width, info.height)?;
    Ok(Thumb {
        width: info.width,
        height: info.height,
        rgba,
    })
}

/// The payload of `player:thumb`: a new preview is stored. `seq` counts the previews, so the UI
/// can tell a new one from the one it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ThumbReady {
    pub width: u32,
    pub height: u32,
    pub seq: u64,
}

/// The latest preview and how many have been stored. Managed by Tauri; the mpv event thread
/// stores, the UI's `thumb_get` reads.
#[derive(Default)]
pub struct ThumbStore {
    latest: Mutex<Latest>,
}

#[derive(Default)]
struct Latest {
    seq: u64,
    /// [`Thumb::frame`] of the latest preview; empty before the first.
    frame: Vec<u8>,
}

impl ThumbStore {
    /// Loads the image a `thumbfast-render` message names and keeps it as the latest preview.
    /// A message that is refused changes nothing, and is not counted.
    pub fn accept(&self, json: &str, temp_dir: &Path) -> Result<ThumbReady, ThumbError> {
        // The file is read before the lock is taken: `thumb_get` does not wait for the disk.
        let thumb = load(json, temp_dir)?;
        let mut latest = self.lock();
        latest.seq += 1;
        latest.frame = thumb.frame();
        Ok(ThumbReady {
            width: thumb.width,
            height: thumb.height,
            seq: latest.seq,
        })
    }

    /// The latest preview as [`Thumb::frame`] has it; empty when none has been stored yet.
    pub fn latest(&self) -> Vec<u8> {
        self.lock().frame.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Latest> {
        self.latest.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A `thumbfast-render` message arrived (on the mpv event thread): stores the preview and tells
/// the UI. A message that does not check out is logged and dropped.
pub fn rendered(app: &AppHandle, json: &str) {
    let Some(store) = app.try_state::<ThumbStore>() else {
        tracing::warn!("a preview is dropped: the store is not set up");
        return;
    };
    match store.accept(json, &thumbfast_temp_dir()) {
        Ok(ready) => {
            if let Err(error) = app.emit(READY_EVENT, ready) {
                tracing::warn!("cannot send {READY_EVENT} to the UI: {error}");
            }
        }
        Err(error) => tracing::warn!("a preview is refused ({error:?}): {json:.300}"),
    }
}

/// `seconds` as thumbfast reads it: three decimals, never negative. `None` for a time that is
/// not a finite number.
fn format_time(seconds: f64) -> Option<String> {
    if !seconds.is_finite() {
        return None;
    }
    // Not `max(0.0)`: that can leave a negative zero, which would be written as "-0.000".
    let seconds = if seconds > 0.0 { seconds } else { 0.0 };
    Some(format!("{seconds:.3}"))
}

/// Asks thumbfast for the preview at `seconds`; it arrives as `player:thumb`. Only queues the
/// request, so it is safe on the main thread.
pub fn request(engine: &Engine, seconds: f64) {
    let Some(time) = format_time(seconds) else {
        tracing::warn!("no preview for the time {seconds}");
        return;
    };
    // Empty x and y plus the name of this client: thumbfast then sends `thumbfast-render` to
    // it instead of drawing an overlay in mpv. The name comes from the mpv handle, which only
    // the request thread has.
    engine.request(Request::Call(Box::new(move |mpv| {
        let client = mpv.client_name();
        if let Err(error) = mpv.command(&[
            "script-message-to",
            "thumbfast",
            "thumb",
            &time,
            "",
            "",
            &client,
        ]) {
            tracing::warn!("cannot ask thumbfast for a preview: {error}");
        }
    })));
}

/// The UI no longer shows a preview: thumbfast stops rendering for it. The stored preview stays;
/// the UI only reads it after the next `player:thumb`.
pub fn clear(engine: &Engine) {
    engine.command(&["script-message-to", "thumbfast", "clear"]);
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::thread;
    use std::time::{Duration, Instant};

    use mpv_ffi::Event;
    use serde_json::{Value, json};

    use super::*;
    use crate::player::options;
    use crate::player::testing::{Recorded, headless, temp_paths};

    fn payload(width: u32, height: u32, thumbnail: &Path) -> String {
        format!(
            r#"{{"width":{width},"height":{height},"thumbnail":{}}}"#,
            serde_json::to_string(&thumbnail.display().to_string()).unwrap()
        )
    }

    #[test]
    fn accepts_thumbfasts_own_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let (info, file) = validate(
            &payload(200, 112, &dir.path().join("thumbfast.out1234")),
            dir.path(),
        )
        .unwrap();
        assert_eq!((info.width, info.height), (200, 112));
        assert!(file.ends_with("thumbfast.out1234.bgra"));
    }

    #[test]
    fn rejects_paths_outside_temp() {
        let dir = tempfile::tempdir().unwrap();
        let foreign = Path::new(r"C:\Windows\System32\thumbfast");
        assert_eq!(
            validate(&payload(10, 10, foreign), dir.path()).unwrap_err(),
            ThumbError::Path
        );
    }

    #[test]
    fn rejects_other_files_in_temp() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            validate(&payload(10, 10, &dir.path().join("secret")), dir.path()).unwrap_err(),
            ThumbError::Path
        );
    }

    #[test]
    fn rejects_bad_sizes_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("thumbfast.out1");
        assert_eq!(
            validate(&payload(0, 10, &file), dir.path()).unwrap_err(),
            ThumbError::Size
        );
        assert_eq!(
            validate(&payload(4096, 10, &file), dir.path()).unwrap_err(),
            ThumbError::Size
        );
        assert_eq!(
            validate("not json", dir.path()).unwrap_err(),
            ThumbError::Json
        );
    }

    #[test]
    fn converts_bgra_to_opaque_rgba() {
        assert_eq!(
            bgra_to_rgba(vec![1, 2, 3, 0, 4, 5, 6, 7], 2, 1),
            Ok(vec![3, 2, 1, 255, 6, 5, 4, 255])
        );
    }

    #[test]
    fn rejects_truncated_pixel_data() {
        assert_eq!(bgra_to_rgba(vec![0; 7], 2, 1), Err(ThumbError::Length));
    }

    #[test]
    fn loads_a_written_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("thumbfast.out9");
        std::fs::write(dir.path().join("thumbfast.out9.bgra"), [9, 8, 7, 6]).unwrap();
        let thumb = load(&payload(1, 1, &base), dir.path()).unwrap();
        assert_eq!(thumb.rgba, vec![7, 8, 9, 255]);
    }

    #[test]
    fn missing_file_is_a_read_error() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("thumbfast.out404");
        assert_eq!(
            load(&payload(1, 1, &base), dir.path()).err(),
            Some(ThumbError::Read)
        );
    }

    /// The conversion would call a file of the wrong size `Length`; `Size` is what the check
    /// before the read says, so the contents were not read.
    #[test]
    fn size_is_checked_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("thumbfast.out5");
        let file = dir.path().join("thumbfast.out5.bgra");

        // One byte more than a 1×1 image.
        fs::write(&file, [1, 2, 3, 4, 5]).unwrap();
        assert_eq!(
            load(&payload(1, 1, &base), dir.path()).err(),
            Some(ThumbError::Size)
        );
        // And one byte fewer.
        fs::write(&file, [1, 2, 3]).unwrap();
        assert_eq!(
            load(&payload(1, 1, &base), dir.path()).err(),
            Some(ThumbError::Size)
        );
        // Exactly right.
        fs::write(&file, [1, 2, 3, 4]).unwrap();
        assert!(load(&payload(1, 1, &base), dir.path()).is_ok());
    }

    #[test]
    fn temp_dir_is_the_one_thumbfast_uses() {
        // `std::env::temp_dir()` would pick TMP.
        let env = |name: &str| match name {
            "TEMP" => Some(OsString::from(r"C:\x")),
            "TMP" => Some(OsString::from(r"C:\y")),
            _ => None,
        };
        assert_eq!(temp_dir_from(env), PathBuf::from(r"C:\x"));
    }

    #[test]
    fn without_temp_the_systems_temp_dir_is_used() {
        assert_eq!(temp_dir_from(|_| None), std::env::temp_dir());
    }

    #[test]
    fn thumb_response_has_size_header() {
        let thumb = Thumb {
            width: 2,
            height: 1,
            rgba: vec![1, 2, 3, 255, 4, 5, 6, 255],
        };
        assert_eq!(
            thumb.frame(),
            [2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 255, 4, 5, 6, 255]
        );
        // Little-endian, whatever the size.
        let wide = Thumb {
            width: 0x0102,
            height: 0x0304,
            rgba: Vec::new(),
        };
        assert_eq!(wide.frame(), [2, 1, 0, 0, 4, 3, 0, 0]);
    }

    #[test]
    fn a_rendered_preview_is_stored_numbered_and_served_with_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let store = ThumbStore::default();
        assert!(store.latest().is_empty(), "nothing before the first");

        fs::write(
            dir.path().join("thumbfast.out1.bgra"),
            [1, 2, 3, 0, 4, 5, 6, 0],
        )
        .unwrap();
        let first = store
            .accept(
                &payload(2, 1, &dir.path().join("thumbfast.out1")),
                dir.path(),
            )
            .unwrap();
        assert_eq!(
            first,
            ThumbReady {
                width: 2,
                height: 1,
                seq: 1
            }
        );
        assert_eq!(
            store.latest(),
            [2, 0, 0, 0, 1, 0, 0, 0, 3, 2, 1, 255, 6, 5, 4, 255]
        );

        // thumbfast writes the next image over the same file.
        fs::write(dir.path().join("thumbfast.out1.bgra"), [7, 8, 9, 0]).unwrap();
        let second = store
            .accept(
                &payload(1, 1, &dir.path().join("thumbfast.out1")),
                dir.path(),
            )
            .unwrap();
        assert_eq!(
            second,
            ThumbReady {
                width: 1,
                height: 1,
                seq: 2
            }
        );
        assert_eq!(store.latest(), [1, 0, 0, 0, 1, 0, 0, 0, 9, 8, 7, 255]);
    }

    #[test]
    fn a_refused_preview_leaves_the_stored_one_and_the_count_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = ThumbStore::default();
        fs::write(dir.path().join("thumbfast.out2.bgra"), [1, 2, 3, 0]).unwrap();
        let good = payload(1, 1, &dir.path().join("thumbfast.out2"));
        store.accept(&good, dir.path()).unwrap();
        let stored = store.latest();

        // Another script's message: a file that is not thumbfast's, bad JSON, a wrong size.
        fs::write(dir.path().join("secret.bgra"), [0, 0, 0, 0]).unwrap();
        for (message, error) in [
            (payload(1, 1, &dir.path().join("secret")), ThumbError::Path),
            ("{".to_owned(), ThumbError::Json),
            (
                payload(2, 1, &dir.path().join("thumbfast.out2")),
                ThumbError::Size,
            ),
        ] {
            assert_eq!(store.accept(&message, dir.path()), Err(error), "{message}");
            assert_eq!(store.latest(), stored);
        }
        assert_eq!(store.accept(&good, dir.path()).unwrap().seq, 2);
    }

    /// The contract table's `player:thumb { width, height, seq }`.
    #[test]
    fn the_ready_event_carries_size_and_sequence() {
        let ready = ThumbReady {
            width: 200,
            height: 112,
            seq: 3,
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            json!({"width": 200, "height": 112, "seq": 3})
        );
        assert_eq!(READY_EVENT, "player:thumb");
    }

    #[test]
    fn times_are_sent_with_three_decimals_and_never_negative() {
        assert_eq!(format_time(12.3456).as_deref(), Some("12.346"));
        assert_eq!(format_time(0.0).as_deref(), Some("0.000"));
        assert_eq!(format_time(-5.0).as_deref(), Some("0.000"));
        assert_eq!(format_time(-0.0).as_deref(), Some("0.000"));
        assert_eq!(format_time(f64::NAN), None);
        assert_eq!(format_time(f64::INFINITY), None);
        assert_eq!(format_time(f64::NEG_INFINITY), None);
    }

    /// What thumbfast would send (`thumbfast-render`), or `None` for any other event.
    fn render_message(event: &Event) -> Option<String> {
        match event {
            Event::ClientMessage { args }
                if args.first().map(String::as_str) == Some("thumbfast-render") =>
            {
                args.get(1).cloned()
            }
            _ => None,
        }
    }

    /// Takes the place of thumbfast.lua and sends back what it received and what `script-opts`
    /// say, as the render message.
    const STAND_IN: &str = r#"local utils = require "mp.utils"
mp.register_script_message("thumb", function(time, x, y, client)
    mp.commandv("script-message-to", client, "thumbfast-render", utils.format_json({
        script = mp.get_script_name(),
        time = time, x = x, y = y, client = client,
        mpv_path = mp.get_opt("thumbfast-mpv_path"),
        network = mp.get_opt("thumbfast-network"),
        tone_mapping = mp.get_opt("thumbfast-tone_mapping"),
        other = mp.get_opt("other-key"),
    }))
end)
"#;

    /// Real libmpv: the script is loaded from the bundled path (`essentials\thumbfast\thumbfast.lua`
    /// in the resources folder) under the name `thumbfast`, gets Kaleido's script options on top
    /// of the user's, and a request makes it answer the client that asked, with the time and
    /// without a position. The installation folder has a comma in its name: `script-opts` is a
    /// list split at commas, so the helper's path must arrive whole.
    #[test]
    fn thumbfast_loads_with_kaleidos_options_and_answers_the_requesting_client() {
        let tmp = tempfile::Builder::new()
            .prefix("kaleido, thumbfast")
            .tempdir()
            .unwrap();
        let paths = temp_paths(tmp.path());
        let thumbfast = paths.resource_dir.join("essentials").join("thumbfast");
        fs::create_dir_all(&thumbfast).unwrap();
        fs::write(thumbfast.join("thumbfast.lua"), STAND_IN).unwrap();
        // The user's own script options stay; what they say about thumbfast's own does not.
        fs::write(
            paths.config_dir.join("mpv.conf"),
            "script-opts=other-key=kept,thumbfast-network=yes\n",
        )
        .unwrap();

        let events = Recorded::default();
        let engine = Engine::start(headless(paths.clone()), events.clone()).unwrap();
        options::load_thumbfast(&engine, &paths);
        let client = engine.call(|mpv| mpv.client_name());

        // The script may still be starting: ask until it answers.
        let deadline = Instant::now() + Duration::from_secs(5);
        let reply = loop {
            request(&engine, 12.3456);
            thread::sleep(Duration::from_millis(100));
            if let Some(reply) = events.events().iter().find_map(render_message) {
                break reply;
            }
            assert!(
                Instant::now() < deadline,
                "thumbfast never answered: {:#?}",
                events.events()
            );
        };

        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["script"], "thumbfast");
        assert_eq!(reply["time"], "12.346");
        assert_eq!(reply["x"], "");
        assert_eq!(reply["y"], "");
        assert_eq!(reply["client"], client.as_str());
        let helper = paths.exe_dir.join("kaleido-mpv.exe");
        assert_eq!(reply["mpv_path"], helper.to_string_lossy().into_owned());
        assert_eq!(reply["network"], "no");
        assert_eq!(reply["tone_mapping"], "mobius");
        assert_eq!(reply["other"], "kept");
    }
}
