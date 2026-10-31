//! Read-only diagnostics for native-messaging installation state.

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::fs;

#[cfg(windows)]
use super::paths::HostPlatform;
use super::paths::{Browser, BrowserSelection, ManifestScope, NativeMessagingManifest};
use super::registration::RegistrationContext;

/// The installation scopes examined by a diagnostics request.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DiagnosticScope {
    /// Inspect user-level registrations only.
    User,
    /// Inspect system-level registrations only.
    System,
    /// Inspect both locations in user-first order.
    #[default]
    Both,
}

impl DiagnosticScope {
    fn scopes(self) -> &'static [ManifestScope] {
        match self {
            Self::User => &[ManifestScope::User],
            Self::System => &[ManifestScope::System],
            Self::Both => &[ManifestScope::User, ManifestScope::System],
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DoctorFormat {
    /// Human-readable line-oriented output.
    #[default]
    Text,
    /// Structured JSON output for an automation caller.
    Json,
}

/// A stable JSON spelling for the diagnostic result.
#[must_use]
pub const fn diagnostic_status_name(status: DiagnosticStatus) -> &'static str {
    match status {
        DiagnosticStatus::Ok => "ok",
        DiagnosticStatus::Warning => "warning",
        DiagnosticStatus::Error => "error",
        DiagnosticStatus::Unsupported => "unsupported",
    }
}

/// Inputs for a read-only installation diagnostic.
#[derive(Clone, Debug)]
pub struct DoctorRequest {
    /// Optional native host executable expected by the manifests.
    pub host_path: Option<PathBuf>,
    /// Browsers to inspect.
    pub browsers: BrowserSelection,
    /// Registration locations to inspect.
    pub scope: DiagnosticScope,
    /// Rendering selected by the command parser.
    pub format: DoctorFormat,
    /// Whether the command should repair executable permissions before checking state.
    pub fix: bool,
}

/// Severity for one diagnostic finding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticStatus {
    /// The check passed.
    Ok,
    /// The check found a recoverable configuration issue.
    Warning,
    /// The check found a condition which prevents a usable registration.
    Error,
    /// The check is deliberately unavailable on this platform.
    Unsupported,
}

impl DiagnosticStatus {
    /// Returns whether this finding should make a CLI doctor invocation fail.
    #[must_use]
    pub const fn is_failure(self) -> bool {
        matches!(self, Self::Error | Self::Unsupported)
    }
}

/// A concrete read-only check result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticFinding {
    /// Short stable check name suitable for JSON consumers.
    pub check: &'static str,
    /// Browser and scope location considered, when applicable.
    pub target: Option<DiagnosticTarget>,
    /// Result severity.
    pub status: DiagnosticStatus,
    /// Human-readable evidence and remediation.
    pub message: String,
}

/// A browser manifest diagnostic target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticTarget {
    /// Browser whose registration is inspected.
    pub browser: Browser,
    /// Installation scope whose registration is inspected.
    pub scope: ManifestScope,
    /// Exact manifest path inspected.
    pub manifest_path: PathBuf,
}

/// Full result of a read-only diagnostics command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DoctorReport {
    /// Timestamp captured when checks began, as milliseconds since the Unix epoch.
    pub generated_at_unix_ms: u128,
    /// Findings in deterministic check and browser order.
    pub findings: Vec<DiagnosticFinding>,
    /// Concrete instructions for integrations not supplied by this Rust module.
    pub next_steps: Vec<String>,
}

impl DoctorReport {
    /// Reports whether no error or unsupported finding was recorded.
    #[must_use]
    pub fn is_healthy(&self) -> bool {
        self.findings
            .iter()
            .all(|finding| !finding.status.is_failure())
    }
}

