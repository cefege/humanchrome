//! Legacy resolvable decisions over host-owned values and property handles.

/// A variable path segment retained from an authored legacy resolvable.
#[derive(Clone, Debug, PartialEq)]
pub enum VariablePathSegment {
    /// Reads a named object property.
    Key(String),
    /// Reads an array index.
    Index(f64),
}

/// A decoded legacy resolvable whose raw values remain host-owned.
#[derive(Clone, Debug, PartialEq)]
pub enum LegacyResolvable {
    /// A literal value retained by its host handle.
    Literal(usize),
    /// A variable reference with an optional fallback value.
    Variable {
        /// The variable name.
        name: String,
        /// The optional nested property path.
        path: Vec<VariablePathSegment>,
        /// A fallback literal when lookup fails.
        default: Option<usize>,
    },
    /// An expression, which the default legacy resolver does not execute.
    Expression {
        /// A fallback literal when expression execution is unavailable.
        default: Option<usize>,
    },
}

/// Supplies opaque values and property access to the legacy resolver.
pub trait LegacyResolverHost {
    /// An opaque host value preserving JavaScript identity.
    type Value;

    /// Returns an authored literal or fallback by retained handle.
    fn input(&self, index: usize) -> Self::Value;
    /// Looks up one top-level variable.
    fn variable(&self, name: &str) -> Option<Self::Value>;
    /// Reads a path after the core has selected variable-resolution behavior.
    fn read_path(&self, value: &Self::Value, path: &[VariablePathSegment]) -> Option<Self::Value>;
    /// Returns JavaScript `null` for a missing variable without a fallback.
    fn null(&self) -> Self::Value;
}

/// Resolves one generic legacy value while retaining all host object identity.
///
/// # Errors
///
/// Returns the historical default-resolver expression error when no expression fallback exists.
pub fn resolve_json<H: LegacyResolverHost>(
    value: &LegacyResolvable,
    host: &H,
) -> Result<H::Value, &'static str> {
    match value {
        LegacyResolvable::Literal(index) => Ok(host.input(*index)),
        LegacyResolvable::Variable {
            name,
            path,
            default,
        } => host
            .variable(name)
            .and_then(|value| host.read_path(&value, path))
            .or_else(|| default.map(|index| host.input(index)))
            .map_or_else(|| Ok(host.null()), Ok),
        LegacyResolvable::Expression { default } => default
            .map(|index| host.input(index))
            .ok_or("Expression value is not supported by the default resolver"),
    }
}

/// A decoded legacy string resolvable retaining raw host handles.
#[derive(Clone, Debug, PartialEq)]
pub enum LegacyStringResolvable {
    /// A literal that must already be a string.
    Literal(usize),
    /// A variable reference with a string-only fallback.
    Variable {
        /// The variable name.
        name: String,
        /// The optional nested property path.
        path: Vec<VariablePathSegment>,
        /// A fallback literal when lookup fails.
        default: Option<usize>,
    },
    /// A composed template.
    Template(Vec<LegacyTemplatePart>),
    /// An expression with a string-only fallback.
    Expression {
        /// A fallback literal when expression execution is unavailable.
        default: Option<usize>,
    },
    /// An unsupported authored form.
    Unsupported,
}

/// One decoded legacy template part.
#[derive(Clone, Debug, PartialEq)]
pub enum LegacyTemplatePart {
    /// Appends an authored string literal.
    Text(usize),
    /// Resolves and formats one generic value.
    Insert {
        /// The authored generic resolvable.
        value: LegacyResolvable,
        /// The insertion format.
        format: LegacyTemplateFormat,
    },
    /// Preserves a malformed text-part failure.
    InvalidText,
    /// Preserves the legacy invalid-part failure.
    Invalid,
    /// Preserves an unsupported part kind in the error message.
    Unknown(usize),
}

/// The formatting mode for one legacy template insertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyTemplateFormat {
    /// JavaScript string coercion, with null becoming empty text.
    Text,
    /// JavaScript JSON serialization.
    Json,
    /// JavaScript string coercion followed by `encodeURIComponent`.
    UrlEncoded,
}

/// A legacy resolver failure, retaining host-thrown JavaScript intrinsic exceptions.
#[derive(Debug)]
pub enum LegacyStringResolutionError<E> {
    /// A deterministic legacy policy error.
    Policy(String),
    /// A JavaScript intrinsic exception that must retain its original identity.
    Intrinsic(E),
}

