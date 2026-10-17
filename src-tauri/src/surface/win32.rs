//! The Win32 calls behind the surface: finding mpv's window, moving it, and keeping it where
//! Kaleido put it against libmpv, which moves it back (spec 5.1).

use std::sync::{Mutex, PoisonError};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, GW_CHILD, GW_HWNDNEXT, GWLP_WNDPROC, GetClassNameW, GetWindow,
    GetWindowLongPtrW, HWND_BOTTOM, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, WINDOWPOS, WM_NCDESTROY,
    WM_WINDOWPOSCHANGED, WNDPROC,
};

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

/// Real windows for the tests, owned by the test's thread.
#[cfg(test)]
pub mod testing {
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GW_CHILD, GetClassNameW,
        GetWindow, GetWindowRect, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, SWP_NOACTIVATE,
        SWP_NOZORDER, SetWindowPos, TranslateMessage, WINDOW_EX_STYLE, WNDCLASSW, WS_CHILD,
        WS_POPUP,
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
}

#[cfg(test)]
mod tests {
    use super::testing::{destroy, test_windows, window_rect};
    use super::{PxRect, find_child, place};

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
