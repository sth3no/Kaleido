//! The window's buttons as Windows sees them (spec 5.1). The window has no frame: the UI draws
//! minimise, maximise/restore and close itself. For Windows 11 to offer Snap Layouts when the
//! pointer rests on maximise, Windows' hit test there has to answer `HTMAXBUTTON`.
//!
//! Attempt 1 of the spike (Task 16, ruling R36):
//! - WebView2's non-client region support is on ([`install`]), so the CSS `app-region: drag` of
//!   the top islands is a real caption (drag, double-click, the window menu);
//! - the UI sends the maximise button's rectangle (`surface_set_caption_buttons`), and Kaleido puts
//!   a small window of its own over it that answers `HTMAXBUTTON` ([`win32::CaptionWindows`]).
//!
//! The one switch for the attempt is the UI's `SNAP_LAYOUTS` (src/shell/captionButtons.ts): the
//! UI decides whether the islands carry `app-region` and whether it sends any rectangle, and Rust
//! only acts on what it is sent. It is not a constant here because WebView2 may apply a change of
//! its non-client regions only at the next page load, while the page is loading when the setup
//! runs: leaving the CSS out is what turns them off for sure. Without the CSS the setting changes
//! nothing (wry turns it on for every webview anyway).
//!
//! Which window answers the hit test, and why not the main window: Windows sends `WM_NCHITTEST`
//! to the deepest visible child window under the pointer. Over the whole client area that is
//! WebView2's window, which belongs to the WebView2 browser process. The main window is asked
//! only where no child covers it, and a child's `HTTRANSPARENT` hands the hit test on only to
//! windows of the same thread, so nothing WebView2's window answers can reach the main window (the
//! same holds for mpv's window, which mpv's own thread owns). A child window of Kaleido's, made on
//! the main thread and kept above WebView2 exactly over the button, is the window under the pointer
//! there instead, and it answers `HTMAXBUTTON` itself; Windows Terminal's drag bar does the same
//! over its XAML title bar. It draws nothing: the main window is transparent and composes no GDI
//! content of child windows (spec 5.1), so the button the UI draws stays visible through it. It
//! only takes the pointer: a click there maximises or restores the window natively, and the page
//! sees no hover on that button.
//!
//! Not verified yet (quiet mode); the big manual pass checks it (docs/m1/checklist.md). Should
//! the flyout not open, one thing is left to try before the fallback: hand the window's
//! `WM_NCMOUSEMOVE` and `WM_NCMOUSEHOVER` on to the main window, in case Windows wants the
//! top-level window itself to see the hover over its maximise button.
//!
//! `SNAP_LAYOUTS = false` in the UI is the fallback (a one-line switch): no CSS `app-region`, no
//! rectangle, so no window over the button, and the UI's own buttons take every click.
//! `data-tauri-drag-region` still moves the window; Snap Layouts are then reachable with Win+Z
//! only.
//!
//! [`win32::CaptionWindows`]: super::win32::CaptionWindows

use anyhow::Context;
use serde::Deserialize;
use tauri::Webview;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Settings9,
};
use windows::core::Interface;

use super::layout::{Layout, PxRect, to_physical};

/// A window button the UI draws and Windows hit-tests itself, as the UI measured it: CSS px of the
/// window (before the display scale), like a glass rectangle. Today only the maximise/restore
/// button.
// `Serialize` only for the IPC contract test, which writes what it read back.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct CaptionButton {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The rectangles of `buttons` in physical px of a client area of `client_w`×`client_h` at
/// `scale`, clamped to it; a button outside it or without a size is left out, and a minimised
/// window (0×0) has none.
pub fn to_physical_rects(
    buttons: &[CaptionButton],
    client_w: u32,
    client_h: u32,
    scale: f64,
) -> Vec<PxRect> {
    buttons
        .iter()
        .filter_map(|button| {
            let layout = Layout::Rect {
                x: button.x,
                y: button.y,
                w: button.w,
                h: button.h,
            };
            to_physical(layout, client_w, client_h, scale)
        })
        .collect()
}

/// Turns WebView2's non-client regions (CSS `app-region`) on for the main window. wry does it for
/// every webview today; this says so where the spike needs it, and keeps it so should wry stop.
/// Called on the main thread, as in the setup, it is done when this returns.
pub fn install(webview: &Webview) -> anyhow::Result<()> {
    webview
        .with_webview(|platform| {
            if let Err(error) = enable_non_client_regions(&platform.controller()) {
                tracing::warn!("cannot turn WebView2's non-client regions on: {error}");
            }
        })
        .context("cannot reach the WebView2 of the main window")
}

fn enable_non_client_regions(controller: &ICoreWebView2Controller) -> windows::core::Result<()> {
    // SAFETY: COM calls on the main thread, which owns the WebView2.
    unsafe {
        controller
            .CoreWebView2()?
            .Settings()?
            .cast::<ICoreWebView2Settings9>()?
            .SetIsNonClientRegionSupportEnabled(true)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CaptionButton, PxRect, to_physical_rects};

    /// The maximise button of a 1280×720 window at the top right, as the UI measures it.
    const MAXIMIZE: CaptionButton = CaptionButton {
        x: 1196.5,
        y: 16.0,
        w: 36.0,
        h: 32.0,
    };

    #[test]
    fn buttons_are_scaled_to_physical_pixels() {
        // 150 % display scale: a 1280×720 CSS window is 1920×1080 physical.
        assert_eq!(
            to_physical_rects(&[MAXIMIZE], 1920, 1080, 1.5),
            [PxRect {
                x: 1795,
                y: 24,
                w: 54,
                h: 48
            }]
        );
    }

    #[test]
    fn buttons_outside_the_window_or_in_a_minimised_one_are_left_out() {
        let outside = CaptionButton {
            x: 2000.0,
            ..MAXIMIZE
        };
        let empty = CaptionButton { w: 0.0, ..MAXIMIZE };
        assert_eq!(
            to_physical_rects(&[outside, empty, MAXIMIZE], 1280, 720, 1.0),
            [PxRect {
                x: 1197,
                y: 16,
                w: 36,
                h: 32
            }],
            "only the button that is in the window"
        );
        assert!(to_physical_rects(&[MAXIMIZE], 0, 0, 1.0).is_empty());
        assert!(to_physical_rects(&[], 1280, 720, 1.0).is_empty());
    }

    /// A button partly outside the window (the window is narrower than the UI thought) is cut to it.
    #[test]
    fn buttons_are_clamped_to_the_window() {
        assert_eq!(
            to_physical_rects(&[MAXIMIZE], 1210, 720, 1.0),
            [PxRect {
                x: 1197,
                y: 16,
                w: 13,
                h: 32
            }]
        );
    }

    /// The shape `surface_set_caption_buttons` receives from the UI.
    #[test]
    fn caption_buttons_deserialize_from_the_ui_contract() {
        let button: CaptionButton =
            serde_json::from_value(json!({ "x": 1196.5, "y": 16, "w": 36, "h": 32 })).unwrap();
        assert_eq!(button, MAXIMIZE);
        assert!(
            serde_json::from_value::<CaptionButton>(json!({ "x": 1, "y": 2, "w": 3 })).is_err(),
            "every side is needed"
        );
    }
}
