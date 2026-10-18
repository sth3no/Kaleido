//! What a plugin's settings look like (spec 7.2, the `settings` of a manifest): which keys of
//! its `script-opts` file the UI offers, and as what. These are the types and their JSON, and
//! [`validate`], which checks a value against them before it is written to the file.

use std::fmt::Display;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::settings::is_hex_color;

/// A text in English and, where there is one, in Czech. The UI shows English where `cs` is
/// missing (spec 7.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Localized {
    pub en: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cs: Option<String>,
}

/// One setting of a plugin: `{"key", "type", "default", "min", "max", "values", "label",
/// "description"}`, where `min`, `max` and `values` depend on the `type` (see [`SettingKind`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingSpec {
    /// The key in the plugin's `script-opts` file.
    pub key: String,
    #[serde(flatten)]
    pub kind: SettingKind,
    /// What the script uses when the file does not have the key, as JSON of the kind's type.
    pub default: Value,
    pub label: Localized,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<Localized>,
}

/// The type of a setting: `type` in the JSON, lowercase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SettingKind {
    Bool,
    Int {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<i64>,
    },
    Float {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    String,
    Enum {
        values: Vec<String>,
    },
    /// `#RRGGBB` or `#AARRGGBB`.
    Color,
}

/// Checks `raw`, the text of a setting as the user typed or chose it, against `spec`, and gives
/// the text to write to the `script-opts` file, or a short reason why it will not do. Nothing is
/// trimmed: spaces count, as they do for the script.
///
/// - `bool` is written `yes` or `no` (`true` and `false` are taken for them), the only booleans
///   `mp.options` knows.
/// - `int` is a whole number and `float` a finite one, within `min` and `max`, which are
///   inclusive. An `int` is written in its plain form (`+07` is `7`); a `float` as it was typed
///   (`1.50` stays `1.50`).
/// - `enum` is one of its `values`, `color` is `#RRGGBB` or `#AARRGGBB`, `string` is anything.
///
/// Whatever the type, the text must be in one line: a line break would end the line in the file.
pub fn validate(spec: &SettingSpec, raw: &str) -> Result<String, String> {
    if raw.contains(['\r', '\n']) {
        return Err("must be in one line".to_owned());
    }
    match &spec.kind {
        SettingKind::Bool => match raw {
            "yes" | "true" => Ok("yes".to_owned()),
            "no" | "false" => Ok("no".to_owned()),
            _ => Err("must be yes or no".to_owned()),
        },
        SettingKind::Int { min, max } => {
            let number: i64 = raw
                .parse()
                .map_err(|_| "must be a whole number".to_owned())?;
            in_range(number, *min, *max)?;
            Ok(number.to_string())
        }
        SettingKind::Float { min, max } => {
            let number = raw
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
                .ok_or_else(|| "must be a number".to_owned())?;
            in_range(number, *min, *max)?;
            Ok(raw.to_owned())
        }
        SettingKind::String => Ok(raw.to_owned()),
        SettingKind::Enum { values } if values.iter().any(|value| value == raw) => {
            Ok(raw.to_owned())
        }
        SettingKind::Enum { values } => Err(format!("must be one of: {}", values.join(", "))),
        SettingKind::Color if is_hex_color(raw, &[6, 8]) => Ok(raw.to_owned()),
        SettingKind::Color => Err("must be #RRGGBB or #AARRGGBB".to_owned()),
    }
}

