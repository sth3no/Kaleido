//! The parts of the appearance that depend on Windows (spec 8.1, 8.9, 10.6): whether Windows
//! gives transparency effects, whether a high-contrast theme is on, and which build it is
//! (Mica needs Windows 11). From these and the appearance settings Rust decides three things on
//! its own, with the same rules as the UI (`src/theme/tokens.ts`):
//!
//! - the glass shader: off when the glass is reduced to opaque, which saves the GPU;
//! - the window effect: Mica, on Windows 11 only (Windows 10 has none, the UI paints a gradient);
//! - the window's theme, so that Mica has the colour the UI has when the mode is not "system".
//!
//! The decision itself ([`plan`]) is a pure function. [`start`], [`refresh`] and
//! [`on_settings_changed`] read the inputs and carry it out.

use std::ffi::c_void;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use serde_json::Value;
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewWindow};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows::Win32::UI::WindowsAndMessaging::{
    SPI_GETHIGHCONTRAST, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW,
};
use windows::core::w;

use crate::glass::{GlassController, GlassReason};
use crate::settings::{Appearance, ReduceTransparency, SharedSettings, ThemeMode, lock};
use crate::surface::MAIN_WINDOW;
use crate::system::diagnostics;

/// The event that tells the UI Windows' appearance changed; its payload is [`SystemAppearance`].
pub const APPEARANCE_CHANGED_EVENT: &str = "system:appearance-changed";

/// The first Windows 11 build: Mica (the undocumented switch of 21H2 and the documented backdrop
/// type after it) exists from here on.
pub const MICA_MIN_BUILD: u32 = 22_000;

/// What Windows says about the look of the desktop. The UI reads it with `system_appearance`
/// and hears `system:appearance-changed` when it changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppearance {
    /// Windows' "Transparency effects" switch.
    pub transparency_effects: bool,
    /// A high-contrast theme is on.
    pub high_contrast: bool,
    /// The Windows build number; 0 if it could not be read.
    pub windows_build: u32,
}

impl SystemAppearance {
    /// Whether effects that show through (glass, Mica) can be had at all: the switch is on and a
    /// high-contrast theme, which paints with system colours, is not.
    pub fn effects_available(&self) -> bool {
        self.transparency_effects && !self.high_contrast
    }
}

/// Windows' "Transparency effects" from `EnableTransparency` (a DWORD; `None` where there is no
/// such value). A value that is not there counts as on: Windows has it on until it is switched.
pub fn transparency_from_registry(value: Option<u32>) -> bool {
    value != Some(0)
}

/// Whether this build of Windows has Mica.
pub fn mica_supported(build: u32) -> bool {
    build >= MICA_MIN_BUILD
}

/// Whether the glass shader runs. The same rule as the UI's `resolveReduceTransparency`, which
/// draws the opaque glass when this is false: `Auto` follows Windows, the others are the user's
/// word.
pub fn glass_enabled(reduce: ReduceTransparency, transparency_effects: bool) -> bool {
    match reduce {
        ReduceTransparency::Auto => transparency_effects,
        ReduceTransparency::On => false,
        ReduceTransparency::Off => true,
    }
}

/// What the appearance asks of the window and the glass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// The window has Mica.
    pub mica: bool,
    /// The window's theme; `None` follows Windows (mode "system").
    pub theme: Option<Theme>,
    /// `None`: the glass is on. Else why it is off, for `GlassController::set_enabled`.
    pub glass_off: Option<GlassReason>,
}

/// The decision, from the appearance settings and Windows. Mica needs the switch, Windows 11 and
/// glass that is not reduced: reducing transparency takes away everything that shows through.
/// The glass is off for the user when they said so (`On`), else for the system.
pub fn plan(appearance: &Appearance, system: &SystemAppearance) -> Plan {
    let reduce = appearance.reduce_transparency;
    let glass = glass_enabled(reduce, system.effects_available());
    Plan {
        mica: appearance.mica && mica_supported(system.windows_build) && glass,
        theme: match appearance.mode {
            ThemeMode::System => None,
            ThemeMode::Dark => Some(Theme::Dark),
            ThemeMode::Light => Some(Theme::Light),
        },
        glass_off: (!glass).then_some(match reduce {
            ReduceTransparency::Auto => GlassReason::System,
            ReduceTransparency::On | ReduceTransparency::Off => GlassReason::User,
        }),
    }
}

/// Whether a `settings_set` patch touches the appearance, so that it has to be applied again.
/// A change to the language or to playback leaves the window alone (setting the same effect
/// again would flicker).
pub fn touches_appearance(patch: &Value) -> bool {
    patch.get("appearance").is_some()
}

// ---------------------------------------------------------------------------------------------
// Reading Windows

/// Windows' appearance now. Reads one registry value and two system settings; it waits for
/// nothing.
pub fn read() -> SystemAppearance {
    SystemAppearance {
        transparency_effects: transparency_from_registry(transparency_value()),
        high_contrast: high_contrast(),
        windows_build: diagnostics::windows_build().unwrap_or(0),
    }
}

