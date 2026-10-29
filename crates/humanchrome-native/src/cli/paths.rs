//! Platform-specific native-messaging manifest locations and manifest validation.

use std::{
    env, fmt, io,
    path::{Path, PathBuf},
    str::FromStr,
};

use serde::{Deserialize, Serialize};

/// The Chrome native-messaging host name shared with the extension.
pub const HOST_NAME: &str = "com.humanchrome.nativehost";
/// Human-readable description included in each native-messaging manifest.
pub const HOST_DESCRIPTION: &str = "Native messaging host for HumanChrome.";
/// Extension IDs permitted to connect to the native host.
pub const ALLOWED_EXTENSION_IDS: [&str; 3] = [
    "dhabpgnpajocncnoigibmocmfjnhlmhe",
    "hbdgbgagpkpjffpklnamcljpakneikee",
    "dekkpcefpenbgcegejbolgkhkkcidaoj",
];

/// A Chrome-family browser supported by the native-messaging installer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Browser {
    /// Google Chrome.
    Chrome,
    /// Chromium.
    Chromium,
}

impl Browser {
    /// All browsers supported by the current manifest contract.
    pub const ALL: [Self; 2] = [Self::Chrome, Self::Chromium];

    /// Returns the stable command-line spelling for this browser.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Chromium => "chromium",
        }
    }

    /// Returns the display name used in command results.
    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Chrome => "Chrome",
            Self::Chromium => "Chromium",
        }
    }
}

impl fmt::Display for Browser {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Browser {
    type Err = ParseBrowserError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "chrome" => Ok(Self::Chrome),
            "chromium" => Ok(Self::Chromium),
            _ => Err(ParseBrowserError(value.to_owned())),
        }
    }
}

/// A command-line browser selector, including automatic local detection.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BrowserSelection {
    /// Register exactly one browser.
    One(Browser),
    /// Register every supported browser.
    #[default]
    All,
    /// Detect installed browsers, falling back to every supported browser when none are found.
    Detected,
}

impl BrowserSelection {
    /// Expands an explicit selection without allocating.
    ///
    /// Detection is resolved by the registration handler and conservatively falls back to all.
    #[must_use]
    pub fn browsers(self) -> &'static [Browser] {
        match self {
            Self::One(Browser::Chrome) => &[Browser::Chrome],
            Self::One(Browser::Chromium) => &[Browser::Chromium],
            Self::All | Self::Detected => &Browser::ALL,
        }
    }
}

impl FromStr for BrowserSelection {
    type Err = ParseBrowserError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.eq_ignore_ascii_case("all") {
            Ok(Self::All)
        } else if value.eq_ignore_ascii_case("detect") || value.eq_ignore_ascii_case("auto") {
            Ok(Self::Detected)
        } else {
            value.parse().map(Self::One)
        }
    }
}

/// Invalid browser selector text.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("invalid browser {0:?}; expected chrome, chromium, or all")]
pub struct ParseBrowserError(String);

/// The operating-system convention used to resolve browser manifest paths.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostPlatform {
    /// macOS paths and permissions.
    MacOs,
    /// Linux and other Unix paths.
    Linux,
    /// Windows filesystem and Registry conventions.
    Windows,
}

impl HostPlatform {
    /// Resolves the target platform for this process.
    #[must_use]
    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::MacOs
        }
        #[cfg(windows)]
        {
            Self::Windows
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Self::Linux
        }
        #[cfg(not(any(unix, windows)))]
        {
            Self::Linux
        }
    }
}

/// A user or system native-messaging manifest location.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManifestScope {
    /// The manifest belongs to the invoking user.
    User,
    /// The manifest belongs to the system-wide browser installation.
    System,
}

impl fmt::Display for ManifestScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::User => formatter.write_str("user"),
            Self::System => formatter.write_str("system"),
        }
    }
}

/// Explicit roots used to resolve native-messaging paths without touching an installation.
#[derive(Clone, Debug)]
pub struct NativeMessagingPaths {
    platform: HostPlatform,
    home: PathBuf,
    app_data: PathBuf,
    system_root: PathBuf,
}

