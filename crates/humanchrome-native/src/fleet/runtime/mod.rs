//! Chrome fleet runtime primitives for profile ownership, CDP, leases, and supervision.
//!
//! The parent [`crate::fleet`] module intentionally chooses when to expose this runtime.
//! Every operation here is scoped to an explicit fleet root and never touches a daily profile.

mod cdp;
mod error;
mod gateway;
mod google_session;
mod label;
mod launcher;
mod leases;
mod profile;
mod supervisor;

pub use cdp::{
    CdpPipe, CdpResponse, ChromeProcess, assert_keychain_readable, chrome_args,
    disable_foreign_extensions, find_chrome_for_profile, read_extension_manifest, terminate_chrome,
    terminate_chrome_checked,
};
pub use error::FleetRuntimeError;
pub(crate) use gateway::profiles_to_json;
pub use gateway::{FleetGateway, FleetNode, GatewayConfig};
pub(crate) use google_session::probe_profile_google_session;
pub use launcher::{
    LaunchConfig, LaunchedProfile, launch_profile_with_extension, profile_environment,
};
pub use leases::{AcquireLease, FleetLease, FleetLeases};
pub use profile::{
    AddedProfile, COOKIE_KEEP_RATIO, CookieCount, GoogleSession, GoogleSessionState,
    ProfileProvisioner, SeedProvenance, capture_session, classify_list_accounts, cookie_loss,
    copied_google_login, copy_profile_dir, count_copied_cookies, count_live_cookies,
    google_session_loss, restore_session, seed_profile_from, signin_pending_since,
    write_native_host_manifest,
};
pub use supervisor::{
    DemandReason, FleetProfile, FleetRuntimeConfig, ProfileSnapshot, ProfileStartError,
    ProfileState, ProfileSupervisor,
};