/// `number` within the bounds that are given (both inclusive).
fn in_range<T: PartialOrd + Display + Copy>(
    number: T,
    min: Option<T>,
    max: Option<T>,
) -> Result<(), String> {
    if let Some(min) = min
        && number < min
    {
        return Err(format!("must be at least {min}"));
    }
    if let Some(max) = max
        && number > max
    {
        return Err(format!("must be at most {max}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every type of spec 7.2 reads from its JSON and writes the same JSON back: the optional
    /// bounds and the description are left out when absent, and nothing else is added.
    #[test]
    fn every_setting_kind_round_trips_through_the_spec_7_2_json() {
        let json = serde_json::json!([
            { "key": "a", "type": "bool", "default": true, "label": { "en": "A" } },
            { "key": "b", "type": "int", "default": 200, "min": 50, "max": 600,
              "label": { "en": "B", "cs": "Bé" } },
            { "key": "c", "type": "int", "default": 1, "label": { "en": "C" } },
            { "key": "d", "type": "float", "default": 0.5, "min": 0.0, "max": 1.5,
              "label": { "en": "D" }, "description": { "en": "Dd", "cs": "Dé" } },
            { "key": "e", "type": "string", "default": "x", "label": { "en": "E" } },
            { "key": "f", "type": "enum", "default": "no", "values": ["no", "yes"],
              "label": { "en": "F" } },
            { "key": "g", "type": "color", "default": "#FFFFFF", "label": { "en": "G" } },
        ]);

        let specs: Vec<SettingSpec> = serde_json::from_value(json.clone()).unwrap();

        assert_eq!(specs[0].kind, SettingKind::Bool);
        assert_eq!(
            specs[1].kind,
            SettingKind::Int {
                min: Some(50),
                max: Some(600)
            }
        );
        assert_eq!(specs[1].label.cs.as_deref(), Some("Bé"));
        assert_eq!(
            specs[2].kind,
            SettingKind::Int {
                min: None,
                max: None
            }
        );
        assert_eq!(
            specs[3].kind,
            SettingKind::Float {
                min: Some(0.0),
                max: Some(1.5)
            }
        );
        assert_eq!(specs[3].description.as_ref().unwrap().en, "Dd");
        assert_eq!(specs[4].kind, SettingKind::String);
        assert_eq!(
            specs[5].kind,
            SettingKind::Enum {
                values: vec!["no".to_owned(), "yes".to_owned()]
            }
        );
        assert_eq!(specs[6].kind, SettingKind::Color);
        assert_eq!(serde_json::to_value(&specs).unwrap(), json);
    }

    #[test]
    fn a_setting_without_a_known_type_is_refused() {
        let unknown = r#"{ "key": "a", "type": "path", "default": "x", "label": { "en": "A" } }"#;
        assert!(serde_json::from_str::<SettingSpec>(unknown).is_err());
        let missing = r#"{ "key": "a", "default": "x", "label": { "en": "A" } }"#;
        assert!(serde_json::from_str::<SettingSpec>(missing).is_err());
        // An enum without its values is no enum.
        let bare = r#"{ "key": "a", "type": "enum", "default": "x", "label": { "en": "A" } }"#;
        assert!(serde_json::from_str::<SettingSpec>(bare).is_err());
    }

    #[test]
    fn settings_specs_read_the_spec_7_2_shape() {
        let json = r#"{"key":"max_height","type":"int","default":200,"min":50,"max":600,"label":{"en":"Max height"}}"#;

        let spec: SettingSpec = serde_json::from_str(json).unwrap();

        assert_eq!(spec.key, "max_height");
        assert_eq!(
            spec.kind,
            SettingKind::Int {
                min: Some(50),
                max: Some(600)
            }
        );
        assert_eq!(spec.default, serde_json::json!(200));
        assert_eq!(
            spec.label,
            Localized {
                en: "Max height".to_owned(),
                cs: None
            }
        );
        assert_eq!(spec.description, None);
        // It writes the same JSON back, and a manifest holds a list of them.
        assert_eq!(
            serde_json::to_value(&spec).unwrap(),
            serde_json::from_str::<Value>(json).unwrap()
        );
        let list: Vec<SettingSpec> = serde_json::from_str(&format!("[{json}]")).unwrap();
        assert_eq!(list, std::slice::from_ref(&spec));
        // Its bounds are the ones a value is checked against.
        assert_eq!(validate(&spec, "200"), Ok("200".to_owned()));
        assert!(validate(&spec, "700").is_err());
    }

    fn spec(kind: SettingKind) -> SettingSpec {
        SettingSpec {
            key: "k".to_owned(),
            kind,
            default: Value::Null,
            label: Localized {
                en: "K".to_owned(),
                cs: None,
            },
            description: None,
        }
    }

    #[test]
    fn values_are_checked_and_normalised() {
        let check = |kind, raw: &str| validate(&spec(kind), raw);
        let int = |min, max| SettingKind::Int { min, max };
        let float = |min, max| SettingKind::Float { min, max };

        // bool: yes and no, and true and false for them.
        for (raw, written) in [
            ("true", "yes"),
            ("yes", "yes"),
            ("false", "no"),
            ("no", "no"),
        ] {
            assert_eq!(
                check(SettingKind::Bool, raw),
                Ok(written.to_owned()),
                "{raw}"
            );
        }
        for raw in ["", "maybe", "Yes", "1", " yes", "yes "] {
            assert!(check(SettingKind::Bool, raw).is_err(), "{raw:?}");
        }

        // int: whole, in bounds (inclusive), written plain.
        assert_eq!(check(int(Some(50), Some(600)), "200"), Ok("200".to_owned()));
        assert_eq!(check(int(Some(50), Some(600)), "50"), Ok("50".to_owned()));
        assert_eq!(check(int(Some(50), Some(600)), "600"), Ok("600".to_owned()));
        assert_eq!(check(int(None, None), "+007"), Ok("7".to_owned()));
        assert_eq!(check(int(None, None), "-5"), Ok("-5".to_owned()));
        for raw in ["700", "601", "49", "-1"] {
            assert!(check(int(Some(50), Some(600)), raw).is_err(), "{raw}");
        }
        for raw in [
            "",
            "1.5",
            "1e3",
            "ten",
            " 5",
            "5 ",
            "0x10",
            "99999999999999999999",
        ] {
            assert!(check(int(None, None), raw).is_err(), "{raw:?}");
        }
        // One bound is enough, and the reason says which.
        assert_eq!(
            check(int(Some(0), None), "-1"),
            Err("must be at least 0".to_owned())
        );
        assert_eq!(
            check(int(None, Some(9)), "10"),
            Err("must be at most 9".to_owned())
        );

        // float: finite, in bounds, written as typed.
        assert_eq!(check(float(None, None), "1.50"), Ok("1.50".to_owned()));
        assert_eq!(check(float(None, None), "-.5"), Ok("-.5".to_owned()));
        assert_eq!(check(float(None, None), "2e-3"), Ok("2e-3".to_owned()));
        assert_eq!(check(float(Some(0.0), Some(1.5)), "0"), Ok("0".to_owned()));
        assert_eq!(
            check(float(Some(0.0), Some(1.5)), "1.5"),
            Ok("1.5".to_owned())
        );
        for raw in ["1.51", "-0.1"] {
            assert!(check(float(Some(0.0), Some(1.5)), raw).is_err(), "{raw}");
        }
        for raw in [
            "NaN", "nan", "inf", "-inf", "infinity", "1e999", "", "1,5", "x", " 1",
        ] {
            assert!(check(float(None, None), raw).is_err(), "{raw:?}");
        }

        // enum: one of the values, exactly.
        let choice = || SettingKind::Enum {
            values: vec!["no".to_owned(), "auto".to_owned(), "always".to_owned()],
        };
        assert_eq!(check(choice(), "auto"), Ok("auto".to_owned()));
        for raw in ["", "maybe", "Auto", "auto ", "yes"] {
            assert!(check(choice(), raw).is_err(), "{raw:?}");
        }
        assert_eq!(
            check(choice(), "yes"),
            Err("must be one of: no, auto, always".to_owned())
        );

        // color: #RRGGBB or #AARRGGBB, as typed.
        for raw in ["#FFFFFF", "#80ffffff", "#0a0B0c"] {
            assert_eq!(check(SettingKind::Color, raw), Ok(raw.to_owned()), "{raw}");
        }
        for raw in [
            "red", "", "#", "#FFF", "#FFFFF", "#FFFFFFF", "#GGGGGG", "FFFFFF", "#FFFFFF ",
        ] {
            assert!(check(SettingKind::Color, raw).is_err(), "{raw:?}");
        }

        // string: anything in one line, spaces and all.
        assert_eq!(check(SettingKind::String, ""), Ok(String::new()));
        assert_eq!(
            check(SettingKind::String, " a=b # c "),
            Ok(" a=b # c ".to_owned())
        );
        assert_eq!(
            check(SettingKind::String, "C:\\Videos"),
            Ok("C:\\Videos".to_owned())
        );
        for raw in ["a\nb", "a\r\nb", "a\r", "\n"] {
            assert!(check(SettingKind::String, raw).is_err(), "{raw:?}");
        }
        // No type takes a line break, an enum that lists one included.
        let odd = SettingKind::Enum {
            values: vec!["a\nb".to_owned()],
        };
        assert!(check(odd, "a\nb").is_err());
    }
}
