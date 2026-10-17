//! Files dropped on the window (plan decision 8). The UI posts them to WebView2 with
//! `postMessageWithAdditionalObjects({ "type": "kaleido:drop" }, files)`; Rust reads their paths
//! here, so the UI never sees a path.
//!
//! The message is a JSON object, not a string, on purpose. wry's own handler for the same event
//! (the one that feeds Tauri's IPC) starts with `TryGetWebMessageAsString`, which fails for
//! anything but a string, and returns that error before Tauri sees the message. A string such as
//! `"kaleido:drop"` would reach Tauri's IPC, which cannot parse it and logs a `console.error` for
//! every drop. Here the message is read with `WebMessageAsJson`, which works for either kind.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Instant;

use anyhow::Context;
use serde_json::Value;
use tauri::{AppHandle, Manager, Webview};
use url::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR};

use super::open_queue::OpenRequest;
use crate::player::load::{Source, parse_source};

/// The `type` of the message the UI posts with the dropped files
/// (`tests/fixtures/drop/message.json`, which the UI's tests read too).
const DROP_TYPE: &str = "kaleido:drop";

/// Whether `json`, a web message as WebView2 hands it over (`WebMessageAsJson`), is the UI's drop
/// message, an object `{ "type": "kaleido:drop" }`. A string (what Tauri's IPC posts, and what
/// the first version of this message was), an array and any other object are not.
fn is_drop_message(json: &str) -> bool {
    // Indexing a value that is no object gives `null`, never a panic.
    serde_json::from_str::<Value>(json).is_ok_and(|message| message["type"] == DROP_TYPE)
}

/// Whether `source`, the address of the page that posted a message, is a page of the app itself:
/// where Tauri serves the UI on Windows (`http://tauri.localhost`, `https://tauri.localhost`
/// with the HTTPS scheme, `tauri://localhost` elsewhere), or `dev_url`, the dev server, which the
/// caller passes in a dev run only. Anything else (a page the webview was sent to) may not make
/// Kaleido open files.
fn is_app_origin(source: &str, dev_url: Option<&Url>) -> bool {
    let Ok(page) = Url::parse(source) else {
        return false;
    };
    let is = |scheme: &str, host: &str| {
        page.scheme() == scheme && page.host_str() == Some(host) && page.port().is_none()
    };
    is("http", "tauri.localhost")
        || is("https", "tauri.localhost")
        || is("tauri", "localhost")
        || dev_url.is_some_and(|dev| {
            page.scheme() == dev.scheme()
                && page.host_str() == dev.host_str()
                && page.port_or_known_default() == dev.port_or_known_default()
        })
}

/// Listens on `webview` for the UI's drop message and opens the files that come with it. Other
/// messages are left alone. Called on the main thread, as in the setup, the handler is in place
/// when this returns, and an error says it could not be added (dropped files then open nowhere;
/// the open dialog still works).
pub fn install(webview: &Webview) -> anyhow::Result<()> {
    let app = webview.app_handle().clone();
    let (done, outcome) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            let result = listen(&platform.controller(), app);
            // Nobody is waiting: `install` returned before this ran (it was not called on the
            // main thread), so the failure is reported here.
            if let Err(mpsc::SendError(Err(error))) = done.send(result) {
                tracing::error!("dropped files will not open: {error}");
            }
        })
        .context("cannot reach the WebView2 of the main window")?;
    match outcome.try_recv() {
        Ok(result) => result.context("cannot listen for the UI's drop message"),
        // Still queued for the main thread: it reports a failure itself.
        Err(_) => Ok(()),
    }
}

