//! Validating submitted extension values against what a model declared.
//!
//! A node advertises the controls its engine accepts; a client sends values
//! back. Everything here treats those values as untrusted, and every rejection
//! names the key rather than a generic failure, because a caller that cannot
//! tell which field was wrong cannot fix it.

use std::collections::BTreeMap;

use crate::{
    MAX_EXTENSION_KEY_BYTES, MAX_EXTENSIONS, MAX_EXTENSIONS_ENCODED_BYTES, ModelParameter,
    ParameterValue,
};

/// Canonical engine fields that also exist as legacy top-level request fields.
///
/// Supplying one through both paths is rejected instead of resolved: choosing a
/// precedence silently would run a generation the caller did not ask for.
pub const LEGACY_FIELDS: [&str; 2] = ["steps", "cfg"];

#[derive(Clone, Debug, PartialEq)]
pub enum ExtensionError {
    TooMany,
    TooLarge,
    KeyTooLong(String),
    UndeclaredKey(String),
    LegacyCollision(String),
    WrongKind(String),
    OutOfRange(String),
    NotAStep(String),
    UnknownChoice(String),
    TextTooLong(String),
}

impl ExtensionError {
    /// The field name to report. Bounds that are not about one key report the
    /// map itself.
    pub fn field(&self) -> &str {
        match self {
            Self::TooMany | Self::TooLarge => "extensions",
            Self::KeyTooLong(key)
            | Self::UndeclaredKey(key)
            | Self::LegacyCollision(key)
            | Self::WrongKind(key)
            | Self::OutOfRange(key)
            | Self::NotAStep(key)
            | Self::UnknownChoice(key)
            | Self::TextTooLong(key) => key,
        }
    }
}

/// Check submitted values against the declarations of the installed model.
///
/// `legacy_present` names the legacy top-level fields the same request also
/// set, so a collision can be reported rather than resolved.
pub fn validate_extensions(
    extensions: &BTreeMap<String, ParameterValue>,
    declared: &[ModelParameter],
    legacy_present: &[&str],
) -> Result<(), ExtensionError> {
    if extensions.is_empty() {
        return Ok(());
    }
    if extensions.len() > MAX_EXTENSIONS {
        return Err(ExtensionError::TooMany);
    }
    // Measured on the canonical encoding rather than on the parsed values: the
    // bound exists to cap what admission has to handle.
    let encoded = serde_json::to_vec(extensions).map_err(|_| ExtensionError::TooLarge)?;
    if encoded.len() > MAX_EXTENSIONS_ENCODED_BYTES {
        return Err(ExtensionError::TooLarge);
    }

    for (key, value) in extensions {
        if key.len() > MAX_EXTENSION_KEY_BYTES {
            return Err(ExtensionError::KeyTooLong(key.clone()));
        }
        if LEGACY_FIELDS.contains(&key.as_str()) && legacy_present.contains(&key.as_str()) {
            return Err(ExtensionError::LegacyCollision(key.clone()));
        }
        let parameter = declared
            .iter()
            .find(|parameter| parameter.key() == key)
            .ok_or_else(|| ExtensionError::UndeclaredKey(key.clone()))?;
        check_value(key, value, parameter)?;
    }
    Ok(())
}

fn check_value(
    key: &str,
    value: &ParameterValue,
    parameter: &ModelParameter,
) -> Result<(), ExtensionError> {
    match (parameter, value) {
        (
            ModelParameter::Integer {
                minimum,
                maximum,
                step,
                ..
            },
            ParameterValue::Number(number),
        ) => {
            if !number.is_finite() || number.fract() != 0.0 {
                return Err(ExtensionError::WrongKind(key.to_owned()));
            }
            let whole = *number as i32;
            if whole < *minimum || whole > *maximum {
                return Err(ExtensionError::OutOfRange(key.to_owned()));
            }
            if let Some(step) = step {
                if *step > 0 && (whole - *minimum).rem_euclid(*step) != 0 {
                    return Err(ExtensionError::NotAStep(key.to_owned()));
                }
            }
            Ok(())
        }
        (
            ModelParameter::Number {
                minimum,
                maximum,
                step,
                ..
            },
            ParameterValue::Number(number),
        ) => {
            if !number.is_finite() {
                return Err(ExtensionError::WrongKind(key.to_owned()));
            }
            if number < minimum || number > maximum {
                return Err(ExtensionError::OutOfRange(key.to_owned()));
            }
            if let Some(step) = step {
                if *step > 0.0 {
                    let offsets = (number - minimum) / step;
                    // Floating point: accept anything within a millionth of a
                    // step rather than rejecting 0.30000000000000004.
                    if (offsets - offsets.round()).abs() > 1e-6 {
                        return Err(ExtensionError::NotAStep(key.to_owned()));
                    }
                }
            }
            Ok(())
        }
        (ModelParameter::Boolean { .. }, ParameterValue::Boolean(_)) => Ok(()),
        (ModelParameter::Choice { choices, .. }, ParameterValue::Text(text)) => {
            if choices.iter().any(|choice| choice == text) {
                Ok(())
            } else {
                Err(ExtensionError::UnknownChoice(key.to_owned()))
            }
        }
        (ModelParameter::Text { max_bytes, .. }, ParameterValue::Text(text)) => {
            if text.len() > *max_bytes as usize {
                return Err(ExtensionError::TextTooLong(key.to_owned()));
            }
            if text.chars().any(char::is_control) {
                return Err(ExtensionError::WrongKind(key.to_owned()));
            }
            Ok(())
        }
        _ => Err(ExtensionError::WrongKind(key.to_owned())),
    }
}