/// Supplies JavaScript string, JSON, URI, and numeric intrinsics to the portable resolver policy.
pub trait LegacyStringResolverHost: LegacyResolverHost {
    /// A host-native JavaScript string handle.
    type String;
    /// A host-native exception value.
    type Error;

    /// Returns whether one input handle is a JavaScript string.
    fn input_is_string(&self, index: usize) -> bool;
    /// Returns an authored string input by handle.
    fn input_string(&self, index: usize) -> Self::String;
    /// Returns an empty JavaScript string.
    fn empty_string(&self) -> Self::String;
    /// Tests JavaScript null.
    fn is_null(&self, value: &Self::Value) -> bool;
    /// Applies JavaScript `String(value)`.
    fn string(&self, value: &Self::Value) -> Self::String;
    /// Applies JavaScript `JSON.stringify(value)`.
    fn json_stringify(&self, value: &Self::Value) -> Result<Self::String, Self::Error>;
    /// Appends JavaScript strings without UTF-8 conversion.
    fn append(&self, output: &mut Self::String, value: &Self::String);
    /// Applies JavaScript `encodeURIComponent`.
    fn encode_uri_component(&self, value: &Self::String) -> Result<Self::String, Self::Error>;
    /// Converts an opaque string to an error-message string.
    fn string_for_error(&self, value: &Self::String) -> String;
}

/// Resolves one legacy string without serializing opaque values.
///
/// # Errors
///
/// Returns deterministic policy errors or an unmodified host intrinsic exception.
pub fn resolve_string<H: LegacyStringResolverHost>(
    value: &LegacyStringResolvable,
    host: &H,
) -> Result<H::String, LegacyStringResolutionError<H::Error>> {
    match value {
        LegacyStringResolvable::Literal(index) if host.input_is_string(*index) => {
            Ok(host.input_string(*index))
        }
        LegacyStringResolvable::Variable {
            name,
            path,
            default,
        } => {
            if let Some(value) = host
                .variable(name)
                .and_then(|value| host.read_path(&value, path))
                .filter(|value| !host.is_null(value))
            {
                return Ok(host.string(&value));
            }
            if let Some(default) = default.filter(|index| host.input_is_string(*index)) {
                return Ok(host.input_string(default));
            }
            Ok(host.empty_string())
        }
        LegacyStringResolvable::Template(parts) => {
            let mut output = host.empty_string();
            for part in parts {
                let inserted = match part {
                    LegacyTemplatePart::Text(index) => host.input_string(*index),
                    LegacyTemplatePart::Insert { value, format } => {
                        let value = resolve_json(value, host).map_err(|error| {
                            LegacyStringResolutionError::Policy(String::from(error))
                        })?;
                        match format {
                            LegacyTemplateFormat::Text => {
                                if host.is_null(&value) {
                                    host.empty_string()
                                } else {
                                    host.string(&value)
                                }
                            }
                            LegacyTemplateFormat::Json => host
                                .json_stringify(&value)
                                .map_err(LegacyStringResolutionError::Intrinsic)?,
                            LegacyTemplateFormat::UrlEncoded => {
                                let text = if host.is_null(&value) {
                                    host.empty_string()
                                } else {
                                    host.string(&value)
                                };
                                host.encode_uri_component(&text)
                                    .map_err(LegacyStringResolutionError::Intrinsic)?
                            }
                        }
                    }
                    LegacyTemplatePart::Invalid => {
                        return Err(LegacyStringResolutionError::Policy(String::from(
                            "Invalid template part",
                        )));
                    }
                    LegacyTemplatePart::InvalidText => {
                        return Err(LegacyStringResolutionError::Policy(String::from(
                            "Invalid template text part",
                        )));
                    }
                    LegacyTemplatePart::Unknown(index) => {
                        return Err(LegacyStringResolutionError::Policy(format!(
                            "Unknown template part kind: {}",
                            host.string_for_error(&host.input_string(*index))
                        )));
                    }
                };
                host.append(&mut output, &inserted);
            }
            Ok(output)
        }
        LegacyStringResolvable::Expression { default } => default
            .filter(|index| host.input_is_string(*index))
            .map(|index| host.input_string(index))
            .ok_or_else(|| {
                LegacyStringResolutionError::Policy(String::from(
                    "Expression value is not supported by the default resolver",
                ))
            }),
        LegacyStringResolvable::Literal(_) | LegacyStringResolvable::Unsupported => {
            Err(LegacyStringResolutionError::Policy(String::from(
                "Unsupported resolvable string value",
            )))
        }
    }
}

