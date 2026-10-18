//! The Win32 calls behind the surface: finding mpv's window, moving it, and keeping it where
//! Kaleido put it against libmpv, which moves it back (spec 5.1); and the windows over the
//! window buttons the UI draws, which answer Windows' hit test for them (`caption.rs`).

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Mutex, Once, PoisonError};

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreateWindowExW, DefWindowProcW, GA_ROOT, GW_CHILD, GW_HWNDNEXT,
    GWLP_HINSTANCE, GWLP_WNDPROC, GetAncestor, GetClassNameW, GetWindow, GetWindowLongPtrW,
    HTMAXBUTTON, HWND_BOTTOM, HWND_TOP, IsZoomed, MA_NOACTIVATE, PostMessageW, RegisterClassW,
    SC_MAXIMIZE, SC_RESTORE, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, WINDOWPOS, WM_CAPTURECHANGED,
    WM_MOUSEACTIVATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN,
    WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SYSCOMMAND, WM_WINDOWPOSCHANGED, WNDCLASSW,
    WNDPROC, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_NOPARENTNOTIFY,
};
use windows::core::{PCWSTR, w};

use super::layout::PxRect;

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

/// A window whose procedure we wrapped to keep it at `rect`.
struct Pinned {
    window: isize,
    original: isize,
    rect: Option<PxRect>,
}

static PINNED: Mutex<Vec<Pinned>> = Mutex::new(Vec::new());

/// Keeps a child window at `rect` (parent client coordinates) whoever moves it; None releases
/// it. The first pin wraps the window procedure, which keeps running on the owner's thread
/// (mpv's); call it before `place`, never while holding a lock that procedure could need.
pub fn pin(window: isize, rect: Option<PxRect>) {
    let mut pinned = PINNED.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(entry) = pinned.iter_mut().find(|p| p.window == window) {
        entry.rect = rect;
        return;
    }
    if rect.is_none() {
        return;
    }
    // Registered before the swap so the wrapper always finds the original procedure.
    // SAFETY: plain Win32 call; a window that is gone makes it return 0.
    let original = unsafe { GetWindowLongPtrW(hwnd(window), GWLP_WNDPROC) };
    pinned.push(Pinned {
        window,
        original,
        rect,
    });
    drop(pinned);
    // SAFETY: `pinned_proc` has the WNDPROC signature and forwards to `original`.
    unsafe {
        SetWindowLongPtrW(
            hwnd(window),
            GWLP_WNDPROC,
            pinned_proc as *const () as isize,
        )
    };
}

unsafe extern "system" fn pinned_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let found = {
        let mut pinned = PINNED.lock().unwrap_or_else(PoisonError::into_inner);
        let index = pinned.iter().position(|p| p.window == h.0 as isize);
        index.map(|i| {
            if msg == WM_NCDESTROY {
                let gone = pinned.swap_remove(i);
                (gone.original, None)
            } else {
                (pinned[i].original, pinned[i].rect)
            }
        })
    };
    let Some((original, rect)) = found else {
        return unsafe { DefWindowProcW(h, msg, wp, lp) };
    };
    if msg == WM_NCDESTROY {
        unsafe { SetWindowLongPtrW(h, GWLP_WNDPROC, original) };
    }
    // mpv resizes its window with SWP_NOSENDCHANGING, so only WM_WINDOWPOSCHANGED shows it.
    // Put the window back before mpv's procedure sees the change: without the original
    // procedure (and DefWindowProc) mpv gets no WM_SIZE and keeps its swapchain size.
    if msg == WM_WINDOWPOSCHANGED
        && let Some(r) = rect
    {
        // SAFETY: for WM_WINDOWPOSCHANGED lParam points to the applied WINDOWPOS.
        let pos = unsafe { &*(lp.0 as *const WINDOWPOS) };
        let moved = pos.flags.0 & SWP_NOMOVE.0 == 0 && (pos.x, pos.y) != (r.x, r.y);
        let sized = pos.flags.0 & SWP_NOSIZE.0 == 0 && (pos.cx, pos.cy) != (r.w, r.h);
        if moved || sized {
            let _ =
                unsafe { SetWindowPos(h, None, r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOACTIVATE) };
            return LRESULT(0);
        }
    }
    // SAFETY: `original` is the window procedure GetWindowLongPtrW returned for this window.
    let original: WNDPROC = unsafe { std::mem::transmute::<isize, WNDPROC>(original) };
    unsafe { CallWindowProcW(original, h, msg, wp, lp) }
}

