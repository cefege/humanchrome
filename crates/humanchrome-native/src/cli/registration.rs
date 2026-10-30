//! Safe installation and removal of native-messaging manifests.

use std::{
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use tokio::fs;

use super::paths::{
    Browser, BrowserSelection, HOST_NAME, HostPlatform, ManifestError, ManifestScope,
    NativeMessagingManifest, NativeMessagingPaths,
};

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Whether an existing manifest owned by HumanChrome may be replaced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExistingManifest {
    /// Refuse to change any existing manifest.
    Refuse,
    /// Replace only an existing manifest that passes ownership validation.
    ReplaceOwned,
}

/// The authority available for a system-wide installation request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SystemInstallAuthorization {
    /// The current process has no verified elevated permission.
    Unverified,
    /// The current process was verified as allowed to install system files.
    Verified,
}

impl SystemInstallAuthorization {
    /// Detects whether the current process has the native platform's system-write authority.
    #[must_use]
    pub fn detect() -> Self {
        #[cfg(unix)]
        {
            // SAFETY: geteuid takes no pointers and only reads process credentials.
            if unsafe { libc::geteuid() } == 0 {
                Self::Verified
            } else {
                Self::Unverified
            }
        }
        #[cfg(windows)]
        {
            // `net session` succeeds only from an elevated administrator token.
            if std::process::Command::new("net")
                .arg("session")
                .output()
                .is_ok_and(|output| output.status.success())
            {
                Self::Verified
            } else {
                Self::Unverified
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            Self::Unverified
        }
    }
}

/// Inputs required to write or remove manifests without consulting global process state.
#[derive(Clone, Debug)]
pub struct RegistrationContext {
    paths: NativeMessagingPaths,
    system_authorization: SystemInstallAuthorization,
}

impl RegistrationContext {
    /// Creates a context from explicit roots and authorization for isolated invocations.
    #[must_use]
    pub fn new(
        paths: NativeMessagingPaths,
        system_authorization: SystemInstallAuthorization,
    ) -> Self {
        Self {
            paths,
            system_authorization,
        }
    }

    /// Creates a production context using environment-backed path roots.
    ///
    /// # Errors
    /// Returns an error when the user's home directory is unavailable.
    pub fn from_environment() -> io::Result<Self> {
        Ok(Self::new(
            NativeMessagingPaths::from_environment()?,
            SystemInstallAuthorization::detect(),
        ))
    }

    /// Returns the isolated path resolver used by this context.
    #[must_use]
    pub fn paths(&self) -> &NativeMessagingPaths {
        &self.paths
    }

    /// Resolves the stable complete-release root for the requested installation scope.
    #[must_use]
    pub fn native_install_root(&self, scope: ManifestScope) -> PathBuf {
        self.paths.native_install_root(scope)
    }

    /// Rejects a system operation before it creates an installation staging directory.
    ///
    /// # Errors
    /// Returns when system scope was requested without verified elevated authority.
    pub(crate) fn require_install_authorization(
        &self,
        scope: ManifestScope,
    ) -> Result<(), RegistrationError> {
        if scope == ManifestScope::System
            && self.system_authorization != SystemInstallAuthorization::Verified
        {
            return Err(RegistrationError::SystemAuthorizationRequired);
        }
        Ok(())
    }

    /// Rejects a complete-release target Chrome could not launch on macOS.
    ///
    /// # Errors
    /// Returns when the target lies in a macOS TCC-protected directory.
    pub(crate) fn validate_install_target(
        &self,
        native_host_path: &Path,
    ) -> Result<(), RegistrationError> {
        if self.paths.platform() == HostPlatform::MacOs {
            validate_macos_tcc_path(&self.paths, native_host_path)?;
        }
        Ok(())
    }

