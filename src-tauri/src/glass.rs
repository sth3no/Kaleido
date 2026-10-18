//! Glass over the video (spec 8.2, 10.6). CSS `backdrop-filter` cannot see the video (mpv draws
//! it in its own window under WebView2), so the blur is a GLSL shader in mpv. The UI measures
//! its glass elements and Rust sends them to the shader as rounded rectangles through
//! `glsl-shader-opts`, at run time. Only the shader's own keys are merged in and out of that
//! option; the user's shader parameters in it stay.
//!
//! [`GlassController`] owns everything around the shader: it attaches it to `glsl-shaders`
//! next to the user's own, keeps the regions up to date (scale, where mpv's window is, the
//! output origin in it), takes the glass
//! out of screenshots, and switches it off when the GPU cannot run it. It only queues requests
//! on the engine, so it is safe to use on the main thread.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::player::command::ScreenshotMode;
use crate::player::{Engine, LogLine, Request};

/// The event that tells the UI the glass went on or off; its payload is [`GlassState`].
pub const STATE_EVENT: &str = "glass:state";
/// Regions the shader can blur at once (spec 8.2).
pub const MAX_REGIONS: usize = 6;
/// Shader file stem; also the prefix that targets only our params in glsl-shader-opts.
pub const SHADER: &str = "kaleido-glass";
/// Whether libplacebo's OUTPUT texture starts at the video rectangle (inside letterbox
/// bars) instead of the window origin. M0 assumed it and did not confirm it on `letterbox`
/// media (docs/m0/report.md).
pub const OUTPUT_EXCLUDES_MARGINS: bool = true;

const FIELDS: [&str; 6] = ["x", "y", "w", "h", "r", "a"];
/// The mpv option that carries the regions to the shader.
const OPTS: &str = "glsl-shader-opts";
/// The mpv option that lists the user shaders; the glass shader joins them.
const SHADERS: &str = "glsl-shaders";

/// Glass element as measured by the UI: CSS px in window coordinates, radius, opacity.
// `Serialize` only for the IPC contract test, which writes what it read back.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
pub struct GlassRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub r: f64,
    /// How much of the blur shows, 0 to 1. The UI may leave it out: fully.
    #[serde(default = "opaque")]
    pub a: f64,
}

fn opaque() -> f64 {
    1.0
}

/// Window position (physical px) of the OUTPUT texture's top-left corner. [`GlassController`]
/// also keeps the letterbox margins inside mpv's own window in it (`osd-dimensions`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct OutputOrigin {
    pub x: f64,
    pub y: f64,
}

/// Where mpv's window is in the main window, in CSS px of the main window (the coordinates the
/// UI measures its glass in). The surface says so for every layout it places (Ruling R45).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl VideoRect {
    /// Whether any of `rect` is over it. Written so that a NaN anywhere says no.
    fn overlaps(&self, rect: &GlassRect) -> bool {
        rect.x < self.x + self.w
            && self.x < rect.x + rect.w
            && rect.y < self.y + self.h
            && self.y < rect.y + rect.h
    }
}

/// A number mpv can parse: infinity and NaN (a huge rectangle times the scale) become 0.
fn finite(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

/// Value for mpv's `glsl-shader-opts`. Always sets every region so stale ones are cleared.
pub fn shader_opts(rects: &[GlassRect], scale: f64, origin: OutputOrigin) -> String {
    let count = rects.len().min(MAX_REGIONS);
    let mut parts = vec![format!("{SHADER}/count={count}")];
    for i in 0..MAX_REGIONS {
        let [x, y, w, h, r, a] = match rects.get(i) {
            Some(g) => {
                let (w, h) = (g.w * scale, g.h * scale);
                [
                    g.x * scale - origin.x,
                    g.y * scale - origin.y,
                    w,
                    h,
                    (g.r * scale).min(w.min(h) / 2.0),
                    g.a.clamp(0.0, 1.0),
                ]
                .map(finite)
            }
            None => [0.0; 6],
        };
        parts.push(format!(
            "{SHADER}/r{i}x={x:.1},{SHADER}/r{i}y={y:.1},{SHADER}/r{i}w={w:.1},{SHADER}/r{i}h={h:.1},{SHADER}/r{i}r={r:.1},{SHADER}/r{i}a={a:.2}"
        ));
    }
    parts.join(",")
}

/// [`shader_opts`] for regions the UI measured in the main window while mpv's window is at
/// `video` (Ruling R45; `None`: at the window's origin, as wide as the window).
///
/// The UI measures in CSS px of the main window; the shader works in physical px of mpv's OUTPUT
/// texture, which starts where mpv's window is (the mini player moves it off the window's origin)
/// plus the letterbox `margins` inside that window (physical px, `osd-dimensions`). So for x:
///
/// ```text
/// shader x = UI x × scale − (video.x × scale + margins.x)
///          = (UI x − video.x) × scale − margins.x
/// ```
///
/// and the same for y; widths, heights and radii only scale. A region with nothing of it over
/// mpv's window is left out: the shader would draw none of it, and with no region left at all its
/// passes do not run. One that is partly over it stays whole: the texture's edge cuts it.
pub fn region_opts(
    rects: &[GlassRect],
    scale: f64,
    video: Option<VideoRect>,
    margins: OutputOrigin,
) -> String {
    let shown: Vec<GlassRect> = rects
        .iter()
        .filter(|rect| video.is_none_or(|video| video.overlaps(rect)))
        .copied()
        .collect();
    let (x, y) = video.map_or((0.0, 0.0), |video| (video.x, video.y));
    let origin = OutputOrigin {
        x: x * scale + margins.x,
        y: y * scale + margins.y,
    };
    shader_opts(&shown, scale, origin)
}

/// The value with no region at all: what a screenshot is taken with.
fn zeroed_opts() -> String {
    shader_opts(&[], 1.0, OutputOrigin::default())
}

/// Where the shader file goes: its stem is the name `glsl-shader-opts` prefixes target.
pub fn shader_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("shaders").join(format!("{SHADER}.glsl"))
}

/// GLSL user shader (libplacebo syntax): downsampled separable blur + rounded-rect mask.
pub fn shader_source() -> String {
    let mut src = String::from(
        "// Generated by Kaleido (src-tauri/src/glass.rs). Blur under glass UI, spec 8.2.\n\n",
    );
    src += &format!(
        "//!PARAM count\n//!TYPE DYNAMIC int\n//!MINIMUM 0\n//!MAXIMUM {MAX_REGIONS}\n0\n\n"
    );
    for i in 0..MAX_REGIONS {
        for field in FIELDS {
            src += &format!("//!PARAM r{i}{field}\n//!TYPE DYNAMIC float\n0.0\n\n");
        }
    }
    src += BLUR_PASSES;
    let mut regions = String::new();
    for i in 0..MAX_REGIONS {
        regions +=
            &format!("    m = max(m, region(p, r{i}x, r{i}y, r{i}w, r{i}h, r{i}r) * r{i}a);\n");
    }
    src += &COMPOSITE_PASS.replace("{regions}", &regions);
    src
}

