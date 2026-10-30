//! CSS property normalization, inheritance, and shorthand expansion policy.
//!
//! CSSOM remains responsible for parsing declarations. This module only owns the editor's
//! curated property metadata and the pure decisions made from a browser-read property name.

/// Normalizes a browser property name after the JavaScript host has applied ECMAScript coercion.
#[must_use]
pub fn normalize_property(property: &str) -> String {
    let property = property.trim();
    if property.is_empty() || property.starts_with("--") {
        return property.to_owned();
    }
    property.to_lowercase()
}

/// Returns whether the normalized property inherits in the editor's CSSOM view.
#[must_use]
pub fn is_inheritable_property(property: &str) -> bool {
    property.starts_with("--") || INHERITED_PROPERTIES.contains(&property)
}

/// Expands one normalized shorthand into the longhands tracked by the cascade view.
#[must_use]
pub fn expand_to_longhands(property: &str) -> Vec<String> {
    if property.is_empty() {
        return Vec::new();
    }
    if property.starts_with("--") {
        return vec![property.to_owned()];
    }
    shorthand_longhands(property)
        .map(|longhands| {
            longhands
                .iter()
                .map(|property| (*property).to_owned())
                .collect()
        })
        .unwrap_or_else(|| vec![property.to_owned()])
}

/// Returns the curated longhands for a normalized shorthand property.
#[must_use]
pub fn shorthand_longhands(property: &str) -> Option<&'static [&'static str]> {
    Some(match property {
        "margin" => &["margin-top", "margin-right", "margin-bottom", "margin-left"],
        "padding" => &[
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
        ],
        "inset" => &["top", "right", "bottom", "left"],
        "border" => &[
            "border-top-width",
            "border-right-width",
            "border-bottom-width",
            "border-left-width",
            "border-top-style",
            "border-right-style",
            "border-bottom-style",
            "border-left-style",
            "border-top-color",
            "border-right-color",
            "border-bottom-color",
            "border-left-color",
        ],
        "border-width" => &[
            "border-top-width",
            "border-right-width",
            "border-bottom-width",
            "border-left-width",
        ],
        "border-style" => &[
            "border-top-style",
            "border-right-style",
            "border-bottom-style",
            "border-left-style",
        ],
        "border-color" => &[
            "border-top-color",
            "border-right-color",
            "border-bottom-color",
            "border-left-color",
        ],
        "border-top" => &["border-top-width", "border-top-style", "border-top-color"],
        "border-right" => &[
            "border-right-width",
            "border-right-style",
            "border-right-color",
        ],
        "border-bottom" => &[
            "border-bottom-width",
            "border-bottom-style",
            "border-bottom-color",
        ],
        "border-left" => &[
            "border-left-width",
            "border-left-style",
            "border-left-color",
        ],
        "border-radius" => &[
            "border-top-left-radius",
            "border-top-right-radius",
            "border-bottom-right-radius",
            "border-bottom-left-radius",
        ],
        "outline" => &["outline-color", "outline-style", "outline-width"],
        "background" => &[
            "background-attachment",
            "background-clip",
            "background-color",
            "background-image",
            "background-origin",
            "background-position",
            "background-repeat",
            "background-size",
        ],
        "font" => &[
            "font-style",
            "font-variant",
            "font-weight",
            "font-stretch",
            "font-size",
            "line-height",
            "font-family",
        ],
        "flex" => &["flex-grow", "flex-shrink", "flex-basis"],
        "flex-flow" => &["flex-direction", "flex-wrap"],
        "place-content" => &["align-content", "justify-content"],
        "place-items" => &["align-items", "justify-items"],
        "place-self" => &["align-self", "justify-self"],
        "gap" | "grid-gap" => &["row-gap", "column-gap"],
        "overflow" => &["overflow-x", "overflow-y"],
        "grid-area" => &[
            "grid-row-start",
            "grid-column-start",
            "grid-row-end",
            "grid-column-end",
        ],
        "grid-row" => &["grid-row-start", "grid-row-end"],
        "grid-column" => &["grid-column-start", "grid-column-end"],
        "grid-template" => &[
            "grid-template-rows",
            "grid-template-columns",
            "grid-template-areas",
        ],
        "text-emphasis" => &["text-emphasis-style", "text-emphasis-color"],
        "text-decoration" => &[
            "text-decoration-line",
            "text-decoration-style",
            "text-decoration-color",
            "text-decoration-thickness",
        ],
        "transition" => &[
            "transition-property",
            "transition-duration",
            "transition-timing-function",
            "transition-delay",
        ],
        "animation" => &[
            "animation-name",
            "animation-duration",
            "animation-timing-function",
            "animation-delay",
            "animation-iteration-count",
            "animation-direction",
            "animation-fill-mode",
            "animation-play-state",
        ],
        "columns" => &["column-width", "column-count"],
        "column-rule" => &[
            "column-rule-width",
            "column-rule-style",
            "column-rule-color",
        ],
        "list-style" => &["list-style-position", "list-style-image", "list-style-type"],
        _ => return None,
    })
}

const INHERITED_PROPERTIES: &[&str] = &[
    "color",
    "color-scheme",
    "caret-color",
    "accent-color",
    "font",
    "font-family",
    "font-feature-settings",
    "font-kerning",
    "font-language-override",
    "font-optical-sizing",
    "font-palette",
    "font-size",
    "font-size-adjust",
    "font-stretch",
    "font-style",
    "font-synthesis",
    "font-synthesis-small-caps",
    "font-synthesis-style",
    "font-synthesis-weight",
    "font-variant",
    "font-variant-alternates",
    "font-variant-caps",
    "font-variant-east-asian",
    "font-variant-emoji",
    "font-variant-ligatures",
    "font-variant-numeric",
    "font-variant-position",
    "font-variation-settings",
    "font-weight",
    "letter-spacing",
    "line-height",
    "text-rendering",
    "text-size-adjust",
    "text-transform",
    "text-indent",
    "text-align",
    "text-align-last",
    "text-justify",
    "text-shadow",
    "text-emphasis-color",
    "text-emphasis-position",
    "text-emphasis-style",
    "text-underline-position",
    "tab-size",
    "white-space",
    "word-break",
    "overflow-wrap",
    "word-spacing",
    "hyphens",
    "line-break",
    "direction",
    "unicode-bidi",
    "writing-mode",
    "text-orientation",
    "text-combine-upright",
    "list-style",
    "list-style-image",
    "list-style-position",
    "list-style-type",
    "border-collapse",
    "border-spacing",
    "caption-side",
    "empty-cells",
    "cursor",
    "visibility",
    "pointer-events",
    "user-select",
    "quotes",
    "orphans",
    "widows",
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "paint-order",
    "shape-rendering",
    "image-rendering",
    "color-interpolation",
    "color-interpolation-filters",
    "color-rendering",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "text-anchor",
    "stop-color",
    "stop-opacity",
    "flood-color",
    "flood-opacity",
    "lighting-color",
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
];