fn listen(controller: &ICoreWebView2Controller, app: AppHandle) -> windows::core::Result<()> {
    // The dev server is a page of the app in a dev run only.
    let dev_url = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
        match args
            .as_ref()
            .map(|args| dropped_paths(args, dev_url.as_ref()))
        {
            Some(Ok(Some(paths))) if paths.is_empty() => {
                tracing::warn!("the drop message came without any file");
            }
            Some(Ok(Some(paths))) => open_later(&app, paths),
            Some(Err(error)) => tracing::warn!("cannot read the dropped files: {error}"),
            _ => {}
        }
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: COM calls on the main thread, which owns the WebView2. The handler stays
    // registered for the webview's life, so the token is not needed.
    unsafe {
        controller
            .CoreWebView2()?
            .add_WebMessageReceived(&handler, &mut token)
    }
}

/// The paths of the files posted with the UI's drop message; `None` for any other message, and
/// for one from a page that is not the app's. A dropped item that cannot be read is logged and
/// left out ([`read_items`]).
fn dropped_paths(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
    dev_url: Option<&Url>,
) -> windows::core::Result<Option<Vec<PathBuf>>> {
    let mut message = PWSTR::null();
    let mut source = PWSTR::null();
    // SAFETY: COM calls on the main thread; `take_pwstr` frees what WebView2 allocated.
    unsafe {
        // A message that cannot be read as JSON is not ours either.
        if args.WebMessageAsJson(&mut message).is_err() || !is_drop_message(&take_pwstr(message)) {
            return Ok(None);
        }
        args.Source(&mut source)?;
        let source = take_pwstr(source);
        if !is_app_origin(&source, dev_url) {
            tracing::warn!("ignored files dropped on a page that is not the app's: {source}");
            return Ok(None);
        }
        let objects = args
            .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
            .AdditionalObjects()?;
        let mut count = 0;
        objects.Count(&mut count)?;
        Ok(Some(read_items(count, |index| {
            // Anything but a file (the UI sends only files) is skipped.
            let Ok(file) = objects.GetValueAtIndex(index)?.cast::<ICoreWebView2File>() else {
                return Ok(None);
            };
            let mut path = PWSTR::null();
            file.Path(&mut path)?;
            Ok(Some(PathBuf::from(take_pwstr(path))))
        })))
    }
}

/// Reads the `count` dropped items one by one with `read`, which answers the path of a file,
/// `None` for an item that is no file, or an error for one WebView2 cannot read. Such an item is
/// logged and left out: the other files of the drop still open.
fn read_items(
    count: u32,
    mut read: impl FnMut(u32) -> windows::core::Result<Option<PathBuf>>,
) -> Vec<PathBuf> {
    (0..count)
        .filter_map(|index| match read(index) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!("cannot read dropped item {index}: {error}");
                None
            }
        })
        .collect()
}

/// Checks and opens `paths` off the main thread (a share may answer slowly), in order with the
/// other requests from outside.
fn open_later(app: &AppHandle, paths: Vec<PathBuf>) {
    let arrived = Instant::now();
    super::in_order(app, move |app| {
        let request = OpenRequest {
            sources: sources_from_paths(paths),
            ..OpenRequest::default()
        };
        super::open(app, arrived, request);
    });
}