/// Horizontal then vertical 13-tap Gaussian on a quarter-resolution copy of OUTPUT.
const BLUR_PASSES: &str = r#"//!HOOK OUTPUT
//!BIND HOOKED
//!SAVE KGLASS_H
//!WIDTH HOOKED.w 4 /
//!HEIGHT HOOKED.h 4 /
//!WHEN count 0 >
//!DESC kaleido-glass blur H
vec4 hook() {
    vec4 c = vec4(0.0);
    float total = 0.0;
    for (int i = -6; i <= 6; i++) {
        float w = exp(-float(i * i) / 18.0);
        c += w * HOOKED_tex(HOOKED_pos + vec2(float(i) * 4.0 * HOOKED_pt.x, 0.0));
        total += w;
    }
    return c / total;
}

//!HOOK OUTPUT
//!BIND KGLASS_H
//!SAVE KGLASS_V
//!WIDTH KGLASS_H.w
//!HEIGHT KGLASS_H.h
//!WHEN count 0 >
//!DESC kaleido-glass blur V
vec4 hook() {
    vec4 c = vec4(0.0);
    float total = 0.0;
    for (int i = -6; i <= 6; i++) {
        float w = exp(-float(i * i) / 18.0);
        c += w * KGLASS_H_tex(KGLASS_H_pos + vec2(0.0, float(i) * KGLASS_H_pt.y));
        total += w;
    }
    return c / total;
}

"#;

/// Mixes the blurred copy back in, masked by antialiased rounded rectangles.
const COMPOSITE_PASS: &str = r#"//!HOOK OUTPUT
//!BIND HOOKED
//!BIND KGLASS_V
//!WHEN count 0 >
//!DESC kaleido-glass composite
float region(vec2 p, float x, float y, float w, float h, float r) {
    if (w <= 0.0 || h <= 0.0) return 0.0;
    vec2 half_size = vec2(w, h) * 0.5;
    vec2 q = abs(p - vec2(x, y) - half_size) - half_size + vec2(r);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    return 1.0 - smoothstep(-0.75, 0.75, d);
}

vec4 hook() {
    vec4 base = HOOKED_tex(HOOKED_pos);
    vec2 p = HOOKED_pos * HOOKED_size;
    float m = 0.0;
{regions}    return mix(base, KGLASS_V_tex(HOOKED_pos), clamp(m, 0.0, 1.0));
}
"#;

// ---------------------------------------------------------------------------------------------
// Screenshots (spec 8.2): the glass is not in them.

/// The word mpv's `screenshot` command (and `script-message kaleido screenshot`) uses.
fn mode_name(mode: ScreenshotMode) -> &'static str {
    match mode {
        ScreenshotMode::Subtitles => "subtitles",
        ScreenshotMode::Video => "video",
        ScreenshotMode::Window => "window",
        ScreenshotMode::EachFrame => "each-frame",
    }
}

/// The mode a `script-message kaleido screenshot <mode>` names.
pub fn parse_mode(name: &str) -> Option<ScreenshotMode> {
    [
        ScreenshotMode::Subtitles,
        ScreenshotMode::Video,
        ScreenshotMode::Window,
        ScreenshotMode::EachFrame,
    ]
    .into_iter()
    .find(|&mode| mode_name(mode) == name)
}

fn args<const N: usize>(args: [&str; N]) -> Vec<String> {
    args.iter().map(|&arg| arg.to_owned()).collect()
}

/// Puts our keys into `glsl-shader-opts` (`value` is a whole [`shader_opts`] string) and leaves
/// the others, the user's own shader parameters, as they are.
fn merge_opts(value: &str) -> Vec<String> {
    args(["change-list", OPTS, "add", value])
}

/// The keys `shader_opts` sets, `kaleido-glass/count` first.
fn opt_keys() -> Vec<String> {
    zeroed_opts()
        .split(',')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, _)| key.to_owned())
        .collect()
}

/// Takes our keys out of `glsl-shader-opts` again, one command each; the user's stay.
fn remove_opts() -> Vec<Vec<String>> {
    opt_keys()
        .iter()
        .map(|key| args(["change-list", OPTS, "remove", key]))
        .collect()
}

/// The mpv commands that take a screenshot without the glass: the regions go (`zeroed`), the
/// screenshot is taken, the regions come back (`current`). `each-frame` is a switch, not one
/// shot: it starts with the regions gone and does not bring them back, because every frame
/// that follows is a screenshot; [`each_frame_off_sequence`] ends it.
pub fn screenshot_sequence(current: &str, zeroed: &str, mode: ScreenshotMode) -> Vec<Vec<String>> {
    let mut sequence = vec![merge_opts(zeroed), args(["screenshot", mode_name(mode)])];
    if mode != ScreenshotMode::EachFrame {
        sequence.push(merge_opts(current));
    }
    sequence
}

/// Turning `each-frame` off: the screenshots stop, then the regions come back.
fn each_frame_off_sequence(restored: &str) -> Vec<Vec<String>> {
    vec![args(["screenshot", "each-frame"]), merge_opts(restored)]
}

// ---------------------------------------------------------------------------------------------
// GPU failure (spec 10.6)

/// Whether mpv complains about the glass shader: an error from the `gpu-next` video output
/// (libplacebo logs under it) that names the shader.
pub fn is_glass_failure(line: &LogLine) -> bool {
    matches!(line.level.as_str(), "error" | "fatal")
        && line.prefix.starts_with("vo/gpu-next")
        && line.text.contains(SHADER)
}

/// Why the glass is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GlassReason {
    /// The user turned transparency off.
    User,
    /// Windows turned transparency effects off, or a high-contrast theme replaced them
    /// (`themes::plan`).
    System,
    /// The shader or the GPU failed (spec 10.6); the glass stays off until Kaleido restarts.
    GpuFailure,
}

/// The payload of `glass:state`: the UI shows opaque panels while the glass is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GlassState {
    pub enabled: bool,
    /// `None` while the glass is on.
    pub reason: Option<GlassReason>,
}

impl GlassState {
    const ON: GlassState = GlassState {
        enabled: true,
        reason: None,
    };

