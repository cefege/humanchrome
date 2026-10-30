//! The editor's existing selector-specificity grammar, including its permissive malformed input.

use super::is_js_whitespace;
use serde::Serialize;

type Specificity = [i64; 4];

fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

fn ident_start(unit: u16) -> bool {
    matches!(unit, 0x41..=0x5a | 0x61..=0x7a | 0x5f) || unit >= 0x80
}

fn consume_ident(input: &[u16], mut index: usize) -> usize {
    while let Some(&unit) = input.get(index) {
        if unit == 0x5c {
            index += 2;
        } else if ident_start(unit) || matches!(unit, 0x30..=0x39 | 0x2d) {
            index += 1;
        } else {
            break;
        }
    }
    index
}

fn consume_bracket(input: &[u16], open: usize) -> usize {
    let mut depth = 1;
    let mut quote = None;
    let mut index = open + 1;
    while let Some(&unit) = input.get(index) {
        if let Some(current_quote) = quote {
            if unit == 0x5c {
                index += 2;
                continue;
            }
            if unit == current_quote {
                quote = None;
            }
        } else {
            match unit {
                0x22 | 0x27 => quote = Some(unit),
                0x5c => {
                    index += 2;
                    continue;
                }
                0x5b => depth += 1,
                0x5d => {
                    depth -= 1;
                    if depth == 0 {
                        return index;
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    input.len() - 1
}

fn consume_function(input: &[u16], open: usize) -> (&[u16], usize) {
    let mut depth = 1;
    let mut quote = None;
    let mut index = open + 1;
    while let Some(&unit) = input.get(index) {
        if let Some(current_quote) = quote {
            if unit == 0x5c {
                index += 2;
                continue;
            }
            if unit == current_quote {
                quote = None;
            }
        } else {
            match unit {
                0x22 | 0x27 => quote = Some(unit),
                0x5c => {
                    index += 2;
                    continue;
                }
                0x5b => index = consume_bracket(input, index),
                0x28 => depth += 1,
                0x29 => {
                    depth -= 1;
                    if depth == 0 {
                        return (&input[open + 1..index], index);
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    (&input[open + 1..], input.len() - 1)
}

fn trim(mut input: &[u16]) -> &[u16] {
    while input.first().is_some_and(|&unit| whitespace(unit)) {
        input = &input[1..];
    }
    while input.last().is_some_and(|&unit| whitespace(unit)) {
        input = &input[..input.len() - 1];
    }
    input
}

// Keywords are ASCII, but JS toLowerCase also accepts Unicode spellings such as bacKdrop.
// Compare the lowercase iterator directly rather than allocating a name for each pseudo selector.
fn name_is(name: &[u16], keyword: &str) -> bool {
    let mut expected = keyword.chars();
    for decoded in char::decode_utf16(name.iter().copied()) {
        let Ok(character) = decoded else { return false };
        for lowercase in character.to_lowercase() {
            if expected.next() != Some(lowercase) {
                return false;
            }
        }
    }
    expected.next().is_none()
}

fn max_selector_list(input: &[u16]) -> Specificity {
    let mut best = [0; 4];
    let mut start = 0;
    let mut parentheses = 0_usize;
    let mut brackets = 0_usize;
    let mut quote = None;
    let mut index = 0;
    while let Some(&unit) = input.get(index) {
        if let Some(current_quote) = quote {
            if unit == 0x5c {
                index += 2;
                continue;
            }
            if unit == current_quote {
                quote = None;
            }
        } else {
            match unit {
                0x22 | 0x27 => quote = Some(unit),
                0x5c => {
                    index += 2;
                    continue;
                }
                0x5b => brackets += 1,
                0x5d => brackets = brackets.saturating_sub(1),
                0x28 => parentheses += 1,
                0x29 => parentheses = parentheses.saturating_sub(1),
                0x2c if parentheses == 0 && brackets == 0 => {
                    best = best.max(compute_specificity(trim(&input[start..index])));
                    start = index + 1;
                }
                _ => {}
            }
        }
        index += 1;
    }
    best.max(compute_specificity(trim(&input[start..])))
}

fn nth_of_selectors(input: &[u16]) -> Option<&[u16]> {
    let mut parentheses = 0_usize;
    let mut brackets = 0_usize;
    let mut quote = None;
    let mut index = 0;
    while let Some(&unit) = input.get(index) {
        if let Some(current_quote) = quote {
            if unit == 0x5c {
                index += 2;
                continue;
            }
            if unit == current_quote {
                quote = None;
            }
        } else {
            match unit {
                0x22 | 0x27 => {
                    quote = Some(unit);
                    index += 1;
                    continue;
                }
                0x5c => {
                    index += 2;
                    continue;
                }
                0x5b => brackets += 1,
                0x5d => brackets = brackets.saturating_sub(1),
                0x28 => parentheses += 1,
                0x29 => parentheses = parentheses.saturating_sub(1),
                _ => {}
            }
            let previous_ok = index == 0 || whitespace(input[index - 1]);
            let next_ok = input.get(index + 2).is_none_or(|&next| whitespace(next));
            if parentheses == 0
                && brackets == 0
                && unit == 0x6f
                && input.get(index + 1) == Some(&0x66)
                && previous_ok
                && next_ok
            {
                let mut selectors = &input[index + 2..];
                while selectors.first().is_some_and(|&next| whitespace(next)) {
                    selectors = &selectors[1..];
                }
                return Some(selectors);
            }
        }
        index += 1;
    }
    None
}

/// Computes the existing Level-4 specificity policy over JavaScript code units.
/// Nested arguments borrow the original selector; parsing does not allocate or copy substrings.
#[must_use]
pub fn compute_specificity(input: &[u16]) -> Specificity {
    let mut result = [0; 4];
    let mut expect_type = true;
    let mut index = 0;
    while let Some(&unit) = input.get(index) {
        match unit {
            0x5c => index += 2,
            0x5b => {
                result[2] += 1;
                index = consume_bracket(input, index) + 1;
                expect_type = false;
            }
            _ if whitespace(unit) || matches!(unit, 0x3e | 0x2b | 0x7e | 0x7c) => {
                while input.get(index).is_some_and(|&next| whitespace(next)) {
                    index += 1;
                }
                if input.get(index) == Some(&0x7c) && input.get(index + 1) == Some(&0x7c) {
                    index += 2;
                } else if input
                    .get(index)
                    .is_some_and(|&next| matches!(next, 0x3e | 0x2b | 0x7e | 0x7c))
                {
                    index += 1;
                }
                expect_type = true;
            }
            0x23 | 0x2e => {
                result[if unit == 0x23 { 1 } else { 2 }] += 1;
                index = consume_ident(input, index + 1);
                expect_type = false;
            }
            0x3a => {
                let pseudo_element = input.get(index + 1) == Some(&0x3a);
                let start = index + if pseudo_element { 2 } else { 1 };
                let end = consume_ident(input, start);
                let name = &input[start..end.min(input.len())];
                if pseudo_element {
                    result[3] += 1;
                    index = end;
                    if input.get(end) == Some(&0x28) && name_is(name, "slotted") {
                        let (content, close) = consume_function(input, end);
                        let argument = max_selector_list(content);
                        for offset in 1..4 {
                            result[offset] += argument[offset];
                        }
                        index = close + 1;
                    }
                } else if [
                    "before",
                    "after",
                    "first-line",
                    "first-letter",
                    "selection",
                    "backdrop",
                    "placeholder",
                ]
                .iter()
                .any(|keyword| name_is(name, keyword))
                {
                    result[3] += 1;
                    index = end;
                } else if input.get(end) == Some(&0x28) {
                    let (content, close) = consume_function(input, end);
                    index = close + 1;
                    if name_is(name, "where") {
                        // :where intentionally contributes no specificity.
                    } else if ["is", "not", "has"]
                        .iter()
                        .any(|keyword| name_is(name, keyword))
                    {
                        let argument = max_selector_list(content);
                        for offset in 1..4 {
                            result[offset] += argument[offset];
                        }
                    } else {
                        result[2] += 1;
                        if (name_is(name, "nth-child") || name_is(name, "nth-last-child"))
                            && let Some(selectors) = nth_of_selectors(content)
                        {
                            let argument = max_selector_list(selectors);
                            for offset in 1..4 {
                                result[offset] += argument[offset];
                            }
                        }
                    }
                } else {
                    result[2] += 1;
                    index = end;
                }
                expect_type = false;
            }
            0x2a if expect_type => {
                index += 1;
                expect_type = false;
            }
            _ if expect_type && ident_start(unit) => {
                result[3] += 1;
                index = consume_ident(input, index + 1);
                expect_type = false;
            }
            _ => index += 1,
        }
    }
    result
}

#[derive(Clone, Copy, Serialize)]
pub struct SpecificityMatch {
    index: usize,
    specificity: Specificity,
}

/// Streaming maximum over host-matched selectors, without storing or copying their text.
#[derive(Default)]
pub struct SpecificitySelection {
    best: Option<SpecificityMatch>,
}

impl SpecificitySelection {
    /// Considers one matched selector, preserving the first candidate on a tie.
    pub fn consider(&mut self, index: usize, selector: &[u16]) {
        let specificity = compute_specificity(selector);
        if self.best.is_none_or(|best| specificity > best.specificity) {
            self.best = Some(SpecificityMatch { index, specificity });
        }
    }

    /// Returns the selected source index and its specificity, or no match.
    #[must_use]
    pub fn finish(self) -> Option<SpecificityMatch> {
        self.best
    }
}

#[cfg(test)]
mod tests {
    use super::compute_specificity;

    #[test]
    fn nested_lists_and_nth_of_retain_existing_argument_selection() {
        for (selector, expected) in [
            (":where(#x,.a)", [0, 0, 0, 0]),
            (":not(.a):has(> #x)", [0, 1, 1, 0]),
            (":nth-last-child(odd of :where(#x),p.a)", [0, 0, 2, 1]),
            (":nth-child(2n OF #x)", [0, 0, 1, 0]),
            ("::slotted(:is(.a,#x))", [0, 1, 0, 1]),
            (":is([data-x=\"a,b\"],.x)", [0, 0, 1, 0]),
            (":is(.x, #a", [0, 1, 0, 0]),
        ] {
            assert_eq!(
                compute_specificity(&selector.encode_utf16().collect::<Vec<_>>()),
                expected,
                "{selector}"
            );
        }
    }

    #[test]
    fn namespace_unicode_and_permissive_pseudo_element_behavior_are_not_rewritten() {
        for (selector, expected) in [
            ("svg|a", [0, 0, 0, 2]),
            (":before(#x)", [0, 1, 0, 1]),
            ("::part(.x)", [0, 0, 1, 1]),
            (":bacKdrop", [0, 0, 0, 1]),
        ] {
            assert_eq!(
                compute_specificity(&selector.encode_utf16().collect::<Vec<_>>()),
                expected,
                "{selector}"
            );
        }
        assert_eq!(compute_specificity(&[0xd800, 0x23, 0x78]), [0, 1, 0, 1]);
    }
}
