//! Portable editor comparison, parsing, and fingerprint-ranking policy.
//!
//! Browser adapters collect DOM and CSSOM values before invoking this module; this module never
//! retains DOM handles or evaluates browser-native CSS semantics.

use serde::{Deserialize, Serialize};

mod cascade;
pub use cascade::{
    CascadeCandidate, CascadeRank, cascade_overrides, compare_cascade, compare_order,
};
mod css_model;
pub use css_model::{expand_to_longhands, is_inheritable_property, normalize_property};
mod snap;
pub use snap::{
    Anchors as SnapAnchors, DistanceLabel as SnapDistanceLabel, DistanceLabelsInput,
    Rect as SnapRect, SnapFrameInput, SnapInput, SnapResult, SnapState,
    ViewportSize as SnapViewportSize, compute as compute_snap,
    distance_labels as compute_snap_distance_labels,
};
mod specificity;
pub use specificity::{SpecificitySelection, compute_specificity};

const DEFAULT_PX_EPSILON: f64 = 0.5;
const DEFAULT_MATRIX_EPSILON: f64 = 1e-3;

#[derive(Debug, Clone, Deserialize)]
pub struct CssCompareInput {
    pub expected: Vec<CssValue>,
    pub actual: Vec<CssValue>,
    #[serde(rename = "pxEpsilon")]
    pub px_epsilon: Option<f64>,
    #[serde(rename = "matrixEpsilon")]
    pub matrix_epsilon: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CssValue {
    pub property: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CssCompareResult {
    pub matches: bool,
    pub diffs: Vec<CssDiff>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CssDiff {
    pub property: String,
    pub expected: String,
    pub actual: String,
    pub r#match: bool,
    pub reason: &'static str,
}

/// Compares pre-read computed CSS values using the editor's historical tolerances.
#[must_use]
pub fn compare_computed(input: CssCompareInput) -> CssCompareResult {
    let px_epsilon = input
        .px_epsilon
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_PX_EPSILON);
    let matrix_epsilon = input
        .matrix_epsilon
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_MATRIX_EPSILON);
    let mut diffs = Vec::with_capacity(input.expected.len());
    for expected in input.expected {
        let actual = input
            .actual
            .iter()
            .find(|actual| actual.property == expected.property)
            .map(|actual| actual.value.as_str())
            .unwrap_or("");
        let expected_value = normalize_css_value(&expected.value);
        let actual_value = normalize_css_value(actual);
        let (matches, reason) =
            compare_css_value(&expected_value, &actual_value, px_epsilon, matrix_epsilon);
        diffs.push(CssDiff {
            property: expected.property,
            expected: expected_value,
            actual: actual_value,
            r#match: matches,
            reason,
        });
    }
    let matches = diffs.iter().all(|diff| diff.r#match);
    CssCompareResult { matches, diffs }
}

/// Collapses JavaScript whitespace runs and trims their edges.
#[must_use]
pub fn normalize_text(value: &str) -> String {
    collapse_whitespace(value, false)
}

/// Normalizes one CSS value using the historical comparison punctuation rules.
#[must_use]
pub fn normalize_css_value(value: &str) -> String {
    let collapsed = collapse_whitespace(value, false);
    let mut out = String::with_capacity(collapsed.len());
    let mut chars = collapsed.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == ',' || ch == '(' {
            out.push(ch);
            if matches!(chars.peek(), Some(next) if is_js_whitespace(*next)) {
                chars.next();
            }
        } else if ch == ' ' && matches!(chars.peek(), Some(')')) {
            continue;
        } else {
            out.push(ch);
        }
    }
    out
}

fn compare_css_value(
    expected: &str,
    actual: &str,
    px_epsilon: f64,
    matrix_epsilon: f64,
) -> (bool, &'static str) {
    if expected == actual {
        return (true, "exact");
    }
    if is_matrix(expected) && is_matrix(actual) && compare_matrix(expected, actual, matrix_epsilon)
    {
        return (true, "matrix_epsilon");
    }
    if has_px(expected) && has_px(actual) && compare_px(expected, actual, px_epsilon) {
        return (true, "px_epsilon");
    }
    (false, "string")
}

fn is_matrix(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("matrix(") || lower.starts_with("matrix3d(")
}

fn compare_matrix(expected: &str, actual: &str, epsilon: f64) -> bool {
    let expected_kind = expected.to_ascii_lowercase().starts_with("matrix3d(");
    if expected_kind != actual.to_ascii_lowercase().starts_with("matrix3d(") {
        return false;
    }
    let left = extract_numbers(expected);
    let right = extract_numbers(actual);
    left.len() == right.len()
        && !left.is_empty()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| (left - right).abs() <= epsilon)
}

