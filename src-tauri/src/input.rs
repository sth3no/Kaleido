//! Input the UI did not handle itself, on its way to mpv (spec 5.3): keys, the mouse and the
//! wheel become mpv's own input commands, so that input.conf bindings, scripts and the menus
//! plugins draw in the picture keep working. The names are the ones of mpv's input.conf.

use serde::Deserialize;

use crate::player::{Engine, Request};

/// The most `keypress` commands one wheel event is turned into, however far the UI says the
/// wheel turned: a fast spin must not flood mpv.
pub const MAX_WHEEL_STEPS: u8 = 10;

const BUTTONS: &[&str] = &[
    "MBTN_LEFT",
    "MBTN_MID",
    "MBTN_RIGHT",
    "MBTN_BACK",
    "MBTN_FORWARD",
];
const WHEEL: &[&str] = &["WHEEL_UP", "WHEEL_DOWN", "WHEEL_LEFT", "WHEEL_RIGHT"];

/// What the UI sends. There is no double click: mpv builds it from two quick presses of the left
/// button itself.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    KeyDown {
        key: String,
    },
    KeyUp {
        key: String,
    },
    /// In physical pixels of mpv's window.
    MouseMove {
        x: i32,
        y: i32,
    },
    ButtonDown {
        button: String,
    },
    ButtonUp {
        button: String,
    },
    /// `steps` whole notches of the wheel (the UI adds up the small steps of a touchpad).
    Wheel {
        key: String,
        steps: u8,
    },
}

/// The mpv commands (each a list of arguments) for the event, in order; none if it is not
/// allowed.
pub fn to_commands(event: &InputEvent) -> Vec<Vec<String>> {
    match event {
        InputEvent::KeyDown { key } if valid_key(key) => vec![command(&["keydown", key])],
        InputEvent::KeyUp { key } if valid_key(key) => vec![command(&["keyup", key])],
        InputEvent::MouseMove { x, y } => {
            vec![command(&["mouse", &x.to_string(), &y.to_string()])]
        }
        InputEvent::ButtonDown { button } if BUTTONS.contains(&button.as_str()) => {
            vec![command(&["keydown", button])]
        }
        InputEvent::ButtonUp { button } if BUTTONS.contains(&button.as_str()) => {
            vec![command(&["keyup", button])]
        }
        InputEvent::Wheel { key, steps } if WHEEL.contains(&key.as_str()) => {
            let steps = usize::from((*steps).min(MAX_WHEEL_STEPS));
            vec![command(&["keypress", key]); steps]
        }
        _ => Vec::new(),
    }
}

/// Queues the event's mpv commands on the engine, which runs them in the order they were queued
/// (a key's down and up stay in order). Nothing waits for mpv. Returns whether the event was
/// allowed; if not, nothing was queued.
pub fn send(engine: &Engine, event: &InputEvent) -> bool {
    let commands = to_commands(event);
    let allowed = !commands.is_empty();
    for args in commands {
        engine.request(Request::Command(args));
    }
    allowed
}

