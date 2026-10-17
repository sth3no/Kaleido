//! The video surface (spec 5.1): mpv's own window inside the main window, placed for the UI's
//! layout (whole window, mini-player animation, anchored mini player, hidden), and fullscreen and
//! always-on-top kept the same in mpv and the Tauri window. Also the window buttons Windows
//! hit-tests itself, for Snap Layouts (`caption`).

pub mod caption;
pub mod layout;
pub mod win32;

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow, Window};

pub use caption::CaptionButton;
pub use layout::{Layout, PxRect, to_physical};

use crate::player::{Engine, Request};

/// Window class of the child window mpv creates inside `wid`.
pub const MPV_WINDOW_CLASS: &str = "mpv";

/// The label of the main window (tauri.conf.json).
pub(crate) const MAIN_WINDOW: &str = "main";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Positions mpv's own window (a direct child of the main window) for the UI's layout. Used on
/// the main thread.
///
/// M0 finding: mpv must get the top-level HWND as `wid`. Nested one level deeper (inside a
/// child window of ours) its flip-model swapchain is not composited under the transparent
/// WebView2 and the video area stays see-through.
pub struct Surface {
    main: isize,
    layout: Mutex<Layout>,
    client: Mutex<(u32, u32, f64)>,
    /// The window buttons Windows hit-tests itself, as the UI measured them (CSS px).
    caption: Mutex<Vec<CaptionButton>>,
    /// The windows over them; made and moved on the main thread only.
    caption_windows: Mutex<win32::CaptionWindows>,
}

impl Surface {
    /// `main` = the HWND mpv got as `wid`.
    pub fn new(main: isize) -> Surface {
        Surface {
            main,
            layout: Mutex::new(Layout::Full),
            client: Mutex::new((0, 0, 1.0)),
            caption: Mutex::new(Vec::new()),
            caption_windows: Mutex::new(win32::CaptionWindows::default()),
        }
    }

    /// Places mpv's window, and the windows over the window buttons, for a client area of
    /// `client_w`×`client_h` physical px at `scale`. Call it on every resize and DPI change.
    pub fn apply(&self, client_w: u32, client_h: u32, scale: f64) {
        *lock(&self.client) = (client_w, client_h, scale);
        let layout = *lock(&self.layout);
        // Until mpv has created its window there is nothing to place; it starts full-size.
        if let Some(mpv) = win32::find_child(self.main, MPV_WINDOW_CLASS) {
            let rect = to_physical(layout, client_w, client_h, scale);
            // mpv resizes its window to our whole client area whenever the main window moves or
            // resizes. That is right for Full; the mini player's rectangle is pinned against it.
            let pinned = match layout {
                Layout::Rect { .. } | Layout::Mini { .. } => rect,
                Layout::Full | Layout::Hidden => None,
            };
            win32::pin(mpv, pinned);
            win32::place(mpv, rect);
        }
        // The UI's rectangles stay the same CSS px through a DPI change; the windows over them
        // must still follow the new scale.
        self.place_caption_buttons(client_w, client_h, scale);
    }

    pub fn set_layout(&self, layout: Layout) {
        *lock(&self.layout) = layout;
        let (w, h, scale) = *lock(&self.client);
        self.apply(w, h, scale);
    }

    /// The window buttons the UI drew that Windows hit-tests itself (Snap Layouts, see
    /// `caption`); an empty list for none. Main thread only. With the spike off the UI sends
    /// none, and the UI's own buttons take every click.
    pub fn set_caption_buttons(&self, buttons: Vec<CaptionButton>) {
        *lock(&self.caption) = buttons;
        let (w, h, scale) = *lock(&self.client);
        self.place_caption_buttons(w, h, scale);
    }

    fn place_caption_buttons(&self, client_w: u32, client_h: u32, scale: f64) {
        let rects = caption::to_physical_rects(&lock(&self.caption), client_w, client_h, scale);
        // Placing sends messages to the windows (on this thread), whose procedure takes no lock.
        lock(&self.caption_windows).place(self.main, &rects);
    }
}

/// What [`FullscreenSync`] asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAction {
    /// Put the Tauri window into this state.
    SetWindow(bool),
    /// Set mpv's property to this value.
    SetMpv(bool),
}

/// Keeps one state, fullscreen or always on top, the same in mpv's property and the Tauri
/// window, in both directions, without acting on the echo of its own action.
///
/// Used on the main thread, where the window reports its changes, and what it returns is done
/// there at once: so at every report it knows the window's real state, and a report that differs
/// from it is a change the window made on its own, never a late echo.
#[derive(Debug, Default)]
pub struct FullscreenSync {
    mpv: bool,
    window: bool,
}

