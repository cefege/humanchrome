//! Persistent image attachment storage and its composable local HTTP routes.

mod routes;
mod store;

pub use routes::{AttachmentProjectSource, attachment_router, attachment_router_with_projects};
pub use store::{
    AttachmentCleanupResult, AttachmentError, AttachmentMetadata, AttachmentProjectStats,
    AttachmentStats, AttachmentStore, CleanupProjectResult, SavedAttachment, ext_to_mime_type,
    mime_type_to_ext,
};
