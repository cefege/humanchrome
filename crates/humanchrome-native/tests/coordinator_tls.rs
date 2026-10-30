//! Opt-in real PostgreSQL TLS coverage for the public coordinator store.

use humanchrome_native::fleet::coordinator::CoordinatorStore;

fn required_url(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for the TLS smoke"))
}

async fn opens_and_reads(name: &str, database_url: String) {
    let store = CoordinatorStore::new(name, database_url);
    store.open().await.unwrap_or_else(|error| {
        panic!("{name}: TLS coordinator advisory-lock session failed: {error}")
    });
    assert!(
        store.ready().await,
        "TLS coordinator store must execute its readiness SELECT"
    );
    store.close().await;
}

#[tokio::test]
#[ignore = "requires an owned TLS-only PostgreSQL and HC_TEST_COORDINATOR_TLS_*_URL"]
async fn node_pg_compatible_tls_modes_reach_the_public_coordinator_store() {
    opens_and_reads(
        "rust-transition-tls-strict",
        required_url("HC_TEST_COORDINATOR_TLS_STRICT_URL"),
    )
    .await;
    opens_and_reads(
        "rust-transition-tls-verify-ca",
        required_url("HC_TEST_COORDINATOR_TLS_VERIFY_CA_URL"),
    )
    .await;
    opens_and_reads(
        "rust-transition-tls-no-verify",
        required_url("HC_TEST_COORDINATOR_TLS_NO_VERIFY_URL"),
    )
    .await;
    opens_and_reads(
        "rust-transition-tls-direct",
        required_url("HC_TEST_COORDINATOR_TLS_DIRECT_URL"),
    )
    .await;

    let rejected = CoordinatorStore::new(
        "rust-transition-tls-rejected",
        required_url("HC_TEST_COORDINATOR_TLS_REJECT_URL"),
    )
    .open()
    .await;
    assert!(
        rejected.is_err(),
        "a self-signed TLS endpoint without its configured CA must be rejected"
    );

    let wrong_hostname = CoordinatorStore::new(
        "rust-transition-tls-wrong-hostname",
        required_url("HC_TEST_COORDINATOR_TLS_HOSTNAME_REJECT_URL"),
    )
    .open()
    .await;
    assert!(
        wrong_hostname.is_err(),
        "verify-full must reject a trusted certificate for the wrong host"
    );
}