impl FullscreenSync {
    /// mpv reported its property.
    pub fn mpv_changed(&mut self, on: bool) -> Option<SyncAction> {
        self.mpv = on;
        if self.window == on {
            // Already so, or mpv echoes our SetMpv.
            return None;
        }
        self.window = on;
        Some(SyncAction::SetWindow(on))
    }

    /// The window reported its state (any report, changed or not).
    pub fn window_changed(&mut self, on: bool) -> Option<SyncAction> {
        if self.window == on {
            // Unchanged, or the echo of our SetWindow.
            return None;
        }
        self.window = on;
        if self.mpv == on {
            return None;
        }
        self.mpv = on;
        Some(SyncAction::SetMpv(on))
    }
}

/// The window states mpv has as properties (spec 5.1: `fullscreen` and `ontop`, so that
/// input.conf and plugins can change them too).
#[derive(Debug, Clone, Copy)]
enum Flag {
    Fullscreen,
    Ontop,
}

impl Flag {
    const ALL: [Flag; 2] = [Flag::Fullscreen, Flag::Ontop];

    fn property(self) -> &'static str {
        match self {
            Flag::Fullscreen => "fullscreen",
            Flag::Ontop => "ontop",
        }
    }

    fn read(self, window: &WebviewWindow) -> tauri::Result<bool> {
        match self {
            Flag::Fullscreen => window.is_fullscreen(),
            Flag::Ontop => window.is_always_on_top(),
        }
    }

    fn write(self, window: &WebviewWindow, on: bool) -> tauri::Result<()> {
        match self {
            Flag::Fullscreen => window.set_fullscreen(on),
            Flag::Ontop => window.set_always_on_top(on),
        }
    }
}

/// A [`FullscreenSync`] for each [`Flag`]. Managed state, used on the main thread only.
#[derive(Debug, Default)]
pub struct WindowSync {
    fullscreen: Mutex<FullscreenSync>,
    ontop: Mutex<FullscreenSync>,
}

impl WindowSync {
    fn of(&self, flag: Flag) -> MutexGuard<'_, FullscreenSync> {
        match flag {
            Flag::Fullscreen => lock(&self.fullscreen),
            Flag::Ontop => lock(&self.ontop),
        }
    }
}

/// The main window was resized or got another display scale (main thread): mpv's window is
/// placed again, and a fullscreen or always-on-top change the window made on its own (e.g. the
/// UI through Tauri's window API) goes to mpv.
pub fn window_resized(window: &Window) {
    if let (Some(surface), Ok(size), Ok(scale)) = (
        window.try_state::<Surface>(),
        window.inner_size(),
        window.scale_factor(),
    ) {
        surface.apply(size.width, size.height, scale);
    }
    follow_window(window.app_handle());
}

/// mpv reported a batch of property changes (event thread): the window takes a new `fullscreen`
/// or `ontop`. On the main thread, in order with the window's own reports (see
/// [`FullscreenSync`]); this thread only queues it.
pub fn follow_mpv(app: &AppHandle, changes: &BTreeMap<String, Value>) {
    for flag in Flag::ALL {
        let Some(on) = changes.get(flag.property()).and_then(Value::as_bool) else {
            continue;
        };
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Some(sync) = handle.try_state::<WindowSync>() {
                // The lock goes before the action: changing the window reports back at once.
                let action = sync.of(flag).mpv_changed(on);
                perform(&handle, flag, action);
            }
        }) {
            tracing::warn!(
                "the window cannot follow mpv's {}: {error}",
                flag.property()
            );
        }
    }
}

fn follow_window(app: &AppHandle) {
    let (Some(sync), Some(window)) = (
        app.try_state::<WindowSync>(),
        app.get_webview_window(MAIN_WINDOW),
    ) else {
        return;
    };
    for flag in Flag::ALL {
        match flag.read(&window) {
            Ok(on) => {
                let action = sync.of(flag).window_changed(on);
                perform(app, flag, action);
            }
            Err(error) => tracing::warn!("cannot read the window's {}: {error}", flag.property()),
        }
    }
}