    /// Verifies a native host executable and produces its exact manifest contract.
    ///
    /// # Errors
    /// Returns when the host is relative, unavailable, non-executable, or macOS TCC-protected.
    pub async fn verify_native_host(
        &self,
        host_path: &Path,
    ) -> Result<VerifiedNativeHost, RegistrationError> {
        verify_native_host(self.paths(), host_path).await
    }
}

/// A verified executable together with the exact native-messaging manifest Chrome requires.
#[derive(Clone, Debug)]
pub struct VerifiedNativeHost {
    path: PathBuf,
    manifest: NativeMessagingManifest,
}

impl VerifiedNativeHost {
    /// Returns the canonical executable path verified against the filesystem.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Returns the generated manifest ready for JSON serialization or profile provisioning.
    #[must_use]
    pub fn manifest(&self) -> &NativeMessagingManifest {
        &self.manifest
    }
}

/// Request to create native-messaging manifest registrations.
#[derive(Clone, Debug)]
pub struct RegistrationRequest {
    /// Absolute path of the native host executable Chrome will launch.
    pub host_path: PathBuf,
    /// Browsers to receive a registration.
    pub browsers: BrowserSelection,
    /// User-level or system-wide registration.
    pub scope: ManifestScope,
    /// Existing manifest behavior.
    pub existing: ExistingManifest,
}

/// Request to remove native-messaging manifest registrations.
#[derive(Clone, Debug)]
pub struct UnregistrationRequest {
    /// Absolute path that the manifest must already target before removal.
    pub host_path: PathBuf,
    /// Browsers whose manifests should be removed.
    pub browsers: BrowserSelection,
    /// User-level or system-wide registration.
    pub scope: ManifestScope,
}

/// The concrete outcome for one browser manifest operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManifestOutcome {
    /// A new manifest was safely written.
    Registered,
    /// An owned manifest was atomically replaced.
    Replaced,
    /// A matching manifest was safely removed.
    Unregistered,
    /// There was no manifest to remove.
    Absent,
    /// The requested operation cannot be completed on this platform yet.
    Unsupported { instruction: String },
    /// The individual browser operation failed but other targets were attempted.
    Failed { message: String },
}

impl ManifestOutcome {
    /// Reports whether this outcome represents a completed requested effect.
    #[must_use]
    pub const fn is_success(&self) -> bool {
        matches!(
            self,
            Self::Registered | Self::Replaced | Self::Unregistered | Self::Absent
        )
    }
}

/// A result retained for every requested browser rather than discarding partial failures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestResult {
    /// Browser targeted by this operation.
    pub browser: Browser,
    /// Exact manifest location considered for this operation.
    pub manifest_path: PathBuf,
    /// Per-browser effect or failure.
    pub outcome: ManifestOutcome,
}

/// Aggregate result of registration or unregistration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistrationReport {
    /// Scope requested for all results.
    pub scope: ManifestScope,
    /// Every browser target in stable command-line order.
    pub results: Vec<ManifestResult>,
}

impl RegistrationReport {
    /// Reports whether every requested browser operation completed successfully.
    #[must_use]
    pub fn is_success(&self) -> bool {
        self.results
            .iter()
            .all(|result| result.outcome.is_success())
    }
}

/// A preflight error which means no browser manifest was touched.
#[derive(Debug, thiserror::Error)]
pub enum RegistrationError {
    /// The executable path cannot be safely embedded in a manifest.
    #[error("native host executable is unavailable: {0}")]
    HostPath(#[from] io::Error),
    /// A path exists but is not a regular host executable.
    #[error("native host path is not a regular file: {0}")]
    NotAFile(PathBuf),
    /// Unix executable permission bits are required before Chrome can launch the host.
    #[error("native host is not executable: {0}")]
    NotExecutable(PathBuf),
    /// macOS TCC blocks Chrome from launching a host installed in this location.
    #[error(
        "refusing to register TCC-protected native host path {path}; install under {suggested}"
    )]
    TccProtectedPath { path: PathBuf, suggested: PathBuf },
    /// System registration requires confirmed elevated authority.
    #[error(
        "system-level registration requires administrator privileges; rerun with sudo or choose user scope"
    )]
    SystemAuthorizationRequired,
    /// A relative path cannot be used in a Chrome native-messaging manifest.
    #[error(transparent)]
    Manifest(#[from] ManifestError),
}

/// Registers native-messaging manifests, preserving one result per browser.
///
/// Existing foreign or malformed manifests are never overwritten, including with force.
///
/// # Errors
/// Returns only preflight failures, before any target manifest is touched.
pub async fn register(
    context: &RegistrationContext,
    request: &RegistrationRequest,
) -> Result<RegistrationReport, RegistrationError> {
    register_with_install_root(context, request, None).await
}