/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\EnableTransparency`.
fn transparency_value() -> Option<u32> {
    let mut data = 0u32;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: `data` is a u32 and `size` its size in bytes, both valid for the writes of the
    // call; the key and value names are static, null-terminated wide strings.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("EnableTransparency"),
            RRF_RT_REG_DWORD,
            None,
            Some((&raw mut data).cast::<c_void>()),
            Some(&raw mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(data)
}

/// Whether a high-contrast theme is on (`SPI_GETHIGHCONTRAST`). A call that fails reads as off.
fn high_contrast() -> bool {
    let mut info = HIGHCONTRASTW {
        cbSize: size_of::<HIGHCONTRASTW>() as u32,
        ..HIGHCONTRASTW::default()
    };
    // SAFETY: `info` is a HIGHCONTRASTW whose size field is set, which is what the call needs to
    // fill it in; the scheme name it may point to is not read.
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            info.cbSize,
            Some((&raw mut info).cast::<c_void>()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    read.is_ok() && info.dwFlags.contains(HCF_HIGHCONTRASTON)
}

// ---------------------------------------------------------------------------------------------
// The window

/// Gives the window Mica, or takes every effect off. Mica needs Windows 11 and a transparent
/// window; on Windows 10 it does nothing, and the UI paints a gradient instead. The window
/// follows the system theme unless the appearance forces one ([`apply`] sets it), and Mica has
/// the colour of that theme.
pub fn apply_window_effect(window: &WebviewWindow, mica: bool) {
    let result = if mica {
        window.set_effects(EffectsBuilder::new().effect(Effect::Mica).build())
    } else {
        window.set_effects(None::<WindowEffectsConfig>)
    };
    if let Err(error) = result {
        tracing::warn!("cannot set the window effect (Mica: {mica}): {error}");
    }
}

// ---------------------------------------------------------------------------------------------
// Carrying it out

/// What the appearance code remembers. Managed from the start, so that the lookups never fail;
/// [`start`] fills it.
#[derive(Default)]
pub struct ThemeState {
    /// Windows' appearance as last read, which the UI also has. `None` until [`start`] ran: the
    /// events that come before it are ignored, as the setup is not done.
    system: Mutex<Option<SystemAppearance>>,
    /// The window's Mica and theme as last set, so that the same ones are not set again.
    window: Mutex<Option<(bool, Option<Theme>)>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The appearance settings now; the defaults before the store is managed.
fn current_appearance(app: &AppHandle) -> Appearance {
    match app.try_state::<SharedSettings>() {
        Some(store) => lock(&store).get().appearance.clone(),
        None => Appearance::default(),
    }
}

/// Reads Windows' appearance and applies the settings once. Called from the setup after the
/// glass controller is managed; the UI asks for the appearance itself (`system_appearance`).
pub fn start(app: &AppHandle) {
    let Some(state) = app.try_state::<ThemeState>() else {
        return;
    };
    let system = read();
    *locked(&state.system) = Some(system);
    tracing::info!("the system appearance: {system:?}");
    apply(app, &current_appearance(app), &system);
}

/// Windows' appearance may have changed: reads it again, and if it did, tells the UI
/// (`system:appearance-changed`) and applies the settings again. Called on `ThemeChanged` and
/// when the window gets the focus. Tao reports `ThemeChanged` only when the dark or light theme
/// flips, not when the transparency switch or high contrast does; changing those takes the user
/// away from Kaleido, so the focus is the other moment to look.
pub fn refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<ThemeState>() else {
        return;
    };
    let system = read();
    {
        let mut last = locked(&state.system);
        // Not started: the setup is not done, and `start` reads it all anyway.
        let Some(previous) = *last else {
            return;
        };
        if previous == system {
            return;
        }
        *last = Some(system);
    }
    tracing::info!("the system appearance changed: {system:?}");
    if let Err(error) = app.emit(APPEARANCE_CHANGED_EVENT, system) {
        tracing::warn!("cannot send {APPEARANCE_CHANGED_EVENT} to the UI: {error}");
    }
    apply(app, &current_appearance(app), &system);
}

/// The appearance settings changed (`settings_set`): applies them with Windows' appearance as it
/// is.
pub fn on_settings_changed(app: &AppHandle, appearance: &Appearance) {
    let Some(state) = app.try_state::<ThemeState>() else {
        return;
    };
    let known = *locked(&state.system);
    apply(app, appearance, &known.unwrap_or_else(read));
}

/// Sets the window's effect and theme, and switches the glass on or off, as [`plan`] says.
fn apply(app: &AppHandle, appearance: &Appearance, system: &SystemAppearance) {
    let plan = plan(appearance, system);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Some(state) = app.try_state::<ThemeState>()
    {
        let wanted = (plan.mica, plan.theme);
        // The lock is let go before Tauri is called: setting the theme may send `ThemeChanged`
        // at once, which comes back here.
        let changed = {
            let mut applied = locked(&state.window);
            let changed = *applied != Some(wanted);
            *applied = Some(wanted);
            changed
        };
        if changed {
            apply_window_effect(&window, plan.mica);
            if let Err(error) = window.set_theme(plan.theme) {
                tracing::warn!("cannot set the window theme: {error}");
            }
        }
    }
    match (app.try_state::<GlassController>(), plan.glass_off) {
        (Some(glass), None) => glass.set_enabled(true, GlassReason::User),
        (Some(glass), Some(reason)) => glass.set_enabled(false, reason),
        // Before the setup has made it; `start` comes after.
        (None, _) => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn system(effects: bool, contrast: bool, build: u32) -> SystemAppearance {
        SystemAppearance {
            transparency_effects: effects,
            high_contrast: contrast,
            windows_build: build,
        }
    }

    #[test]
    fn transparency_effects_default_on_when_the_value_is_missing() {
        assert!(transparency_from_registry(None));
        assert!(transparency_from_registry(Some(1)));
        assert!(!transparency_from_registry(Some(0)));
    }

    #[test]
    fn mica_only_on_windows_11() {
        // Windows 10 22H2, and the build before the first Windows 11.
        assert!(!mica_supported(19_045));
        assert!(!mica_supported(21_999));
        assert!(!mica_supported(0), "an unknown build has no Mica");
        // Windows 11 21H2, 23H2 and 25H2.
        assert!(mica_supported(22_000));
        assert!(mica_supported(22_631));
        assert!(mica_supported(26_200));
    }

    #[test]
    fn glass_follows_the_same_rule_as_the_ui() {
        use ReduceTransparency::{Auto, Off, On};
        // `resolveReduceTransparency` in tokens.ts: auto reduces when Windows has no effects.
        assert!(!glass_enabled(Auto, false));
        assert!(glass_enabled(Auto, true));
        // The user's word wins over Windows.
        assert!(!glass_enabled(On, true));
        assert!(!glass_enabled(On, false));
        assert!(glass_enabled(Off, true));
        assert!(glass_enabled(Off, false));
    }

    #[test]
    fn the_plan_follows_the_settings_and_windows() {
        let default = Appearance::default();

        // Windows 11 with effects: Mica and glass, the theme follows Windows.
        assert_eq!(
            plan(&default, &system(true, false, 22_631)),
            Plan {
                mica: true,
                theme: None,
                glass_off: None
            }
        );
        // Windows 10: the glass stays, Mica cannot be had.
        assert_eq!(
            plan(&default, &system(true, false, 19_045)),
            Plan {
                mica: false,
                theme: None,
                glass_off: None
            }
        );
        // Windows switched the effects off: the glass goes for the system, and Mica with it.
        assert_eq!(
            plan(&default, &system(false, false, 22_631)),
            Plan {
                mica: false,
                theme: None,
                glass_off: Some(GlassReason::System)
            }
        );
        // A high-contrast theme counts as no effects.
        assert_eq!(
            plan(&default, &system(true, true, 22_631)).glass_off,
            Some(GlassReason::System)
        );

        // The user's word: reduced on any Windows, or glass although Windows has no effects.
        let reduced = Appearance {
            reduce_transparency: ReduceTransparency::On,
            ..Appearance::default()
        };
        let reduced = plan(&reduced, &system(true, false, 22_631));
        assert_eq!(reduced.glass_off, Some(GlassReason::User));
        assert!(!reduced.mica, "reduced transparency takes Mica away too");
        let glassy = Appearance {
            reduce_transparency: ReduceTransparency::Off,
            ..Appearance::default()
        };
        assert_eq!(plan(&glassy, &system(false, false, 22_631)).glass_off, None);

        // The Mica switch, and the mode that forces a theme.
        let no_mica = Appearance {
            mica: false,
            mode: ThemeMode::Dark,
            ..Appearance::default()
        };
        let no_mica = plan(&no_mica, &system(true, false, 22_631));
        assert!(!no_mica.mica);
        assert_eq!(no_mica.theme, Some(Theme::Dark));
        let light = Appearance {
            mode: ThemeMode::Light,
            ..Appearance::default()
        };
        assert_eq!(
            plan(&light, &system(true, false, 22_631)).theme,
            Some(Theme::Light)
        );
    }

    #[test]
    fn only_a_patch_with_the_appearance_applies_it_again() {
        assert!(touches_appearance(&json!({ "appearance": { "blur": 12 } })));
        // `null` takes the whole section back to its defaults.
        assert!(touches_appearance(&json!({ "appearance": null })));
        assert!(!touches_appearance(&json!({ "language": "cs" })));
        assert!(!touches_appearance(
            &json!({ "playback": { "openWhilePlaying": "append" } })
        ));
        assert!(!touches_appearance(&json!({})));
    }

    #[test]
    fn effects_need_the_switch_and_no_high_contrast() {
        assert!(system(true, false, 0).effects_available());
        assert!(!system(false, false, 0).effects_available());
        assert!(!system(true, true, 0).effects_available());
    }

    /// Reads the machine this runs on: it is Windows 10 or later, and the three values are read
    /// without a panic.
    #[test]
    fn reads_the_windows_of_this_machine() {
        let now = read();
        assert!(now.windows_build >= 10_240, "{now:?}");
    }
}
