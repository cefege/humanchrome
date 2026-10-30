//! PostgreSQL-fenced fleet coordination, authenticated control, and worker routing.

mod config;
pub(crate) mod connection;
mod server;
mod store;

pub use config::{
    ConfigError, CoordinatorClient, CoordinatorConfig, CoordinatorWorker, ProfileSnapshot,
    ProfileState, StartedBy, WorkerInventory,
};
pub use server::{ClientIdentity, CoordinatorControl, FleetCoordinator};
pub use store::{CoordinatorError, CoordinatorLease, CoordinatorProfile, CoordinatorStore};