/// Allows an installer to replace only manifests targeting its managed native or legacy host.
pub(super) async fn register_bundle(
    context: &RegistrationContext,
    request: &RegistrationRequest,
) -> Result<RegistrationReport, RegistrationError> {
    let root = fs::canonicalize(context.native_install_root(request.scope)).await?;
    register_with_install_root(context, request, Some(&root)).await
}

async fn register_with_install_root(
    context: &RegistrationContext,
    request: &RegistrationRequest,
    install_root: Option<&Path>,
) -> Result<RegistrationReport, RegistrationError> {
    let verified = validate_host(context, &request.host_path, request.scope).await?;
    let manifest = verified.manifest();
    let browsers = resolve_browsers(request.browsers);
    let mut results = Vec::with_capacity(browsers.len());

    for browser in browsers {
        let manifest_path = context.paths.manifest_path(request.scope, browser);
        let outcome = register_for_browser(
            context,
            &manifest_path,
            manifest,
            request.existing,
            request.scope,
            browser,
            install_root,
        )
        .await;
        results.push(ManifestResult {
            browser,
            manifest_path,
            outcome,
        });
    }

    Ok(RegistrationReport {
        scope: request.scope,
        results,
    })
}

/// Detects locally installed supported browsers using the established platform conventions.
#[must_use]
pub fn detect_installed_browsers() -> Vec<Browser> {
    let mut browsers = Vec::with_capacity(Browser::ALL.len());
    #[cfg(target_os = "macos")]
    {
        for (browser, application) in [
            (Browser::Chrome, "/Applications/Google Chrome.app"),
            (Browser::Chromium, "/Applications/Chromium.app"),
        ] {
            if std::path::Path::new(application).is_dir() {
                browsers.push(browser);
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for (browser, names) in [
            (
                Browser::Chrome,
                &["google-chrome", "google-chrome-stable"][..],
            ),
            (Browser::Chromium, &["chromium", "chromium-browser"][..]),
        ] {
            if executable_on_path(names) {
                browsers.push(browser);
            }
        }
    }
    #[cfg(windows)]
    {
        for (browser, key) in [
            (Browser::Chrome, r"HKLM\SOFTWARE\Google\Chrome"),
            (Browser::Chromium, r"HKLM\SOFTWARE\Chromium"),
        ] {
            if std::process::Command::new("reg")
                .args(["query", key])
                .output()
                .is_ok_and(|output| output.status.success())
            {
                browsers.push(browser);
            }
        }
    }
    browsers
}

fn resolve_browsers(selection: BrowserSelection) -> Vec<Browser> {
    if selection == BrowserSelection::Detected {
        let detected = detect_installed_browsers();
        if !detected.is_empty() {
            return detected;
        }
    }
    selection.browsers().to_vec()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn executable_on_path(names: &[&str]) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| {
            names.iter().any(|name| {
                std::fs::metadata(directory.join(name)).is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
            })
        })
    })
}

/// Removes only manifests that still exactly match the requested HumanChrome host.
///
/// # Errors
/// Returns only preflight failures, before any target manifest is touched.
pub async fn unregister(
    context: &RegistrationContext,
    request: &UnregistrationRequest,
) -> Result<RegistrationReport, RegistrationError> {
    let host_path = validate_unregistration_host(context, &request.host_path, request.scope)?;
    let browsers = resolve_browsers(request.browsers);
    let mut results = Vec::with_capacity(browsers.len());

    for browser in browsers {
        let manifest_path = context.paths.manifest_path(request.scope, browser);
        let outcome =
            unregister_for_browser(context, &manifest_path, &host_path, request.scope, browser)
                .await;
        results.push(ManifestResult {
            browser,
            manifest_path,
            outcome,
        });
    }

    Ok(RegistrationReport {
        scope: request.scope,
        results,
    })
}