fn compare_px(expected: &str, actual: &str, epsilon: f64) -> bool {
    let left = extract_px_numbers(expected);
    let right = extract_px_numbers(actual);
    left.len() == right.len()
        && !left.is_empty()
        && px_shape(expected) == px_shape(actual)
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| (left - right).abs() <= epsilon)
}

fn has_px(value: &str) -> bool {
    !extract_px_numbers(value).is_empty()
}

fn px_shape(value: &str) -> String {
    let bytes = normalize_css_value(value).as_bytes().to_vec();
    let mut out = String::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if let Some((end, _)) = parse_number_at(&bytes, index)
            && bytes
                .get(end..end + 2)
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(b"px"))
        {
            out.push_str("#px");
            index = end + 2;
            continue;
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    out
}

fn extract_numbers(value: &str) -> Vec<f64> {
    let bytes = value.as_bytes();
    let mut values = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if let Some((end, value)) = parse_number_at(bytes, index) {
            values.push(value);
            index = end;
        } else {
            index += 1;
        }
    }
    values
}

fn extract_px_numbers(value: &str) -> Vec<f64> {
    let bytes = value.as_bytes();
    let mut values = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if let Some((end, number)) = parse_number_at(bytes, index)
            && bytes
                .get(end..end + 2)
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(b"px"))
        {
            values.push(number);
            index = end + 2;
            continue;
        }
        index += 1;
    }
    values
}

fn parse_number_at(bytes: &[u8], start: usize) -> Option<(usize, f64)> {
    let mut index = start;
    if matches!(bytes.get(index), Some(b'-')) {
        index += 1;
    }
    let digit_start = index;
    while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
        index += 1;
    }
    if matches!(bytes.get(index), Some(b'.')) {
        index += 1;
        while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
            index += 1;
        }
    }
    if index == digit_start {
        return None;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        let exponent_start = index;
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let digits = index;
        while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
            index += 1;
        }
        if index == digits {
            index = exponent_start;
        }
    }
    let value = std::str::from_utf8(&bytes[start..index])
        .ok()?
        .parse::<f64>()
        .ok()?;
    value.is_finite().then_some((index, value))
}

/// Formats a CSS custom property reference without reading CSSOM.
#[must_use]
pub fn format_css_var(name: &str, fallback: Option<&str>) -> String {
    match fallback
        .map(str::trim)
        .filter(|fallback| !fallback.is_empty())
    {
        Some(fallback) => format!("var({name}, {fallback})"),
        None => format!("var({name})"),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CssVarReference {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

/// Parses a standalone `var()` expression, preserving the existing permissive custom-name rule.
#[must_use]
pub fn parse_css_var(value: &str) -> Option<CssVarReference> {
    let raw = value.trim();
    if !raw.get(..4)?.eq_ignore_ascii_case("var(") {
        return None;
    }
    let mut depth = 0_i32;
    let mut end = None;
    for (index, ch) in raw.char_indices() {
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                end = Some(index);
                break;
            }
        }
    }
    let end = end?;
    if end + 1 != raw.len() {
        return None;
    }
    let inner = raw.get(4..end)?.trim();
    if inner.is_empty() {
        return None;
    }
    let mut depth = 0_i32;
    let mut comma = None;
    for (index, ch) in inner.char_indices() {
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth = (depth - 1).max(0);
        } else if ch == ',' && depth == 0 {
            comma = Some(index);
            break;
        }
    }
    let (name, fallback) = match comma {
        Some(index) => (&inner[..index], Some(inner[index + 1..].trim())),
        None => (inner, None),
    };
    let name = name.trim();
    name.starts_with("--").then(|| CssVarReference {
        name: name.to_owned(),
        fallback: fallback
            .filter(|fallback| !fallback.is_empty())
            .map(str::to_owned),
    })
}