/// A decoded legacy numeric resolvable retaining raw host handles.
#[derive(Clone, Debug, PartialEq)]
pub enum LegacyNumberResolvable {
    /// A literal value.
    Literal(usize),
    /// A variable reference with a numeric fallback.
    Variable {
        /// The variable name.
        name: String,
        /// The optional nested property path.
        path: Vec<VariablePathSegment>,
        /// A fallback literal when lookup fails.
        default: Option<usize>,
    },
    /// An expression with a numeric fallback.
    Expression {
        /// A fallback literal when expression execution is unavailable.
        default: Option<usize>,
    },
    /// An unsupported authored form.
    Unsupported,
}

/// Adds JavaScript numeric observation to the string resolver host.
pub trait LegacyNumberResolverHost: LegacyStringResolverHost {
    /// Returns a finite number when the raw value is already numeric.
    fn finite_number(&self, value: &Self::Value) -> Option<f64>;
    /// Reports whether a raw value is a nonblank JavaScript string.
    fn string_is_nonempty_after_trim(&self, value: &Self::Value) -> bool;
    /// Applies JavaScript `Number` to a raw string value.
    fn number_from_string(&self, value: &Self::Value) -> f64;
}

/// Resolves one finite legacy number without serializing opaque values.
///
/// # Errors
///
/// Returns the historical resolver messages.
pub fn resolve_number<H: LegacyNumberResolverHost>(
    value: &LegacyNumberResolvable,
    host: &H,
) -> Result<f64, String> {
    let numeric = |value: H::Value| {
        host.finite_number(&value).or_else(|| {
            host.string_is_nonempty_after_trim(&value)
                .then(|| host.number_from_string(&value))
                .filter(|number| number.is_finite())
        })
    };
    match value {
        LegacyNumberResolvable::Literal(index) => host
            .finite_number(&host.input(*index))
            .ok_or_else(|| String::from("Unsupported resolvable number value")),
        LegacyNumberResolvable::Variable {
            name,
            path,
            default,
        } => host
            .variable(name)
            .and_then(|value| host.read_path(&value, path))
            .and_then(numeric)
            .or_else(|| default.and_then(|index| host.finite_number(&host.input(index))))
            .ok_or_else(|| format!("Variable \"{name}\" is not a finite number")),
        LegacyNumberResolvable::Expression { default } => default
            .and_then(|index| host.finite_number(&host.input(index)))
            .ok_or_else(|| {
                String::from("Expression value is not supported by the default resolver")
            }),
        LegacyNumberResolvable::Unsupported => {
            Err(String::from("Unsupported resolvable number value"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    struct Host {
        input: Vec<u8>,
        vars: HashMap<String, u8>,
    }

    impl LegacyResolverHost for Host {
        type Value = u8;

        fn input(&self, index: usize) -> Self::Value {
            self.input[index]
        }

        fn variable(&self, name: &str) -> Option<Self::Value> {
            self.vars.get(name).copied()
        }

        fn read_path(
            &self,
            value: &Self::Value,
            path: &[VariablePathSegment],
        ) -> Option<Self::Value> {
            path.is_empty().then_some(*value)
        }

        fn null(&self) -> Self::Value {
            0
        }
    }

    #[test]
    fn variable_values_retain_their_host_handle_and_missing_values_fall_back_to_null() {
        let host = Host {
            input: vec![9],
            vars: HashMap::from([(String::from("same"), 7)]),
        };
        assert_eq!(
            resolve_json(
                &LegacyResolvable::Variable {
                    name: String::from("same"),
                    path: vec![],
                    default: Some(0),
                },
                &host,
            ),
            Ok(7)
        );
        assert_eq!(
            resolve_json(
                &LegacyResolvable::Variable {
                    name: String::from("missing"),
                    path: vec![],
                    default: None,
                },
                &host,
            ),
            Ok(0)
        );
    }
}
