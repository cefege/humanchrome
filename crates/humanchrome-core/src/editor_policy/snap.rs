//! Numeric resize snapping, lock hysteresis, guide, and distance-label policy.
//!
//! The browser adapter owns DOM rectangle collection and canvas drawing. This module owns all
//! decisions over the collected numeric anchors and keeps per-gesture anchors/locks reusable.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeDirection {
    pub has_west: bool,
    pub has_east: bool,
    pub has_north: bool,
    pub has_south: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnchorSource {
    Sibling,
    Viewport,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnchorXType {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnchorYType {
    Top,
    Middle,
    Bottom,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorX {
    pub value: f64,
    #[serde(rename = "type")]
    pub anchor_type: AnchorXType,
    pub source: AnchorSource,
    #[serde(default)]
    pub source_rect: Option<Rect>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorY {
    pub value: f64,
    #[serde(rename = "type")]
    pub anchor_type: AnchorYType,
    pub source: AnchorSource,
    #[serde(default)]
    pub source_rect: Option<Rect>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Anchors {
    pub x: Vec<AnchorX>,
    pub y: Vec<AnchorY>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockX {
    #[serde(rename = "type")]
    pub anchor_type: AnchorXType,
    pub value: f64,
    pub source: AnchorSource,
    pub source_rect: Option<Rect>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockY {
    #[serde(rename = "type")]
    pub anchor_type: AnchorYType,
    pub value: f64,
    pub source: AnchorSource,
    pub source_rect: Option<Rect>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapInput {
    pub rect: Rect,
    pub resize: ResizeDirection,
    pub anchors: Anchors,
    pub threshold_px: f64,
    pub hysteresis_px: f64,
    pub min_size_px: f64,
    pub lock_x: Option<LockX>,
    pub lock_y: Option<LockY>,
    pub viewport: ViewportSize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapFrameInput {
    pub rect: Rect,
    pub resize: ResizeDirection,
    pub threshold_px: f64,
    pub hysteresis_px: f64,
    pub min_size_px: f64,
    pub viewport: ViewportSize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapResult {
    pub snapped_rect: Rect,
    pub guide_lines: Vec<ViewportLine>,
    pub lock_x: Option<LockX>,
    pub lock_y: Option<LockY>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct ViewportLine {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistanceLabelsInput {
    pub rect: Rect,
    pub lock_x: Option<LockX>,
    pub lock_y: Option<LockY>,
    pub viewport: ViewportSize,
    pub min_gap_px: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DistanceLabel {
    pub kind: LabelKind,
    pub axis: Axis,
    pub value: f64,
    pub text: String,
    pub line: ViewportLine,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelKind {
    Sibling,
    Viewport,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
}

/// Reusable, owned state for one resize gesture. Replacing targets resets hysteresis locks.
#[derive(Clone, Debug, Default)]
pub struct SnapState {
    anchors: Anchors,
    lock_x: Option<LockX>,
    lock_y: Option<LockY>,
}

impl SnapState {
    /// Stores the DOM-collected anchor batch once for local per-frame computation.
    pub fn set_targets(&mut self, anchors: Anchors) {
        self.anchors = anchors;
        self.lock_x = None;
        self.lock_y = None;
    }

    /// Applies snapping with the retained anchors and hysteresis locks.
    #[must_use]
    pub fn compute(&mut self, input: SnapFrameInput) -> SnapResult {
        let result = compute_with(
            input,
            &self.anchors,
            self.lock_x.clone(),
            self.lock_y.clone(),
        );
        self.lock_x = result.lock_x.clone();
        self.lock_y = result.lock_y.clone();
        result
    }

    /// Computes labels from the current retained locks without copying the anchor batch.
    #[must_use]
    pub fn distance_labels(
        &self,
        rect: Rect,
        viewport: ViewportSize,
        min_gap_px: f64,
    ) -> Vec<DistanceLabel> {
        distance_labels(DistanceLabelsInput {
            rect,
            lock_x: self.lock_x.clone(),
            lock_y: self.lock_y.clone(),
            viewport,
            min_gap_px,
        })
    }
}

/// Applies the resize snapping contract to one complete input.
#[must_use]
pub fn compute(input: SnapInput) -> SnapResult {
    compute_with(
        SnapFrameInput {
            rect: input.rect,
            resize: input.resize,
            threshold_px: input.threshold_px,
            hysteresis_px: input.hysteresis_px,
            min_size_px: input.min_size_px,
            viewport: input.viewport,
        },
        &input.anchors,
        input.lock_x,
        input.lock_y,
    )
}

fn compute_with(
    input: SnapFrameInput,
    anchors: &Anchors,
    initial_lock_x: Option<LockX>,
    initial_lock_y: Option<LockY>,
) -> SnapResult {
    let SnapFrameInput {
        rect: initial_rect,
        resize,
        threshold_px,
        hysteresis_px,
        min_size_px,
        viewport,
    } = input;
    if !valid_rect(initial_rect) {
        return SnapResult {
            snapped_rect: initial_rect,
            guide_lines: Vec::new(),
            lock_x: None,
            lock_y: None,
        };
    }
    let fixed_x = if resize.has_west {
        FixedX::Right
    } else if resize.has_east {
        FixedX::Left
    } else {
        FixedX::None
    };
    let fixed_y = if resize.has_north {
        FixedY::Bottom
    } else if resize.has_south {
        FixedY::Top
    } else {
        FixedY::None
    };
    let mut rect = initial_rect;
    let mut lock_x = initial_lock_x;
    let mut lock_y = initial_lock_y;

    if fixed_x == FixedX::None {
        lock_x = None;
    } else {
        if let Some(lock) = &lock_x {
            let allowed = matches!(
                (fixed_x, lock.anchor_type),
                (FixedX::Left, AnchorXType::Right | AnchorXType::Center)
                    | (FixedX::Right, AnchorXType::Left | AnchorXType::Center)
            );
            let distance = (lock.value - x_value(rect, lock.anchor_type)).abs();
            if !allowed
                || distance > threshold_px + hysteresis_px
                || apply_x(rect, fixed_x, lock.anchor_type, lock.value, min_size_px).is_none()
            {
                lock_x = None;
            }
        }
        if let Some(lock) = &lock_x {
            if let Some(next) = apply_x(rect, fixed_x, lock.anchor_type, lock.value, min_size_px) {
                rect = next;
            }
        } else if let Some(candidate) = best_x(rect, fixed_x, &anchors.x, threshold_px, min_size_px)
        {
            rect = candidate.rect;
            lock_x = Some(LockX {
                anchor_type: candidate.anchor.anchor_type,
                value: candidate.anchor.value,
                source: candidate.anchor.source,
                source_rect: candidate.anchor.source_rect,
            });
        }
    }

    if fixed_y == FixedY::None {
        lock_y = None;
    } else {
        if let Some(lock) = &lock_y {
            let allowed = matches!(
                (fixed_y, lock.anchor_type),
                (FixedY::Top, AnchorYType::Bottom | AnchorYType::Middle)
                    | (FixedY::Bottom, AnchorYType::Top | AnchorYType::Middle)
            );
            let distance = (lock.value - y_value(rect, lock.anchor_type)).abs();
            if !allowed
                || distance > threshold_px + hysteresis_px
                || apply_y(rect, fixed_y, lock.anchor_type, lock.value, min_size_px).is_none()
            {
                lock_y = None;
            }
        }
        if let Some(lock) = &lock_y {
            if let Some(next) = apply_y(rect, fixed_y, lock.anchor_type, lock.value, min_size_px) {
                rect = next;
            }
        } else if let Some(candidate) = best_y(rect, fixed_y, &anchors.y, threshold_px, min_size_px)
        {
            rect = candidate.rect;
            lock_y = Some(LockY {
                anchor_type: candidate.anchor.anchor_type,
                value: candidate.anchor.value,
                source: candidate.anchor.source,
                source_rect: candidate.anchor.source_rect,
            });
        }
    }
    let guide_lines = guides(rect, lock_x.as_ref(), lock_y.as_ref(), viewport);
    SnapResult {
        snapped_rect: rect,
        guide_lines,
        lock_x,
        lock_y,
    }
}

/// Computes distance labels from a snapped rectangle and current locks.
#[must_use]
pub fn distance_labels(input: DistanceLabelsInput) -> Vec<DistanceLabel> {
    if !valid_rect(input.rect) {
        return Vec::new();
    }
    let viewport_width = if input.viewport.width.is_finite() {
        js_max(1.0, input.viewport.width)
    } else {
        1.0
    };
    let viewport_height = if input.viewport.height.is_finite() {
        js_max(1.0, input.viewport.height)
    } else {
        1.0
    };
    let min_gap = js_max(0.0, input.min_gap_px);
    let mut labels = Vec::new();
    if let Some(lock) = input
        .lock_x
        .as_ref()
        .filter(|lock| lock.source == AnchorSource::Sibling)
        && let Some(other) = lock.source_rect
    {
        let above = input.rect.top - bottom(other);
        let below = other.top - bottom(input.rect);
        if show_gap(above, min_gap) {
            labels.push(label(
                LabelKind::Sibling,
                Axis::Y,
                above,
                ViewportLine {
                    x1: lock.value,
                    y1: bottom(other),
                    x2: lock.value,
                    y2: input.rect.top,
                },
            ));
        } else if show_gap(below, min_gap) {
            labels.push(label(
                LabelKind::Sibling,
                Axis::Y,
                below,
                ViewportLine {
                    x1: lock.value,
                    y1: bottom(input.rect),
                    x2: lock.value,
                    y2: other.top,
                },
            ));
        }
    }
    if let Some(lock) = input
        .lock_y
        .as_ref()
        .filter(|lock| lock.source == AnchorSource::Sibling)
        && let Some(other) = lock.source_rect
    {
        let left = input.rect.left - right(other);
        let right_gap = other.left - right(input.rect);
        if show_gap(left, min_gap) {
            labels.push(label(
                LabelKind::Sibling,
                Axis::X,
                left,
                ViewportLine {
                    x1: right(other),
                    y1: lock.value,
                    x2: input.rect.left,
                    y2: lock.value,
                },
            ));
        } else if show_gap(right_gap, min_gap) {
            labels.push(label(
                LabelKind::Sibling,
                Axis::X,
                right_gap,
                ViewportLine {
                    x1: right(input.rect),
                    y1: lock.value,
                    x2: other.left,
                    y2: lock.value,
                },
            ));
        }
    }
    if let Some(lock) = input
        .lock_x
        .as_ref()
        .filter(|lock| lock.source == AnchorSource::Viewport)
    {
        let y = clamp(center_y(input.rect), 0.0, viewport_height);
        let left = input.rect.left;
        let right_gap = viewport_width - right(input.rect);
        let add_left = |labels: &mut Vec<DistanceLabel>| {
            if show_gap(left, min_gap) {
                labels.push(label(
                    LabelKind::Viewport,
                    Axis::X,
                    left,
                    ViewportLine {
                        x1: 0.0,
                        y1: y,
                        x2: input.rect.left,
                        y2: y,
                    },
                ));
                true
            } else {
                false
            }
        };
        let add_right = |labels: &mut Vec<DistanceLabel>| {
            if show_gap(right_gap, min_gap) {
                labels.push(label(
                    LabelKind::Viewport,
                    Axis::X,
                    right_gap,
                    ViewportLine {
                        x1: right(input.rect),
                        y1: y,
                        x2: viewport_width,
                        y2: y,
                    },
                ));
                true
            } else {
                false
            }
        };
        match lock.anchor_type {
            AnchorXType::Center => {
                add_left(&mut labels);
                add_right(&mut labels);
            }
            AnchorXType::Left => {
                if !add_left(&mut labels) {
                    add_right(&mut labels);
                }
            }
            AnchorXType::Right => {
                if !add_right(&mut labels) {
                    add_left(&mut labels);
                }
            }
        }
    }
    if let Some(lock) = input
        .lock_y
        .as_ref()
        .filter(|lock| lock.source == AnchorSource::Viewport)
    {
        let x = clamp(center_x(input.rect), 0.0, viewport_width);
        let top = input.rect.top;
        let bottom_gap = viewport_height - bottom(input.rect);
        let add_top = |labels: &mut Vec<DistanceLabel>| {
            if show_gap(top, min_gap) {
                labels.push(label(
                    LabelKind::Viewport,
                    Axis::Y,
                    top,
                    ViewportLine {
                        x1: x,
                        y1: 0.0,
                        x2: x,
                        y2: input.rect.top,
                    },
                ));
                true
            } else {
                false
            }
        };
        let add_bottom = |labels: &mut Vec<DistanceLabel>| {
            if show_gap(bottom_gap, min_gap) {
                labels.push(label(
                    LabelKind::Viewport,
                    Axis::Y,
                    bottom_gap,
                    ViewportLine {
                        x1: x,
                        y1: bottom(input.rect),
                        x2: x,
                        y2: viewport_height,
                    },
                ));
                true
            } else {
                false
            }
        };
        match lock.anchor_type {
            AnchorYType::Middle => {
                add_top(&mut labels);
                add_bottom(&mut labels);
            }
            AnchorYType::Top => {
                if !add_top(&mut labels) {
                    add_bottom(&mut labels);
                }
            }
            AnchorYType::Bottom => {
                if !add_bottom(&mut labels) {
                    add_top(&mut labels);
                }
            }
        }
    }
    labels
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FixedX {
    Left,
    Right,
    None,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum FixedY {
    Top,
    Bottom,
    None,
}
struct CandidateX<'a> {
    distance: f64,
    anchor: &'a AnchorX,
    rect: Rect,
}
struct CandidateY<'a> {
    distance: f64,
    anchor: &'a AnchorY,
    rect: Rect,
}

fn best_x<'a>(
    rect: Rect,
    fixed: FixedX,
    anchors: &'a [AnchorX],
    threshold: f64,
    min_size: f64,
) -> Option<CandidateX<'a>> {
    let mut best: Option<CandidateX<'a>> = None;
    for anchor in anchors {
        if !matches!(
            (fixed, anchor.anchor_type),
            (FixedX::Left, AnchorXType::Right | AnchorXType::Center)
                | (FixedX::Right, AnchorXType::Left | AnchorXType::Center)
        ) {
            continue;
        }
        let distance = (anchor.value - x_value(rect, anchor.anchor_type)).abs();
        if distance > threshold {
            continue;
        }
        let Some(next) = apply_x(rect, fixed, anchor.anchor_type, anchor.value, min_size) else {
            continue;
        };
        if best.as_ref().is_none_or(|current| {
            distance < current.distance
                || (distance == current.distance
                    && anchor.source == AnchorSource::Sibling
                    && current.anchor.source != AnchorSource::Sibling)
        }) {
            best = Some(CandidateX {
                distance,
                anchor,
                rect: next,
            });
        }
    }
    best
}
fn best_y<'a>(
    rect: Rect,
    fixed: FixedY,
    anchors: &'a [AnchorY],
    threshold: f64,
    min_size: f64,
) -> Option<CandidateY<'a>> {
    let mut best: Option<CandidateY<'a>> = None;
    for anchor in anchors {
        if !matches!(
            (fixed, anchor.anchor_type),
            (FixedY::Top, AnchorYType::Bottom | AnchorYType::Middle)
                | (FixedY::Bottom, AnchorYType::Top | AnchorYType::Middle)
        ) {
            continue;
        }
        let distance = (anchor.value - y_value(rect, anchor.anchor_type)).abs();
        if distance > threshold {
            continue;
        }
        let Some(next) = apply_y(rect, fixed, anchor.anchor_type, anchor.value, min_size) else {
            continue;
        };
        if best.as_ref().is_none_or(|current| {
            distance < current.distance
                || (distance == current.distance
                    && anchor.source == AnchorSource::Sibling
                    && current.anchor.source != AnchorSource::Sibling)
        }) {
            best = Some(CandidateY {
                distance,
                anchor,
                rect: next,
            });
        }
    }
    best
}
fn apply_x(
    rect: Rect,
    fixed: FixedX,
    anchor: AnchorXType,
    value: f64,
    min_size: f64,
) -> Option<Rect> {
    match (fixed, anchor) {
        (FixedX::Left, AnchorXType::Right) => sized_x(rect, rect.left, value - rect.left, min_size),
        (FixedX::Left, AnchorXType::Center) => {
            sized_x(rect, rect.left, (value - rect.left) * 2.0, min_size)
        }
        (FixedX::Right, AnchorXType::Left) => sized_x(rect, value, right(rect) - value, min_size),
        (FixedX::Right, AnchorXType::Center) => {
            let left = 2.0 * value - right(rect);
            sized_x(rect, left, right(rect) - left, min_size)
        }
        _ => Some(rect),
    }
}
fn apply_y(
    rect: Rect,
    fixed: FixedY,
    anchor: AnchorYType,
    value: f64,
    min_size: f64,
) -> Option<Rect> {
    match (fixed, anchor) {
        (FixedY::Top, AnchorYType::Bottom) => sized_y(rect, rect.top, value - rect.top, min_size),
        (FixedY::Top, AnchorYType::Middle) => {
            sized_y(rect, rect.top, (value - rect.top) * 2.0, min_size)
        }
        (FixedY::Bottom, AnchorYType::Top) => sized_y(rect, value, bottom(rect) - value, min_size),
        (FixedY::Bottom, AnchorYType::Middle) => {
            let top = 2.0 * value - bottom(rect);
            sized_y(rect, top, bottom(rect) - top, min_size)
        }
        _ => Some(rect),
    }
}
fn sized_x(rect: Rect, left: f64, width: f64, min_size: f64) -> Option<Rect> {
    (width.is_finite() && width.partial_cmp(&min_size) != Some(std::cmp::Ordering::Less)).then_some(
        Rect {
            left,
            top: rect.top,
            width,
            height: rect.height,
        },
    )
}
fn sized_y(rect: Rect, top: f64, height: f64, min_size: f64) -> Option<Rect> {
    (height.is_finite() && height.partial_cmp(&min_size) != Some(std::cmp::Ordering::Less))
        .then_some(Rect {
            left: rect.left,
            top,
            width: rect.width,
            height,
        })
}
fn guides(
    rect: Rect,
    lock_x: Option<&LockX>,
    lock_y: Option<&LockY>,
    viewport: ViewportSize,
) -> Vec<ViewportLine> {
    let mut lines = Vec::new();
    let width = js_max(1.0, viewport.width);
    let height = js_max(1.0, viewport.height);
    if let Some(lock) = lock_x {
        if lock.source == AnchorSource::Viewport || lock.source_rect.is_none() {
            lines.push(ViewportLine {
                x1: lock.value,
                y1: 0.0,
                x2: lock.value,
                y2: height,
            });
        } else if let Some(source) = lock.source_rect {
            lines.push(ViewportLine {
                x1: lock.value,
                y1: js_min(source.top, rect.top),
                x2: lock.value,
                y2: js_max(bottom(source), bottom(rect)),
            });
        }
    }
    if let Some(lock) = lock_y {
        if lock.source == AnchorSource::Viewport || lock.source_rect.is_none() {
            lines.push(ViewportLine {
                x1: 0.0,
                y1: lock.value,
                x2: width,
                y2: lock.value,
            });
        } else if let Some(source) = lock.source_rect {
            lines.push(ViewportLine {
                x1: js_min(source.left, rect.left),
                y1: lock.value,
                x2: js_max(right(source), right(rect)),
                y2: lock.value,
            });
        }
    }
    lines
}
fn valid_rect(rect: Rect) -> bool {
    rect.left.is_finite()
        && rect.top.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.width > 0.5
        && rect.height > 0.5
}
fn x_value(rect: Rect, anchor: AnchorXType) -> f64 {
    match anchor {
        AnchorXType::Left => rect.left,
        AnchorXType::Center => center_x(rect),
        AnchorXType::Right => right(rect),
    }
}
fn y_value(rect: Rect, anchor: AnchorYType) -> f64 {
    match anchor {
        AnchorYType::Top => rect.top,
        AnchorYType::Middle => center_y(rect),
        AnchorYType::Bottom => bottom(rect),
    }
}
fn right(rect: Rect) -> f64 {
    rect.left + rect.width
}
fn bottom(rect: Rect) -> f64 {
    rect.top + rect.height
}
fn center_x(rect: Rect) -> f64 {
    rect.left + rect.width / 2.0
}
fn center_y(rect: Rect) -> f64 {
    rect.top + rect.height / 2.0
}
fn show_gap(gap: f64, minimum: f64) -> bool {
    gap.is_finite() && gap > 0.0 && gap >= minimum
}
fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left > right {
        left
    } else if right > left {
        right
    } else if left == 0.0 && right == 0.0 {
        0.0
    } else {
        right
    }
}
fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    if !value.is_finite() {
        minimum
    } else {
        js_min(maximum, js_max(minimum, value))
    }
}
fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left < right {
        left
    } else if right < left {
        right
    } else if left == 0.0 && right == 0.0 {
        -0.0
    } else {
        right
    }
}
fn js_round(value: f64) -> f64 {
    let rounded = (value + 0.5).floor();
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}
fn label(kind: LabelKind, axis: Axis, gap: f64, line: ViewportLine) -> DistanceLabel {
    let rounded = js_round(gap);
    let display = if rounded == 0.0 { 0.0 } else { rounded };
    DistanceLabel {
        kind,
        axis,
        value: rounded,
        text: format!("{}px", crate::json::number_to_string(display)),
        line,
    }
}