/// Extracts token names using the historical `var(--name` scanner.
#[must_use]
pub fn extract_css_var_names(value: &str) -> Vec<String> {
    let mut names = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index + 5 <= bytes.len() {
        if bytes[index..]
            .get(..4)
            .map(|prefix| prefix.eq_ignore_ascii_case(b"var("))
            .unwrap_or(false)
        {
            let mut cursor = index + 4;
            while matches!(bytes.get(cursor), Some(byte) if is_js_whitespace(*byte as char)) {
                cursor += 1;
            }
            if bytes.get(cursor..cursor + 2) == Some(b"--".as_slice()) {
                let start = cursor;
                cursor += 2;
                while matches!(bytes.get(cursor), Some(byte) if byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
                {
                    cursor += 1;
                }
                if cursor > start + 2 {
                    names.push(value[start..cursor].to_owned());
                }
            }
        }
        index += 1;
    }
    names
}

#[derive(Debug, Clone, Deserialize)]
pub struct FingerprintRankInput {
    pub expected: Fingerprint,
    pub candidate: Fingerprint,
    #[serde(rename = "expectedText", default)]
    pub expected_text: Option<String>,
    #[serde(rename = "actualText", default)]
    pub actual_text: Option<String>,
    #[serde(rename = "expectedPath", default)]
    pub expected_path: Vec<i64>,
    #[serde(rename = "candidatePath", default)]
    pub candidate_path: Vec<i64>,
    #[serde(rename = "anchorCenter", default)]
    pub anchor_center: Option<Point>,
    #[serde(rename = "candidateCenter", default)]
    pub candidate_center: Option<Point>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Fingerprint {
    pub tag: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub classes: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Scores a collected HMR candidate; `None` retains the JS invalid-candidate sentinel.
#[must_use]
pub fn score_fingerprint_candidate(input: &FingerprintRankInput) -> Option<f64> {
    if input.candidate.tag != input.expected.tag
        || input
            .expected
            .id
            .as_ref()
            .is_some_and(|id| input.candidate.id.as_ref() != Some(id))
    {
        return None;
    }
    let mut score = if input.expected.id.is_some() {
        12.0
    } else {
        0.0
    };
    let overlap = input
        .expected
        .classes
        .iter()
        .filter(|class_name| input.candidate.classes.contains(class_name))
        .count();
    score += (overlap * 2).min(8) as f64;
    if let Some(expected) = input.expected_text.as_deref()
        && input
            .actual_text
            .as_deref()
            .map(normalize_text)
            .is_some_and(|actual| actual.contains(&normalize_text(expected)))
    {
        score += 4.0;
    }
    if !input.expected_path.is_empty() {
        let prefix = input
            .expected_path
            .iter()
            .zip(&input.candidate_path)
            .take_while(|(left, right)| left == right)
            .count();
        score += prefix as f64 / input.expected_path.len() as f64 * 6.0;
        if prefix == input.expected_path.len()
            && input.candidate_path.len() == input.expected_path.len()
        {
            score += 2.0;
        }
    }
    if let (Some(anchor), Some(candidate)) = (&input.anchor_center, &input.candidate_center)
        && anchor.x.is_finite()
        && anchor.y.is_finite()
        && candidate.x.is_finite()
        && candidate.y.is_finite()
    {
        score += (6.0 - ((candidate.x - anchor.x).hypot(candidate.y - anchor.y) / 50.0)).max(0.0);
    }
    Some(score)
}

fn collapse_whitespace(value: &str, _css: bool) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for ch in value.chars() {
        if is_js_whitespace(ch) {
            if !out.is_empty() {
                pending_space = true;
            }
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

fn is_js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct RgbaColor {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

/// Clamps a finite number, retaining the editor's non-finite lower-bound behavior.
#[must_use]
pub fn clamp_number(value: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        min
    }
}

/// Parses a hexadecimal CSS color supported by the gradient editor.
#[must_use]
pub fn parse_hex_color(value: &str) -> Option<RgbaColor> {
    let value = value.trim().to_ascii_lowercase();
    let hex = value.strip_prefix('#')?;
    let byte = |index: usize| u8::from_str_radix(hex.get(index..index + 2)?, 16).ok();
    match hex.len() {
        3 => Some(RgbaColor {
            r: u8::from_str_radix(&hex[0..1].repeat(2), 16).ok()? as f64,
            g: u8::from_str_radix(&hex[1..2].repeat(2), 16).ok()? as f64,
            b: u8::from_str_radix(&hex[2..3].repeat(2), 16).ok()? as f64,
            a: 1.0,
        }),
        4 => Some(RgbaColor {
            r: u8::from_str_radix(&hex[0..1].repeat(2), 16).ok()? as f64,
            g: u8::from_str_radix(&hex[1..2].repeat(2), 16).ok()? as f64,
            b: u8::from_str_radix(&hex[2..3].repeat(2), 16).ok()? as f64,
            a: u8::from_str_radix(&hex[3..4].repeat(2), 16).ok()? as f64 / 255.0,
        }),
        6 => Some(RgbaColor {
            r: byte(0)? as f64,
            g: byte(2)? as f64,
            b: byte(4)? as f64,
            a: 1.0,
        }),
        8 => Some(RgbaColor {
            r: byte(0)? as f64,
            g: byte(2)? as f64,
            b: byte(4)? as f64,
            a: byte(6)? as f64 / 255.0,
        }),
        _ => None,
    }
}

/// Parses the gradient editor's supported `rgb()` and `rgba()` forms.
#[must_use]
pub fn parse_rgb_color(value: &str) -> Option<RgbaColor> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("rgb(") || lower.starts_with("rgba(")) {
        return None;
    }
    let open = trimmed.find('(')?;
    let close = trimmed.rfind(')')?;
    if close < open {
        return None;
    }
    let inner = trimmed.get(open + 1..close)?.trim();
    if inner.is_empty() {
        return None;
    }
    let (channels, alpha) = match inner.find('/') {
        Some(index) => (&inner[..index], Some(inner[index + 1..].trim())),
        None => (inner, None),
    };
    let tokens = if channels.contains(',') {
        channels
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
    } else {
        channels.split_whitespace().collect::<Vec<_>>()
    };
    if tokens.len() < 3 {
        return None;
    }
    let mut alpha = alpha;
    if alpha.is_none() && tokens.len() >= 4 {
        alpha = tokens.get(3).copied();
    }
    Some(RgbaColor {
        r: parse_rgb_channel(tokens[0])?,
        g: parse_rgb_channel(tokens[1])?,
        b: parse_rgb_channel(tokens[2])?,
        a: alpha.and_then(parse_alpha_channel).unwrap_or(1.0),
    })
}

/// Formats an RGBA color exactly as the gradient control's authored CSS subset.
#[must_use]
pub fn rgba_to_css(color: RgbaColor) -> String {
    let alpha = clamp_number(color.a, 0.0, 1.0);
    let r = clamp_byte(color.r);
    let g = clamp_byte(color.g);
    let b = clamp_byte(color.b);
    if alpha >= 1.0 {
        return format!("#{r:02x}{g:02x}{b:02x}");
    }
    let alpha = (alpha * 1000.0).round() / 1000.0;
    format!("rgba({r}, {g}, {b}, {alpha})")
}

/// Interpolates two colors after applying the control's `t` clamp.
#[must_use]
pub fn interpolate_rgba(left: RgbaColor, right: RgbaColor, t: f64) -> RgbaColor {
    let t = clamp_number(t, 0.0, 1.0);
    RgbaColor {
        r: left.r + (right.r - left.r) * t,
        g: left.g + (right.g - left.g) * t,
        b: left.b + (right.b - left.b) * t,
        a: left.a + (right.a - left.a) * t,
    }
}

fn clamp_byte(value: f64) -> u8 {
    clamp_number(value, 0.0, 255.0).round() as u8
}

fn parse_rgb_channel(value: &str) -> Option<f64> {
    let value = value.trim();
    let value = if let Some(percent) = value.strip_suffix('%') {
        percent
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(|number| number / 100.0 * 255.0)?
    } else {
        value
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())?
    };
    Some(clamp_byte(value) as f64)
}

fn parse_alpha_channel(value: &str) -> Option<f64> {
    let value = value.trim();
    let value = if let Some(percent) = value.strip_suffix('%') {
        percent
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(|number| number / 100.0)?
    } else {
        value
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())?
    };
    Some(clamp_number(value, 0.0, 1.0))
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParsedGradientStop {
    pub color: String,
    pub position: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GradientStop {
    pub color: String,
    pub position: f64,
}

/// Normalizes parsed gradient stops with the control's CSS-compatible default and ordering rules.
#[must_use]
pub fn normalize_gradient_stops(stops: &[ParsedGradientStop]) -> Vec<GradientStop> {
    if stops.is_empty() {
        return Vec::new();
    }
    if stops.len() == 1 {
        let stop = &stops[0];
        return vec![GradientStop {
            color: fallback_stop_color(&stop.color),
            position: clamp_number(stop.position.unwrap_or(0.0), 0.0, 100.0),
        }];
    }
    let mut positions = stops
        .iter()
        .map(|stop| {
            stop.position
                .map(|position| clamp_number(position, 0.0, 100.0))
        })
        .collect::<Vec<_>>();
    if positions[0].is_none() {
        positions[0] = Some(0.0);
    }
    let last = positions.len() - 1;
    if positions[last].is_none() {
        positions[last] = Some(100.0);
    }
    let mut max_so_far = positions[0].unwrap_or(0.0);
    for value in positions.iter_mut().skip(1).flatten() {
        if *value < max_so_far {
            *value = max_so_far;
        } else {
            max_so_far = *value;
        }
    }
    let mut run_start = None;
    for index in 0..positions.len() {
        if positions[index].is_none() {
            run_start.get_or_insert(index);
        } else if let Some(start) = run_start.take() {
            let previous = positions[start - 1].unwrap_or(0.0);
            let next = positions[index].unwrap_or(100.0);
            let run_length = index - start + 1;
            for (offset, position) in positions[start..index].iter_mut().enumerate() {
                *position =
                    Some(previous + (next - previous) * (offset + 1) as f64 / run_length as f64);
            }
        }
    }
    stops
        .iter()
        .zip(positions)
        .map(|(stop, position)| GradientStop {
            color: fallback_stop_color(&stop.color),
            position: clamp_number(position.unwrap_or(0.0), 0.0, 100.0),
        })
        .collect()
}

/// Associates inline stops with closest computed stop colors, retaining first-match ties.
#[must_use]
pub fn gradient_placeholder_mapping(
    inline: &[GradientStop],
    computed: &[GradientStop],
) -> Vec<String> {
    inline
        .iter()
        .map(|inline_stop| {
            computed
                .iter()
                .min_by(|left, right| {
                    (left.position - inline_stop.position)
                        .abs()
                        .partial_cmp(&(right.position - inline_stop.position).abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|stop| stop.color.clone())
                .unwrap_or_default()
        })
        .collect()
}

fn fallback_stop_color(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        "#000000".to_owned()
    } else {
        value.to_owned()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ParsedBoxShadow {
    pub inset: bool,
    #[serde(rename = "offsetX")]
    pub offset_x: String,
    #[serde(rename = "offsetY")]
    pub offset_y: String,
    #[serde(rename = "blurRadius")]
    pub blur_radius: String,
    #[serde(rename = "spreadRadius")]
    pub spread_radius: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CssFunctionMatch {
    pub start: usize,
    pub end: usize,
    pub args: String,
}

/// Splits a CSS value at top-level separators while retaining quoted and escaped content.
#[must_use]
pub fn split_css_top_level(value: &str, separator: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut depth = 0_i32;
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            continue;
        }
        match ch {
            '(' => depth += 1,
            ')' => depth = (depth - 1).max(0),
            _ => {}
        }
        if ch == separator && depth == 0 {
            out.push(value[start..index].to_owned());
            start = index + ch.len_utf8();
        }
    }
    out.push(value[start..].to_owned());
    out
}

/// Splits a CSS value at top-level whitespace while retaining functional and quoted values.
#[must_use]
pub fn tokenize_css_top_level(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = None;
    let mut depth = 0_i32;
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            continue;
        }
        match ch {
            '(' => depth += 1,
            ')' => depth = (depth - 1).max(0),
            _ => {}
        }
        if depth == 0 && is_js_whitespace(ch) {
            if let Some(start) = start.take() {
                out.push(value[start..index].to_owned());
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(start) = start {
        out.push(value[start..].to_owned());
    }
    out
}

/// Adds the gradient/effects editor's default `px` suffix to pure numeric lengths.
#[must_use]
pub fn normalize_editor_length(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("none") {
        return String::new();
    }
    if is_plain_length_number(trimmed) || is_trailing_dot_number(trimmed) {
        return format!("{}px", trimmed.strip_suffix('.').unwrap_or(trimmed));
    }
    trimmed.to_owned()
}

/// Parses the first authored box shadow without browser color resolution.
#[must_use]
pub fn parse_box_shadow(raw: &str) -> Option<ParsedBoxShadow> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("none") {
        return None;
    }
    let first = split_css_top_level(trimmed, ',')
        .into_iter()
        .next()?
        .trim()
        .to_owned();
    if first.is_empty() || first.eq_ignore_ascii_case("none") {
        return None;
    }
    let mut inset = false;
    let mut lengths = Vec::new();
    let mut other = Vec::new();
    for token in tokenize_css_top_level(&first) {
        if token.eq_ignore_ascii_case("inset") {
            inset = true;
        } else if is_length_token(&token) || (is_css_function_token(&token) && lengths.len() < 4) {
            lengths.push(token);
        } else {
            other.push(token);
        }
    }
    (lengths.len() >= 2).then(|| ParsedBoxShadow {
        inset,
        offset_x: lengths.first().cloned().unwrap_or_default(),
        offset_y: lengths.get(1).cloned().unwrap_or_default(),
        blur_radius: lengths.get(2).cloned().unwrap_or_default(),
        spread_radius: lengths.get(3).cloned().unwrap_or_default(),
        color: other.join(" "),
    })
}

/// Finds one named CSS function with quote, escape, and nested-parenthesis handling.
#[must_use]
pub fn find_css_function(value: &str, name: &str) -> Option<CssFunctionMatch> {
    let lower = value.to_ascii_lowercase();
    let needle = name.to_ascii_lowercase();
    let mut search = 0;
    while let Some(relative) = lower.get(search..)?.find(&needle) {
        let found = search + relative;
        if found > 0
            && value[..found]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        {
            search = found + needle.len();
            continue;
        }
        let mut open = found + needle.len();
        while value
            .get(open..)?
            .chars()
            .next()
            .is_some_and(is_js_whitespace)
        {
            open += 1;
        }
        if value.as_bytes().get(open) != Some(&b'(') {
            search = found + needle.len();
            continue;
        }
        let mut depth = 0_i32;
        let mut quote = None;
        let mut escaped = false;
        for (relative, ch) in value[open..].char_indices() {
            let index = open + relative;
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if let Some(active) = quote {
                if ch == active {
                    quote = None;
                }
                continue;
            }
            if matches!(ch, '\'' | '"') {
                quote = Some(ch);
                continue;
            }
            if ch == '(' {
                depth += 1;
            }
            if ch == ')' {
                depth -= 1;
                if depth == 0 {
                    return Some(CssFunctionMatch {
                        start: found,
                        end: index + 1,
                        args: value[open + 1..index].to_owned(),
                    });
                }
            }
        }
        return None;
    }
    None
}

fn is_plain_length_number(value: &str) -> bool {
    value.parse::<f64>().is_ok() && !value.contains(['e', 'E'])
}
fn is_trailing_dot_number(value: &str) -> bool {
    value
        .strip_suffix('.')
        .is_some_and(|value| !value.is_empty() && value.parse::<f64>().is_ok())
}
fn is_length_token(value: &str) -> bool {
    let value = value.strip_prefix('-').unwrap_or(value);
    let numeric_end = value
        .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .unwrap_or(value.len());
    numeric_end > 0
        && value[..numeric_end].parse::<f64>().is_ok()
        && value[numeric_end..]
            .chars()
            .all(|ch| ch.is_ascii_alphabetic() || ch == '%')
}
fn is_css_function_token(value: &str) -> bool {
    let value = value.trim_start();
    let name_end = value
        .find(|ch: char| !(ch.is_ascii_alphabetic() || matches!(ch, '_' | '-')))
        .unwrap_or(value.len());
    name_end > 0 && value[name_end..].trim_start().starts_with('(')
}

/// Compares CSS specificity tuples lexicographically.
#[must_use]
pub fn compare_specificity(left: [i64; 4], right: [i64; 4]) -> i64 {
    left.into_iter()
        .zip(right)
        .find_map(|(left, right)| (left != right).then_some(if left > right { 1 } else { -1 }))
        .unwrap_or(0)
}

/// Splits a selector list while preserving quoted, escaped, functional, and attribute content.
#[must_use]
pub fn split_selector_list(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut paren = 0_i32;
    let mut bracket = 0_i32;
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            continue;
        }
        match ch {
            '[' => bracket += 1,
            ']' => bracket = (bracket - 1).max(0),
            '(' => paren += 1,
            ')' => paren = (paren - 1).max(0),
            ',' if paren == 0 && bracket == 0 => {
                let part = value[start..index].trim();
                if !part.is_empty() {
                    out.push(part.to_owned());
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    let tail = value[start..].trim();
    if !tail.is_empty() {
        out.push(tail.to_owned());
    }
    out
}