/// Does `action` at once. Never waits for mpv: this is the main thread.
fn perform(app: &AppHandle, flag: Flag, action: Option<SyncAction>) {
    match action {
        None => {}
        Some(SyncAction::SetWindow(on)) => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW)
                && let Err(error) = flag.write(&window, on)
            {
                tracing::warn!(
                    "cannot set the window's {} to {on}: {error}",
                    flag.property()
                );
            }
        }
        Some(SyncAction::SetMpv(on)) => {
            if let Some(engine) = app.try_state::<Engine>() {
                engine.request(Request::SetProperty {
                    name: flag.property().to_owned(),
                    value: if on { "yes" } else { "no" }.to_owned(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::win32::testing::{
        class_name, destroy, pump, set_rect, test_parent, wait_for_child, window_rect,
    };
    use super::{FullscreenSync, Layout, Surface, SyncAction};
    use crate::player::testing::{NoEvents, temp_paths};
    use crate::player::{Engine, EngineConfig};

    #[test]
    fn fullscreen_sync_ignores_its_own_echo() {
        let mut sync = FullscreenSync::default();
        assert_eq!(sync.mpv_changed(true), Some(SyncAction::SetWindow(true)));
        assert_eq!(sync.window_changed(true), None, "the echo of SetWindow");
        assert_eq!(sync.window_changed(false), Some(SyncAction::SetMpv(false)));
        assert_eq!(sync.mpv_changed(false), None, "the echo of SetMpv");
    }

    /// A frame of the mini-player animation.
    const FRAME: Layout = Layout::Rect {
        x: 10.0,
        y: 20.0,
        w: 160.0,
        h: 90.0,
    };

    /// The mini player at rest, 16 px from the bottom-right corner.
    const MINI: Layout = Layout::Mini {
        w: 160.0,
        h: 90.0,
        right: 16.0,
        bottom: 16.0,
    };

    /// The real libmpv with `wid` = `parent` (a `test_parent()`), started as in the app, and the
    /// window it created there.
    fn mpv_inside(parent: isize, dir: &std::path::Path) -> (Engine, isize) {
        let engine = Engine::start(
            EngineConfig {
                paths: temp_paths(dir),
                wid: Some(parent),
                // The app's video output. Without a GPU (CI) d3d11-warp=auto uses WARP.
                vo: "gpu-next".into(),
                ao: Some("null".into()),
            },
            NoEvents,
        )
        .expect("start libmpv");
        // Found without find_child: the parent's only child is whatever mpv created.
        let video = wait_for_child(parent, Duration::from_secs(15))
            .expect("libmpv created no direct child window inside wid");
        (engine, video)
    }

    /// Ends the engine on another thread while this one, which owns `parent`, handles what mpv's
    /// window sends while it closes (in the app that is the main thread's job), then destroys
    /// `parent`.
    fn close(engine: Engine, parent: isize) {
        let (done, closed) = mpsc::channel();
        thread::spawn(move || {
            drop(engine);
            let _ = done.send(());
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while closed.try_recv().is_err() {
            assert!(Instant::now() < deadline, "closing libmpv hung");
            pump(Duration::from_millis(20));
        }
        destroy(parent);
    }

    /// Upstream detail the surface relies on (spec 5.1): with `wid` set, the real libmpv creates
    /// its own window of class "mpv" as a direct child of `wid`, and a layout moves it.
    /// Fails when a libmpv update renames that class or nests the window deeper.
    #[test]
    fn surface_moves_the_window_libmpv_creates_inside_wid() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = test_parent();
        let (engine, video) = mpv_inside(parent, tmp.path());
        assert_eq!(class_name(video), "mpv");

        let surface = Surface::new(parent);
        surface.apply(400, 300, 1.0);
        surface.set_layout(FRAME);
        // Give mpv time to fight the placement; it must not.
        pump(Duration::from_millis(500));
        assert_eq!(window_rect(video), (110, 120, 160, 90));

        close(engine, parent);
    }

    /// libmpv snaps its window back to the parent's whole client area whenever the parent moves
    /// or resizes. The mini player must stay in its corner through both, and Full must follow
    /// the parent again.
    #[test]
    fn mini_player_survives_moving_and_resizing_the_window() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = test_parent();
        let (engine, video) = mpv_inside(parent, tmp.path());
        let surface = Surface::new(parent);
        surface.apply(400, 300, 1.0);
        surface.set_layout(MINI);
        pump(Duration::from_millis(500));
        // Client 400×300 at (100, 100): x = 400 − 16 − 160, y = 300 − 16 − 90.
        assert_eq!(window_rect(video), (324, 294, 160, 90), "in the corner");

        set_rect(parent, 150, 150, 400, 300);
        pump(Duration::from_millis(500));
        assert_eq!(window_rect(video), (374, 344, 160, 90), "after a move");

        set_rect(parent, 150, 150, 500, 400);
        surface.apply(500, 400, 1.0); // what WindowEvent::Resized does
        pump(Duration::from_millis(500));
        assert_eq!(
            window_rect(video),
            (474, 444, 160, 90),
            "after a resize, in the new corner"
        );

        surface.set_layout(Layout::Full);
        set_rect(parent, 150, 150, 600, 450);
        surface.apply(600, 450, 1.0);
        pump(Duration::from_millis(500));
        assert_eq!(window_rect(video), (150, 150, 600, 450), "full again");

        close(engine, parent);
    }
}
