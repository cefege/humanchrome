//! Composable native command handlers for local installation and diagnostics.
//!
//! The crate deliberately exposes parsing and execution separately so a binary, supervisor, or
//! future fleet launcher can own process I/O and lifecycle without duplicating safety checks.

mod commands;
mod diagnostics;
mod fleet;
mod fleet_ops;
mod install;
mod maintenance;
mod paths;
mod registration;
mod report;

pub use commands::{
    CliCommand, CliOutput, CliParseError, execute, help_text, parse_args, registration_json,
};
pub use diagnostics::{
    DiagnosticFinding, DiagnosticScope, DiagnosticStatus, DiagnosticTarget, DoctorFormat,
    DoctorReport, DoctorRequest, diagnostic_status_name, doctor,
};
pub use fleet::{FleetAgent, FleetCommand, ProfileAction, serve_fleet};
pub use fleet_ops::{
    add_purpose, initialize, nodes, profiles, purposes, remove_node, remove_profile,
    remove_purpose, set_parked, set_profile_enabled, upsert_node,
};
pub use install::{
    NativeBundleInstallError, NativeBundleInstallReport, NativeBundleInstallRequest,
    current_bundle_root, install_and_register_bundle,
};
pub use maintenance::{PermissionResult, fix_permissions, update_port};
pub use paths::{
    ALLOWED_EXTENSION_IDS, Browser, BrowserSelection, HOST_DESCRIPTION, HOST_NAME, HostPlatform,
    ManifestError, ManifestScope, NativeMessagingManifest, NativeMessagingPaths, ParseBrowserError,
};
pub use registration::{
    ExistingManifest, ManifestOutcome, ManifestResult, RegistrationContext, RegistrationError,
    RegistrationReport, RegistrationRequest, SystemInstallAuthorization, UnregistrationRequest,
    VerifiedNativeHost, detect_installed_browsers, register, unregister, verify_native_host,
};
pub use report::{IncludeLogs, ReportFormat, ReportOutput, ReportRequest, report};
