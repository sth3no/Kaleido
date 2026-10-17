//! The open dialog for media and for subtitles. It never blocks the thread that asks for it:
//! the dialog plugin shows it from the main thread without waiting and answers on its own
//! thread.

use std::path::PathBuf;
use std::time::Instant;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

use super::drop::sources_from_paths;
use super::open_queue::OpenRequest;
use crate::player::Engine;
use crate::player::load::Source;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DialogPurpose {
    /// Files to play, opened by the open-while-playing setting.
    Media,
    /// A subtitle file for what is playing.
    Subtitle,
}

/// The groups of spec 8.12, as far as mpv plays them.
pub const VIDEO: &[&str] = &[
    "3g2", "3gp", "3gp2", "3gpp", "amv", "asf", "av1", "avi", "divx", "f4v", "flv", "h264", "h265",
    "hevc", "m1v", "m2t", "m2ts", "m2v", "m4v", "mkv", "mov", "mp2v", "mp4", "mp4v", "mpe", "mpeg",
    "mpg", "mpv", "mts", "mxf", "ogm", "ogv", "qt", "rm", "rmvb", "ts", "vob", "webm", "wmv",
    "wtv", "y4m",
];
pub const AUDIO: &[&str] = &[
    "aac", "ac3", "aif", "aiff", "amr", "ape", "au", "caf", "dts", "eac3", "flac", "m4a", "m4b",
    "mka", "mp2", "mp3", "mpc", "oga", "ogg", "opus", "tta", "wav", "weba", "wma", "wv",
];
pub const PLAYLISTS: &[&str] = &["m3u", "m3u8", "pls"];
pub const SUBTITLES: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "sup", "idx"];

/// The filter names in the dialog, which Windows shows next to the patterns.
struct Labels {
    media: &'static str,
    all_files: &'static str,
    subtitles: &'static str,
}

const CS: Labels = Labels {
    media: "Video, zvuk a playlisty",
    all_files: "Všechny soubory",
    subtitles: "Titulky",
};

const EN: Labels = Labels {
    media: "Video, audio and playlists",
    all_files: "All files",
    subtitles: "Subtitles",
};

/// Czech on a Czech Windows, English otherwise (spec 8.8). The dialog's own texts come from
/// Windows in its language.
fn labels() -> &'static Labels {
    const LANG_CZECH: u16 = 0x05;
    // SAFETY: no arguments; reads the user's display language.
    let language = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    // The primary language is the low 10 bits of a LANGID.
    if language & 0x3ff == LANG_CZECH {
        &CS
    } else {
        &EN
    }
}

/// Shows the dialog for `purpose` over the main window and returns at once.
pub fn open(app: &AppHandle, purpose: DialogPurpose) {
    let labels = labels();
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let app = app.clone();
    match purpose {
        DialogPurpose::Media => {
            let media = [VIDEO, AUDIO, PLAYLISTS].concat();
            dialog
                .add_filter(labels.media, &media)
                .add_filter(labels.all_files, &["*"])
                .pick_files(move |picked| {
                    let sources = sources_from_paths(paths(picked.unwrap_or_default()));
                    let request = OpenRequest {
                        sources,
                        ..OpenRequest::default()
                    };
                    super::open(&app, Instant::now(), request);
                });
        }
        DialogPurpose::Subtitle => {
            dialog
                .add_filter(labels.subtitles, SUBTITLES)
                .pick_file(move |picked| {
                    let picked = sources_from_paths(paths(picked.into_iter().collect()));
                    if let (Some(subtitle @ Source::File(_)), Some(engine)) =
                        (picked.first(), app.try_state::<Engine>())
                    {
                        engine.command(&["sub-add", &subtitle.to_mpv(), "select"]);
                    }
                });
        }
    }
}

/// The local paths among what the dialog returned.
fn paths(picked: Vec<FilePath>) -> Vec<PathBuf> {
    picked
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect()
}
