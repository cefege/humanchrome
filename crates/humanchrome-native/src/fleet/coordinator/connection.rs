//! PostgreSQL connection setup with Node pg-compatible TLS policy.

use std::collections::BTreeMap;

use openssl::{
    ssl::{SslConnector, SslFiletype, SslMethod, SslVerifyMode, SslVersion},
    x509::{X509, store::X509StoreBuilder},
};
use postgres_openssl::MakeTlsConnector;
use tokio::task::JoinHandle;
use tokio_postgres::config::{SslMode, SslNegotiation};
use tokio_postgres::{Client, Config, NoTls};
use url::Url;

/// Immutable connection settings loaded once per coordinator store.
pub(crate) struct Connector {
    config: Config,
    tls: Option<MakeTlsConnector>,
}

impl Connector {
    /// Loads certificates off the async executor; configuration changes require a store reload,
    /// just as they do for the Node pg pool.
    pub(crate) async fn new(database_url: &str) -> Result<Self, ConnectError> {
        let (mut config, tls) = parse_connection(database_url)?;
        let tls = match tls {
            TlsSettings::Disabled => {
                config.ssl_mode(SslMode::Disable);
                None
            }
            tls => {
                config.ssl_mode(SslMode::Require);
                config.ssl_negotiation(tls.negotiation());
                Some(
                    tokio::task::spawn_blocking(move || tls_connector(&tls))
                        .await
                        .map_err(|_| ConnectError)??,
                )
            }
        };
        Ok(Self { config, tls })
    }

    /// Returns a client and its owned connection driver. Errors never expose credentials or paths.
    pub(crate) async fn connect(&self) -> Result<(Client, JoinHandle<()>), ConnectError> {
        match &self.tls {
            None => {
                let (client, connection) =
                    self.config.connect(NoTls).await.map_err(|_| ConnectError)?;
                Ok((client, drive(connection)))
            }
            Some(tls) => {
                let (client, connection) = self
                    .config
                    .connect(tls.clone())
                    .await
                    .map_err(|_| ConnectError)?;
                Ok((client, drive(connection)))
            }
        }
    }
}

/// A connection error safe to surface through coordinator availability failures.
#[derive(Debug, thiserror::Error)]
#[error("unable to connect to coordinator database")]
pub(crate) struct ConnectError;

fn drive<S, T>(connection: tokio_postgres::Connection<S, T>) -> JoinHandle<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let _ = connection.await;
    })
}

fn parse_connection(database_url: &str) -> Result<(Config, TlsSettings), ConnectError> {
    let mut url = Url::parse(database_url).map_err(|_| ConnectError)?;
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(ConnectError);
    }

    // pg-connection-string stores the last value for duplicate URL query keys.
    let query: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
    let tls = TlsSettings::from_node_pg(&query)?;

    // tokio-postgres is intentionally strict about unrecognised parameters while pg ignores most
    // of them. Strip pg's TLS-only parameters after interpreting them ourselves, and pass only the
    // libpq settings that tokio-postgres implements.
    let retained = query
        .iter()
        .filter(|(key, _)| is_tokio_postgres_parameter(key));
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(retained.map(|(key, value)| (key.as_str(), value.as_str())));

    let config = url.as_str().parse::<Config>().map_err(|_| ConnectError)?;
    Ok((config, tls))
}

fn is_tokio_postgres_parameter(key: &str) -> bool {
    matches!(
        key,
        "user"
            | "password"
            | "dbname"
            | "options"
            | "application_name"
            | "host"
            | "hostaddr"
            | "port"
            | "connect_timeout"
            | "tcp_user_timeout"
            | "keepalives"
            | "keepalives_idle"
            | "keepalives_interval"
            | "keepalives_retries"
            | "target_session_attrs"
            | "channel_binding"
            | "load_balance_hosts"
    )
}

#[derive(Debug)]
enum TlsSettings {
    Disabled,
    VerifyFull(TlsMaterial),
    VerifyCa(TlsMaterial),
    NoVerify(TlsMaterial),
}

