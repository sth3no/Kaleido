//! Where the UI wants the video (spec 8.3, 8.6) and the rectangle that makes in the main window's
//! client area.

use serde::Deserialize;

/// Where the video surface should be, in CSS px of the window (the UI's coordinates, before the
/// display scale).
// `Serialize` only for the IPC contract test, which writes what it read back.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layout {
    /// The whole client area (the player page).
    Full,
    /// A frame of the animation between the player and the mini player.
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
    /// The mini player at rest: `w`×`h` with its bottom-right corner `right` and `bottom` from
    /// the window's, wherever that corner goes when the window is resized.
    Mini {
        w: f64,
        h: f64,
        right: f64,
        bottom: f64,
    },
    Hidden,
}

/// Child-window rectangle in physical px of the client area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PxRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// How far past the UI's hole mpv's window goes on every side, in physical px (Ruling R47). The
/// UI cuts the hole in CSS px from its own reading of the window, and rounds nothing; this side
/// rounds the margins and the size to whole physical px apart. At a display scale such as 125 or
/// 150 % the two can be half a pixel or so apart, which would show a seam of whatever is under
/// the WebView between the page and the video. A window that is a little too large is covered by
/// the page (and the frame's edge) instead.
pub const OVERSCAN: i32 = 1;

/// `rect` grown by [`OVERSCAN`] on every side, inside the client area.
fn overscan(rect: PxRect, client_w: i32, client_h: i32) -> PxRect {
    let left = (rect.x - OVERSCAN).max(0);
    let top = (rect.y - OVERSCAN).max(0);
    let right = (rect.x + rect.w + OVERSCAN).min(client_w);
    let bottom = (rect.y + rect.h + OVERSCAN).min(client_h);
    PxRect {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    }
}

