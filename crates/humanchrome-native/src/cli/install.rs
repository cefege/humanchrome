//! Atomic installation of complete Node-free native executable bundles.

use std::{
    io,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use tokio::fs;

use super::{
    paths::{HostPlatform, ManifestScope},
    registration::{
        RegistrationContext, RegistrationError, RegistrationReport, RegistrationRequest,
        register_bundle,
    },
};

const RELEASES_DIRECTORY: &str = "releases";
const ACTIVE_RELEASE_FILE: &str = "active-release.json";
const STDIO_CONFIG_RELATIVE_PATH: &str = "mcp/stdio-config.json";
static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A complete native bundle installation request.
#[derive(Clone, Debug)]
pub struct NativeBundleInstallRequest {
    /// Directory containing the three sibling native executables and `mcp/stdio-config.json`.
    pub bundle_root: PathBuf,
    /// Browser registrations to create after the complete release has been staged.
    pub registration: RegistrationRequest,
}

/// The completed result of staging a native release and updating its registrations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeBundleInstallReport {
    /// The immutable complete-release directory selected for Chrome native messaging.
    pub release_root: PathBuf,
    /// Registration results for every requested browser.
    pub registration: RegistrationReport,
}

/// Installation failures that occur before any native-messaging manifest is changed.
#[derive(Debug, thiserror::Error)]
pub enum NativeBundleInstallError {
    /// The source directory is not a complete native archive layout.
    #[error("native bundle is incomplete or unsafe: {0}")]
    InvalidBundle(String),
    /// An installed stdio configuration could not be read or validated before preservation.
    #[error("could not preserve installed stdio configuration: {0}")]
    ExistingConfiguration(#[source] io::Error),
    /// Staging or activation metadata could not be written atomically.
    #[error("could not stage native bundle: {0}")]
    Staging(#[source] io::Error),
    /// System installation authority or native-host safety validation failed before staging.
    #[error(transparent)]
    Registration(#[from] RegistrationError),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ActiveRelease {
    release: String,
}

#[derive(Debug)]
struct StagedRelease {
    root: PathBuf,
    release: String,
}

/// Resolves the directory containing the executable that invoked the native CLI.
///
/// # Errors
/// Returns when the current executable path cannot be determined.
pub fn current_bundle_root() -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    executable.parent().map(Path::to_path_buf).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "native CLI executable has no parent directory",
        )
    })
}

/// Stages a complete native bundle and registers its installed native host.
///
/// The source bundle is validated before any destination is created. Staging occurs below the
/// stable install root and is activated with a same-filesystem directory rename. Completed
/// releases remain available: other browsers or running workers can still reference them.
/// Callers that coordinate a live runtime drain do so before invoking this function.
///
/// # Errors
/// Returns before changing a manifest when the bundle is incomplete, the target is unsafe, or
/// release staging fails. Registration outcomes remain in [`NativeBundleInstallReport`].
pub async fn install_and_register_bundle(
    context: &RegistrationContext,
    request: &NativeBundleInstallRequest,
) -> Result<NativeBundleInstallReport, NativeBundleInstallError> {
    context.require_install_authorization(request.registration.scope)?;
    let staged = stage_bundle(context, &request.bundle_root, request.registration.scope).await?;

    let mut registration = request.registration.clone();
    registration.host_path = staged
        .root
        .join(native_host_name(context.paths().platform()));
    let report = register_bundle(context, &registration).await?;
    if report
        .results
        .iter()
        .any(|result| result.outcome.is_success())
    {
        write_active_release(
            &context.native_install_root(request.registration.scope),
            &staged.release,
        )
        .await
        .map_err(NativeBundleInstallError::Staging)?;
    }
    // Even a failed Windows Registry operation can leave a valid manifest pointing here.
    // Never unlink a complete release after registration has been attempted.

    Ok(NativeBundleInstallReport {
        release_root: staged.root,
        registration: report,
    })
}

