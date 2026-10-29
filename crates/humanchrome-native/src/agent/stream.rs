//! Session-scoped in-process event fan-out for SSE clients.

use std::{
    collections::HashMap,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    task::{Context, Poll},
    time::Duration,
};

use futures_core::Stream;
use tokio::{sync::broadcast, task::JoinHandle};
use tokio_stream::wrappers::{BroadcastStream, errors::BroadcastStreamRecvError};

use super::types::{HeartbeatEvent, RealtimeEvent};

const STREAM_BUFFER: usize = 256;

#[derive(Default)]
struct Streams {
    sessions: HashMap<String, broadcast::Sender<RealtimeEvent>>,
    heartbeat: Option<JoinHandle<()>>,
}

/// A stream of session events. Lag is surfaced to the HTTP adapter as an explicit error event.
pub struct AgentEventStream {
    inner: Option<BroadcastStream<RealtimeEvent>>,
    session_id: String,
    owner: Weak<Mutex<Streams>>,
}

impl Stream for AgentEventStream {
    type Item = Result<RealtimeEvent, BroadcastStreamRecvError>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut() {
            Some(inner) => Pin::new(inner).poll_next(context),
            None => Poll::Ready(None),
        }
    }
}

impl Drop for AgentEventStream {
    fn drop(&mut self) {
        drop(self.inner.take());
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        let mut streams = owner.lock().expect("agent event stream lock poisoned");
        if streams
            .sessions
            .get(&self.session_id)
            .is_some_and(|sender| sender.receiver_count() == 0)
        {
            streams.sessions.remove(&self.session_id);
        }
        if streams.sessions.is_empty()
            && let Some(heartbeat) = streams.heartbeat.take()
        {
            heartbeat.abort();
        }
    }
}

/// Owns session fan-out and the shared heartbeat while at least one client is subscribed.
#[derive(Clone, Default)]
pub struct AgentStreamHub {
    streams: Arc<Mutex<Streams>>,
}

impl AgentStreamHub {
    /// Publishes a session event, or a heartbeat to every currently connected session.
    pub fn publish(&self, session_id: &str, event: RealtimeEvent) {
        let streams = self
            .streams
            .lock()
            .expect("agent event stream lock poisoned");
        if matches!(event, RealtimeEvent::Heartbeat { .. }) {
            for sender in streams.sessions.values() {
                let _ = sender.send(event.clone());
            }
        } else if let Some(sender) = streams.sessions.get(session_id) {
            let _ = sender.send(event);
        }
    }

    /// Subscribes one SSE client and starts the same shared 30-second heartbeat as Node.
    #[must_use]
    pub fn subscribe(&self, session_id: &str) -> AgentEventStream {
        let mut streams = self
            .streams
            .lock()
            .expect("agent event stream lock poisoned");
        let receiver = streams
            .sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| broadcast::channel(STREAM_BUFFER).0)
            .subscribe();
        if streams.heartbeat.is_none() {
            let owner = Arc::downgrade(&self.streams);
            streams.heartbeat = Some(tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(30));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let Some(owner) = owner.upgrade() else { return };
                    let streams = owner.lock().expect("agent event stream lock poisoned");
                    if streams.sessions.is_empty() {
                        return;
                    }
                    let event = RealtimeEvent::Heartbeat {
                        data: HeartbeatEvent {
                            timestamp: chrono::Utc::now()
                                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        },
                    };
                    for sender in streams.sessions.values() {
                        let _ = sender.send(event.clone());
                    }
                }
            }));
        }
        AgentEventStream {
            inner: Some(BroadcastStream::new(receiver)),
            session_id: session_id.to_owned(),
            owner: Arc::downgrade(&self.streams),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_core::Stream;

    #[tokio::test]
    async fn subscribers_receive_only_their_session_events() {
        let hub = AgentStreamHub::default();
        let mut stream = Box::pin(hub.subscribe("one"));
        let event = |session_id: &str| RealtimeEvent::Connected {
            data: super::super::types::ConnectedEvent {
                session_id: session_id.into(),
                transport: "sse".into(),
                timestamp: "now".into(),
            },
        };
        hub.publish("two", event("two"));
        hub.publish("one", event("one"));
        let received = std::future::poll_fn(|context| stream.as_mut().poll_next(context)).await;
        assert_eq!(received.expect("event").expect("not lagged"), event("one"));
    }
}