/// The CSS px rectangle `x`, `y`, `w`, `h` in physical px of a client area of
/// `client_w`×`client_h` at `scale`: its edges rounded, clamped to the client area. `None` when
/// nothing of it is inside (or the client area is empty). As it is, with no overscan: the window
/// buttons Windows hit-tests (`caption`) take it so.
pub fn rect_to_physical(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    client_w: u32,
    client_h: u32,
    scale: f64,
) -> Option<PxRect> {
    let (cw, ch) = (i32::try_from(client_w).ok()?, i32::try_from(client_h).ok()?);
    if cw <= 0 || ch <= 0 {
        return None;
    }
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

/// The rectangle of `layout` in a client area of `client_w`×`client_h` physical px at `scale`.
/// None = hide the surface: explicitly hidden, or nothing of it is visible (a minimized window
/// has a 0×0 client area). A frame of the animation and the mini player overfill the UI's hole
/// by [`OVERSCAN`].
pub fn to_physical(layout: Layout, client_w: u32, client_h: u32, scale: f64) -> Option<PxRect> {
    let (cw, ch) = (i32::try_from(client_w).ok()?, i32::try_from(client_h).ok()?);
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
        Layout::Rect { x, y, w, h } => rect_to_physical(x, y, w, h, client_w, client_h, scale)
            .map(|rect| overscan(rect, cw, ch)),
        Layout::Mini {
            w,
            h,
            right,
            bottom,
        } => {
            // Margins and size are rounded on their own, so the size does not change by a pixel
            // (and mpv does not resize its swapchain) while the window is resized.
            let (right, bottom) = (
                (right.max(0.0) * scale).round(),
                (bottom.max(0.0) * scale).round(),
            );
            let (w, h) = (w * scale, h * scale);
            // Written so that NaN is refused too.
            if !(w > 0.0 && h > 0.0) {
                return None;
            }
            // A window too small for it keeps the margins on all four sides and gets a smaller
            // mini player with the same aspect ratio; it is never squashed.
            let room_w = f64::from(cw) - 2.0 * right;
            let room_h = f64::from(ch) - 2.0 * bottom;
            let fit = (room_w / w).min(room_h / h).min(1.0);
            // No room for it at all ends at or below 0 here.
            let (w, h) = ((w * fit).round() as i32, (h * fit).round() as i32);
            (w > 0 && h > 0).then(|| {
                let rect = PxRect {
                    x: cw - right as i32 - w,
                    y: ch - bottom as i32 - h,
                    w,
                    h,
                };
                overscan(rect, cw, ch)
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::{Layout, OVERSCAN, PxRect, to_physical};

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

    /// (16, 30) to (166, 105), and a pixel more on every side (Ruling R47).
    #[test]
    fn rect_is_scaled_rounded_and_overscanned() {
        let layout = Layout::Rect {
            x: 10.4,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        };
        assert_eq!(
            to_physical(layout, 1920, 1080, 1.5),
            Some(PxRect {
                x: 15,
                y: 29,
                w: 152,
                h: 77
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
        assert_eq!(to_physical(MINI, 0, 0, 1.0), None);
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

    /// The UI's mini player: 360 CSS px wide, 16:9, 16 px from the bottom-right corner.
    const MINI: Layout = Layout::Mini {
        w: 360.0,
        h: 202.0,
        right: 16.0,
        bottom: 16.0,
    };

    #[test]
    fn mini_stays_anchored_bottom_right_after_resize() {
        for (width, height) in [(1280, 720), (1600, 900)] {
            assert_eq!(
                to_physical(MINI, width, height, 1.0),
                Some(PxRect {
                    x: width as i32 - 16 - 360 - OVERSCAN,
                    y: height as i32 - 16 - 202 - OVERSCAN,
                    w: 360 + 2 * OVERSCAN,
                    h: 202 + 2 * OVERSCAN
                }),
                "{width}×{height}"
            );
        }
    }

    /// A mini player flush with the window's edges does not go past them.
    #[test]
    fn the_overscan_stays_inside_the_client_area() {
        let flush = Layout::Mini {
            w: 360.0,
            h: 202.0,
            right: 0.0,
            bottom: 0.0,
        };
        assert_eq!(
            to_physical(flush, 1280, 720, 1.0),
            Some(PxRect {
                x: 1280 - 360 - OVERSCAN,
                y: 720 - 202 - OVERSCAN,
                w: 360 + OVERSCAN,
                h: 202 + OVERSCAN
            })
        );
    }

    /// A window smaller than the mini player and its margins (spec review focus 5): smaller, with
    /// the video's aspect ratio, still in the corner and inside the window.
    #[test]
    fn mini_shrinks_with_aspect_instead_of_squashing() {
        let rect = to_physical(MINI, 300, 200, 1.0).expect("a mini player");
        let unsquashed_h = f64::from(rect.w) * 202.0 / 360.0;
        assert!(
            (f64::from(rect.h) - unsquashed_h).abs() <= 1.0,
            "{rect:?} is not 360:202"
        );
        assert!(rect.w < 360, "{rect:?} did not shrink");
        assert_eq!(
            (rect.x + rect.w, rect.y + rect.h),
            (300 - 16 + OVERSCAN, 200 - 16 + OVERSCAN),
            "{rect:?} left the corner"
        );
        assert!(rect.x >= 0 && rect.y >= 0, "{rect:?} is outside the window");
    }

    /// One case of the table both sides test against (tests/fixtures/surface/mini_layout.json):
    /// the UI computes `hole` from `aspect` and `zoom` (src/surface/mini.test.ts); here the
    /// `layout` it sends is placed at `placement`.
    #[derive(Deserialize)]
    struct Golden {
        name: String,
        client: Size,
        scale: f64,
        layout: Layout,
        hole: Area,
        placement: Area,
    }

    #[derive(Deserialize)]
    struct Size {
        w: u32,
        h: u32,
    }

    #[derive(Deserialize)]
    struct Area {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    #[derive(Deserialize)]
    struct Table {
        cases: Vec<Golden>,
    }

    /// Ruling R47: the UI's hole and mpv's window come from the same numbers on both sides, and
    /// mpv's window always covers the whole hole, also at 125, 150 and 175 % and for a client that
    /// is no whole number of CSS px (1921 × 1081 at 150 %).
    #[test]
    fn mini_placement_matches_the_shared_table_and_overfills_the_hole() {
        let table: Table = serde_json::from_str(include_str!(
            "../../tests/fixtures/surface/mini_layout.json"
        ))
        .expect("the table parses");
        assert!(table.cases.len() >= 8, "the table has its cases");
        for case in &table.cases {
            let Golden {
                name,
                client,
                scale,
                layout,
                hole,
                placement,
            } = case;
            let placed = to_physical(*layout, client.w, client.h, *scale)
                .unwrap_or_else(|| panic!("{name}: no mini player"));
            assert_eq!(
                (
                    f64::from(placed.x),
                    f64::from(placed.y),
                    f64::from(placed.w),
                    f64::from(placed.h)
                ),
                (placement.x, placement.y, placement.w, placement.h),
                "{name}"
            );
            // The hole in physical px lies inside mpv's window (the table rounds the hole to
            // thousandths of a CSS px).
            let slack = 0.01;
            let (left, top) = (hole.x * scale, hole.y * scale);
            let (right, bottom) = ((hole.x + hole.w) * scale, (hole.y + hole.h) * scale);
            assert!(
                left >= f64::from(placed.x) - slack
                    && top >= f64::from(placed.y) - slack
                    && right <= f64::from(placed.x + placed.w) + slack
                    && bottom <= f64::from(placed.y + placed.h) + slack,
                "{name}: the hole ({left}, {top}) to ({right}, {bottom}) is not inside {placed:?}"
            );
        }
    }

    /// A mini player without a positive size (a UI bug) is not shown anywhere.
    #[test]
    fn mini_without_a_size_hides_surface() {
        for (w, h) in [(0.0, 202.0), (-360.0, -202.0), (f64::NAN, 202.0)] {
            let layout = Layout::Mini {
                w,
                h,
                right: 16.0,
                bottom: 16.0,
            };
            assert_eq!(to_physical(layout, 1280, 720, 1.0), None, "{w}×{h}");
        }
    }

    /// The shape `surface_set_layout` receives from the UI.
    #[test]
    fn layouts_deserialize_from_the_ui_contract() {
        let layout = |value| serde_json::from_value::<Layout>(value).unwrap();
        assert_eq!(layout(json!({"kind": "full"})), Layout::Full);
        assert_eq!(layout(json!({"kind": "hidden"})), Layout::Hidden);
        assert_eq!(
            layout(json!({"kind": "rect", "x": 1.5, "y": 2, "w": 3, "h": 4})),
            Layout::Rect {
                x: 1.5,
                y: 2.0,
                w: 3.0,
                h: 4.0
            }
        );
        assert_eq!(
            layout(json!({"kind": "mini", "w": 360, "h": 202, "right": 16, "bottom": 16})),
            MINI
        );
    }
}
