//! Persistent local agent execution, event streaming, and HTTP routes.

mod http;
mod provider;
mod service;
mod store;
mod stream;
mod types;

pub use http::{AgentAuthorizer, AgentHttp, AgentHttpConfig};
pub use provider::{
    AgentProvider, CodexProvider, ProviderError, ProviderEvent, ProviderRegistry, ProviderRequest,
};
pub use service::{AgentService, AgentServiceError};
pub use store::{AgentStore, StoreError};
pub use stream::{AgentEventStream, AgentStreamHub};
pub use types::{
    AgentActRequest, AgentActResponse, AgentAttachment, AgentMessage, AgentProject, AgentSession,
    AgentStoredMessage, CreateProjectInput, CreateSessionInput, EngineName, RealtimeEvent,
    UpdateSessionInput,
};