/// Direct child of `parent` whose window class is `class`.
pub fn find_child(parent: isize, class: &str) -> Option<isize> {
    // SAFETY: plain Win32 calls on window handles; a stale handle only makes them fail.
    unsafe {
        let mut next = GetWindow(hwnd(parent), GW_CHILD).ok();
        while let Some(child) = next {
            let mut name = [0u16; 64];
            let len = GetClassNameW(child, &mut name);
            if String::from_utf16_lossy(&name[..len.max(0) as usize]) == class {
                return Some(child.0 as isize);
            }
            next = GetWindow(child, GW_HWNDNEXT).ok();
        }
        None
    }
}

/// Moves a child window (parent client coordinates) and shows it, or hides it for None; it
/// always stays under WebView2.
pub fn place(window: isize, rect: Option<PxRect>) {
    // Failures only mean the window is gone (app shutting down); nothing to recover.
    // SAFETY: plain Win32 call on a window handle.
    let _ = unsafe {
        match rect {
            Some(r) => SetWindowPos(
                hwnd(window),
                Some(HWND_BOTTOM),
                r.x,
                r.y,
                r.w,
                r.h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            ),
            None => SetWindowPos(
                hwnd(window),
                Some(HWND_BOTTOM),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_HIDEWINDOW,
            ),
        }
    };
}

// ---------------------------------------------------------------------------------------------
// The window buttons Windows hit-tests itself (caption.rs explains why it is a window of ours)

/// The window class of the windows over the window buttons.
pub const CAPTION_WINDOW_CLASS: &str = "KaleidoCaptionButton";
/// [`CAPTION_WINDOW_CLASS`] as Win32 takes it.
const CAPTION_CLASS: PCWSTR = w!("KaleidoCaptionButton");

static REGISTER_CAPTION_CLASS: Once = Once::new();

/// The window the left button went down on (0 for none): only a release on the same window is a
/// click.
static PRESSED: AtomicIsize = AtomicIsize::new(0);

/// Kaleido's own windows over the window buttons the UI draws: one per button, children of the
/// main window above WebView2, answering Windows' hit test for the button (`HTMAXBUTTON`, the
/// only kind there is today). They draw nothing; the button under them stays the UI's.
#[derive(Debug, Default)]
pub struct CaptionWindows {
    windows: Vec<isize>,
}

impl CaptionWindows {
    /// Puts a window over each of `rects` (client px of `parent`), above every other child, and
    /// hides the rest. Main thread only: a window belongs to the thread that makes it, and that
    /// thread's message loop runs its procedure.
    pub fn place(&mut self, parent: isize, rects: &[PxRect]) {
        while self.windows.len() < rects.len() {
            match create_caption_window(parent) {
                Some(window) => self.windows.push(window),
                None => break,
            }
        }
        for (index, &window) in self.windows.iter().enumerate() {
            // Failures only mean the window is gone (app shutting down); nothing to recover.
            // SAFETY: plain Win32 calls on a window handle.
            let _ = unsafe {
                match rects.get(index) {
                    // Above WebView2's window, which covers the whole client area.
                    Some(r) => SetWindowPos(
                        hwnd(window),
                        Some(HWND_TOP),
                        r.x,
                        r.y,
                        r.w,
                        r.h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    ),
                    None => SetWindowPos(
                        hwnd(window),
                        None,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_HIDEWINDOW,
                    ),
                }
            };
        }
    }
}

/// A hidden window of [`CAPTION_WINDOW_CLASS`] inside `parent`, or None if Windows refuses one.
fn create_caption_window(parent: isize) -> Option<isize> {
    // SAFETY: plain Win32 calls; the class's procedure has the WNDPROC signature.
    unsafe {
        // The module that made the main window (Kaleido.exe), without another windows feature.
        let instance = HINSTANCE(GetWindowLongPtrW(hwnd(parent), GWLP_HINSTANCE) as *mut _);
        REGISTER_CAPTION_CLASS.call_once(|| {
            let class = WNDCLASSW {
                lpfnWndProc: Some(caption_proc),
                hInstance: instance,
                lpszClassName: CAPTION_CLASS,
                // No background brush: it paints nothing.
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                tracing::warn!("cannot register the caption button window class");
            }
        });
        match CreateWindowExW(
            WS_EX_NOPARENTNOTIFY,
            CAPTION_CLASS,
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(hwnd(parent)),
            None,
            Some(instance),
            None,
        ) {
            Ok(window) => Some(window.0 as isize),
            Err(error) => {
                tracing::warn!("cannot make the window over the maximise button: {error}");
                None
            }
        }
    }
}