/// Performs diagnostics without creating, modifying, or deleting any filesystem entry.
pub async fn doctor(context: &RegistrationContext, request: &DoctorRequest) -> DoctorReport {
    let mut findings = Vec::new();
    check_host(request.host_path.as_deref(), &mut findings).await;
    for &scope in request.scope.scopes() {
        for &browser in request.browsers.browsers() {
            check_manifest(
                context,
                request.host_path.as_deref(),
                scope,
                browser,
                &mut findings,
            )
            .await;
        }
    }
    let next_steps = vec![
        "Invoke `register --host-path <absolute-native-host>` after the binary is installed at its final executable path."
            .to_owned(),
    ];
    DoctorReport {
        generated_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        findings,
        next_steps,
    }
}

async fn check_host(host_path: Option<&Path>, findings: &mut Vec<DiagnosticFinding>) {
    let Some(host_path) = host_path else {
        findings.push(DiagnosticFinding {
            check: "native_host",
            target: None,
            status: DiagnosticStatus::Warning,
            message: "no --host-path supplied; manifest ownership and executable permissions cannot be verified"
                .to_owned(),
        });
        return;
    };
    if !host_path.is_absolute() {
        findings.push(DiagnosticFinding {
            check: "native_host",
            target: None,
            status: DiagnosticStatus::Error,
            message: format!("native host path must be absolute: {}", host_path.display()),
        });
        return;
    }
    match fs::metadata(host_path).await {
        Ok(metadata) if !metadata.is_file() => findings.push(DiagnosticFinding {
            check: "native_host",
            target: None,
            status: DiagnosticStatus::Error,
            message: format!(
                "native host path is not a regular file: {}",
                host_path.display()
            ),
        }),
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                if metadata.permissions().mode() & 0o111 == 0 {
                    findings.push(DiagnosticFinding {
                        check: "native_host",
                        target: None,
                        status: DiagnosticStatus::Error,
                        message: format!("native host is not executable: {}", host_path.display()),
                    });
                    return;
                }
            }
            findings.push(DiagnosticFinding {
                check: "native_host",
                target: None,
                status: DiagnosticStatus::Ok,
                message: format!("native host is executable: {}", host_path.display()),
            });
        }
        Err(error) => findings.push(DiagnosticFinding {
            check: "native_host",
            target: None,
            status: DiagnosticStatus::Error,
            message: format!(
                "native host is unavailable at {}: {error}",
                host_path.display()
            ),
        }),
    }
}

async fn check_manifest(
    context: &RegistrationContext,
    host_path: Option<&Path>,
    scope: ManifestScope,
    browser: Browser,
    findings: &mut Vec<DiagnosticFinding>,
) {
    let manifest_path = context.paths().manifest_path(scope, browser);
    let target = DiagnosticTarget {
        browser,
        scope,
        manifest_path: manifest_path.clone(),
    };
    #[cfg(windows)]
    if context.paths().platform() == HostPlatform::Windows {
        check_windows_registry(context, scope, browser, &target, findings);
    }
    let bytes = match fs::read(&manifest_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            findings.push(DiagnosticFinding {
                check: "native_messaging_manifest",
                target: Some(target),
                status: DiagnosticStatus::Error,
                message: format!(
                    "manifest is missing; run `register --browser {} --{} --host-path <absolute-native-host>`",
                    browser.as_str(), scope
                ),
            });
            return;
        }
        Err(error) => {
            findings.push(DiagnosticFinding {
                check: "native_messaging_manifest",
                target: Some(target),
                status: DiagnosticStatus::Error,
                message: format!("cannot read manifest {}: {error}", manifest_path.display()),
            });
            return;
        }
    };
    let manifest = match serde_json::from_slice::<NativeMessagingManifest>(&bytes) {
        Ok(manifest) => manifest,
        Err(error) => {
            findings.push(DiagnosticFinding {
                check: "native_messaging_manifest",
                target: Some(target),
                status: DiagnosticStatus::Error,
                message: format!("manifest is invalid JSON: {error}"),
            });
            return;
        }
    };
    let expected_path = host_path.unwrap_or(manifest.path.as_path());
    match manifest.validate_owned_by(expected_path) {
        Ok(()) => findings.push(DiagnosticFinding {
            check: "native_messaging_manifest",
            target: Some(target),
            status: DiagnosticStatus::Ok,
            message: "manifest matches the HumanChrome native-host contract".to_owned(),
        }),
        Err(error) => findings.push(DiagnosticFinding {
            check: "native_messaging_manifest",
            target: Some(target),
            status: DiagnosticStatus::Error,
            message: error.to_string(),
        }),
    }
}