    fn off(reason: GlassReason) -> GlassState {
        GlassState {
            enabled: false,
            reason: Some(reason),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The controller

/// What the controller needs from the app around it. In Kaleido that is the engine and the
/// UI's events ([`AppHost`]); the tests record them.
pub trait GlassHost: Send + Sync + 'static {
    /// Queues `request` on the engine and returns at once. Requests run in the order queued.
    fn request(&self, request: Request);

    /// The glass was switched on or off (`glass:state`).
    fn state_changed(&self, state: &GlassState);
}

struct Shared {
    rects: Vec<GlassRect>,
    /// Physical px per CSS px of the window.
    scale: f64,
    /// Where the picture starts inside mpv's window (letterbox bars), physical px.
    margins: OutputOrigin,
    /// Where mpv's window is in the main window (CSS px); `None` until the surface says, which
    /// is the window's origin.
    video: Option<VideoRect>,
    /// The shader is in `glsl-shaders`.
    attached: bool,
    state: GlassState,
    /// `screenshot each-frame` is on: every frame is a screenshot, so there is no glass.
    each_frame: bool,
    /// The last value of our keys in `glsl-shader-opts` (`None`: none there); a new value that
    /// equals it is not sent.
    pushed: Option<String>,
}

impl Shared {
    /// What `glsl-shader-opts` should say now.
    fn wanted(&self) -> String {
        if self.each_frame {
            zeroed_opts()
        } else {
            region_opts(&self.rects, self.scale, self.video, self.margins)
        }
    }
}

pub struct GlassController {
    host: Arc<dyn GlassHost>,
    /// The shader's path as mpv has it in `glsl-shaders`.
    shader: String,
    shared: Mutex<Shared>,
}

impl GlassController {
    /// Writes the shader to `shader_path` (`shader_path(cache_dir)`) and attaches it to
    /// `glsl-shaders` after the user's shaders. If the file cannot be written the glass starts
    /// off, as after a GPU failure.
    pub fn new(host: Arc<dyn GlassHost>, shader_path: PathBuf) -> GlassController {
        let written = write_shader(&shader_path);
        if let Err(error) = &written {
            tracing::error!(
                "cannot write the glass shader {}: {error}; the glass stays off",
                shader_path.display()
            );
        }
        let controller = GlassController {
            host,
            shader: shader_path.to_string_lossy().into_owned(),
            shared: Mutex::new(Shared {
                rects: Vec::new(),
                scale: 1.0,
                margins: OutputOrigin::default(),
                video: None,
                attached: written.is_ok(),
                state: if written.is_ok() {
                    GlassState::ON
                } else {
                    GlassState::off(GlassReason::GpuFailure)
                },
                each_frame: false,
                pushed: None,
            }),
        };
        if written.is_ok() {
            controller.send([controller.attach()]);
        }
        controller
    }

    /// What `glass:state` says now. The UI asks for it (`glass_state`) when it starts or
    /// reloads: the event comes only when the state changes, and a glass that failed to start
    /// never sent one.
    pub fn state(&self) -> GlassState {
        self.lock().state
    }

    /// The glass shader's path as mpv has it in `glsl-shaders`.
    pub fn shader(&self) -> &str {
        &self.shader
    }

    /// The user's shaders (`glsl-shaders` entries as mpv.conf holds them) replace the ones in
    /// mpv, and the glass shader, if it is on, comes after them again: it blurs what they made.
    pub fn set_user_shaders(&self, user: &[String]) {
        // Under the lock, so that switching the glass on or off cannot come in between.
        let shared = self.lock();
        let mut commands = vec![args(["change-list", SHADERS, "clr", ""])];
        commands.extend(
            user.iter()
                .map(|shader| args(["change-list", SHADERS, "append", shader])),
        );
        if shared.attached {
            commands.push(self.attach());
        }
        self.send(commands);
    }

    /// The regions the UI measured (CSS px). Sent to mpv at once if they changed.
    pub fn set_regions(&self, mut rects: Vec<GlassRect>) {
        rects.truncate(MAX_REGIONS);
        let mut shared = self.lock();
        shared.rects = rects;
        self.push(&mut shared);
    }

    /// The window's scale factor (physical px per CSS px) changed, e.g. on a monitor with
    /// another DPI. The UI's rectangles stay the same, so it sends nothing; the regions mpv
    /// blurs must still follow.
    pub fn set_scale(&self, scale: f64) {
        if !(scale.is_finite() && scale > 0.0) {
            tracing::warn!("the glass ignores the display scale {scale}");
            return;
        }
        let mut shared = self.lock();
        shared.scale = scale;
        self.push(&mut shared);
    }

    /// Where mpv's output starts inside mpv's own window (letterbox bars), from the
    /// `osd-dimensions` property as the UI gets it. Where that window is in the main window is
    /// [`GlassController::set_video_rect`]'s; [`region_opts`] puts the two together.
    pub fn set_origin(&self, osd: &Value) {
        if !OUTPUT_EXCLUDES_MARGINS {
            return;
        }
        let margin = |name: &str| osd.get(name).and_then(Value::as_f64);
        let (Some(x), Some(y)) = (margin("ml"), margin("mt")) else {
            return;
        };
        let mut shared = self.lock();
        shared.margins = OutputOrigin { x, y };
        self.push(&mut shared);
    }

    /// Where mpv's window is in the main window now (CSS px): the surface calls it whenever it
    /// places that window for a layout or the main window changes size (Ruling R45). The UI keeps
    /// measuring its glass in the main window; the regions are moved into mpv's window here, and
    /// the ones beside it are left out (see [`region_opts`]). Sent to mpv only if that changes
    /// what the shader gets.
    pub fn set_video_rect(&self, rect: VideoRect) {
        let VideoRect { x, y, w, h } = rect;
        if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0)
        {
            tracing::warn!("the glass ignores the video rectangle {rect:?}");
            return;
        }
        let mut shared = self.lock();
        shared.video = Some(rect);
        self.push(&mut shared);
    }

    /// Switches the glass on or off. Off removes the shader, so that it costs the GPU nothing.
    /// Asking for what already is does nothing, and after a GPU failure the glass stays off
    /// (a shader that failed here fails again).
    pub fn set_enabled(&self, on: bool, reason: GlassReason) {
        self.switch(on, reason);
    }

    /// Takes a screenshot of the picture without the glass. `EachFrame` switches the screenshots
    /// of every frame on or off, and the glass stays off while they are on.
    pub fn screenshot(&self, mode: ScreenshotMode) {
        let mut shared = self.lock();
        let turning_off = mode == ScreenshotMode::EachFrame && shared.each_frame;
        if mode == ScreenshotMode::EachFrame {
            shared.each_frame = !shared.each_frame;
        }
        if !shared.attached {
            self.send([args(["screenshot", mode_name(mode)])]);
            return;
        }
        // With each-frame on this is the zeroed value, else the regions: what ends up in mpv.
        let current = shared.wanted();
        let commands = if turning_off {
            each_frame_off_sequence(&current)
        } else {
            screenshot_sequence(&current, &zeroed_opts(), mode)
        };
        shared.pushed = Some(current);
        self.send(commands);
    }

    /// Looks at a log line of mpv. A failure of the glass shader switches the glass off, once.
    /// Returns whether this line did.
    pub fn on_log(&self, line: &LogLine) -> bool {
        // A line about a shader that is gone already is old news.
        if !is_glass_failure(line) || !self.lock().state.enabled {
            return false;
        }
        let switched = self.switch(false, GlassReason::GpuFailure);
        if switched {
            tracing::error!(
                "the glass shader failed ({}: {}); the glass is off",
                line.prefix,
                line.text
            );
        }
        switched
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues mpv commands in order. Called with the lock held, so that the commands of two
    /// callers do not mix (a screenshot's three, say).
    fn send(&self, commands: impl IntoIterator<Item = Vec<String>>) {
        for command in commands {
            self.host.request(Request::Command(command));
        }
    }

    fn attach(&self) -> Vec<String> {
        args(["change-list", SHADERS, "append", &self.shader])
    }

    fn detach(&self) -> Vec<String> {
        args(["change-list", SHADERS, "remove", &self.shader])
    }

    /// Merges our keys into `glsl-shader-opts` if the shader is attached and they are not what
    /// mpv has.
    fn push(&self, shared: &mut Shared) {
        if !shared.attached {
            return;
        }
        let wanted = shared.wanted();
        if shared.pushed.as_deref() != Some(wanted.as_str()) {
            self.send([merge_opts(&wanted)]);
            shared.pushed = Some(wanted);
        }
    }

    /// Returns whether the state changed.
    fn switch(&self, on: bool, reason: GlassReason) -> bool {
        let state = {
            let mut shared = self.lock();
            if shared.state.reason == Some(GlassReason::GpuFailure) {
                return false;
            }
            let next = if on {
                GlassState::ON
            } else {
                GlassState::off(reason)
            };
            if on && !shared.attached {
                // The regions first, so that the first frame with the shader has them.
                shared.attached = true;
                shared.pushed = None;
                self.push(&mut shared);
                self.send([self.attach()]);
            } else if !on && shared.attached {
                shared.attached = false;
                self.send([self.detach()]);
                // Our keys only, and only if there are any in mpv.
                if shared.pushed.take().is_some() {
                    self.send(remove_opts());
                }
            }
            if shared.state == next {
                return false;
            }
            shared.state = next;
            next
        };
        // Outside the lock: the host may be slow.
        self.host.state_changed(&state);
        true
    }
}

fn write_shader(path: &Path) -> io::Result<()> {
    let source = shader_source();
    if fs::read_to_string(path).is_ok_and(|existing| existing == source) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, source)
}

/// The host in the app: the managed [`Engine`] and the UI's events.
pub struct AppHost {
    app: AppHandle,
}

impl AppHost {
    pub fn new(app: AppHandle) -> AppHost {
        AppHost { app }
    }
}

impl GlassHost for AppHost {
    fn request(&self, request: Request) {
        match self.app.try_state::<Engine>() {
            Some(engine) => engine.request(request),
            None => tracing::warn!("a glass request is dropped: the player is not running"),
        }
    }