unsafe extern "system" fn caption_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let on_button = wp.0 == HTMAXBUTTON as usize;
    match msg {
        // All of the window is the button: Windows sees its maximise button here and opens Snap
        // Layouts when the pointer rests on it (spec 5.1).
        WM_NCHITTEST => LRESULT(HTMAXBUTTON as isize),
        // Pressing and releasing are a click; Windows' own handling of a caption button in a child
        // window would draw a classic one. A double click is two clicks, as on Windows' button.
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if on_button => {
            PRESSED.store(h.0 as isize, Ordering::Relaxed);
            LRESULT(0)
        }
        WM_NCLBUTTONUP if on_button => {
            if PRESSED.swap(0, Ordering::Relaxed) == h.0 as isize {
                toggle_maximized(h);
            }
            LRESULT(0)
        }
        // Over the button: ask to hear when the pointer leaves it (WM_NCMOUSELEAVE). Only the leave
        // is asked for, so Windows' own hover tracking (for Snap Layouts) is left as it is; the
        // move itself still goes to Windows below.
        WM_NCMOUSEMOVE => {
            track_leave(h);
            // SAFETY: the default procedure for this window's own message.
            unsafe { DefWindowProcW(h, msg, wp, lp) }
        }
        // The pointer left the button, or the mouse went to someone else: a press that began here
        // is over, and a release that comes later is no click.
        WM_NCMOUSELEAVE | WM_CAPTURECHANGED => {
            let _ = PRESSED.compare_exchange(h.0 as isize, 0, Ordering::Relaxed, Ordering::Relaxed);
            // SAFETY: the default procedure for this window's own message.
            unsafe { DefWindowProcW(h, msg, wp, lp) }
        }
        // The click must not take the focus from WebView2.
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        // Hovering (WM_NCMOUSEHOVER) goes to Windows, which shows Snap Layouts.
        // SAFETY: the default procedure for this window's own messages.
        _ => unsafe { DefWindowProcW(h, msg, wp, lp) },
    }
}

/// Asks Windows for a `WM_NCMOUSELEAVE` when the pointer leaves `window`. Asked again on every
/// move: Windows forgets it once it has sent one.
fn track_leave(window: HWND) {
    let mut track = TRACKMOUSEEVENT {
        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE | TME_NONCLIENT,
        hwndTrack: window,
        dwHoverTime: 0,
    };
    // SAFETY: `track` is a valid TRACKMOUSEEVENT for a window of this thread. A failure only
    // means no leave message: a stale press then ends at the next press anyway.
    let _ = unsafe { TrackMouseEvent(&mut track) };
}

/// What Windows' maximise button does: maximise, or restore a maximised window. Posted to the
/// main window as the system command, so that its procedure (tao) sees it as it sees the
/// system's own button.
fn toggle_maximized(button: HWND) {
    // SAFETY: plain Win32 calls on window handles; a window that is gone makes them fail.
    unsafe {
        let window = GetAncestor(button, GA_ROOT);
        let command = if IsZoomed(window).as_bool() {
            SC_RESTORE
        } else {
            SC_MAXIMIZE
        };
        if let Err(error) = PostMessageW(
            Some(window),
            WM_SYSCOMMAND,
            WPARAM(command as usize),
            LPARAM(0),
        ) {
            tracing::warn!("cannot maximise or restore the window: {error}");
        }
    }
}

