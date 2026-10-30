//! CDP-backed profile labels that make each Chrome window identifiable.

use std::path::Path;

use serde_json::{Value, json};

use super::{CdpPipe, FleetRuntimeError};

const LABEL_FILE: &str = ".hc-label.html";

/// Write and focus a replacement label tab, leaving the old label intact if creation fails.
///
/// # Errors
/// Reports CDP/filesystem failures; callers may treat cosmetic failure as non-fatal.
pub async fn apply_window_label(
    cdp: &CdpPipe,
    profile_dir: &Path,
    label: &str,
) -> Result<bool, FleetRuntimeError> {
    let file = profile_dir.join(LABEL_FILE);
    tokio::fs::write(&file, label_html(label, &colour_for(label)))
        .await
        .map_err(|error| FleetRuntimeError::io(&file, error))?;
    let url = format!("file://{}", file.display());
    let created = cdp
        .send_default("Target.createTarget", json!({ "url": url }))
        .await?;
    let target_id = result(created, "Target.createTarget")?
        .get("targetId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let Some(target_id) = target_id else {
        return Ok(false);
    };
    let targets = cdp.send_default("Target.getTargets", json!({})).await?;
    let stale = result(targets, "Target.getTargets")?
        .get("targetInfos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|target| {
            target.get("targetId").and_then(Value::as_str) != Some(&target_id)
                && target
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| url.contains(LABEL_FILE))
        })
        .filter_map(|target| target.get("targetId").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    for stale in stale {
        let _ = cdp
            .send_default("Target.closeTarget", json!({ "targetId": stale }))
            .await?;
    }
    let _ = cdp
        .send_default("Target.activateTarget", json!({ "targetId": target_id }))
        .await?;
    Ok(true)
}

/// Close page targets created by the extension's onboarding flow after the label receives focus.
pub async fn close_onboarding_tabs(
    cdp: &CdpPipe,
    extension_id: &str,
) -> Result<usize, FleetRuntimeError> {
    let targets = cdp.send_default("Target.getTargets", json!({})).await?;
    let welcome = result(targets, "Target.getTargets")?
        .get("targetInfos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|target| {
            target.get("type").and_then(Value::as_str) == Some("page")
                && target
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| {
                        url.starts_with(&format!("chrome-extension://{extension_id}/"))
                    })
        })
        .filter_map(|target| target.get("targetId").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    for target_id in &welcome {
        let _ = cdp
            .send_default("Target.closeTarget", json!({ "targetId": target_id }))
            .await?;
    }
    Ok(welcome.len())
}

/// Choose a stable label from the profile's exclusive purpose or its own name.
#[must_use]
pub fn label_for(name: &str, purpose: Option<&str>) -> String {
    purpose.unwrap_or(name).to_owned()
}

fn result(response: super::CdpResponse, command: &str) -> Result<Value, FleetRuntimeError> {
    if let Some(error) = response.error {
        return Err(FleetRuntimeError::Cdp(format!("{command} failed: {error}")));
    }
    response
        .result
        .ok_or_else(|| FleetRuntimeError::Cdp(format!("{command} returned no result")))
}

fn colour_for(label: &str) -> String {
    let mut hash = 0_u32;
    for character in label.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(character));
    }
    let hue = hash % 280 + 40;
    hsl_to_hex(hue as f64, 0.6, 0.3)
}

fn hsl_to_hex(hue: f64, saturation: f64, lightness: f64) -> String {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let secondary = chroma * (1.0 - ((hue / 60.0 % 2.0) - 1.0).abs());
    let matching = lightness - chroma / 2.0;
    let (red, green, blue) = if hue < 60.0 {
        (chroma, secondary, 0.0)
    } else if hue < 120.0 {
        (secondary, chroma, 0.0)
    } else if hue < 180.0 {
        (0.0, chroma, secondary)
    } else if hue < 240.0 {
        (0.0, secondary, chroma)
    } else if hue < 300.0 {
        (secondary, 0.0, chroma)
    } else {
        (chroma, 0.0, secondary)
    };
    format!(
        "#{:02x}{:02x}{:02x}",
        ((red + matching) * 255.0).round() as u8,
        ((green + matching) * 255.0).round() as u8,
        ((blue + matching) * 255.0).round() as u8,
    )
}

fn label_html(label: &str, colour: &str) -> String {
    let escaped = escape_html(label);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"theme-color\" content=\"{colour}\"><title>{escaped}</title><style>html,body{{height:100%;margin:0}}body{{background:{colour};color:#fff;font:600 42px/1.2 -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}}</style></head><body>{escaped}</body></html>"
    )
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