async fn stage_bundle(
    context: &RegistrationContext,
    source_root: &Path,
    scope: ManifestScope,
) -> Result<StagedRelease, NativeBundleInstallError> {
    let source_root = fs::canonicalize(source_root)
        .await
        .map_err(NativeBundleInstallError::Staging)?;
    validate_bundle(&source_root, context.paths().platform()).await?;

    let install_root = context.native_install_root(scope);
    let releases_root = install_root.join(RELEASES_DIRECTORY);
    let previous_release = read_active_release(&install_root).await?;

    if let Some(active) = previous_release.as_deref() {
        let active_root = fs::canonicalize(releases_root.join(active))
            .await
            .map_err(NativeBundleInstallError::ExistingConfiguration)?;
        if source_root == active_root {
            return Ok(StagedRelease {
                root: source_root,
                release: active.to_owned(),
            });
        }
    }

    context.validate_install_target(
        &releases_root.join(native_host_name(context.paths().platform())),
    )?;
    let retained_config = existing_stdio_config(&install_root, previous_release.as_deref()).await?;

    fs::create_dir_all(&releases_root)
        .await
        .map_err(NativeBundleInstallError::Staging)?;
    let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let release = format!(
        "{}-{}-{}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        sequence
    );
    let staging = releases_root.join(format!(".{release}.staging"));
    let destination = releases_root.join(&release);

    let result = async {
        copy_directory(&source_root, &staging).await?;
        if let Some(config) = retained_config {
            fs::write(staging.join(STDIO_CONFIG_RELATIVE_PATH), config).await?;
        }
        validate_bundle(&staging, context.paths().platform())
            .await
            .map_err(io::Error::other)?;
        fs::rename(&staging, &destination).await
    }
    .await;
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging).await;
        return Err(NativeBundleInstallError::Staging(error));
    }

    Ok(StagedRelease {
        root: destination,
        release,
    })
}

async fn validate_bundle(
    root: &Path,
    platform: HostPlatform,
) -> Result<(), NativeBundleInstallError> {
    let metadata = fs::symlink_metadata(root)
        .await
        .map_err(|error| NativeBundleInstallError::InvalidBundle(error.to_string()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(NativeBundleInstallError::InvalidBundle(
            "bundle root must be a real directory".to_owned(),
        ));
    }

    for name in native_binary_names(platform) {
        let path = root.join(name);
        let metadata = fs::symlink_metadata(&path).await.map_err(|_| {
            NativeBundleInstallError::InvalidBundle(format!("missing required executable {name}"))
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(NativeBundleInstallError::InvalidBundle(format!(
                "required executable {name} is not a regular file"
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(NativeBundleInstallError::InvalidBundle(format!(
                    "required executable {name} is not executable"
                )));
            }
        }
    }

    let config = root.join(STDIO_CONFIG_RELATIVE_PATH);
    let bytes = fs::read(&config).await.map_err(|_| {
        NativeBundleInstallError::InvalidBundle("missing mcp/stdio-config.json".to_owned())
    })?;
    validate_stdio_config(&bytes).map_err(NativeBundleInstallError::InvalidBundle)
}

fn validate_stdio_config(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid mcp/stdio-config.json: {error}"))?;
    if value
        .as_object()
        .and_then(|object| object.get("url"))
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err("mcp/stdio-config.json must contain a string url".to_owned());
    }
    Ok(())
}

async fn existing_stdio_config(
    install_root: &Path,
    active_release: Option<&str>,
) -> Result<Option<Vec<u8>>, NativeBundleInstallError> {
    if let Some(release) = active_release {
        let active_config = install_root
            .join(RELEASES_DIRECTORY)
            .join(release)
            .join(STDIO_CONFIG_RELATIVE_PATH);
        let bytes = fs::read(active_config)
            .await
            .map_err(NativeBundleInstallError::ExistingConfiguration)?;
        validate_stdio_config(&bytes).map_err(|message| {
            NativeBundleInstallError::ExistingConfiguration(io::Error::new(
                io::ErrorKind::InvalidData,
                message,
            ))
        })?;
        return Ok(Some(bytes));
    }

    // These locations cover the initial cutover from the historic stable installation.
    for candidate in [
        install_root.join(STDIO_CONFIG_RELATIVE_PATH),
        install_root.join("dist").join(STDIO_CONFIG_RELATIVE_PATH),
    ] {
        match fs::read(candidate).await {
            Ok(bytes) => {
                validate_stdio_config(&bytes).map_err(|message| {
                    NativeBundleInstallError::ExistingConfiguration(io::Error::new(
                        io::ErrorKind::InvalidData,
                        message,
                    ))
                })?;
                return Ok(Some(bytes));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(NativeBundleInstallError::ExistingConfiguration(error)),
        }
    }
    Ok(None)
}

async fn copy_directory(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir(destination).await?;
    let mut entries = fs::read_dir(source).await?;
    while let Some(entry) = entries.next_entry().await? {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).await?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "refusing symlink in native bundle: {}",
                    source_path.display()
                ),
            ));
        }
        if metadata.is_dir() {
            Box::pin(copy_directory(&source_path, &destination_path)).await?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path).await?;
            #[cfg(unix)]
            fs::set_permissions(&destination_path, metadata.permissions()).await?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "refusing non-regular native bundle entry: {}",
                    source_path.display()
                ),
            ));
        }
    }
    Ok(())
}

