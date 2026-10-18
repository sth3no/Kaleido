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

use crate::glass::{GlassController, VideoRect};
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
    /// The window of mpv's that `apply` placed last; 0 before it found one.
    placed: Mutex<isize>,
    /// The window buttons Windows hit-tests itself, as the UI measured them (CSS px).
    caption: Mutex<Vec<CaptionButton>>,
    /// The windows over them; made and moved on the main thread only.
    caption_windows: Mutex<win32::CaptionWindows>,
}

impl Surface {
    /// `main` = the HWND mpv got as `wid`. It starts hidden (Ruling R52): until a file opens there
    /// is no video, and mpv's idle window (`force-window`) would be a black area under the page.
    pub fn new(main: isize) -> Surface {
        Surface {
            main,
            layout: Mutex::new(Layout::Hidden),
            client: Mutex::new((0, 0, 1.0)),
            placed: Mutex::new(0),
            caption: Mutex::new(Vec::new()),
            caption_windows: Mutex::new(win32::CaptionWindows::default()),
        }
    }

    /// Places mpv's window, and the windows over the window buttons, for a client area of
    /// `client_w`×`client_h` physical px at `scale`. Call it on every resize and DPI change.
    pub fn apply(&self, client_w: u32, client_h: u32, scale: f64) {
        *lock(&self.client) = (client_w, client_h, scale);
        let layout = *lock(&self.layout);
        // Until mpv has created its window there is nothing to place; it makes it shown and
        // full-size, and `adopt_new_window` places it then.
        if let Some(mpv) = win32::find_child(self.main, MPV_WINDOW_CLASS) {
            *lock(&self.placed) = mpv;
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

    /// mpv may have made its window since the last placement (main thread): when its idle loop
    /// starts, after the setup has placed nothing, and when its video output starts again. A
    /// window it has made shows itself over the whole client area; one that is not the window
    /// placed last gets the layout, hidden on a page without a video (Ruling R52), in the corner
    /// for the mini player. Returns whether it placed one.
    pub fn adopt_new_window(&self) -> bool {
        let found = win32::find_child(self.main, MPV_WINDOW_CLASS);
        if found.is_none_or(|window| window == *lock(&self.placed)) {
            return false;
        }
        let (w, h, scale) = *lock(&self.client);
        self.apply(w, h, scale);
        true
    }

    /// Where mpv's window is for the layout and the client area now, in CSS px of the window;
    /// `None` while it is hidden. See [`video_rect`].
    pub fn video_rect(&self) -> Option<VideoRect> {
        let layout = *lock(&self.layout);
        let (w, h, scale) = *lock(&self.client);
        video_rect(layout, w, h, scale)
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

/// Where `layout` puts mpv's window in a client area of `client_w`×`client_h` physical px at
/// `scale`, in CSS px of the window: the physical rectangle [`to_physical`] places it at (so with
/// its rounding), divided by the scale. `None` while it is hidden or there is no scale.
pub fn video_rect(layout: Layout, client_w: u32, client_h: u32, scale: f64) -> Option<VideoRect> {
    if !(scale.is_finite() && scale > 0.0) {
        return None;
    }
    to_physical(layout, client_w, client_h, scale).map(|px| VideoRect {
        x: f64::from(px.x) / scale,
        y: f64::from(px.y) / scale,
        w: f64::from(px.w) / scale,
        h: f64::from(px.h) / scale,
    })
}

/// Tells the glass where mpv's window is now (Ruling R45). The UI measures its glass in CSS px
/// of the main window; the shader draws in mpv's window, which the mini player and its animation
/// move off the window's origin. Call it whenever the surface places that window: a new layout,
/// a resize, a DPI change. A hidden surface leaves the glass where it was: nothing shows then.
pub fn sync_glass(surface: &Surface, glass: &GlassController) {
    if let Some(rect) = surface.video_rect() {
        glass.set_video_rect(rect);
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

/// mpv reported the size of its window (`osd-dimensions`, event thread), as it does once it has
/// made one: on the main thread, a window it has just made gets the layout
/// ([`Surface::adopt_new_window`], Ruling R52). This thread only queues it.
pub fn mpv_window_reported(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Some(surface) = handle.try_state::<Surface>() {
            surface.adopt_new_window();
        }
    }) {
        tracing::warn!("cannot place a new window of mpv's: {error}");
    }
}

/// The main window was resized or got another display scale (main thread): mpv's window is
/// placed again (the mini player stays in its corner), the glass is told where it went, and a
/// fullscreen or always-on-top change the window made on its own (e.g. the UI through Tauri's
/// window API) goes to mpv.
pub fn window_resized(window: &Window) {
    if let (Some(surface), Ok(size), Ok(scale)) = (
        window.try_state::<Surface>(),
        window.inner_size(),
        window.scale_factor(),
    ) {
        surface.apply(size.width, size.height, scale);
        if let Some(glass) = window.try_state::<GlassController>() {
            sync_glass(&surface, &glass);
        }
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

    use super::win32::find_child;
    use super::win32::testing::{
        class_name, destroy, has_visible_style, pump, set_rect, test_parent, wait_for_child,
        window_rect,
    };
    use super::{
        FullscreenSync, Layout, MPV_WINDOW_CLASS, PxRect, Surface, SyncAction, to_physical,
        video_rect,
    };
    use crate::glass::VideoRect;
    use crate::player::testing::{NoEvents, temp_paths};
    use crate::player::{
        Engine, EngineConfig, EventLoop, EventSink, PlayerEvent, Request, StateLoop, observe_all,
    };

    /// What the glass is told (Ruling R45): the rectangle mpv's window is placed at, overscan
    /// included (Ruling R47), in CSS px.
    #[test]
    fn the_video_rect_is_where_mpvs_window_goes_in_css_px() {
        // A mini player in a 1280 × 720 CSS px window at 150 %: 540 × 303 physical px at
        // (1920 − 24 − 540, 1080 − 24 − 303), and a pixel more on every side.
        let mini = Layout::Mini {
            w: 360.0,
            h: 202.0,
            right: 16.0,
            bottom: 16.0,
        };
        assert_eq!(
            to_physical(mini, 1920, 1080, 1.5),
            Some(PxRect {
                x: 1355,
                y: 752,
                w: 542,
                h: 305
            })
        );
        assert_eq!(
            video_rect(mini, 1920, 1080, 1.5),
            Some(VideoRect {
                x: 1355.0 / 1.5,
                y: 752.0 / 1.5,
                w: 542.0 / 1.5,
                h: 305.0 / 1.5
            })
        );
        assert_eq!(
            video_rect(Layout::Full, 1920, 1080, 1.5),
            Some(VideoRect {
                x: 0.0,
                y: 0.0,
                w: 1280.0,
                h: 720.0
            })
        );
        // A frame of the animation, as rounded (and overscanned) as the window is placed.
        assert_eq!(
            video_rect(FRAME, 400, 300, 1.0),
            Some(VideoRect {
                x: 9.0,
                y: 19.0,
                w: 162.0,
                h: 92.0
            })
        );
        assert_eq!(video_rect(Layout::Hidden, 1920, 1080, 1.5), None);
        assert_eq!(video_rect(mini, 0, 0, 1.5), None, "minimized");
        assert_eq!(video_rect(Layout::Full, 1920, 1080, 0.0), None);
    }

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

    /// The real libmpv with `wid` = a `test_parent()` of its own, started as in the app, and the
    /// window it created there.
    ///
    /// It is a guard: however the test ends, returning or panicking at a failed assertion, its
    /// Drop ends the engine as [`close`] does. Dropped as it is on the test thread, which owns the
    /// parent window, the engine would wait for mpv's window to close, and mpv's window for the
    /// message pump of the very thread that waits: a failing test would hang instead of failing.
    struct MpvInside {
        /// `None` once closed.
        engine: Option<Engine>,
        parent: isize,
        /// The window mpv created inside `parent`.
        video: isize,
    }

    impl MpvInside {
        fn start(dir: &std::path::Path) -> MpvInside {
            let mut mpv = MpvInside::start_in(dir, test_parent(), NoEvents);
            // Found without find_child: the parent's only child is whatever mpv created. A
            // failure here is a panic the guard already covers.
            mpv.video = wait_for_child(mpv.parent, Duration::from_secs(15))
                .expect("libmpv created no direct child window inside wid");
            mpv
        }

        /// The engine in `parent` with `events`, without waiting for its window (`video` is 0).
        fn start_in(dir: &std::path::Path, parent: isize, events: impl EventLoop) -> MpvInside {
            let engine = Engine::start(
                EngineConfig {
                    paths: temp_paths(dir),
                    wid: Some(parent),
                    // The app's video output. Without a GPU (CI) d3d11-warp=auto uses WARP.
                    vo: "gpu-next".into(),
                    ao: Some("null".into()),
                },
                events,
            )
            .expect("start libmpv");
            MpvInside {
                engine: Some(engine),
                parent,
                video: 0,
            }
        }

        fn engine(&self) -> &Engine {
            self.engine.as_ref().expect("the engine runs")
        }
    }

    impl Drop for MpvInside {
        fn drop(&mut self) {
            let Some(engine) = self.engine.take() else {
                return;
            };
            let closed = close(engine, self.parent);
            // A second panic while the test unwinds would abort the run; the first one is the
            // test's failure, and it is reported as such.
            if !closed && !thread::panicking() {
                panic!("closing libmpv hung");
            }
        }
    }

    /// Ends the engine on another thread while this one, which owns `parent`, handles what mpv's
    /// window sends while it closes (in the app that is the main thread's job), then destroys
    /// `parent`. False if it did not end within 10 s; `parent` is then left alone (mpv's window
    /// is still in it, and the thread that drops the engine is left to the end of the run).
    fn close(engine: Engine, parent: isize) -> bool {
        let (done, closed) = mpsc::channel();
        thread::spawn(move || {
            drop(engine);
            let _ = done.send(());
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while closed.try_recv().is_err() {
            if Instant::now() >= deadline {
                return false;
            }
            pump(Duration::from_millis(20));
        }
        destroy(parent);
        true
    }

    /// Upstream detail the surface relies on (spec 5.1): with `wid` set, the real libmpv creates
    /// its own window of class "mpv" as a direct child of `wid`, and a layout moves it.
    /// Fails when a libmpv update renames that class or nests the window deeper.
    #[test]
    fn surface_moves_the_window_libmpv_creates_inside_wid() {
        let tmp = tempfile::tempdir().unwrap();
        let mpv = MpvInside::start(tmp.path());
        assert_eq!(class_name(mpv.video), "mpv");

        let surface = Surface::new(mpv.parent);
        surface.apply(400, 300, 1.0);
        surface.set_layout(FRAME);
        // Give mpv time to fight the placement; it must not. A pixel past the frame on every
        // side (layout::OVERSCAN).
        pump(Duration::from_millis(500));
        assert_eq!(window_rect(mpv.video), (109, 119, 162, 92));
    }

    /// libmpv snaps its window back to the parent's whole client area whenever the parent moves
    /// or resizes. The mini player must stay in its corner through both, and Full must follow
    /// the parent again.
    #[test]
    fn mini_player_survives_moving_and_resizing_the_window() {
        let tmp = tempfile::tempdir().unwrap();
        let mpv = MpvInside::start(tmp.path());
        let (parent, video) = (mpv.parent, mpv.video);
        let surface = Surface::new(parent);
        surface.apply(400, 300, 1.0);
        surface.set_layout(MINI);
        pump(Duration::from_millis(500));
        // Client 400×300 at (100, 100): x = 400 − 16 − 160, y = 300 − 16 − 90, and a pixel more
        // on every side (layout::OVERSCAN).
        assert_eq!(window_rect(video), (323, 293, 162, 92), "in the corner");

        set_rect(parent, 150, 150, 400, 300);
        pump(Duration::from_millis(500));
        assert_eq!(window_rect(video), (373, 343, 162, 92), "after a move");

        set_rect(parent, 150, 150, 500, 400);
        surface.apply(500, 400, 1.0); // what WindowEvent::Resized does
        pump(Duration::from_millis(500));
        assert_eq!(
            window_rect(video),
            (473, 443, 162, 92),
            "after a resize, in the new corner"
        );

        surface.set_layout(Layout::Full);
        set_rect(parent, 150, 150, 600, 450);
        surface.apply(600, 450, 1.0);
        pump(Duration::from_millis(500));
        assert_eq!(window_rect(video), (150, 150, 600, 450), "full again");
    }

    /// What `route` reacts to (lib.rs): the batches in which mpv reports `osd-dimensions`.
    struct OsdReports(mpsc::Sender<()>);

    impl EventSink for OsdReports {
        fn emit(&self, event: PlayerEvent) {
            if let PlayerEvent::State { changes } = event
                && changes.contains_key("osd-dimensions")
            {
                let _ = self.0.send(());
            }
        }
    }

    /// Ruling R52, the way the app starts: the surface is hidden and placed before mpv has made its
    /// window (mpv makes it, shown and full-size, when its idle loop starts: `force-window`). mpv
    /// reports the window's size, and the window is hidden then and stays hidden. A file that
    /// opens on the player page shows it over the whole window.
    #[test]
    fn the_window_mpv_makes_while_nothing_is_open_is_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = test_parent();
        let surface = Surface::new(parent);
        // What the setup does before the engine starts: there is nothing to place yet.
        surface.apply(400, 300, 1.0);
        assert!(
            !surface.adopt_new_window(),
            "a window of mpv's before mpv runs"
        );
        let (reported, reports) = mpsc::channel();
        let mpv = MpvInside::start_in(tmp.path(), parent, StateLoop::new(OsdReports(reported)));
        mpv.engine().request(Request::Call(Box::new(|mpv| {
            observe_all(mpv).expect("observe the player state");
        })));

        // What `route` has done at each report, on the thread that owns the windows.
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut adopted = None;
        while adopted.is_none() {
            assert!(
                Instant::now() < deadline,
                "mpv's window was never placed: no osd-dimensions after mpv made it"
            );
            pump(Duration::from_millis(20));
            while reports.try_recv().is_ok() {
                if surface.adopt_new_window() {
                    adopted = find_child(parent, MPV_WINDOW_CLASS);
                }
            }
        }
        let video = adopted.expect("mpv's window");
        pump(Duration::from_millis(500));
        assert!(!has_visible_style(video), "mpv's idle window is shown");
        assert!(!surface.adopt_new_window(), "the same window placed twice");

        surface.set_layout(Layout::Full);
        pump(Duration::from_millis(200));
        assert!(
            has_visible_style(video),
            "the whole-window video is not shown"
        );
        assert_eq!(window_rect(video), (100, 100, 400, 300));
    }

    /// The surface starts hidden: nothing is open when Kaleido starts (Ruling R52).
    #[test]
    fn the_surface_starts_hidden() {
        let parent = test_parent();
        let surface = Surface::new(parent);
        surface.apply(1280, 720, 1.0);
        assert_eq!(surface.video_rect(), None);
        surface.set_layout(Layout::Full);
        assert!(surface.video_rect().is_some());
        destroy(parent);
    }
}