async fn register_for_browser(
    context: &RegistrationContext,
    manifest_path: &Path,
    manifest: &NativeMessagingManifest,
    existing: ExistingManifest,
    scope: ManifestScope,
    browser: Browser,
    install_root: Option<&Path>,
) -> ManifestOutcome {
    #[cfg(windows)]
    if context.paths.platform() == HostPlatform::Windows {
        let outcome = register_one(manifest_path, manifest, existing, install_root).await;
        if !outcome.is_success() {
            return outcome;
        }
        return match set_windows_registry_value(
            context.paths.registry_key(scope, browser).as_deref(),
            manifest_path,
        ) {
            Ok(()) => outcome,
            Err(error) => ManifestOutcome::Failed {
                message: format!(
                    "manifest was written but Windows Registry registration failed: {error}"
                ),
            },
        };
    }
    let _ = (context, scope, browser);
    register_one(manifest_path, manifest, existing, install_root).await
}

async fn unregister_for_browser(
    context: &RegistrationContext,
    manifest_path: &Path,
    host_path: &Path,
    scope: ManifestScope,
    browser: Browser,
) -> ManifestOutcome {
    #[cfg(windows)]
    if context.paths.platform() == HostPlatform::Windows {
        let outcome = unregister_one(manifest_path, host_path).await;
        if !outcome.is_success() {
            return outcome;
        }
        return match delete_windows_registry_value(
            context.paths.registry_key(scope, browser).as_deref(),
            manifest_path,
        ) {
            Ok(()) => outcome,
            Err(error) => ManifestOutcome::Failed {
                message: format!(
                    "manifest was removed but Windows Registry cleanup failed: {error}"
                ),
            },
        };
    }
    let _ = (context, scope, browser);
    unregister_one(manifest_path, host_path).await
}

#[cfg(windows)]
fn set_windows_registry_value(key: Option<&str>, manifest_path: &Path) -> io::Result<()> {
    let key =
        key.ok_or_else(|| io::Error::other("missing Windows native-messaging Registry key"))?;
    let manifest_path = manifest_path.to_string_lossy().into_owned();
    let output = std::process::Command::new("reg")
        .args([
            "add",
            key,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            manifest_path.as_str(),
            "/f",
        ])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(String::from_utf8_lossy(&output.stderr)));
    }
    let verification = std::process::Command::new("reg")
        .args(["query", key, "/ve"])
        .output()?;
    if !verification.status.success()
        || !String::from_utf8_lossy(&verification.stdout)
            .to_ascii_lowercase()
            .contains(&manifest_path.to_ascii_lowercase())
    {
        return Err(io::Error::other("Registry default value did not verify"));
    }
    Ok(())
}

#[cfg(windows)]
fn delete_windows_registry_value(key: Option<&str>, manifest_path: &Path) -> io::Result<()> {
    let key =
        key.ok_or_else(|| io::Error::other("missing Windows native-messaging Registry key"))?;
    let manifest_path = manifest_path.to_string_lossy();
    let verification = std::process::Command::new("reg")
        .args(["query", key, "/ve"])
        .output()?;
    if verification.status.success()
        && !String::from_utf8_lossy(&verification.stdout)
            .to_ascii_lowercase()
            .contains(&manifest_path.to_ascii_lowercase())
    {
        return Err(io::Error::other(
            "refusing to delete Registry key with a foreign manifest path",
        ));
    }
    let output = std::process::Command::new("reg")
        .args(["delete", key, "/f"])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

async fn validate_host(
    context: &RegistrationContext,
    host_path: &Path,
    scope: ManifestScope,
) -> Result<VerifiedNativeHost, RegistrationError> {
    if scope == ManifestScope::System
        && context.system_authorization != SystemInstallAuthorization::Verified
    {
        return Err(RegistrationError::SystemAuthorizationRequired);
    }
    context.verify_native_host(host_path).await
}

/// Verifies an executable and builds the exact manifest used for registration and provisioning.
///
/// # Errors
/// Returns when the host is relative, unavailable, non-executable, or macOS TCC-protected.
pub async fn verify_native_host(
    paths: &NativeMessagingPaths,
    host_path: &Path,
) -> Result<VerifiedNativeHost, RegistrationError> {
    let manifest = NativeMessagingManifest::new(host_path.to_path_buf())?;
    let host_path = fs::canonicalize(&manifest.path).await?;
    let metadata = fs::metadata(&host_path).await?;
    if !metadata.is_file() {
        return Err(RegistrationError::NotAFile(host_path));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(RegistrationError::NotExecutable(host_path));
        }
    }
    if paths.platform() == HostPlatform::MacOs {
        validate_macos_tcc_path(paths, &host_path)?;
    }
    let manifest = NativeMessagingManifest::new(host_path.clone())?;
    Ok(VerifiedNativeHost {
        path: host_path,
        manifest,
    })
}