async fn read_active_release(
    install_root: &Path,
) -> Result<Option<String>, NativeBundleInstallError> {
    let path = install_root.join(ACTIVE_RELEASE_FILE);
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(NativeBundleInstallError::ExistingConfiguration(error)),
    };
    let active: ActiveRelease = serde_json::from_slice(&bytes).map_err(|error| {
        NativeBundleInstallError::ExistingConfiguration(io::Error::new(
            io::ErrorKind::InvalidData,
            error,
        ))
    })?;
    let mut components = Path::new(&active.release).components();
    let safe_name =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !safe_name {
        return Err(NativeBundleInstallError::ExistingConfiguration(
            io::Error::new(io::ErrorKind::InvalidData, "active release name is unsafe"),
        ));
    }
    Ok(Some(active.release))
}

async fn write_active_release(install_root: &Path, release: &str) -> io::Result<()> {
    fs::create_dir_all(install_root).await?;
    let temporary = install_root.join(format!(
        ".{ACTIVE_RELEASE_FILE}.{}.{}.tmp",
        std::process::id(),
        STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let encoded = serde_json::to_vec_pretty(&ActiveRelease {
        release: release.to_owned(),
    })
    .map_err(io::Error::other)?;
    fs::write(&temporary, encoded).await?;
    if let Err(error) = fs::rename(&temporary, install_root.join(ACTIVE_RELEASE_FILE)).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(())
}

fn native_binary_names(platform: HostPlatform) -> [&'static str; 3] {
    match platform {
        HostPlatform::Windows => [
            "humanchrome-nativehost.exe",
            "humanchrome-bridge.exe",
            "humanchrome-stdio.exe",
        ],
        HostPlatform::MacOs | HostPlatform::Linux => [
            "humanchrome-nativehost",
            "humanchrome-bridge",
            "humanchrome-stdio",
        ],
    }
}

fn native_host_name(platform: HostPlatform) -> &'static str {
    native_binary_names(platform)[0]
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use tempfile::tempdir;

    use super::{NativeBundleInstallRequest, install_and_register_bundle};
    use crate::cli::{
        Browser, BrowserSelection, ExistingManifest, HostPlatform, ManifestScope,
        NativeMessagingManifest, NativeMessagingPaths, RegistrationContext, RegistrationRequest,
        SystemInstallAuthorization,
    };

    fn context(root: &Path) -> RegistrationContext {
        RegistrationContext::new(
            NativeMessagingPaths::new(
                HostPlatform::Linux,
                root.join("home"),
                root.join("data"),
                root.join("system"),
            ),
            SystemInstallAuthorization::Verified,
        )
    }

    fn bundle(root: &Path, label: &str) -> PathBuf {
        let bundle = root.join(label);
        fs::create_dir_all(bundle.join("mcp")).expect("create bundle");
        for executable in [
            "humanchrome-nativehost",
            "humanchrome-bridge",
            "humanchrome-stdio",
        ] {
            let path = bundle.join(executable);
            fs::write(&path, "#!/bin/sh\nexit 0\n").expect("write executable");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .expect("make executable");
            }
        }
        fs::write(
            bundle.join("mcp/stdio-config.json"),
            "{\n  \"url\": \"http://127.0.0.1:12306/mcp\"\n}\n",
        )
        .expect("write config");
        bundle
    }

    fn request(bundle_root: PathBuf) -> NativeBundleInstallRequest {
        NativeBundleInstallRequest {
            bundle_root,
            registration: RegistrationRequest {
                host_path: PathBuf::new(),
                browsers: BrowserSelection::One(Browser::Chrome),
                scope: ManifestScope::User,
                existing: ExistingManifest::ReplaceOwned,
            },
        }
    }

    #[test]
    fn registering_active_bundle_reuses_the_same_manifest_target() {
        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let first = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(bundle(root.path(), "initial")),
            ))
            .expect("initial installation");
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        let original = fs::read(&manifest_path).expect("initial manifest");
        let repeated = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(first.release_root.clone()),
            ))
            .expect("register active bundle");
        assert!(
            repeated.registration.is_success(),
            "{:?}",
            repeated.registration
        );
        assert_eq!(
            fs::canonicalize(repeated.release_root).expect("canonical repeated release"),
            fs::canonicalize(first.release_root).expect("canonical initial release")
        );
        assert_eq!(
            fs::read(manifest_path).expect("repeated manifest"),
            original
        );
    }

    #[test]
    fn matching_host_name_does_not_authorize_replacing_an_external_installation() {
        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let external = bundle(root.path(), "external");
        let manifest = NativeMessagingManifest::new(
            fs::canonicalize(external.join("humanchrome-nativehost"))
                .expect("canonical external host"),
        )
        .expect("external host manifest");
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        fs::create_dir_all(manifest_path.parent().expect("manifest parent"))
            .expect("create manifest directory");
        let original = serde_json::to_vec(&manifest).expect("encode external manifest");
        fs::write(&manifest_path, &original).expect("write external manifest");
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let report = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(bundle(root.path(), "candidate")),
            ))
            .expect("per-browser refusal");
        assert!(!report.registration.is_success());
        assert_eq!(
            fs::read(manifest_path).expect("external manifest retained"),
            original
        );
        assert!(manifest.path.is_file(), "external host remains available");
    }

    #[test]
    fn legacy_stable_host_cutover_preserves_configuration_and_retargets_manifest() {
        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let legacy = context
            .native_install_root(ManifestScope::User)
            .join("dist");
        fs::create_dir_all(legacy.join("mcp")).expect("legacy configuration directory");
        let wrapper = legacy.join("run_host.sh");
        fs::write(&wrapper, "#!/bin/sh\nexit 97\n").expect("legacy host file");
        let preserved = br#"{"url":"http://127.0.0.1:12666/mcp"}"#;
        fs::write(legacy.join("mcp/stdio-config.json"), preserved).expect("legacy configuration");
        let old =
            NativeMessagingManifest::new(fs::canonicalize(wrapper).expect("canonical wrapper"))
                .expect("legacy manifest");
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        fs::create_dir_all(manifest_path.parent().expect("manifest parent"))
            .expect("manifest directory");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&old).expect("encode legacy manifest"),
        )
        .expect("write legacy manifest");
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let report = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(bundle(root.path(), "native")),
            ))
            .expect("native cutover");
        assert!(
            report.registration.is_success(),
            "{:?}",
            report.registration
        );
        let installed: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(manifest_path).expect("native manifest"))
                .expect("parse manifest");
        assert_eq!(
            installed.path,
            fs::canonicalize(report.release_root.join("humanchrome-nativehost"))
                .expect("canonical native host")
        );
        assert_eq!(
            fs::read(report.release_root.join("mcp/stdio-config.json"))
                .expect("preserved configuration"),
            preserved
        );
    }

    #[test]
    fn upgrade_preserves_active_stdio_configuration_and_previous_release() {
        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let first = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(bundle(root.path(), "first")),
            ))
            .expect("install first bundle");
        let preserved = b"{\n  \"url\": \"http://127.0.0.1:12666/mcp\"\n}\n";
        fs::write(first.release_root.join("mcp/stdio-config.json"), preserved)
            .expect("update installed port");

        let second = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(bundle(root.path(), "second")),
            ))
            .expect("install second bundle");
        assert_eq!(
            fs::read(second.release_root.join("mcp/stdio-config.json"))
                .expect("read preserved config"),
            preserved
        );
        assert!(first.release_root.is_dir(), "previous release is retained");
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        let manifest: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(manifest_path).expect("read manifest"))
                .expect("parse manifest");
        assert_eq!(
            manifest.path,
            fs::canonicalize(second.release_root.join("humanchrome-nativehost"))
                .expect("canonical host")
        );
    }

    #[test]
    fn incomplete_upgrade_leaves_existing_manifest_and_release_untouched() {
        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let initial = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(bundle(root.path(), "initial")),
            ))
            .expect("install initial bundle");
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        let manifest_before = fs::read(&manifest_path).expect("read manifest");
        let incomplete = root.path().join("incomplete");
        fs::create_dir_all(incomplete.join("mcp")).expect("create incomplete bundle");
        fs::write(
            incomplete.join("mcp/stdio-config.json"),
            "{\"url\":\"http://127.0.0.1:12306/mcp\"}",
        )
        .expect("write config");

        assert!(
            runtime
                .block_on(install_and_register_bundle(&context, &request(incomplete)))
                .is_err()
        );
        assert_eq!(
            fs::read(&manifest_path).expect("manifest unchanged"),
            manifest_before
        );
        assert!(initial.release_root.is_dir(), "active release remains");
    }

    #[test]
    fn partial_browser_registration_keeps_successful_manifest_target_launchable() {
        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let blocked = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chromium);
        fs::create_dir_all(blocked.parent().expect("manifest parent"))
            .expect("create manifest directory");
        let foreign = br#"{"name":"com.example.other"}"#;
        fs::write(&blocked, foreign).expect("write foreign manifest");
        let mut request = request(bundle(root.path(), "partial"));
        request.registration.browsers = BrowserSelection::All;
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let installed = runtime
            .block_on(install_and_register_bundle(&context, &request))
            .expect("per-browser registration report");
        assert!(!installed.registration.is_success());
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        let manifest: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(manifest_path).expect("successful Chrome manifest"))
                .expect("parse successful manifest");
        assert!(
            manifest.path.is_file(),
            "partial failure must not delete the successfully registered host"
        );
        assert_eq!(
            fs::read(blocked).expect("foreign manifest preserved"),
            foreign
        );
    }

    #[test]
    fn upgrading_one_browser_keeps_other_browser_release_launchable() {
        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let mut initial = request(bundle(root.path(), "initial"));
        initial.registration.browsers = BrowserSelection::All;
        let installed = runtime
            .block_on(install_and_register_bundle(&context, &initial))
            .expect("install both browsers");
        assert!(
            installed.registration.is_success(),
            "{:?}",
            installed.registration
        );
        let other_manifest = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chromium);
        let other: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(&other_manifest).expect("Chromium manifest"))
                .expect("parse manifest");
        for label in ["second", "third"] {
            let upgraded = runtime
                .block_on(install_and_register_bundle(
                    &context,
                    &request(bundle(root.path(), label)),
                ))
                .expect("upgrade Chrome only");
            assert!(
                upgraded.registration.is_success(),
                "{:?}",
                upgraded.registration
            );
        }
        assert!(
            other.path.is_file(),
            "upgrading Chrome must not delete Chromium's registered release"
        );
        let retained: NativeMessagingManifest =
            serde_json::from_slice(&fs::read(other_manifest).expect("retained manifest"))
                .expect("parse manifest");
        assert_eq!(retained.path, other.path);
    }

    #[cfg(unix)]
    #[test]
    fn failed_staging_cleans_only_its_temporary_release() {
        use std::os::unix::fs::symlink;

        let root = tempdir().expect("temporary root");
        let context = context(root.path());
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let initial = runtime
            .block_on(install_and_register_bundle(
                &context,
                &request(bundle(root.path(), "initial")),
            ))
            .expect("install initial bundle");
        let manifest_path = context
            .paths()
            .manifest_path(ManifestScope::User, Browser::Chrome);
        let manifest_before = fs::read(&manifest_path).expect("read manifest");
        let unsafe_bundle = bundle(root.path(), "unsafe");
        symlink(
            unsafe_bundle.join("humanchrome-nativehost"),
            unsafe_bundle.join("adapters"),
        )
        .expect("create rejected bundle symlink");

        assert!(
            runtime
                .block_on(install_and_register_bundle(
                    &context,
                    &request(unsafe_bundle),
                ))
                .is_err()
        );
        assert_eq!(
            fs::read(&manifest_path).expect("manifest unchanged"),
            manifest_before
        );
        assert!(initial.release_root.is_dir(), "active release remains");
        let releases = context
            .native_install_root(ManifestScope::User)
            .join("releases");
        assert_eq!(
            fs::read_dir(releases).expect("read releases").count(),
            1,
            "failed staging leaves no release or staging directory"
        );
    }
}
