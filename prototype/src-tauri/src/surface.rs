use std::sync::Mutex;

use serde::Deserialize;

/// Window class of the child window mpv creates inside `wid`.
pub const MPV_WINDOW_CLASS: &str = "mpv";

/// Where the video surface should be, in CSS px of the window (spec 8.3, mini player).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layout {
    Full,
    Rect { x: f64, y: f64, w: f64, h: f64 },
    Hidden,
}

/// Child-window rectangle in physical px.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PxRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// None = hide the surface (explicitly hidden, or nothing visible to show).
pub fn to_physical(layout: Layout, client_w: u32, client_h: u32, scale: f64) -> Option<PxRect> {
    let (cw, ch) = (client_w as i32, client_h as i32);
    if cw <= 0 || ch <= 0 {
        return None;
    }
    match layout {
        Layout::Hidden => None,
        Layout::Full => Some(PxRect {
            x: 0,
            y: 0,
            w: cw,
            h: ch,
        }),
        Layout::Rect { x, y, w, h } => {
            let px = |v: f64, max: i32| ((v * scale).round() as i32).clamp(0, max);
            let (left, top) = (px(x, cw), px(y, ch));
            let (right, bottom) = (px(x + w, cw), px(y + h, ch));
            (right > left && bottom > top).then_some(PxRect {
                x: left,
                y: top,
                w: right - left,
                h: bottom - top,
            })
        }
    }
}

/// Positions mpv's own window (a direct child of the top-level window) for the UI's layout.
///
/// M0 finding: mpv must get the top-level HWND as `wid`. Nested one level deeper (inside a
/// child window of ours) its flip-model swapchain is not composited under the transparent
/// WebView2 and the video area stays see-through.
pub struct SurfaceState {
    parent: isize,
    layout: Mutex<Layout>,
    client: Mutex<(u32, u32, f64)>,
}

impl SurfaceState {
    pub fn new(parent: isize) -> SurfaceState {
        SurfaceState {
            parent,
            layout: Mutex::new(Layout::Full),
            client: Mutex::new((0, 0, 1.0)),
        }
    }

    /// Call on every resize / DPI change (main thread).
    pub fn apply(&self, client_w: u32, client_h: u32, scale: f64) {
        *self.client.lock().unwrap() = (client_w, client_h, scale);
        let layout = *self.layout.lock().unwrap();
        // Until mpv has created its window there is nothing to place; it starts full-size.
        if let Some(mpv) = win::find_child(self.parent, MPV_WINDOW_CLASS) {
            win::place(mpv, to_physical(layout, client_w, client_h, scale));
        }
    }

    pub fn set_layout(&self, layout: Layout) {
        *self.layout.lock().unwrap() = layout;
        let (w, h, scale) = *self.client.lock().unwrap();
        self.apply(w, h, scale);
    }
}

pub mod win {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GW_CHILD, GW_HWNDNEXT, GetClassNameW, GetWindow, HWND_BOTTOM, SWP_HIDEWINDOW,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetWindowPos,
    };

    use super::PxRect;

    fn hwnd(raw: isize) -> HWND {
        HWND(raw as *mut _)
    }

    /// Direct child of `parent` whose window class is `class`.
    pub fn find_child(parent: isize, class: &str) -> Option<isize> {
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

    /// Moves a child window (parent client coordinates); always keeps it under WebView2.
    pub fn place(window: isize, rect: Option<PxRect>) {
        // Failures only mean the window is gone (app shutting down); nothing to recover.
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

    /// Screen rectangle as (x, y, w, h).
    #[cfg(test)]
    pub fn window_rect(window: isize) -> (i32, i32, i32, i32) {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
        let mut r = RECT::default();
        unsafe { GetWindowRect(hwnd(window), &mut r) }.expect("GetWindowRect");
        (r.left, r.top, r.right - r.left, r.bottom - r.top)
    }

    /// Hidden borderless top-level at (100, 100) with one child of class `child_class`.
    #[cfg(test)]
    pub fn test_windows(child_class: &str) -> (isize, isize) {
        use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, RegisterClassW, WINDOW_EX_STYLE, WNDCLASSW, WS_CHILD,
            WS_POPUP,
        };
        use windows::core::{HSTRING, PCWSTR};

        unsafe extern "system" fn test_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
            unsafe { DefWindowProcW(h, msg, wp, lp) }
        }

        unsafe {
            let instance = GetModuleHandleW(None).expect("module");
            let register = |name: &HSTRING| {
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(test_proc),
                    hInstance: instance.into(),
                    lpszClassName: PCWSTR(name.as_ptr()),
                    ..Default::default()
                };
                RegisterClassW(&wc);
            };
            let (parent_class, child_class) = (
                HSTRING::from("KaleidoTestParent"),
                HSTRING::from(child_class),
            );
            register(&parent_class);
            register(&child_class);
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                &parent_class,
                &HSTRING::new(),
                WS_POPUP,
                100,
                100,
                400,
                300,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .expect("parent");
            let child = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                &child_class,
                &HSTRING::new(),
                WS_CHILD,
                0,
                0,
                1,
                1,
                Some(parent),
                None,
                Some(instance.into()),
                None,
            )
            .expect("child");
            (parent.0 as isize, child.0 as isize)
        }
    }

    #[cfg(test)]
    pub fn destroy(window: isize) {
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd(window)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_covers_the_client_area() {
        assert_eq!(
            to_physical(Layout::Full, 1920, 1080, 1.5),
            Some(PxRect {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080
            })
        );
    }

    #[test]
    fn rect_is_scaled_and_rounded() {
        let layout = Layout::Rect {
            x: 10.4,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        };
        assert_eq!(
            to_physical(layout, 1920, 1080, 1.5),
            Some(PxRect {
                x: 16,
                y: 30,
                w: 150,
                h: 75
            })
        );
    }

    #[test]
    fn rect_is_clamped_to_the_client_area() {
        let layout = Layout::Rect {
            x: -10.0,
            y: -10.0,
            w: 50.0,
            h: 50.0,
        };
        assert_eq!(
            to_physical(layout, 40, 30, 1.0),
            Some(PxRect {
                x: 0,
                y: 0,
                w: 40,
                h: 30
            })
        );
    }

    #[test]
    fn minimized_window_hides_surface() {
        assert_eq!(to_physical(Layout::Full, 0, 0, 1.0), None);
    }

    #[test]
    fn rect_outside_the_window_hides_surface() {
        let layout = Layout::Rect {
            x: 500.0,
            y: 10.0,
            w: 50.0,
            h: 50.0,
        };
        assert_eq!(to_physical(layout, 400, 300, 1.0), None);
    }

    #[test]
    fn hidden_is_hidden() {
        assert_eq!(to_physical(Layout::Hidden, 800, 600, 1.0), None);
    }

    /// mpv creates its own child window (class "mpv") inside `wid`; we find and move that one.
    #[test]
    fn finds_and_places_a_child_window_by_class() {
        let (parent, child) = win::test_windows("KaleidoTestChild");
        assert_eq!(win::find_child(parent, "KaleidoTestChild"), Some(child));
        assert_eq!(win::find_child(parent, "NoSuchClass"), None);
        win::place(
            child,
            Some(PxRect {
                x: 10,
                y: 20,
                w: 30,
                h: 40,
            }),
        );
        assert_eq!(win::window_rect(child), (110, 120, 30, 40));
        win::destroy(parent);
    }
}