/// Real windows for the tests, owned by the test's thread.
#[cfg(test)]
pub mod testing {
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GW_CHILD, GWL_STYLE,
        GetClassNameW, GetWindow, GetWindowLongPtrW, GetWindowRect, MSG, PM_REMOVE, PeekMessageW,
        RegisterClassW, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos, TranslateMessage,
        WINDOW_EX_STYLE, WNDCLASSW, WS_CHILD, WS_POPUP, WS_VISIBLE,
    };
    use windows::core::{HSTRING, PCWSTR};

    use super::hwnd;

    /// Screen rectangle as (x, y, w, h).
    pub fn window_rect(window: isize) -> (i32, i32, i32, i32) {
        let mut r = RECT::default();
        unsafe { GetWindowRect(hwnd(window), &mut r) }.expect("GetWindowRect");
        (r.left, r.top, r.right - r.left, r.bottom - r.top)
    }

    fn register_class(name: &HSTRING) {
        unsafe extern "system" fn test_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
            unsafe { DefWindowProcW(h, msg, wp, lp) }
        }

        unsafe {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(test_proc),
                hInstance: GetModuleHandleW(None).expect("module").into(),
                lpszClassName: PCWSTR(name.as_ptr()),
                ..Default::default()
            };
            // Fails harmlessly when another test registered the class first.
            RegisterClassW(&wc);
        }
    }

    /// Hidden borderless top-level at (100, 100), client area 400×300.
    pub fn test_parent() -> isize {
        let class = HSTRING::from("KaleidoTestParent");
        register_class(&class);
        unsafe {
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                &class,
                &HSTRING::new(),
                WS_POPUP,
                100,
                100,
                400,
                300,
                None,
                None,
                Some(GetModuleHandleW(None).expect("module").into()),
                None,
            )
            .expect("parent");
            parent.0 as isize
        }
    }

    /// `test_parent()` with one child of class `child_class`.
    pub fn test_windows(child_class: &str) -> (isize, isize) {
        let parent = test_parent();
        let class = HSTRING::from(child_class);
        register_class(&class);
        unsafe {
            let child = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                &class,
                &HSTRING::new(),
                WS_CHILD,
                0,
                0,
                1,
                1,
                Some(hwnd(parent)),
                None,
                Some(GetModuleHandleW(None).expect("module").into()),
                None,
            )
            .expect("child");
            (parent, child.0 as isize)
        }
    }

    /// Dispatches this thread's window messages for `duration`. A child created by another
    /// thread shares our input queue, so its messages can wait on us.
    pub fn pump(duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            let mut msg = MSG::default();
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// First direct child of `parent`, waiting up to `timeout` for one to appear.
    pub fn wait_for_child(parent: isize, timeout: Duration) -> Option<isize> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(child) = unsafe { GetWindow(hwnd(parent), GW_CHILD) } {
                return Some(child.0 as isize);
            }
            if Instant::now() >= deadline {
                return None;
            }
            pump(Duration::from_millis(50));
        }
    }

    /// Moves and resizes a top-level window (screen coordinates), like the user dragging it.
    pub fn set_rect(window: isize, x: i32, y: i32, w: i32, h: i32) {
        unsafe {
            SetWindowPos(
                hwnd(window),
                None,
                x,
                y,
                w,
                h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        }
        .expect("SetWindowPos");
    }

    pub fn class_name(window: isize) -> String {
        let mut name = [0u16; 64];
        let len = unsafe { GetClassNameW(hwnd(window), &mut name) };
        String::from_utf16_lossy(&name[..len.max(0) as usize])
    }

    pub fn destroy(window: isize) {
        let _ = unsafe { DestroyWindow(hwnd(window)) };
    }

    /// Whether the window itself is shown (`WS_VISIBLE`); the test parents never are, so
    /// `IsWindowVisible` would say no for every child.
    pub fn has_visible_style(window: isize) -> bool {
        let style = unsafe { GetWindowLongPtrW(hwnd(window), GWL_STYLE) };
        style & WS_VISIBLE.0 as isize != 0
    }
}

