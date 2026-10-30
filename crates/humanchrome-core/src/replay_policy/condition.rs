//! Legacy condition evaluation decisions over host-resolved opaque values.

/// An authored legacy action condition with values retained by host handles.
#[derive(Clone, Debug, PartialEq)]
pub enum Condition {
    /// User-authored expressions remain unsupported by the legacy default resolver.
    Expr,
    /// Compares two independently resolved values.
    Compare {
        /// The left authored resolvable handle.
        left: usize,
        /// The comparison operation.
        op: CompareOp,
        /// The right authored resolvable handle.
        right: usize,
    },
    /// Tests the JavaScript truthiness of one resolved value.
    Truthy {
        /// The authored resolvable handle.
        value: usize,
    },
    /// Tests the inverse JavaScript truthiness of one resolved value.
    Falsy {
        /// The authored resolvable handle.
        value: usize,
    },
    /// Negates one nested condition.
    Not {
        /// The nested condition.
        condition: Box<Condition>,
    },
    /// Evaluates nested conditions until one is false.
    And {
        /// Nested conditions in authored order.
        conditions: Vec<Condition>,
    },
    /// Evaluates nested conditions until one is true.
    Or {
        /// Nested conditions in authored order.
        conditions: Vec<Condition>,
    },
}

/// The supported legacy comparison operators.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CompareOp {
    /// JavaScript strict equality.
    Eq,
    /// Case-insensitive JavaScript string equality.
    Eqi,
    /// JavaScript strict inequality.
    Neq,
    /// JavaScript `Number(left) > Number(right)`.
    Gt,
    /// JavaScript `Number(left) >= Number(right)`.
    Gte,
    /// JavaScript `Number(left) < Number(right)`.
    Lt,
    /// JavaScript `Number(left) <= Number(right)`.
    Lte,
    /// JavaScript string containment.
    Contains,
    /// Case-insensitive JavaScript string containment.
    ContainsI,
    /// Inverse JavaScript string containment.
    NotContains,
    /// Inverse case-insensitive JavaScript string containment.
    NotContainsI,
    /// JavaScript string prefix matching.
    StartsWith,
    /// JavaScript string suffix matching.
    EndsWith,
    /// JavaScript regular-expression matching.
    Regex,
}

/// Supplies opaque host values and JavaScript-defined primitive operations to [`evaluate_condition`].
pub trait ConditionHost {
    /// A host handle that preserves JavaScript primitive and object identity.
    type Value;

    /// Resolves an authored value handle, returning `None` on the legacy resolver failure path.
    fn resolve(&mut self, value: usize) -> Option<Self::Value>;
    /// Applies JavaScript truthiness.
    fn is_truthy(&self, value: &Self::Value) -> bool;
    /// Applies JavaScript strict equality without structural JSON comparison.
    fn strict_equal(&self, left: &Self::Value, right: &Self::Value) -> bool;
    /// Applies JavaScript `Number` coercion once for a relational comparison.
    fn number(&self, value: &Self::Value) -> f64;
    /// Applies JavaScript `String(left).toLowerCase() === String(right).toLowerCase()`.
    fn string_equal_insensitive(&self, left: &Self::Value, right: &Self::Value) -> bool;
    /// Applies JavaScript `String.prototype.includes`, optionally after lower-casing both values.
    fn string_contains(&self, left: &Self::Value, right: &Self::Value, insensitive: bool) -> bool;
    /// Applies JavaScript `String.prototype.startsWith`.
    fn string_starts_with(&self, left: &Self::Value, right: &Self::Value) -> bool;
    /// Applies JavaScript `String.prototype.endsWith`.
    fn string_ends_with(&self, left: &Self::Value, right: &Self::Value) -> bool;
    /// Applies `new RegExp(String(right)).test(String(left))`, returning false for an invalid pattern.
    fn regex_matches(&self, left: &Self::Value, right: &Self::Value) -> bool;
}

