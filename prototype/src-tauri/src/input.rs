use serde::Deserialize;

/// Input the UI did not handle itself (spec 5.3). Names use mpv's input.conf scheme.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    KeyDown { key: String },
    KeyUp { key: String },
    MouseMove { x: i32, y: i32 },
    ButtonDown { button: String },
    ButtonUp { button: String },
    Wheel { key: String },
    DoubleClick,
}

const BUTTONS: &[&str] = &[
    "MBTN_LEFT",
    "MBTN_MID",
    "MBTN_RIGHT",
    "MBTN_BACK",
    "MBTN_FORWARD",
];
const WHEEL: &[&str] = &["WHEEL_UP", "WHEEL_DOWN", "WHEEL_LEFT", "WHEEL_RIGHT"];

/// One mpv command (argument list) for the event, or None if it is not allowed.
pub fn to_command(event: &InputEvent) -> Option<Vec<String>> {
    let owned = |args: &[&str]| Some(args.iter().map(|a| (*a).to_owned()).collect());
    match event {
        InputEvent::KeyDown { key } if valid_key(key) => owned(&["keydown", key]),
        InputEvent::KeyUp { key } if valid_key(key) => owned(&["keyup", key]),
        InputEvent::MouseMove { x, y } => owned(&["mouse", &x.to_string(), &y.to_string()]),
        InputEvent::ButtonDown { button } if BUTTONS.contains(&button.as_str()) => {
            owned(&["keydown", button])
        }
        InputEvent::ButtonUp { button } if BUTTONS.contains(&button.as_str()) => {
            owned(&["keyup", button])
        }
        InputEvent::Wheel { key } if WHEEL.contains(&key.as_str()) => owned(&["keypress", key]),
        InputEvent::DoubleClick => owned(&["keypress", "MBTN_LEFT_DBL"]),
        _ => None,
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= 32
        && !key.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(args: &[&str]) -> Option<Vec<String>> {
        Some(args.iter().map(|a| a.to_string()).collect())
    }

    #[test]
    fn keys_map_to_keydown_and_keyup() {
        assert_eq!(
            to_command(&InputEvent::KeyDown {
                key: "Ctrl+a".into()
            }),
            cmd(&["keydown", "Ctrl+a"])
        );
        assert_eq!(
            to_command(&InputEvent::KeyUp { key: "ě".into() }),
            cmd(&["keyup", "ě"])
        );
    }

    #[test]
    fn malformed_key_names_are_rejected() {
        for key in ["", "a b", "\n", "x".repeat(40).as_str()] {
            assert_eq!(
                to_command(&InputEvent::KeyDown { key: key.into() }),
                None,
                "{key:?}"
            );
        }
    }

    #[test]
    fn mouse_moves_and_known_buttons() {
        assert_eq!(
            to_command(&InputEvent::MouseMove { x: 10, y: 20 }),
            cmd(&["mouse", "10", "20"])
        );
        assert_eq!(
            to_command(&InputEvent::ButtonDown {
                button: "MBTN_LEFT".into()
            }),
            cmd(&["keydown", "MBTN_LEFT"])
        );
        assert_eq!(
            to_command(&InputEvent::ButtonUp {
                button: "MBTN_X".into()
            }),
            None
        );
    }

    #[test]
    fn wheel_and_double_click() {
        assert_eq!(
            to_command(&InputEvent::Wheel {
                key: "WHEEL_UP".into()
            }),
            cmd(&["keypress", "WHEEL_UP"])
        );
        assert_eq!(to_command(&InputEvent::Wheel { key: "q".into() }), None);
        assert_eq!(
            to_command(&InputEvent::DoubleClick),
            cmd(&["keypress", "MBTN_LEFT_DBL"])
        );
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
        let ev: InputEvent = serde_json::from_str(r#"{"type":"doubleClick"}"#).unwrap();
        assert_eq!(ev, InputEvent::DoubleClick);
    }
}