impl NativeMessagingPaths {
    /// Resolves production roots from the current environment.
    ///
    /// # Errors
    /// Returns an error when the home directory cannot be resolved.
    pub fn from_environment() -> io::Result<Self> {
        let home = dirs::home_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))?;
        let platform = HostPlatform::current();
        let app_data = match platform {
            HostPlatform::Windows => env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData/Roaming")),
            HostPlatform::MacOs => home.clone(),
            HostPlatform::Linux => env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share")),
        };
        let system_root = match platform {
            HostPlatform::Windows => env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Program Files")),
            HostPlatform::MacOs | HostPlatform::Linux => PathBuf::from("/"),
        };
        Ok(Self::new(platform, home, app_data, system_root))
    }

    /// Creates a resolver from explicit roots, primarily for isolated commands and tests.
    #[must_use]
    pub fn new(
        platform: HostPlatform,
        home: PathBuf,
        app_data: PathBuf,
        system_root: PathBuf,
    ) -> Self {
        Self {
            platform,
            home,
            app_data,
            system_root,
        }
    }

    /// Returns the user-home root used by this isolated resolver.
    #[must_use]
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Resolves the stable root for complete native executable releases.
    #[must_use]
    pub fn native_install_root(&self, scope: ManifestScope) -> PathBuf {
        match (self.platform, scope) {
            (HostPlatform::MacOs, ManifestScope::User) => self
                .home
                .join("Library/Application Support/humanchrome-bridge"),
            (HostPlatform::MacOs, ManifestScope::System) => self
                .system_root
                .join("Library/Application Support/humanchrome-bridge"),
            (HostPlatform::Linux, ManifestScope::User) => self.app_data.join("humanchrome-bridge"),
            (HostPlatform::Linux, ManifestScope::System) => {
                self.system_root.join("opt/humanchrome-bridge")
            }
            (HostPlatform::Windows, ManifestScope::User) => {
                self.app_data.join("humanchrome-bridge")
            }
            (HostPlatform::Windows, ManifestScope::System) => {
                self.system_root.join("humanchrome-bridge")
            }
        }
    }

    /// Resolves the manifest path for one browser and installation scope.
    #[must_use]
    pub fn manifest_path(&self, scope: ManifestScope, browser: Browser) -> PathBuf {
        let suffix = format!("{HOST_NAME}.json");
        match (self.platform, scope, browser) {
            (HostPlatform::MacOs, ManifestScope::User, Browser::Chrome) => self
                .home
                .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::MacOs, ManifestScope::User, Browser::Chromium) => self
                .home
                .join("Library/Application Support/Chromium/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::MacOs, ManifestScope::System, Browser::Chrome) => self
                .system_root
                .join("Library/Google/Chrome/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::MacOs, ManifestScope::System, Browser::Chromium) => self
                .system_root
                .join("Library/Application Support/Chromium/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::Linux, ManifestScope::User, Browser::Chrome) => self
                .home
                .join(".config/google-chrome/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::Linux, ManifestScope::User, Browser::Chromium) => self
                .home
                .join(".config/chromium/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::Linux, ManifestScope::System, Browser::Chrome) => self
                .system_root
                .join("etc/opt/chrome/native-messaging-hosts")
                .join(suffix),
            (HostPlatform::Linux, ManifestScope::System, Browser::Chromium) => self
                .system_root
                .join("etc/chromium/native-messaging-hosts")
                .join(suffix),
            (HostPlatform::Windows, ManifestScope::User, Browser::Chrome) => self
                .app_data
                .join("Google/Chrome/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::Windows, ManifestScope::User, Browser::Chromium) => self
                .app_data
                .join("Chromium/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::Windows, ManifestScope::System, Browser::Chrome) => self
                .system_root
                .join("Google/Chrome/NativeMessagingHosts")
                .join(suffix),
            (HostPlatform::Windows, ManifestScope::System, Browser::Chromium) => self
                .system_root
                .join("Chromium/NativeMessagingHosts")
                .join(suffix),
        }
    }

    /// Returns the Windows Registry key required in addition to the manifest.
    #[must_use]
    pub fn registry_key(&self, scope: ManifestScope, browser: Browser) -> Option<String> {
        if self.platform != HostPlatform::Windows {
            return None;
        }
        let hive = match scope {
            ManifestScope::User => "HKCU",
            ManifestScope::System => "HKLM",
        };
        let product = match browser {
            Browser::Chrome => "Google\\Chrome",
            Browser::Chromium => "Chromium",
        };
        Some(format!(
            "{hive}\\Software\\{product}\\NativeMessagingHosts\\{HOST_NAME}"
        ))
    }

    /// Returns the platform represented by these paths.
    #[must_use]
    pub const fn platform(&self) -> HostPlatform {
        self.platform
    }
}

/// The on-disk Chrome native-messaging manifest.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NativeMessagingManifest {
    /// Registered host name.
    pub name: String,
    /// User-facing host description.
    pub description: String,
    /// Absolute native host executable path.
    pub path: PathBuf,
    /// Native-messaging transport type.
    #[serde(rename = "type")]
    pub transport: String,
    /// Chrome extension origins authorized to connect.
    pub allowed_origins: Vec<String>,
}

impl NativeMessagingManifest {
    /// Builds a validated manifest for an installed native host executable.
    pub fn new(host_path: PathBuf) -> Result<Self, ManifestError> {
        if !host_path.is_absolute() {
            return Err(ManifestError::RelativeHostPath(host_path));
        }
        Ok(Self {
            name: HOST_NAME.to_owned(),
            description: HOST_DESCRIPTION.to_owned(),
            path: host_path,
            transport: "stdio".to_owned(),
            allowed_origins: ALLOWED_EXTENSION_IDS
                .iter()
                .map(|identifier| format!("chrome-extension://{identifier}/"))
                .collect(),
        })
    }

    /// Ensures a parsed manifest is owned by this CLI and targets the requested executable.
    pub fn validate_owned_by(&self, host_path: &Path) -> Result<(), ManifestError> {
        if self.name != HOST_NAME {
            return Err(ManifestError::ForeignHostName(self.name.clone()));
        }
        if self.transport != "stdio" {
            return Err(ManifestError::InvalidTransport(self.transport.clone()));
        }
        let comparable = std::fs::canonicalize(host_path)
            .or_else(|error| {
                if error.kind() != io::ErrorKind::NotFound {
                    return Err(error);
                }
                let parent = host_path.parent().ok_or(error)?;
                let file_name = host_path.file_name().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "host path has no filename")
                })?;
                Ok(std::fs::canonicalize(parent)?.join(file_name))
            })
            .unwrap_or_else(|_| host_path.to_path_buf());
        if self.path != comparable {
            return Err(ManifestError::HostPathMismatch {
                expected: host_path.to_path_buf(),
                actual: self.path.clone(),
            });
        }
        let expected_origins: Vec<String> = ALLOWED_EXTENSION_IDS
            .iter()
            .map(|identifier| format!("chrome-extension://{identifier}/"))
            .collect();
        if self.allowed_origins != expected_origins {
            return Err(ManifestError::InvalidAllowedOrigins);
        }
        Ok(())
    }
}

/// A malformed or unsafe native-messaging manifest.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ManifestError {
    /// Relative executable paths make Chrome's launch semantics ambiguous.
    #[error("native host path must be absolute: {0}")]
    RelativeHostPath(PathBuf),
    /// An existing file is not this host's manifest.
    #[error("refusing to modify manifest for foreign host {0:?}")]
    ForeignHostName(String),
    /// An existing manifest does not use the native-messaging stdio transport.
    #[error("manifest transport must be stdio, found {0:?}")]
    InvalidTransport(String),
    /// An existing manifest would point at a different executable.
    #[error("manifest host path differs: expected {expected}, found {actual}")]
    HostPathMismatch { expected: PathBuf, actual: PathBuf },
    /// An existing manifest authorizes a different extension set.
    #[error("manifest allowed_origins does not match the HumanChrome extension contract")]
    InvalidAllowedOrigins,
}