    fn state_changed(&self, state: &GlassState) {
        if let Err(error) = self.app.emit(STATE_EVENT, state) {
            tracing::warn!("cannot send {STATE_EVENT} to the UI: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::player::testing::{NoEvents, headless, temp_paths};

    fn rect(x: f64, y: f64, w: f64, h: f64, r: f64) -> GlassRect {
        GlassRect {
            x,
            y,
            w,
            h,
            r,
            a: 1.0,
        }
    }

    // --- the shader and its options (ported from the M0 prototype) -------------------------

    #[test]
    fn no_rects_disables_every_region() {
        let opts = shader_opts(&[], 1.0, OutputOrigin::default());
        assert!(opts.starts_with("kaleido-glass/count=0,"), "{opts}");
        assert!(opts.contains("kaleido-glass/r5w=0.0"), "{opts}");
    }

    #[test]
    fn rects_are_scaled_offset_and_radius_clamped() {
        let opts = shader_opts(
            &[rect(10.0, 20.0, 100.0, 40.0, 999.0)],
            1.5,
            OutputOrigin { x: 0.0, y: 30.0 },
        );
        for part in [
            "count=1",
            "r0x=15.0",
            "r0y=0.0",
            "r0w=150.0",
            "r0h=60.0",
            "r0r=30.0",
            "r0a=1.00",
        ] {
            assert!(
                opts.contains(&format!("kaleido-glass/{part}")),
                "{part} missing in {opts}"
            );
        }
    }

    #[test]
    fn regions_beyond_the_limit_are_dropped() {
        let many = vec![rect(0.0, 0.0, 10.0, 10.0, 0.0); 9];
        let opts = shader_opts(&many, 1.0, OutputOrigin::default());
        assert!(opts.contains("kaleido-glass/count=6"));
        assert!(!opts.contains("r6x"));
    }

    #[test]
    fn shader_declares_every_param_and_three_passes() {
        let src = shader_source();
        assert_eq!(
            src.matches("//!PARAM ").count(),
            1 + MAX_REGIONS * FIELDS.len()
        );
        assert!(src.contains("//!PARAM r5a"));
        assert_eq!(src.matches("//!HOOK OUTPUT").count(), 3);
        assert_eq!(src.matches("//!WHEN count 0 >").count(), 3);
    }

    /// A rectangle far larger than anything a window has times the scale is infinite, and mpv
    /// refuses the whole option if one value is not a number.
    #[test]
    fn numbers_mpv_cannot_parse_never_reach_it() {
        let huge = rect(f64::MAX, 0.0, f64::MAX, 10.0, 4.0);
        let opts = shader_opts(&[huge], 2.0, OutputOrigin::default());
        assert!(!opts.contains("inf") && !opts.contains("NaN"), "{opts}");
        assert!(opts.contains("kaleido-glass/r0x=0.0"), "{opts}");
    }

    #[test]
    fn the_ui_may_leave_the_opacity_out() {
        let rect: GlassRect =
            serde_json::from_value(json!({ "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0, "r": 5.0 }))
                .unwrap();
        assert_eq!(rect.a, 1.0);
        let rect: GlassRect = serde_json::from_value(
            json!({ "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0, "r": 5.0, "a": 0.5 }),
        )
        .unwrap();
        assert_eq!(rect.a, 0.5);
    }

    // --- the controller, with the requests recorded -----------------------------------------

    /// Records what the controller asks of mpv and the UI.
    #[derive(Default)]
    struct Recorder {
        commands: Mutex<Vec<Vec<String>>>,
        states: Mutex<Vec<GlassState>>,
    }

    impl GlassHost for Recorder {
        fn request(&self, request: Request) {
            // The controller queues commands only.
            let Request::Command(args) = request else {
                panic!("the glass queued something other than a command");
            };
            self.commands.lock().unwrap().push(args);
        }

        fn state_changed(&self, state: &GlassState) {
            self.states.lock().unwrap().push(*state);
        }
    }

    impl Recorder {
        /// The commands since the last call.
        fn take(&self) -> Vec<Vec<String>> {
            std::mem::take(&mut *self.commands.lock().unwrap())
        }

        fn states(&self) -> Vec<GlassState> {
            self.states.lock().unwrap().clone()
        }
    }

    fn cmd(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|&part| part.to_owned()).collect()
    }

    /// A controller with its shader in `dir`, and the shader's path as mpv gets it. The
    /// commands of the start-up are taken already.
    fn started(dir: &Path) -> (Arc<Recorder>, GlassController, String) {
        let host = Arc::new(Recorder::default());
        let path = dir.join("shaders").join("kaleido-glass.glsl");
        let glass = GlassController::new(host.clone(), path.clone());
        host.take();
        (host, glass, path.to_string_lossy().into_owned())
    }

    fn regions(rects: &[GlassRect], scale: f64) -> String {
        shader_opts(rects, scale, OutputOrigin::default())
    }

    /// Putting our keys into `glsl-shader-opts`.
    fn merge(opts: &str) -> Vec<String> {
        cmd(&["change-list", "glsl-shader-opts", "add", opts])
    }

    /// Taking all of our keys out of it.
    fn remove_keys() -> Vec<Vec<String>> {
        opt_keys()
            .iter()
            .map(|key| cmd(&["change-list", "glsl-shader-opts", "remove", key]))
            .collect()
    }

    fn gpu_error(text: &str) -> LogLine {
        LogLine {
            level: "error".into(),
            prefix: "vo/gpu-next/libplacebo".into(),
            text: text.into(),
        }
    }

    #[test]
    fn startup_writes_the_shader_and_attaches_it_after_the_users() {
        let tmp = tempfile::tempdir().unwrap();
        let host = Arc::new(Recorder::default());
        let path = shader_path(&tmp.path().join("cache"));
        let glass = GlassController::new(host.clone(), path.clone());

        assert_eq!(std::fs::read_to_string(&path).unwrap(), shader_source());
        assert_eq!(path.file_name().unwrap(), "kaleido-glass.glsl");
        assert_eq!(
            host.take(),
            [cmd(&[
                "change-list",
                "glsl-shaders",
                "append",
                &path.to_string_lossy()
            ])]
        );
        assert_eq!(glass.state(), GlassState::ON);
        assert!(host.states().is_empty(), "nothing changed yet");
    }

    #[test]
    fn a_shader_that_cannot_be_written_leaves_the_glass_off() {
        let tmp = tempfile::tempdir().unwrap();
        // A folder cannot be made under a file.
        let file = tmp.path().join("file");
        std::fs::write(&file, "").unwrap();
        let host = Arc::new(Recorder::default());
        let glass = GlassController::new(host.clone(), file.join("shaders").join("g.glsl"));

        assert_eq!(glass.state(), GlassState::off(GlassReason::GpuFailure));
        glass.set_regions(vec![rect(0.0, 0.0, 10.0, 10.0, 2.0)]);
        glass.set_enabled(true, GlassReason::User);
        assert!(host.take().is_empty(), "no shader, nothing for mpv");
    }

    /// The UI was not listening when the glass failed to start, and a reload loses the event
    /// too: it asks (`glass_state`) and gets the payload `glass:state` has.
    #[test]
    fn glass_state_reports_a_start_up_failure() {
        let tmp = tempfile::tempdir().unwrap();
        // A folder cannot be made under a file.
        let file = tmp.path().join("file");
        std::fs::write(&file, "").unwrap();
        let host = Arc::new(Recorder::default());
        let glass = GlassController::new(host.clone(), file.join("shaders").join("g.glsl"));

        assert_eq!(
            serde_json::to_value(glass.state()).unwrap(),
            json!({ "enabled": false, "reason": "gpuFailure" })
        );
        assert!(host.states().is_empty(), "no event: nobody listened yet");

        // And a glass that did start says so.
        let (_, running, _) = started(tmp.path());
        assert_eq!(
            serde_json::to_value(running.state()).unwrap(),
            json!({ "enabled": true, "reason": null })
        );
    }

    #[test]
    fn our_option_keys_are_the_ones_the_shader_declares() {
        let keys = opt_keys();
        assert_eq!(keys.len(), 1 + MAX_REGIONS * FIELDS.len());
        assert_eq!(keys[0], "kaleido-glass/count");
        let source = shader_source();
        for key in &keys {
            let param = key.strip_prefix("kaleido-glass/").unwrap();
            assert!(source.contains(&format!("//!PARAM {param}\n")), "{key}");
        }
    }

    #[test]
    fn regions_are_sent_only_when_they_change() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        let panel = rect(10.0, 20.0, 100.0, 40.0, 8.0);

        glass.set_regions(vec![panel]);
        assert_eq!(host.take(), [merge(&regions(&[panel], 1.0))]);
        glass.set_regions(vec![panel]);
        assert!(host.take().is_empty(), "the same regions again");
        glass.set_regions(Vec::new());
        assert_eq!(host.take(), [merge(&regions(&[], 1.0))]);
    }

    /// Moving the window to a monitor with another DPI keeps the CSS rects, so the UI pushes
    /// nothing; the regions mpv blurs must still follow the new scale (spec 8.2).
    #[test]
    fn a_new_scale_reapplies_the_glass_regions() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        let panel = rect(10.0, 20.0, 100.0, 40.0, 8.0);
        glass.set_regions(vec![panel]);
        host.take();

        glass.set_scale(1.5);
        let sent = host.take();
        assert_eq!(sent, [merge(&regions(&[panel], 1.5))]);
        for expected in ["r0x=15.0", "r0y=30.0", "r0w=150.0", "r0h=60.0", "r0r=12.0"] {
            assert!(
                sent[0][3].contains(&format!("kaleido-glass/{expected}")),
                "{expected} missing in {}",
                sent[0][3]
            );
        }

        // Not scales: no change, nothing sent.
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            glass.set_scale(bad);
        }
        assert!(host.take().is_empty());
    }

    #[test]
    fn the_output_origin_follows_osd_dimensions() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        let panel = rect(10.0, 20.0, 100.0, 40.0, 0.0);
        glass.set_regions(vec![panel]);
        host.take();

        // Letterbox bars of 30 px above and below.
        glass.set_origin(&json!({ "w": 1280, "h": 720, "ml": 0, "mt": 30, "mr": 0, "mb": 30 }));
        let origin = OutputOrigin { x: 0.0, y: 30.0 };
        assert_eq!(host.take(), [merge(&shader_opts(&[panel], 1.0, origin))]);
        assert!(shader_opts(&[panel], 1.0, origin).contains("kaleido-glass/r0y=-10.0"));

        glass.set_origin(&json!({ "w": 1280, "h": 720, "ml": 0, "mt": 30 }));
        assert!(host.take().is_empty(), "the same margins again");
        glass.set_origin(&Value::Null);
        glass.set_origin(&json!({ "ml": 5 }));
        assert!(host.take().is_empty(), "no margins, no change");
    }

    /// Ruling R45: in the mini player mpv's window is not at the window's origin. The regions the
    /// UI measured in the window are moved into mpv's window by its place, on top of the
    /// letterbox margins inside it, and a region beside it is left out.
    #[test]
    fn regions_are_shifted_by_the_video_origin() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        glass.set_scale(1.5);
        // The mini player's bar over its video, and a panel of the page far from it.
        let bar = rect(912.0, 650.0, 200.0, 40.0, 20.0);
        let beside = rect(100.0, 100.0, 200.0, 40.0, 8.0);
        glass.set_regions(vec![bar, beside]);
        host.take();

        // mpv's window at (904, 501), 360 × 203 CSS px: the UI's mini player in a 1280 × 720
        // window.
        let mini = VideoRect {
            x: 904.0,
            y: 501.0,
            w: 360.0,
            h: 203.0,
        };
        glass.set_video_rect(mini);
        let sent = host.take();
        assert_eq!(
            sent,
            [merge(&region_opts(
                &[bar, beside],
                1.5,
                Some(mini),
                OutputOrigin::default()
            ))]
        );
        // (912 − 904) × 1.5 and (650 − 501) × 1.5; the sizes only scale.
        let opts = &sent[0][3];
        for part in [
            "count=1",
            "r0x=12.0",
            "r0y=223.5",
            "r0w=300.0",
            "r0h=60.0",
            "r0r=30.0",
            "r1w=0.0",
        ] {
            assert!(
                opts.contains(&format!("kaleido-glass/{part}")),
                "{part} missing in {opts}"
            );
        }
        glass.set_video_rect(mini);
        assert!(host.take().is_empty(), "the same place again");

        // Bars of 2 px above and below the picture inside mpv's window come on top of its place.
        glass.set_origin(&json!({ "w": 540, "h": 305, "ml": 0, "mt": 2, "mr": 0, "mb": 2 }));
        let sent = host.take();
        let opts = &sent[0][3];
        assert!(opts.contains("kaleido-glass/r0y=221.5"), "{opts}");
        assert!(opts.contains("kaleido-glass/r0x=12.0"), "{opts}");

        // The whole window again: both are over the video, at their own place.
        glass.set_origin(&json!({ "w": 1920, "h": 1080, "ml": 0, "mt": 0, "mr": 0, "mb": 0 }));
        glass.set_video_rect(VideoRect {
            x: 0.0,
            y: 0.0,
            w: 1280.0,
            h: 720.0,
        });
        let sent = host.take();
        let opts = &sent.last().unwrap()[3];
        for part in [
            "count=2",
            "r0x=1368.0",
            "r0y=975.0",
            "r1x=150.0",
            "r1y=150.0",
        ] {
            assert!(
                opts.contains(&format!("kaleido-glass/{part}")),
                "{part} missing in {opts}"
            );
        }

        // Not rectangles: ignored.
        for (w, h) in [
            (0.0, 10.0),
            (-5.0, 10.0),
            (f64::NAN, 10.0),
            (10.0, f64::INFINITY),
        ] {
            glass.set_video_rect(VideoRect {
                x: 0.0,
                y: 0.0,
                w,
                h,
            });
        }
        assert!(host.take().is_empty());
    }

    /// Without a place from the surface the regions are where the UI measured them, as before.
    #[test]
    fn regions_without_a_video_rect_stay_where_they_were_measured() {
        let panel = rect(10.0, 20.0, 100.0, 40.0, 8.0);
        let origin = OutputOrigin { x: 0.0, y: 30.0 };
        assert_eq!(
            region_opts(&[panel], 1.5, None, origin),
            shader_opts(&[panel], 1.5, origin)
        );
        // A region that only touches the edge of mpv's window is not over it.
        let video = VideoRect {
            x: 110.0,
            y: 0.0,
            w: 50.0,
            h: 50.0,
        };
        assert!(
            region_opts(&[panel], 1.0, Some(video), OutputOrigin::default()).contains("count=0")
        );
    }

    #[test]
    fn screenshot_suspends_glass_around_the_command() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        let panel = rect(10.0, 20.0, 100.0, 40.0, 8.0);
        glass.set_regions(vec![panel]);
        host.take();

        glass.screenshot(ScreenshotMode::Video);
        let (current, zeroed) = (regions(&[panel], 1.0), regions(&[], 1.0));
        assert_ne!(current, zeroed);
        assert_eq!(
            host.take(),
            [
                merge(&zeroed),
                cmd(&["screenshot", "video"]),
                merge(&current)
            ]
        );
        // Back to normal: a region change is still sent.
        glass.set_regions(Vec::new());
        assert_eq!(host.take(), [merge(&zeroed)]);

        // The same as a pure function, for every one-shot mode.
        for (mode, flag) in [
            (ScreenshotMode::Subtitles, "subtitles"),
            (ScreenshotMode::Video, "video"),
            (ScreenshotMode::Window, "window"),
        ] {
            assert_eq!(
                screenshot_sequence("regions", "none", mode),
                [merge("none"), cmd(&["screenshot", flag]), merge("regions")]
            );
        }
    }

    #[test]
    fn each_frame_keeps_glass_off_until_toggled_again() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        let first = rect(10.0, 20.0, 100.0, 40.0, 8.0);
        let second = rect(30.0, 40.0, 50.0, 50.0, 4.0);
        let zeroed = regions(&[], 1.0);
        glass.set_regions(vec![first]);
        host.take();

        // On: the glass goes and is not brought back.
        glass.screenshot(ScreenshotMode::EachFrame);
        assert_eq!(
            host.take(),
            [merge(&zeroed), cmd(&["screenshot", "each-frame"])]
        );
        assert_eq!(
            screenshot_sequence("regions", &zeroed, ScreenshotMode::EachFrame),
            [merge(&zeroed), cmd(&["screenshot", "each-frame"])]
        );

        // New regions and a new scale are remembered and not shown.
        glass.set_regions(vec![second]);
        glass.set_scale(2.0);
        assert!(host.take().is_empty(), "the glass stays off");
        // Another screenshot in between does not bring it back either.
        glass.screenshot(ScreenshotMode::Video);
        assert_eq!(
            host.take(),
            [
                merge(&zeroed),
                cmd(&["screenshot", "video"]),
                merge(&zeroed)
            ]
        );

        // Off: the screenshots stop and the latest regions come back.
        glass.screenshot(ScreenshotMode::EachFrame);
        assert_eq!(
            host.take(),
            [
                cmd(&["screenshot", "each-frame"]),
                merge(&regions(&[second], 2.0))
            ]
        );
        glass.set_regions(vec![first]);
        assert_eq!(host.take(), [merge(&regions(&[first], 2.0))]);
    }