/// Evaluates a condition with legacy failure and short-circuit semantics.
#[must_use]
pub fn evaluate_condition<H: ConditionHost>(condition: &Condition, host: &mut H) -> bool {
    match condition {
        Condition::Expr => false,
        Condition::Compare { left, op, right } => {
            let Some(left) = host.resolve(*left) else {
                return false;
            };
            let Some(right) = host.resolve(*right) else {
                return false;
            };
            match op {
                CompareOp::Eq => host.strict_equal(&left, &right),
                CompareOp::Eqi => host.string_equal_insensitive(&left, &right),
                CompareOp::Neq => !host.strict_equal(&left, &right),
                CompareOp::Gt => host.number(&left) > host.number(&right),
                CompareOp::Gte => host.number(&left) >= host.number(&right),
                CompareOp::Lt => host.number(&left) < host.number(&right),
                CompareOp::Lte => host.number(&left) <= host.number(&right),
                CompareOp::Contains => host.string_contains(&left, &right, false),
                CompareOp::ContainsI => host.string_contains(&left, &right, true),
                CompareOp::NotContains => !host.string_contains(&left, &right, false),
                CompareOp::NotContainsI => !host.string_contains(&left, &right, true),
                CompareOp::StartsWith => host.string_starts_with(&left, &right),
                CompareOp::EndsWith => host.string_ends_with(&left, &right),
                CompareOp::Regex => host.regex_matches(&left, &right),
            }
        }
        Condition::Truthy { value } => host
            .resolve(*value)
            .is_some_and(|value| host.is_truthy(&value)),
        Condition::Falsy { value } => host
            .resolve(*value)
            .is_none_or(|value| !host.is_truthy(&value)),
        Condition::Not { condition } => !evaluate_condition(condition, host),
        Condition::And { conditions } => conditions
            .iter()
            .all(|condition| evaluate_condition(condition, host)),
        Condition::Or { conditions } => conditions
            .iter()
            .any(|condition| evaluate_condition(condition, host)),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Default)]
    struct Host {
        values: VecDeque<Option<u8>>,
        resolutions: usize,
    }

    impl ConditionHost for Host {
        type Value = u8;

        fn resolve(&mut self, _: usize) -> Option<Self::Value> {
            self.resolutions += 1;
            self.values.pop_front().flatten()
        }

        fn is_truthy(&self, value: &Self::Value) -> bool {
            *value != 0
        }

        fn strict_equal(&self, left: &Self::Value, right: &Self::Value) -> bool {
            left == right
        }

        fn number(&self, value: &Self::Value) -> f64 {
            f64::from(*value)
        }

        fn string_equal_insensitive(&self, left: &Self::Value, right: &Self::Value) -> bool {
            left == right
        }

        fn string_contains(&self, left: &Self::Value, right: &Self::Value, _: bool) -> bool {
            left == right
        }

        fn string_starts_with(&self, left: &Self::Value, right: &Self::Value) -> bool {
            left == right
        }

        fn string_ends_with(&self, left: &Self::Value, right: &Self::Value) -> bool {
            left == right
        }

        fn regex_matches(&self, left: &Self::Value, right: &Self::Value) -> bool {
            left == right
        }
    }

    #[test]
    fn falsy_treats_a_resolver_failure_as_true() {
        let mut host = Host {
            values: VecDeque::from([None]),
            ..Host::default()
        };
        assert!(evaluate_condition(
            &Condition::Falsy { value: 0 },
            &mut host
        ));
    }

    #[test]
    fn and_short_circuits_before_resolving_later_conditions() {
        let condition = Condition::And {
            conditions: vec![
                Condition::Truthy { value: 0 },
                Condition::Truthy { value: 1 },
            ],
        };
        let mut host = Host {
            values: VecDeque::from([Some(0), Some(1)]),
            ..Host::default()
        };
        assert!(!evaluate_condition(&condition, &mut host));
        assert_eq!(host.resolutions, 1);
    }
}