#[cfg(test)]
mod tests {
    use super::{
        Browser, BrowserSelection, HostPlatform, ManifestError, ManifestScope,
        NativeMessagingManifest, NativeMessagingPaths,
    };
    use std::{path::PathBuf, str::FromStr};

    #[test]
    fn maps_all_platform_paths_from_explicit_roots() {
        let root = PathBuf::from("/sandbox/system");
        let paths = NativeMessagingPaths::new(
            HostPlatform::MacOs,
            PathBuf::from("/sandbox/home"),
            PathBuf::from("/sandbox/appdata"),
            root,
        );
        assert_eq!(
            paths.manifest_path(ManifestScope::User, Browser::Chrome),
            PathBuf::from(
                "/sandbox/home/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.nativehost.json"
            )
        );
        assert_eq!(
            paths.manifest_path(ManifestScope::System, Browser::Chromium),
            PathBuf::from(
                "/sandbox/system/Library/Application Support/Chromium/NativeMessagingHosts/com.humanchrome.nativehost.json"
            )
        );
    }

    #[test]
    fn maps_linux_and_windows_conventions() {
        let linux = NativeMessagingPaths::new(
            HostPlatform::Linux,
            PathBuf::from("/home/tester"),
            PathBuf::from("unused"),
            PathBuf::from("/sandbox"),
        );
        assert_eq!(
            linux.manifest_path(ManifestScope::System, Browser::Chrome),
            PathBuf::from(
                "/sandbox/etc/opt/chrome/native-messaging-hosts/com.humanchrome.nativehost.json"
            )
        );
        let windows = NativeMessagingPaths::new(
            HostPlatform::Windows,
            PathBuf::from("unused"),
            PathBuf::from("C:/Users/tester/AppData/Roaming"),
            PathBuf::from("C:/Program Files"),
        );
        assert_eq!(
            windows.manifest_path(ManifestScope::User, Browser::Chromium),
            PathBuf::from(
                "C:/Users/tester/AppData/Roaming/Chromium/NativeMessagingHosts/com.humanchrome.nativehost.json"
            )
        );
        assert_eq!(
            windows
                .registry_key(ManifestScope::User, Browser::Chrome)
                .as_deref(),
            Some(
                "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.humanchrome.nativehost"
            )
        );
    }

    #[test]
    fn validates_owned_manifest_before_destructive_operations() {
        let host = std::env::temp_dir().join("humanchrome/native-host");
        let manifest = NativeMessagingManifest::new(host.clone()).expect("absolute host path");
        manifest.validate_owned_by(&host).expect("owned manifest");

        let mut foreign = manifest;
        foreign.name = "com.example.other".to_owned();
        assert!(matches!(
            foreign.validate_owned_by(&host),
            Err(ManifestError::ForeignHostName(_))
        ));
    }

    #[test]
    fn parses_browser_selection() {
        assert_eq!(BrowserSelection::from_str("all"), Ok(BrowserSelection::All));
        assert_eq!(
            BrowserSelection::from_str("chromium"),
            Ok(BrowserSelection::One(Browser::Chromium))
        );
    }
}
