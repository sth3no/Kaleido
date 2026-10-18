//! What a plugin's settings look like (spec 7.2, the `settings` of a manifest): which keys of
//! its `script-opts` file the UI offers, and as what. These are the types and their JSON; a
//! value is checked against them elsewhere.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
}