/// The files and folders among `paths` (absolute, from a drop or the dialog) that can be
/// opened, checked like any other source; the rest is logged and left out.
pub fn sources_from_paths(paths: Vec<PathBuf>) -> Vec<Source> {
    paths
        .into_iter()
        .filter_map(
            |path| match parse_source(&path.to_string_lossy(), Path::new("")) {
                Ok(source) => Some(source),
                Err(error) => {
                    tracing::warn!("cannot open {}: {error:?}", path.display());
                    None
                }
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use windows::Win32::Foundation::E_FAIL;

    use super::*;

    /// What the UI posts with the files; its tests read the same file.
    const UI_MESSAGE: &str = include_str!("../../tests/fixtures/drop/message.json");

    #[test]
    fn sources_from_paths_keep_files_and_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("žluťoučký kůň.mkv");
        fs::write(&file, b"x").unwrap();
        let folder = tmp.path().join("Videa čeština (2026)");
        fs::create_dir(&folder).unwrap();
        let missing = tmp.path().join("missing.mkv");

        assert_eq!(
            sources_from_paths(vec![file.clone(), folder.clone(), missing]),
            [Source::File(file), Source::File(folder)]
        );
    }

    #[test]
    fn the_message_the_ui_posts_is_a_drop() {
        assert!(is_drop_message(UI_MESSAGE));
        // WebView2 hands the JSON over compactly.
        assert!(is_drop_message(r#"{"type":"kaleido:drop"}"#));
    }

    /// The format is the point: a string would reach Tauri's IPC, which logs a `console.error`
    /// for it on every drop (see the module docs), so it is not accepted as a drop either.
    #[test]
    fn a_string_or_another_object_is_no_drop() {
        for json in [
            r#""kaleido:drop""#,
            r#""{\"type\":\"kaleido:drop\"}""#,
            r#"{"type":"other"}"#,
            r#"{"type":"Kaleido:Drop"}"#,
            r#"{"type":1}"#,
            r#"{"kind":"kaleido:drop"}"#,
            r#"{"cmd":"player_load","payload":{}}"#,
            r#"["kaleido:drop"]"#,
            r#"{}"#,
            "null",
            "kaleido:drop",
            "",
        ] {
            assert!(!is_drop_message(json), "{json}");
        }
    }

    #[test]
    fn only_the_apps_own_pages_may_drop_files() {
        let dev = Url::parse("http://localhost:1420/").unwrap();
        for source in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/#/settings",
            "tauri://localhost",
            "tauri://localhost/index.html",
        ] {
            assert!(is_app_origin(source, None), "{source}");
        }
        // The dev server counts in a dev run only (the caller passes it then).
        assert!(is_app_origin("http://localhost:1420/", Some(&dev)));
        assert!(is_app_origin(
            "http://localhost:1420/index.html?x=1",
            Some(&dev)
        ));
        assert!(!is_app_origin("http://localhost:1420/", None));
    }

    #[test]
    fn a_page_that_is_not_the_apps_may_not_drop_files() {
        let dev = Url::parse("http://localhost:1420/").unwrap();
        for source in [
            "",
            "not a url",
            "about:blank",
            "file:///C:/Users/PC/page.html",
            "https://example.com/",
            "http://tauri.localhost.example.com/",
            "http://example.com/tauri.localhost",
            // The host is what follows the `@`.
            "http://tauri.localhost@example.com/",
            "http://tauri.localhost:8080/",
            "tauri://example.com/",
            "ftp://tauri.localhost/",
            // Another port or scheme than the dev server's.
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://localhost/",
            "http://127.0.0.1:1420/",
        ] {
            assert!(!is_app_origin(source, Some(&dev)), "{source}");
            assert!(!is_app_origin(source, None), "{source}");
        }
    }

    #[test]
    fn a_bad_item_is_skipped_and_the_other_files_still_open() {
        let read = |index: u32| match index {
            0 => Ok(Some(PathBuf::from(r"C:\Videa\a.mkv"))),
            // WebView2 cannot read it.
            1 => Err(windows::core::Error::from(E_FAIL)),
            // Not a file.
            2 => Ok(None),
            _ => Ok(Some(PathBuf::from(r"C:\Videa\žluťoučký kůň.mkv"))),
        };

        assert_eq!(
            read_items(4, read),
            [
                PathBuf::from(r"C:\Videa\a.mkv"),
                PathBuf::from(r"C:\Videa\žluťoučký kůň.mkv"),
            ]
        );
    }

    #[test]
    fn items_are_read_in_order_and_once() {
        let mut asked = Vec::new();
        let paths = read_items(3, |index| {
            asked.push(index);
            Ok(Some(PathBuf::from(format!("{index}.mkv"))))
        });

        assert_eq!(asked, [0, 1, 2]);
        assert_eq!(
            paths,
            [
                PathBuf::from("0.mkv"),
                PathBuf::from("1.mkv"),
                PathBuf::from("2.mkv")
            ]
        );
        assert!(read_items(0, |_| unreachable!("no items")).is_empty());
    }
}
