//! Files dropped on the window (plan decision 8). The UI posts them to WebView2 with
//! `postMessageWithAdditionalObjects("kaleido:drop", files)`; Rust reads their paths here, so the
//! UI never sees a path.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Context;
use tauri::{AppHandle, Manager, Webview};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR};

use super::open_queue::OpenRequest;
use crate::player::load::{Source, parse_source};

/// The message the UI posts with the dropped files.
const DROP_MESSAGE: &str = "kaleido:drop";

/// Listens on `webview` for [`DROP_MESSAGE`] and opens the files that come with it. Other
/// messages are left alone: Tauri's IPC has its own handler on the same event (and logs a
/// `console.error` for this message, which is no IPC call). Called on the main thread, as in the
/// setup, the handler is in place when this returns; a failure in adding it is logged.
pub fn install(webview: &Webview) -> anyhow::Result<()> {
    let app = webview.app_handle().clone();
    webview
        .with_webview(move |platform| {
            if let Err(error) = listen(&platform.controller(), app) {
                tracing::error!("dropped files will not open: {error}");
            }
        })
        .context("cannot reach the WebView2 of the main window")
}

fn listen(controller: &ICoreWebView2Controller, app: AppHandle) -> windows::core::Result<()> {
    let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
        match args.as_ref().map(dropped_paths) {
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

/// The paths of the files posted with a [`DROP_MESSAGE`]; `None` for any other message.
fn dropped_paths(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
) -> windows::core::Result<Option<Vec<PathBuf>>> {
    let mut message = PWSTR::null();
    // SAFETY: COM calls on the main thread; `take_pwstr` frees what WebView2 allocated.
    unsafe {
        // Fails for a message that is not a string, which is then not ours either.
        if args.TryGetWebMessageAsString(&mut message).is_err() {
            return Ok(None);
        }
        if take_pwstr(message) != DROP_MESSAGE {
            return Ok(None);
        }
        let objects = args
            .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
            .AdditionalObjects()?;
        let mut count = 0;
        objects.Count(&mut count)?;
        let mut paths = Vec::new();
        for index in 0..count {
            // Anything but a file (the UI sends only files) is skipped.
            let Ok(file) = objects.GetValueAtIndex(index)?.cast::<ICoreWebView2File>() else {
                continue;
            };
            let mut path = PWSTR::null();
            file.Path(&mut path)?;
            paths.push(PathBuf::from(take_pwstr(path)));
        }
        Ok(Some(paths))
    }
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

    use super::*;

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
}