#[cfg(test)]
mod tests {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GW_CHILD, GetWindow, HTMAXBUTTON, HWND_TOP, MSG, PM_REMOVE, PeekMessageW, SC_MAXIMIZE,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SendMessageW, SetWindowPos, WM_NCHITTEST,
        WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_SYSCOMMAND,
    };

    use super::testing::{destroy, has_visible_style, test_windows, window_rect};
    use super::{CAPTION_WINDOW_CLASS, CaptionWindows, PxRect, find_child, hwnd, place};

    /// The lParam of a hit test: screen coordinates, x in the low word, y in the high word.
    fn screen_point(x: i32, y: i32) -> LPARAM {
        LPARAM(((y as isize) << 16) | (x as isize & 0xffff))
    }

    /// Windows hit-tests the window under the pointer, which over the client area is WebView2's (a
    /// child of the main window, placed first, like the test child here). The window over the
    /// maximise button has to be above it and answer `HTMAXBUTTON` itself (caption.rs).
    #[test]
    fn caption_windows_cover_the_button_above_the_webview_and_answer_htmaxbutton() {
        // The parent's client area is at (100, 100); its child stands in for WebView2.
        let (parent, webview) = test_windows("KaleidoTestWebView");
        let mut windows = CaptionWindows::default();
        windows.place(
            parent,
            &[PxRect {
                x: 300,
                y: 10,
                w: 40,
                h: 30,
            }],
        );

        let button = find_child(parent, CAPTION_WINDOW_CLASS).expect("a window over the button");
        assert_eq!(window_rect(button), (400, 110, 40, 30));
        assert!(has_visible_style(button));
        let hit = unsafe {
            SendMessageW(
                hwnd(button),
                WM_NCHITTEST,
                None,
                Some(screen_point(420, 125)),
            )
        };
        assert_eq!(hit.0, HTMAXBUTTON as isize);

        // The webview comes to the top (as wry puts it there); placing the button again puts the
        // window back above it, and moves the same window with the button.
        unsafe {
            SetWindowPos(
                hwnd(webview),
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        }
        .expect("SetWindowPos");
        assert_eq!(top_child(parent), webview);
        windows.place(
            parent,
            &[PxRect {
                x: 200,
                y: 10,
                w: 40,
                h: 30,
            }],
        );
        assert_eq!(top_child(parent), button, "above the webview");
        assert_eq!(window_rect(button), (300, 110, 40, 30));
        assert_eq!(find_child(parent, CAPTION_WINDOW_CLASS), Some(button));

        // No buttons shown: nothing answers for them.
        windows.place(parent, &[]);
        assert!(!has_visible_style(button));
        destroy(parent);
    }

    /// Sends the window over the button what the pointer does there, as Windows would.
    fn send(window: isize, msg: u32) {
        let lp = screen_point(410, 120);
        unsafe {
            SendMessageW(
                hwnd(window),
                msg,
                Some(WPARAM(HTMAXBUTTON as usize)),
                Some(lp),
            )
        };
    }

    /// The system command posted to `parent` since the last call, taken out of the queue before
    /// anything handles it (so the hidden test window is never maximised and shown).
    fn posted_command(parent: isize) -> Option<usize> {
        let mut msg = MSG::default();
        let found = unsafe {
            PeekMessageW(
                &mut msg,
                Some(hwnd(parent)),
                WM_SYSCOMMAND,
                WM_SYSCOMMAND,
                PM_REMOVE,
            )
        };
        found.as_bool().then_some(msg.wParam.0)
    }

    /// A press and a release on the button are a click; a press that left the button (the pointer
    /// went away, WM_NCMOUSELEAVE) is over, and a release later over the button does nothing.
    #[test]
    fn a_click_on_the_button_maximises_but_a_press_that_left_it_does_not() {
        let (parent, _webview) = test_windows("KaleidoTestWebView");
        let mut windows = CaptionWindows::default();
        windows.place(
            parent,
            &[PxRect {
                x: 300,
                y: 10,
                w: 40,
                h: 30,
            }],
        );
        let button = find_child(parent, CAPTION_WINDOW_CLASS).expect("a window over the button");

        // Pressed, the pointer leaves, comes back and is released: no click.
        send(button, WM_NCLBUTTONDOWN);
        send(button, WM_NCMOUSELEAVE);
        send(button, WM_NCLBUTTONUP);
        assert_eq!(posted_command(parent), None);

        // Pressed and released over it: the window is asked to maximise, once.
        send(button, WM_NCLBUTTONDOWN);
        send(button, WM_NCLBUTTONUP);
        assert_eq!(posted_command(parent), Some(SC_MAXIMIZE as usize));
        assert_eq!(posted_command(parent), None);
        destroy(parent);
    }

    /// The topmost direct child of `parent`.
    fn top_child(parent: isize) -> isize {
        unsafe { GetWindow(hwnd(parent), GW_CHILD) }
            .expect("a child")
            .0 as isize
    }

    /// mpv creates its own child window (class "mpv") inside `wid`; we find and move that one.
    #[test]
    fn finds_and_places_a_child_window_by_class() {
        let (parent, child) = test_windows("KaleidoTestChild");
        assert_eq!(find_child(parent, "KaleidoTestChild"), Some(child));
        assert_eq!(find_child(parent, "NoSuchClass"), None);
        place(
            child,
            Some(PxRect {
                x: 10,
                y: 20,
                w: 30,
                h: 40,
            }),
        );
        assert_eq!(window_rect(child), (110, 120, 30, 40));
        destroy(parent);
    }
}