#[cfg(windows)]
fn check_windows_registry(
    context: &RegistrationContext,
    scope: ManifestScope,
    browser: Browser,
    target: &DiagnosticTarget,
    findings: &mut Vec<DiagnosticFinding>,
) {
    let Some(key) = context.paths().registry_key(scope, browser) else {
        return;
    };
    match std::process::Command::new("reg")
        .args(["query", &key, "/ve"])
        .output()
    {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let expected = target.manifest_path.to_string_lossy();
            let status = if text
                .to_ascii_lowercase()
                .contains(&expected.to_ascii_lowercase())
            {
                DiagnosticStatus::Ok
            } else {
                DiagnosticStatus::Error
            };
            findings.push(DiagnosticFinding {
                check: "native_messaging_registry",
                target: Some(target.clone()),
                status,
                message: format!(
                    "Registry key {key} {}",
                    if status == DiagnosticStatus::Ok {
                        "matches manifest"
                    } else {
                        "does not point at the expected manifest"
                    }
                ),
            });
        }
        Ok(output) => findings.push(DiagnosticFinding {
            check: "native_messaging_registry",
            target: Some(target.clone()),
            status: DiagnosticStatus::Error,
            message: format!(
                "cannot query Registry key {key}: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        }),
        Err(error) => findings.push(DiagnosticFinding {
            check: "native_messaging_registry",
            target: Some(target.clone()),
            status: DiagnosticStatus::Error,
            message: format!("cannot run Registry query for {key}: {error}"),
        }),
    }
}
#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use tempfile::tempdir;

    use super::{DiagnosticScope, DiagnosticStatus, DoctorFormat, DoctorRequest, doctor};
    use crate::cli::{
        paths::{Browser, BrowserSelection, HostPlatform, ManifestScope, NativeMessagingPaths},
        registration::{
            ExistingManifest, RegistrationContext, RegistrationRequest, SystemInstallAuthorization,
            register,
        },
    };

    #[test]
    fn doctor_reports_registered_temp_root_without_writing() {
        let directory = tempdir().expect("create temporary root");
        let paths = NativeMessagingPaths::new(
            HostPlatform::Linux,
            directory.path().join("home"),
            directory.path().join("appdata"),
            directory.path().join("system"),
        );
        let context = RegistrationContext::new(paths, SystemInstallAuthorization::Verified);
        let host = directory.path().join("native-host");
        fs::write(&host, "#!/bin/sh\nexit 0\n").expect("write host");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&host, fs::Permissions::from_mode(0o755))
                .expect("make host executable");
        }
        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        runtime
            .block_on(register(
                &context,
                &RegistrationRequest {
                    host_path: PathBuf::from(&host),
                    browsers: BrowserSelection::One(Browser::Chrome),
                    scope: ManifestScope::User,
                    existing: ExistingManifest::Refuse,
                },
            ))
            .expect("register manifest");
        let report = runtime.block_on(doctor(
            &context,
            &DoctorRequest {
                host_path: Some(host),
                browsers: BrowserSelection::One(Browser::Chrome),
                scope: DiagnosticScope::User,
                format: DoctorFormat::Text,
                fix: false,
            },
        ));
        assert!(report.is_healthy());
        assert!(
            report
                .findings
                .iter()
                .all(|finding| finding.status == DiagnosticStatus::Ok)
        );
    }
}