fn validate_unregistration_host(
    context: &RegistrationContext,
    host_path: &Path,
    scope: ManifestScope,
) -> Result<PathBuf, RegistrationError> {
    if scope == ManifestScope::System
        && context.system_authorization != SystemInstallAuthorization::Verified
    {
        return Err(RegistrationError::SystemAuthorizationRequired);
    }
    Ok(NativeMessagingManifest::new(host_path.to_path_buf())?.path)
}

fn validate_macos_tcc_path(
    paths: &NativeMessagingPaths,
    host_path: &Path,
) -> Result<(), RegistrationError> {
    let protected = [
        "Documents",
        "Desktop",
        "Downloads",
        "Pictures",
        "Movies",
        "Music",
        "Library/Mobile Documents",
    ];
    let canonical_home = if host_path.starts_with(paths.home()) {
        None
    } else {
        std::fs::canonicalize(paths.home()).ok()
    };
    let relative = host_path.strip_prefix(paths.home()).ok().or_else(|| {
        canonical_home
            .as_deref()
            .and_then(|home| host_path.strip_prefix(home).ok())
    });
    if relative.is_some_and(|relative| protected.iter().any(|suffix| relative.starts_with(suffix)))
    {
        return Err(RegistrationError::TccProtectedPath {
            path: host_path.to_path_buf(),
            suggested: paths
                .home()
                .join("Library/Application Support/humanchrome-bridge"),
        });
    }
    Ok(())
}