    #[test]
    fn a_switched_off_glass_sends_nothing_and_takes_plain_screenshots() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, path) = started(tmp.path());
        let panel = rect(10.0, 20.0, 100.0, 40.0, 8.0);
        let other = rect(30.0, 40.0, 50.0, 50.0, 4.0);
        glass.set_regions(vec![panel]);
        host.take();

        // Off: the shader goes, and our keys with it; the user's keys stay.
        glass.set_enabled(false, GlassReason::User);
        let mut removed = vec![cmd(&["change-list", "glsl-shaders", "remove", &path])];
        removed.extend(remove_keys());
        assert_eq!(host.take(), removed);
        glass.set_regions(vec![other]);
        glass.screenshot(ScreenshotMode::Video);
        assert_eq!(host.take(), [cmd(&["screenshot", "video"])]);

        // On again: the regions first, then the shader.
        glass.set_enabled(true, GlassReason::User);
        assert_eq!(
            host.take(),
            [
                merge(&regions(&[other], 1.0)),
                cmd(&["change-list", "glsl-shaders", "append", &path])
            ]
        );
        glass.set_enabled(true, GlassReason::System);
        assert!(host.take().is_empty(), "already on");
        assert_eq!(
            host.states(),
            [GlassState::off(GlassReason::User), GlassState::ON]
        );
    }

    #[test]
    fn glass_states_are_sent_as_the_ui_reads_them() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());

        glass.set_enabled(false, GlassReason::System);
        glass.set_enabled(false, GlassReason::System);
        glass.set_enabled(false, GlassReason::User);
        glass.set_enabled(true, GlassReason::User);
        let sent: Vec<Value> = host
            .states()
            .iter()
            .map(|state| serde_json::to_value(state).unwrap())
            .collect();
        assert_eq!(
            sent,
            [
                json!({ "enabled": false, "reason": "system" }),
                json!({ "enabled": false, "reason": "user" }),
                json!({ "enabled": true, "reason": null }),
            ]
        );
    }

    #[test]
    fn shader_errors_switch_glass_off_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, path) = started(tmp.path());
        glass.set_regions(vec![rect(10.0, 20.0, 100.0, 40.0, 8.0)]);
        host.take();

        assert!(glass.on_log(&gpu_error("Failed compiling pass 'kaleido-glass blur H'")));
        assert!(!glass.on_log(&gpu_error(
            "Failed compiling pass 'kaleido-glass composite'"
        )));

        assert_eq!(host.states(), [GlassState::off(GlassReason::GpuFailure)]);
        assert_eq!(
            serde_json::to_value(host.states()[0]).unwrap(),
            json!({ "enabled": false, "reason": "gpuFailure" })
        );
        assert_eq!(glass.state(), host.states()[0], "what the UI asks for");
        // The shader and our keys go once, not for each line.
        let mut removed = vec![cmd(&["change-list", "glsl-shaders", "remove", &path])];
        removed.extend(remove_keys());
        assert_eq!(host.take(), removed);
    }

    #[test]
    fn a_failed_glass_stays_off_when_asked_to_turn_on_again() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        glass.on_log(&gpu_error("kaleido-glass blur H failed"));
        host.take();

        // What the appearance settings do after any change.
        glass.set_enabled(true, GlassReason::User);
        glass.set_enabled(false, GlassReason::System);
        glass.set_regions(vec![rect(0.0, 0.0, 10.0, 10.0, 2.0)]);
        assert!(host.take().is_empty());
        assert_eq!(glass.state(), GlassState::off(GlassReason::GpuFailure));
        assert_eq!(host.states().len(), 1);
    }

    #[test]
    fn a_late_error_about_a_glass_that_was_switched_off_changes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, _) = started(tmp.path());
        glass.set_enabled(false, GlassReason::User);

        assert!(!glass.on_log(&gpu_error("kaleido-glass blur H failed")));
        assert_eq!(glass.state(), GlassState::off(GlassReason::User));
        assert_eq!(host.states().len(), 1);
    }

    #[test]
    fn only_glass_shader_errors_count_as_failures() {
        let line = |level: &str, prefix: &str, text: &str| LogLine {
            level: level.into(),
            prefix: prefix.into(),
            text: text.into(),
        };
        assert!(is_glass_failure(&line(
            "error",
            "vo/gpu-next/libplacebo",
            "kaleido-glass composite"
        )));
        assert!(is_glass_failure(&line(
            "fatal",
            "vo/gpu-next",
            "cannot load kaleido-glass.glsl"
        )));
        // A warning, someone else's shader, another video output, another module.
        assert!(!is_glass_failure(&line(
            "warn",
            "vo/gpu-next/libplacebo",
            "kaleido-glass blur H"
        )));
        assert!(!is_glass_failure(&line(
            "error",
            "vo/gpu-next/libplacebo",
            "user.glsl failed"
        )));
        assert!(!is_glass_failure(&line("error", "vo/gpu", "kaleido-glass")));
        assert!(!is_glass_failure(&line(
            "error",
            "cplayer",
            "kaleido-glass"
        )));
    }

    /// The settings re-list the user's shaders (Task 10): the glass shader stays after them.
    #[test]
    fn user_shaders_are_listed_before_the_glass_shader() {
        let tmp = tempfile::tempdir().unwrap();
        let (host, glass, path) = started(tmp.path());
        let clear = cmd(&["change-list", "glsl-shaders", "clr", ""]);

        glass.set_user_shaders(&["~~/shaders/a.glsl".into(), "~~/shaders/b.glsl".into()]);
        assert_eq!(
            host.take(),
            [
                clear.clone(),
                cmd(&["change-list", "glsl-shaders", "append", "~~/shaders/a.glsl"]),
                cmd(&["change-list", "glsl-shaders", "append", "~~/shaders/b.glsl"]),
                cmd(&["change-list", "glsl-shaders", "append", &path]),
            ]
        );
        assert_eq!(glass.shader(), path);

        // With the glass off, the user's shaders alone.
        glass.set_enabled(false, GlassReason::User);
        host.take();
        glass.set_user_shaders(&[]);
        assert_eq!(host.take(), [clear]);
    }

    #[test]
    fn screenshot_modes_are_the_words_of_the_script_message() {
        for (name, mode) in [
            ("subtitles", ScreenshotMode::Subtitles),
            ("video", ScreenshotMode::Video),
            ("window", ScreenshotMode::Window),
            ("each-frame", ScreenshotMode::EachFrame),
        ] {
            assert_eq!(parse_mode(name), Some(mode));
        }
        assert_eq!(parse_mode("everything"), None);
        assert_eq!(parse_mode("eachFrame"), None);
    }

    // --- the real libmpv --------------------------------------------------------------------

    struct EngineHost(Arc<Engine>);

    impl GlassHost for EngineHost {
        fn request(&self, request: Request) {
            self.0.request(request);
        }

        fn state_changed(&self, _state: &GlassState) {}
    }

    /// A headless core with the user's `mpv.conf`, and a glass controller on it.
    fn real(dir: &Path, mpv_conf: &str) -> (Arc<Engine>, GlassController) {
        let paths = temp_paths(dir);
        std::fs::write(paths.config_dir.join("mpv.conf"), mpv_conf).unwrap();
        let engine = Arc::new(Engine::start(headless(paths.clone()), NoEvents).unwrap());
        let glass = GlassController::new(
            Arc::new(EngineHost(Arc::clone(&engine))),
            shader_path(&paths.cache_dir),
        );
        (engine, glass)
    }

    fn property(engine: &Engine, name: &'static str) -> String {
        engine.call(move |mpv| mpv.get_string(name).unwrap())
    }

    #[test]
    fn user_shaders_and_glass_shader_coexist() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, _glass) = real(tmp.path(), "glsl-shaders=~~/shaders/user.glsl\n");

        let shaders = property(&engine, "glsl-shaders");
        assert!(shaders.contains("user.glsl"), "{shaders}");
        assert!(shaders.contains("kaleido-glass.glsl"), "{shaders}");
        assert!(
            shaders.find("user.glsl") < shaders.find("kaleido-glass.glsl"),
            "the glass blurs what the user's shaders made: {shaders}"
        );
    }

    #[test]
    fn disabling_glass_removes_the_shader() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, glass) = real(tmp.path(), "glsl-shaders=~~/shaders/user.glsl\n");

        glass.set_enabled(false, GlassReason::User);
        let shaders = property(&engine, "glsl-shaders");
        assert!(!shaders.contains("kaleido-glass"), "{shaders}");
        assert!(
            shaders.contains("user.glsl"),
            "the user's own stays: {shaders}"
        );

        // On again, asked twice: once in the list.
        glass.set_enabled(true, GlassReason::User);
        glass.set_enabled(true, GlassReason::System);
        let shaders = property(&engine, "glsl-shaders");
        assert_eq!(
            shaders.matches("kaleido-glass.glsl").count(),
            1,
            "{shaders}"
        );
        assert!(shaders.contains("user.glsl"), "{shaders}");
    }

    #[test]
    fn regions_reach_mpv_as_shader_options() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, glass) = real(tmp.path(), "");

        glass.set_regions(vec![rect(10.0, 20.0, 100.0, 40.0, 8.0)]);
        glass.set_scale(1.5);
        let opts = property(&engine, "glsl-shader-opts");
        for expected in ["count=1", "r0x=15.0", "r0y=30.0", "r0w=150.0", "r0h=60.0"] {
            assert!(
                opts.contains(&format!("kaleido-glass/{expected}")),
                "{expected} missing in {opts}"
            );
        }
        // The new value replaces the old one key by key.
        glass.set_regions(Vec::new());
        let opts = property(&engine, "glsl-shader-opts");
        assert!(opts.contains("kaleido-glass/count=0"), "{opts}");
        assert!(!opts.contains("kaleido-glass/count=1"), "{opts}");
    }

    /// The user's own shader parameters share the option with ours (spec 8.2).
    #[test]
    fn user_shader_opts_survive_glass_pushes() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, glass) = real(tmp.path(), "glsl-shader-opts=user/x=1\n");

        glass.set_regions(vec![rect(10.0, 20.0, 100.0, 40.0, 8.0)]);
        let opts = property(&engine, "glsl-shader-opts");
        assert!(opts.contains("user/x=1"), "{opts}");
        for ours in ["count=1", "r0x=10.0", "r0y=20.0", "r0w=100.0"] {
            assert!(opts.contains(&format!("kaleido-glass/{ours}")), "{opts}");
        }

        // Another push replaces our keys; it does not pile up new ones next to them.
        glass.set_regions(vec![
            rect(30.0, 40.0, 50.0, 50.0, 4.0),
            rect(0.0, 0.0, 20.0, 20.0, 2.0),
        ]);
        let opts = property(&engine, "glsl-shader-opts");
        assert!(opts.contains("user/x=1"), "{opts}");
        assert!(opts.contains("kaleido-glass/count=2"), "{opts}");
        assert_eq!(opts.matches("kaleido-glass/count=").count(), 1, "{opts}");
        assert_eq!(opts.matches("user/x=").count(), 1, "{opts}");

        // Switched off, the glass takes its keys with it and leaves the user's.
        glass.set_enabled(false, GlassReason::User);
        let opts = property(&engine, "glsl-shader-opts");
        assert!(opts.contains("user/x=1"), "{opts}");
        assert!(!opts.contains("kaleido-glass/"), "{opts}");
    }
}