/// Whether `key` can be a key name in mpv's `keydown`, `keyup` and `keypress`: not empty, at most
/// 32 characters, no whitespace or control characters. Whether the key is bound is up to mpv.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= 32
        && !key.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn command(args: &[&str]) -> Vec<String> {
    args.iter().map(|&arg| arg.to_owned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(args: &[&str]) -> Vec<Vec<String>> {
        vec![command(args)]
    }

    #[test]
    fn keys_map_to_keydown_and_keyup() {
        assert_eq!(
            to_commands(&InputEvent::KeyDown {
                key: "Ctrl+a".into()
            }),
            one(&["keydown", "Ctrl+a"])
        );
        assert_eq!(
            to_commands(&InputEvent::KeyUp { key: "ě".into() }),
            one(&["keyup", "ě"])
        );
    }

    #[test]
    fn malformed_key_names_are_rejected() {
        for key in ["", "a b", "\n", "x".repeat(40).as_str()] {
            assert!(
                to_commands(&InputEvent::KeyDown { key: key.into() }).is_empty(),
                "{key:?}"
            );
            assert!(
                to_commands(&InputEvent::KeyUp { key: key.into() }).is_empty(),
                "{key:?}"
            );
            assert!(!valid_key(key), "{key:?}");
        }
        assert!(valid_key("Ctrl+Shift+LEFT"));
        assert!(valid_key(&"x".repeat(32)));
    }

    #[test]
    fn mouse_moves_and_known_buttons() {
        assert_eq!(
            to_commands(&InputEvent::MouseMove { x: 10, y: 20 }),
            one(&["mouse", "10", "20"])
        );
        assert_eq!(
            to_commands(&InputEvent::ButtonDown {
                button: "MBTN_LEFT".into()
            }),
            one(&["keydown", "MBTN_LEFT"])
        );
        assert_eq!(
            to_commands(&InputEvent::ButtonUp {
                button: "MBTN_FORWARD".into()
            }),
            one(&["keyup", "MBTN_FORWARD"])
        );
        for button in ["MBTN_X", "MBTN_LEFT_DBL", "a", ""] {
            assert!(
                to_commands(&InputEvent::ButtonUp {
                    button: button.into()
                })
                .is_empty(),
                "{button:?}"
            );
            assert!(
                to_commands(&InputEvent::ButtonDown {
                    button: button.into()
                })
                .is_empty(),
                "{button:?}"
            );
        }
    }

    #[test]
    fn wheel_steps_repeat_keypress_and_are_capped() {
        let wheel = |key: &str, steps| {
            to_commands(&InputEvent::Wheel {
                key: key.into(),
                steps,
            })
        };
        let keypress = command(&["keypress", "WHEEL_UP"]);
        assert_eq!(wheel("WHEEL_UP", 1), vec![keypress.clone()]);
        assert_eq!(wheel("WHEEL_UP", 3), vec![keypress.clone(); 3]);
        assert_eq!(wheel("WHEEL_UP", 10), vec![keypress.clone(); 10]);
        assert_eq!(wheel("WHEEL_UP", 50), vec![keypress; 10]);
        assert_eq!(
            wheel("WHEEL_RIGHT", 2),
            vec![command(&["keypress", "WHEEL_RIGHT"]); 2]
        );
    }

    #[test]
    fn wheel_needs_a_wheel_key_and_a_step() {
        let wheel = |key: &str, steps| {
            to_commands(&InputEvent::Wheel {
                key: key.into(),
                steps,
            })
        };
        assert!(wheel("q", 1).is_empty());
        assert!(wheel("MBTN_LEFT", 1).is_empty());
        assert!(wheel("", 1).is_empty());
        assert!(wheel("WHEEL_UP", 0).is_empty());
    }

    #[test]
    fn deserializes_ui_payloads() {
        let ev: InputEvent = serde_json::from_str(r#"{"type":"keyDown","key":"Ctrl+a"}"#).unwrap();
        assert_eq!(
            ev,
            InputEvent::KeyDown {
                key: "Ctrl+a".into()
            }
        );
        let ev: InputEvent =
            serde_json::from_str(r#"{"type":"wheel","key":"WHEEL_DOWN","steps":2}"#).unwrap();
        assert_eq!(
            ev,
            InputEvent::Wheel {
                key: "WHEEL_DOWN".into(),
                steps: 2
            }
        );
        let ev: InputEvent =
            serde_json::from_str(r#"{"type":"mouseMove","x":-3,"y":480}"#).unwrap();
        assert_eq!(ev, InputEvent::MouseMove { x: -3, y: 480 });
        // The double click of M0 is gone; a wheel without steps or with a negative one is no wheel.
        for payload in [
            r#"{"type":"doubleClick"}"#,
            r#"{"type":"wheel","key":"WHEEL_UP"}"#,
            r#"{"type":"wheel","key":"WHEEL_UP","steps":-1}"#,
        ] {
            assert!(
                serde_json::from_str::<InputEvent>(payload).is_err(),
                "{payload}"
            );
        }
    }
}