async fn register_one(
    manifest_path: &Path,
    manifest: &NativeMessagingManifest,
    existing: ExistingManifest,
    install_root: Option<&Path>,
) -> ManifestOutcome {
    match fs::read(manifest_path).await {
        Ok(bytes) => {
            let mut parsed = match serde_json::from_slice::<NativeMessagingManifest>(&bytes) {
                Ok(manifest) => manifest,
                Err(error) => {
                    return ManifestOutcome::Failed {
                        message: format!("refusing to replace invalid existing manifest: {error}"),
                    };
                }
            };
            if let Err(error) = parsed.validate_owned_by(&manifest.path) {
                let managed_predecessor = match install_root {
                    Some(root) => validate_installed_predecessor(&parsed, &manifest.path, root)
                        .await
                        .is_ok(),
                    None => false,
                };
                if !managed_predecessor {
                    return ManifestOutcome::Failed {
                        message: error.to_string(),
                    };
                }
            }
            if existing == ExistingManifest::Refuse {
                return ManifestOutcome::Failed {
                    message:
                        "manifest already exists; use --force only for an owned matching manifest"
                            .to_owned(),
                };
            }
            // An owned upgrade changes the executable, not the user's configured extension set.
            parsed.path.clone_from(&manifest.path);
            parsed.description.clone_from(&manifest.description);
            match write_manifest_atomically(manifest_path, &parsed).await {
                Ok(()) => ManifestOutcome::Replaced,
                Err(error) => ManifestOutcome::Failed {
                    message: error.to_string(),
                },
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match write_manifest_atomically(manifest_path, manifest).await {
                Ok(()) => ManifestOutcome::Registered,
                Err(error) => ManifestOutcome::Failed {
                    message: error.to_string(),
                },
            }
        }
        Err(error) => ManifestOutcome::Failed {
            message: error.to_string(),
        },
    }
}

async fn validate_installed_predecessor(
    manifest: &NativeMessagingManifest,
    new_host: &Path,
    install_root: &Path,
) -> io::Result<()> {
    manifest
        .validate_owned_by(&manifest.path)
        .map_err(io::Error::other)?;
    let executable = fs::canonicalize(&manifest.path).await?;
    if !fs::metadata(&executable).await?.is_file() {
        return Err(io::Error::other(
            "installed manifest target is not a regular file",
        ));
    }
    let relative = executable
        .strip_prefix(install_root)
        .map_err(io::Error::other)?;
    let native_release = relative.file_name() == new_host.file_name()
        && relative.parent().and_then(Path::parent) == Some(Path::new("releases"));
    let legacy_host =
        relative == Path::new("dist/run_host.sh") || relative == Path::new("dist/run_host.bat");
    if !native_release && !legacy_host {
        return Err(io::Error::other(
            "manifest does not target a managed installed host",
        ));
    }
    Ok(())
}

async fn unregister_one(manifest_path: &Path, host_path: &Path) -> ManifestOutcome {
    let bytes = match fs::read(manifest_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return ManifestOutcome::Absent,
        Err(error) => {
            return ManifestOutcome::Failed {
                message: error.to_string(),
            };
        }
    };
    let manifest = match serde_json::from_slice::<NativeMessagingManifest>(&bytes) {
        Ok(manifest) => manifest,
        Err(error) => {
            return ManifestOutcome::Failed {
                message: format!("refusing to delete invalid existing manifest: {error}"),
            };
        }
    };
    if let Err(error) = manifest.validate_owned_by(host_path) {
        return ManifestOutcome::Failed {
            message: error.to_string(),
        };
    }
    match fs::remove_file(manifest_path).await {
        Ok(()) => ManifestOutcome::Unregistered,
        Err(error) => ManifestOutcome::Failed {
            message: error.to_string(),
        },
    }
}

async fn write_manifest_atomically(
    manifest_path: &Path,
    manifest: &NativeMessagingManifest,
) -> io::Result<()> {
    let parent = manifest_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "native-messaging manifest has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).await?;
    let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        HOST_NAME,
        std::process::id(),
        sequence
    ));
    let encoded = serde_json::to_vec_pretty(manifest)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    fs::write(&temporary, encoded).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o644)).await?;
    }
    if let Err(error) = fs::rename(&temporary, manifest_path).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use tempfile::tempdir;

    use super::{
        BrowserSelection, ExistingManifest, ManifestOutcome, ManifestScope, RegistrationContext,
        RegistrationRequest, SystemInstallAuthorization, UnregistrationRequest, register,
        unregister,
    };
    use crate::cli::paths::{Browser, HostPlatform, NativeMessagingManifest, NativeMessagingPaths};

    fn context(root: &std::path::Path) -> RegistrationContext {
        RegistrationContext::new(
            NativeMessagingPaths::new(
                HostPlatform::Linux,
                root.join("home"),
                root.join("appdata"),
                root.join("system"),
            ),
            SystemInstallAuthorization::Verified,
        )
    }

    fn host(root: &std::path::Path) -> PathBuf {
        let host = root.join("native-host");
        fs::write(&host, "#!/bin/sh\nexit 0\n").expect("write host");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&host, fs::Permissions::from_mode(0o755))
                .expect("make host executable");
        }
        host
    }

    #[cfg(unix)]
    #[test]
    fn tcc_refusal_resolves_home_alias_without_rejecting_lookalike_directories() {
        let root = tempdir().expect("temporary root");
        let real_home = root.path().join("real-home");
        let documents = real_home.join("Documents");
        let lookalike = real_home.join("Documents-backup");
        fs::create_dir_all(&documents).expect("Documents directory");
        fs::create_dir_all(&lookalike).expect("lookalike directory");
        let alias = root.path().join("home-alias");
        std::os::unix::fs::symlink(&real_home, &alias).expect("home alias");
        let context = RegistrationContext::new(
            NativeMessagingPaths::new(
                HostPlatform::MacOs,
                alias,
                root.path().join("data"),
                root.path().join("system"),
            ),
            SystemInstallAuthorization::Verified,
        );
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let protected_host = host(&documents);
        let error = runtime
            .block_on(context.verify_native_host(&protected_host))
            .expect_err("canonical Documents host must remain protected");
        assert!(matches!(
            error,
            super::RegistrationError::TccProtectedPath { .. }
        ));
        let safe_host = host(&lookalike);
        let verified = runtime
            .block_on(context.verify_native_host(&safe_host))
            .expect("componentwise lookalike remains allowed");
        assert_eq!(
            verified.path(),
            fs::canonicalize(safe_host).expect("canonical safe host")
        );
    }

    #[test]
    fn register_replace_and_unregister_use_explicit_temp_roots() {
        let directory = tempdir().expect("create temp root");
        let context = context(directory.path());
        let host = host(directory.path());
        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let request = RegistrationRequest {
            host_path: host.clone(),
            browsers: BrowserSelection::One(Browser::Chrome),
            scope: ManifestScope::User,
            existing: ExistingManifest::Refuse,
        };
        let initial = runtime
            .block_on(register(&context, &request))
            .expect("register manifest");
        assert_eq!(initial.results[0].outcome, ManifestOutcome::Registered);
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        let manifest: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(&manifest_path).expect("read manifest"))
                .expect("parse manifest");
        assert_eq!(
            manifest.path,
            fs::canonicalize(&host).expect("canonical host")
        );

        let replace = RegistrationRequest {
            existing: ExistingManifest::ReplaceOwned,
            ..request
        };
        let replaced = runtime
            .block_on(register(&context, &replace))
            .expect("replace manifest");
        assert_eq!(replaced.results[0].outcome, ManifestOutcome::Replaced);
        fs::remove_file(&host).expect("remove stale host before unregistering");
        let removed = runtime
            .block_on(unregister(
                &context,
                &UnregistrationRequest {
                    host_path: host,
                    browsers: BrowserSelection::One(Browser::Chrome),
                    scope: ManifestScope::User,
                },
            ))
            .expect("unregister manifest");
        assert_eq!(removed.results[0].outcome, ManifestOutcome::Unregistered);
        assert!(!manifest_path.exists());
    }

    #[test]
    fn force_preserves_configured_extension_origins() {
        let directory = tempdir().expect("temporary installation");
        let context = context(directory.path());
        let host = host(directory.path());
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        fs::create_dir_all(manifest_path.parent().expect("manifest directory"))
            .expect("create manifest directory");
        let canonical_host = fs::canonicalize(&host).expect("canonical host");
        let mut configured = NativeMessagingManifest::new(canonical_host).expect("manifest");
        configured
            .allowed_origins
            .push("chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_owned());
        fs::write(
            &manifest_path,
            serde_json::to_vec(&configured).expect("encode configured manifest"),
        )
        .expect("write configured manifest");
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let report = runtime
            .block_on(register(
                &context,
                &RegistrationRequest {
                    host_path: host.clone(),
                    browsers: BrowserSelection::One(Browser::Chrome),
                    scope: ManifestScope::User,
                    existing: ExistingManifest::ReplaceOwned,
                },
            ))
            .expect("registration preflight");
        assert_eq!(report.results[0].outcome, ManifestOutcome::Replaced);
        let installed: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(manifest_path).expect("read updated manifest"))
                .expect("updated manifest");
        assert_eq!(installed.allowed_origins, configured.allowed_origins);
        assert_eq!(
            installed.path,
            fs::canonicalize(host).expect("canonical host")
        );
    }

    #[test]
    fn force_never_overwrites_a_foreign_manifest() {
        let directory = tempdir().expect("create temp root");
        let context = context(directory.path());
        let host = host(directory.path());
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        fs::create_dir_all(manifest_path.parent().expect("manifest parent"))
            .expect("create manifest parent");
        fs::write(&manifest_path, r#"{"name":"com.example.other"}"#)
            .expect("write foreign manifest");
        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let report = runtime
            .block_on(register(
                &context,
                &RegistrationRequest {
                    host_path: host,
                    browsers: BrowserSelection::One(Browser::Chrome),
                    scope: ManifestScope::User,
                    existing: ExistingManifest::ReplaceOwned,
                },
            ))
            .expect("per-browser error report");
        assert!(matches!(
            report.results[0].outcome,
            ManifestOutcome::Failed { .. }
        ));
        assert_eq!(
            fs::read_to_string(&manifest_path).expect("foreign manifest stays"),
            r#"{"name":"com.example.other"}"#
        );
    }
}