/// Every declared parameter is unique by key.
///
/// Checked where declarations are read rather than where they are used: a
/// duplicate key makes one of the two controls unreachable, and finding out at
/// submission time is too late.
pub fn declarations_are_unique(declared: &[ModelParameter]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    declared
        .iter()
        .all(|parameter| seen.insert(parameter.key()))
}

/// Values to flatten into the engine's initial JSON, defaults filled in.
///
/// A parameter the caller did not send keeps the declared default, so the
/// engine always receives every field it declared.
pub fn resolve_with_defaults(
    extensions: &BTreeMap<String, ParameterValue>,
    declared: &[ModelParameter],
) -> BTreeMap<String, ParameterValue> {
    let mut resolved = BTreeMap::new();
    for parameter in declared {
        let key = parameter.key().to_owned();
        let value = extensions
            .get(&key)
            .cloned()
            .unwrap_or_else(|| match parameter {
                ModelParameter::Integer { default, .. } => ParameterValue::Number(*default as f64),
                ModelParameter::Number { default, .. } => ParameterValue::Number(*default),
                ModelParameter::Boolean { default, .. } => ParameterValue::Boolean(*default),
                ModelParameter::Choice { default, .. } | ModelParameter::Text { default, .. } => {
                    ParameterValue::Text(default.clone())
                }
            });
        resolved.insert(key, value);
    }
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn integer(key: &str) -> ModelParameter {
        ModelParameter::Integer {
            key: key.into(),
            label: "Steps".into(),
            default: 8,
            minimum: 4,
            maximum: 64,
            step: Some(4),
        }
    }

    fn number(key: &str) -> ModelParameter {
        ModelParameter::Number {
            key: key.into(),
            label: "CFG".into(),
            default: 3.0,
            minimum: 1.0,
            maximum: 10.0,
            step: Some(0.5),
        }
    }

    fn choice(key: &str) -> ModelParameter {
        ModelParameter::Choice {
            key: key.into(),
            label: "Key".into(),
            default: "C".into(),
            choices: vec!["C".into(), "G".into()],
        }
    }

    fn map(pairs: &[(&str, ParameterValue)]) -> BTreeMap<String, ParameterValue> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    #[test]
    fn an_empty_map_is_always_fine() {
        assert!(validate_extensions(&BTreeMap::new(), &[], &[]).is_ok());
    }

    #[test]
    fn declared_values_inside_their_bounds_are_accepted() {
        let declared = [integer("steps"), number("cfg"), choice("key")];
        let sent = map(&[
            ("steps", ParameterValue::Number(8.0)),
            ("cfg", ParameterValue::Number(3.5)),
            ("key", ParameterValue::Text("G".into())),
        ]);
        assert!(validate_extensions(&sent, &declared, &[]).is_ok());
    }

    #[test]
    fn an_undeclared_key_is_rejected_by_name() {
        let sent = map(&[("bpm", ParameterValue::Number(120.0))]);
        let error = validate_extensions(&sent, &[integer("steps")], &[]).unwrap_err();
        assert_eq!(error, ExtensionError::UndeclaredKey("bpm".into()));
        assert_eq!(error.field(), "bpm");
    }

    #[test]
    fn supplying_a_field_twice_is_rejected_rather_than_resolved() {
        // Silently choosing a precedence would run a generation nobody asked for.
        let sent = map(&[("steps", ParameterValue::Number(8.0))]);
        let error = validate_extensions(&sent, &[integer("steps")], &["steps"]).unwrap_err();
        assert_eq!(error, ExtensionError::LegacyCollision("steps".into()));
    }

    #[test]
    fn the_same_field_through_one_path_only_is_fine() {
        let sent = map(&[("steps", ParameterValue::Number(8.0))]);
        assert!(validate_extensions(&sent, &[integer("steps")], &["cfg"]).is_ok());
    }

    #[test]
    fn a_value_of_the_wrong_kind_is_rejected() {
        let sent = map(&[("steps", ParameterValue::Text("eight".into()))]);
        assert_eq!(
            validate_extensions(&sent, &[integer("steps")], &[]).unwrap_err(),
            ExtensionError::WrongKind("steps".into())
        );
    }

    #[test]
    fn out_of_range_values_are_rejected_at_both_ends() {
        for value in [0.0, 1000.0] {
            let sent = map(&[("steps", ParameterValue::Number(value))]);
            assert_eq!(
                validate_extensions(&sent, &[integer("steps")], &[]).unwrap_err(),
                ExtensionError::OutOfRange("steps".into())
            );
        }
    }

    #[test]
    fn a_value_off_the_declared_step_is_rejected() {
        let sent = map(&[("steps", ParameterValue::Number(9.0))]);
        assert_eq!(
            validate_extensions(&sent, &[integer("steps")], &[]).unwrap_err(),
            ExtensionError::NotAStep("steps".into())
        );
    }

    #[test]
    fn floating_point_steps_do_not_reject_their_own_arithmetic() {
        // 1.0 + 0.5 * 5 is not exactly 3.5 in binary floating point.
        let sent = map(&[("cfg", ParameterValue::Number(3.5))]);
        assert!(validate_extensions(&sent, &[number("cfg")], &[]).is_ok());
    }

    #[test]
    fn non_finite_numbers_are_rejected() {
        for value in [f64::NAN, f64::INFINITY] {
            let sent = map(&[("cfg", ParameterValue::Number(value))]);
            assert!(validate_extensions(&sent, &[number("cfg")], &[]).is_err());
        }
    }

    #[test]
    fn a_fractional_value_for_an_integer_is_rejected() {
        let sent = map(&[("steps", ParameterValue::Number(8.5))]);
        assert_eq!(
            validate_extensions(&sent, &[integer("steps")], &[]).unwrap_err(),
            ExtensionError::WrongKind("steps".into())
        );
    }

    #[test]
    fn a_choice_outside_the_declared_set_is_rejected() {
        let sent = map(&[("key", ParameterValue::Text("H".into()))]);
        assert_eq!(
            validate_extensions(&sent, &[choice("key")], &[]).unwrap_err(),
            ExtensionError::UnknownChoice("key".into())
        );
    }

    #[test]
    fn text_is_bounded_in_bytes_and_refuses_control_characters() {
        let declared = [ModelParameter::Text {
            key: "style".into(),
            label: "Style".into(),
            default: String::new(),
            max_bytes: 8,
        }];
        let long = map(&[("style", ParameterValue::Text("123456789".into()))]);
        assert_eq!(
            validate_extensions(&long, &declared, &[]).unwrap_err(),
            ExtensionError::TextTooLong("style".into())
        );
        let control = map(&[("style", ParameterValue::Text("a\u{0}b".into()))]);
        assert_eq!(
            validate_extensions(&control, &declared, &[]).unwrap_err(),
            ExtensionError::WrongKind("style".into())
        );
    }

    #[test]
    fn an_oversized_key_is_rejected_before_it_is_looked_up() {
        let key = "k".repeat(MAX_EXTENSION_KEY_BYTES + 1);
        let sent = map(&[(key.as_str(), ParameterValue::Number(1.0))]);
        assert!(matches!(
            validate_extensions(&sent, &[], &[]).unwrap_err(),
            ExtensionError::KeyTooLong(_)
        ));
    }

    #[test]
    fn too_many_entries_are_rejected() {
        let mut sent = BTreeMap::new();
        for index in 0..=MAX_EXTENSIONS {
            sent.insert(format!("k{index}"), ParameterValue::Number(1.0));
        }
        assert_eq!(
            validate_extensions(&sent, &[], &[]).unwrap_err(),
            ExtensionError::TooMany
        );
    }

    #[test]
    fn an_oversized_map_is_rejected() {
        let declared = [ModelParameter::Text {
            key: "style".into(),
            label: "Style".into(),
            default: String::new(),
            max_bytes: u32::MAX,
        }];
        let sent = map(&[(
            "style",
            ParameterValue::Text("x".repeat(MAX_EXTENSIONS_ENCODED_BYTES + 1)),
        )]);
        assert_eq!(
            validate_extensions(&sent, &declared, &[]).unwrap_err(),
            ExtensionError::TooLarge
        );
    }

    #[test]
    fn duplicate_declarations_are_caught_where_they_are_read() {
        assert!(declarations_are_unique(&[integer("steps"), number("cfg")]));
        assert!(!declarations_are_unique(&[
            integer("steps"),
            number("steps")
        ]));
    }

    #[test]
    fn defaults_fill_in_every_declared_field() {
        let declared = [integer("steps"), number("cfg"), choice("key")];
        let sent = map(&[("steps", ParameterValue::Number(12.0))]);

        let resolved = resolve_with_defaults(&sent, &declared);

        assert_eq!(resolved.len(), 3);
        assert_eq!(resolved["steps"], ParameterValue::Number(12.0));
        assert_eq!(resolved["cfg"], ParameterValue::Number(3.0));
        assert_eq!(resolved["key"], ParameterValue::Text("C".into()));
    }
}