impl TlsSettings {
    fn from_node_pg(query: &BTreeMap<String, String>) -> Result<Self, ConnectError> {
        let ssl_mode = query.get("sslmode").map(String::as_str);
        let libpq_compat = query
            .get("uselibpqcompat")
            .is_some_and(|value| value == "true");
        let environment_negotiation = std::env::var("PGSSLNEGOTIATION").ok();
        let direct_from_url = query
            .get("sslnegotiation")
            .is_some_and(|value| value == "direct");
        let direct = match query
            .get("sslnegotiation")
            .map(String::as_str)
            .or(environment_negotiation.as_deref())
        {
            None | Some("postgres") => SslNegotiation::Postgres,
            Some("direct") => SslNegotiation::Direct,
            Some(_) => return Err(ConnectError),
        };

        let material = TlsMaterial {
            root_cert: query.get("sslrootcert").cloned(),
            client_cert: query.get("sslcert").cloned(),
            client_key: query.get("sslkey").cloned(),
            negotiation: direct,
        };
        let has_tls_parameter = material.root_cert.is_some()
            || material.client_cert.is_some()
            || material.client_key.is_some()
            || ssl_mode.is_some();

        // pg-connection-string parses ssl=true/1 and ssl=0 specially, then lets certificate
        // material or sslmode replace that value with an SSL options object.
        let mut setting = if has_tls_parameter {
            Self::VerifyFull(material.clone())
        } else {
            match query.get("ssl").map(String::as_str) {
                Some("0") | Some("") => Self::Disabled,
                Some("no-verify") => Self::NoVerify(material.clone()),
                Some(_) => Self::VerifyFull(material.clone()),
                None if direct_from_url => Self::VerifyFull(material.clone()),
                None => {
                    let environment_ssl_mode = std::env::var("PGSSLMODE").ok();
                    match environment_ssl_mode.as_deref() {
                        None | Some("disable") => Self::Disabled,
                        Some("no-verify") => Self::NoVerify(material.clone()),
                        Some("prefer") | Some("require") | Some("verify-ca")
                        | Some("verify-full") => Self::VerifyFull(material.clone()),
                        // pg defaults to ssl: false for unrecognised PGSSLMODE values.
                        Some(_) => Self::Disabled,
                    }
                }
            }
        };

        if let Some(mode) = ssl_mode {
            setting = if libpq_compat {
                match mode {
                    "disable" => Self::Disabled,
                    "prefer" => Self::NoVerify(material.clone()),
                    "require" if material.root_cert.is_some() => Self::VerifyCa(material.clone()),
                    "require" => Self::NoVerify(material.clone()),
                    "verify-ca" if material.root_cert.is_some() => Self::VerifyCa(material.clone()),
                    "verify-ca" => return Err(ConnectError),
                    // pg-connection-string leaves unknown modes as strict TLS when compatibility
                    // mode is enabled, and verify-full is the strict spelling.
                    _ => Self::VerifyFull(material.clone()),
                }
            } else {
                match mode {
                    "disable" => Self::Disabled,
                    "no-verify" => Self::NoVerify(material.clone()),
                    // Node pg 8 / pg-connection-string 2.14 deliberately treats these aliases as
                    // verify-full until its next major release.
                    _ => Self::VerifyFull(material.clone()),
                }
            };
        }

        if direct == SslNegotiation::Direct && matches!(setting, Self::Disabled) {
            return Err(ConnectError);
        }

        Ok(setting)
    }

    fn negotiation(&self) -> SslNegotiation {
        match self {
            Self::Disabled => SslNegotiation::Postgres,
            Self::VerifyFull(material) | Self::VerifyCa(material) | Self::NoVerify(material) => {
                material.negotiation
            }
        }
    }
}

#[derive(Debug, Clone)]
struct TlsMaterial {
    root_cert: Option<String>,
    client_cert: Option<String>,
    client_key: Option<String>,
    negotiation: SslNegotiation,
}

fn tls_connector(settings: &TlsSettings) -> Result<MakeTlsConnector, ConnectError> {
    let material = match settings {
        TlsSettings::Disabled => return Err(ConnectError),
        TlsSettings::VerifyFull(material)
        | TlsSettings::VerifyCa(material)
        | TlsSettings::NoVerify(material) => material,
    };
    // Node pg uses OpenSSL's certificate policy. WebPKI rejects a trusted CA certificate used
    // as the endpoint certificate even when Node accepts it; do not special-case that error
    // or weaken verification. Use the same TLS family instead.
    let mut builder = SslConnector::builder(SslMethod::tls()).map_err(|_| ConnectError)?;
    builder
        .set_min_proto_version(Some(SslVersion::TLS1_2))
        .map_err(|_| ConnectError)?;
    builder
        .set_max_proto_version(Some(SslVersion::TLS1_3))
        .map_err(|_| ConnectError)?;
    builder.set_verify(if matches!(settings, TlsSettings::NoVerify(_)) {
        SslVerifyMode::NONE
    } else {
        SslVerifyMode::PEER
    });
    let mut roots = X509StoreBuilder::new().map_err(|_| ConnectError)?;
    if let Some(path) = &material.root_cert {
        let bytes = std::fs::read(path).map_err(|_| ConnectError)?;
        for certificate in X509::stack_from_pem(&bytes).map_err(|_| ConnectError)? {
            roots.add_cert(certificate).map_err(|_| ConnectError)?;
        }
    } else if !matches!(settings, TlsSettings::NoVerify(_)) {
        // Compiled Mozilla-derived roots, rather than an implicit platform CA override.
        for certificate in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
            roots
                .add_cert(X509::from_der(certificate.as_ref()).map_err(|_| ConnectError)?)
                .map_err(|_| ConnectError)?;
        }
    }
    builder.set_cert_store(roots.build());
    if let Some(path) = &material.client_cert {
        builder
            .set_certificate_chain_file(path)
            .map_err(|_| ConnectError)?;
    }
    if let Some(path) = &material.client_key {
        builder
            .set_private_key_file(path, SslFiletype::PEM)
            .map_err(|_| ConnectError)?;
    }
    if material.client_cert.is_some() && material.client_key.is_some() {
        builder.check_private_key().map_err(|_| ConnectError)?;
    }
    if material.negotiation == SslNegotiation::Direct {
        builder
            .set_alpn_protos(b"\x0apostgresql")
            .map_err(|_| ConnectError)?;
    }
    let verify_hostname = matches!(settings, TlsSettings::VerifyFull(_));
    let mut connector = MakeTlsConnector::new(builder.build());
    connector.set_callback(move |configuration, _| {
        configuration.set_verify_hostname(verify_hostname);
        Ok(())
    });
    Ok(connector)
}
