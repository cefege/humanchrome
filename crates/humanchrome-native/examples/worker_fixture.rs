//! Test-only executable boundary for the durable worker HTTP routes.
//!
//! It binds a validated local Tailscale address and proxies to a fixture bridge. The
//! worker implementation, SQLite fence store, request body streaming, and response
//! streaming are all production code; only Chrome lifecycle effects are represented
//! by a fixed healthy profile endpoint.

use std::{collections::HashMap, env, net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result, bail};
use humanchrome_native::fleet::{
    runtime::FleetRuntimeConfig,
    worker::{
        ProfileSnapshot, ProfileState, SupervisorError, WorkerConfig, WorkerFleetConfig,
        WorkerHttp, WorkerProvisioner, WorkerRuntimeConfig, WorkerState, WorkerSupervisor,
        server::WorkerFuture,
    },
};
use serde_json::Value;

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BRIDGE_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Debug)]
struct FixtureSupervisor {
    bridge_port: u16,
}

impl WorkerSupervisor for FixtureSupervisor {
    fn snapshot(&self) -> WorkerFuture<'_, Vec<ProfileSnapshot>> {
        let bridge_port = self.bridge_port;
        Box::pin(async move {
            Ok(vec![ProfileSnapshot {
                name: "browser".to_owned(),
                port: bridge_port,
                labels: Vec::new(),
                enabled: true,
                purpose: None,
                state: ProfileState::Healthy,
                pid: Some(std::process::id()),
                leased_by: None,
                last_error: None,
                started_by: None,
            }])
        })
    }

    fn state(&self, name: String) -> WorkerFuture<'_, Option<ProfileState>> {
        Box::pin(async move { Ok((name == "browser").then_some(ProfileState::Healthy)) })
    }

    fn start_profile(&self, _name: String) -> WorkerFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn stop_profile(&self, _name: String) -> WorkerFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn restart_profile(&self, _name: String) -> WorkerFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn demand_start(
        &self,
        _name: String,
        _agent: String,
        _request: String,
    ) -> WorkerFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn reap_idle(&self, _leased: Arc<dyn Fn(&str) -> bool + Send + Sync>) -> WorkerFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn reload(&self, _config: FleetRuntimeConfig) -> WorkerFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Debug)]
struct UnusedConfig;

impl WorkerFleetConfig for UnusedConfig {
    fn load(&self) -> WorkerFuture<'_, WorkerRuntimeConfig> {
        Box::pin(async {
            Err(SupervisorError {
                message: "fixture configuration is not used".to_owned(),
            })
        })
    }

    fn save(&self, _config: WorkerRuntimeConfig) -> WorkerFuture<'_, ()> {
        Box::pin(async {
            Err(SupervisorError {
                message: "fixture configuration is not used".to_owned(),
            })
        })
    }
}

#[derive(Debug)]
struct UnusedProvisioner;

impl WorkerProvisioner for UnusedProvisioner {
    fn add_profile(
        &self,
        _name: String,
        _labels: Vec<String>,
        _seed_dir: Option<PathBuf>,
    ) -> WorkerFuture<'_, Value> {
        Box::pin(async {
            Err(SupervisorError {
                message: "fixture provisioning is not used".to_owned(),
            })
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = FixtureArguments::parse()?;
    let config = WorkerConfig {
        id: "fixture-worker".to_owned(),
        host: arguments.host.clone(),
        port: arguments.port,
        token: TOKEN.to_owned(),
        profiles: vec!["browser".to_owned()],
        seed_sources: HashMap::new(),
    };
    let state = WorkerState::open_async(&arguments.fences)
        .await
        .with_context(|| {
            format!(
                "opening worker fence database {}",
                arguments.fences.display()
            )
        })?;
    let worker = WorkerHttp::new(
        config,
        state,
        Arc::new(FixtureSupervisor {
            bridge_port: arguments.bridge_port,
        }),
        Arc::new(UnusedConfig),
        Arc::new(UnusedProvisioner),
        BRIDGE_TOKEN,
    )?;
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(
        arguments
            .host
            .parse()
            .context("parsing --host as an IP address")?,
        arguments.port,
    ))
    .await
    .with_context(|| {
        format!(
            "binding fixture worker at {}:{}",
            arguments.host, arguments.port
        )
    })?;
    println!("{{\"ready\":true,\"port\":{}}}", arguments.port);
    axum::serve(listener, worker.router())
        .await
        .context("serving worker fixture")
}

#[derive(Debug)]
struct FixtureArguments {
    host: String,
    port: u16,
    bridge_port: u16,
    fences: PathBuf,
}

impl FixtureArguments {
    fn parse() -> Result<Self> {
        let mut host = None;
        let mut port = None;
        let mut bridge_port = None;
        let mut fences = None;
        let mut arguments = env::args().skip(1);
        while let Some(flag) = arguments.next() {
            let value = arguments
                .next()
                .with_context(|| format!("{flag} requires a value"))?;
            match flag.as_str() {
                "--host" => host = Some(value),
                "--port" => port = Some(value.parse().context("parsing --port")?),
                "--bridge-port" => {
                    bridge_port = Some(value.parse().context("parsing --bridge-port")?)
                }
                "--fences" => fences = Some(PathBuf::from(value)),
                _ => bail!("unknown argument {flag}"),
            }
        }
        Ok(Self {
            host: host.context("missing --host")?,
            port: port.context("missing --port")?,
            bridge_port: bridge_port.context("missing --bridge-port")?,
            fences: fences.context("missing --fences")?,
        })
    }
}
