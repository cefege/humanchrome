//! Stable recording-variable upserts while the host retains keys and opaque variable values.

use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableAppendOperation {
    pub source_index: usize,
    pub target_index: usize,
}

/// Selects first-key updates and sequential appends over host-interned SameValueZero keys.
/// `None` represents a JavaScript-falsy key, which the original recorder ignores.
#[must_use]
pub fn recording_variable_append_plan(
    existing: &[Option<u32>],
    incoming: &[Option<u32>],
) -> Vec<VariableAppendOperation> {
    let mut indexes = HashMap::with_capacity(existing.len() + incoming.len());
    for (index, key) in existing.iter().enumerate() {
        if let Some(key) = key {
            indexes.entry(key).or_insert(index);
        }
    }
    let mut next = existing.len();
    let mut operations = Vec::with_capacity(incoming.len());
    for (source_index, key) in incoming.iter().enumerate() {
        let Some(key) = key else { continue };
        let target_index = *indexes.entry(key).or_insert_with(|| {
            let index = next;
            next += 1;
            index
        });
        operations.push(VariableAppendOperation {
            source_index,
            target_index,
        });
    }
    operations
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_existing_keys_update_the_first_slot_and_new_keys_reuse_their_append_slot() {
        let plan =
            recording_variable_append_plan(&[Some(1), Some(1)], &[Some(1), Some(2), Some(2), None]);
        assert_eq!(
            plan,
            [
                VariableAppendOperation {
                    source_index: 0,
                    target_index: 0
                },
                VariableAppendOperation {
                    source_index: 1,
                    target_index: 2
                },
                VariableAppendOperation {
                    source_index: 2,
                    target_index: 2
                },
            ]
        );
    }
}
