//! Real PostgreSQL safety fixture for coordinator leadership and durable lease state.

use std::env;

use anyhow::{Context, Result, bail, ensure};
use humanchrome_native::fleet::coordinator::{
    CoordinatorError, CoordinatorLease, CoordinatorStore, ProfileSnapshot, ProfileState,
};
use tokio_postgres::NoTls;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<()> {
    let database_url = test_database_url()?;
    let coordinator_id = format!("cs-{}", Uuid::new_v4());

    let store = CoordinatorStore::new(coordinator_id.as_str(), database_url.as_str());
    store.open().await.context("opening primary coordinator")?;
    store
        .observe("fixture-worker", Some(&[snapshot()]))
        .await
        .context("storing fixture worker inventory")?;
    let profiles = store
        .profiles(&["fixture-worker".to_owned()])
        .await
        .context("reading fixture worker inventory")?;
    ensure!(!profiles.is_empty(), "fixture inventory is empty");

    let contender = CoordinatorStore::new(coordinator_id.as_str(), database_url.as_str());
    let contested = contender
        .open()
        .await
        .expect_err("second leader must not acquire the same coordinator id");
    assert_error(
        &contested,
        503,
        "coordinator_unavailable",
        "singleton contention",
    )?;

    let first = store.clone();
    let second = store.clone();
    let first_profiles = profiles.clone();
    let second_profiles = profiles.clone();
    let (first, second) = tokio::join!(
        first.acquire(
            "contender-one",
            "fixture-agent",
            &first_profiles,
            30,
            None,
            "any"
        ),
        second.acquire(
            "contender-two",
            "fixture-agent",
            &second_profiles,
            30,
            None,
            "any"
        ),
    );
    let winner = one_winner(first, second)?;
    store
        .release(&winner)
        .await
        .context("releasing contested lease")?;
    store.close().await;

    let reopened = CoordinatorStore::new(coordinator_id.as_str(), database_url.as_str());
    reopened
        .open()
        .await
        .context("reopening released coordinator")?;
    let profiles = reopened
        .profiles(&["fixture-worker".to_owned()])
        .await
        .context("reading inventory after reopen")?;
    let released = reopened
        .acquire(
            "released-client",
            "fixture-agent",
            &profiles,
            30,
            None,
            "any",
        )
        .await
        .context("reacquiring released route after reopen")?;
    ensure!(
        released.generation > winner.generation,
        "released lease generation did not increase"
    );
    reopened
        .release(&released)
        .await
        .context("releasing reopened lease")?;

    let expired = reopened
        .acquire("expired-client", "fixture-agent", &profiles, 0, None, "any")
        .await
        .context("creating immediately expired lease")?;
    reopened.close().await;

    let after_expiry = CoordinatorStore::new(coordinator_id.as_str(), database_url.as_str());
    after_expiry
        .open()
        .await
        .context("reopening expired coordinator")?;
    let profiles = after_expiry
        .profiles(&["fixture-worker".to_owned()])
        .await
        .context("reading inventory after expiry reopen")?;
    let expired_binding = after_expiry
        .acquire(
            "expired-client",
            "fixture-agent",
            &profiles,
            30,
            None,
            "any",
        )
        .await
        .expect_err("expired durable route binding must not silently rebind");
    assert_error(
        &expired_binding,
        409,
        "lease_expired",
        "expired route binding",
    )?;
    let replacement = after_expiry
        .acquire(
            "replacement-client",
            "fixture-agent",
            &profiles,
            30,
            None,
            "any",
        )
        .await
        .context("acquiring capacity freed by expiry")?;
    ensure!(
        replacement.generation > expired.generation,
        "expired lease generation did not increase"
    );

    terminate_leader(&database_url, &coordinator_id).await?;
    let rejected_observe = after_expiry
        .observe("fixture-worker", Some(&[snapshot()]))
        .await
        .expect_err("lost leader must reject writes");
    assert_error(
        &rejected_observe,
        503,
        "coordinator_unavailable",
        "write after leader termination",
    )?;
    let rejected_acquire = after_expiry
        .acquire("after-loss", "fixture-agent", &profiles, 30, None, "any")
        .await
        .expect_err("lost leader must reject reservations");
    assert_error(
        &rejected_acquire,
        503,
        "coordinator_unavailable",
        "reservation after leader termination",
    )?;
    after_expiry.close().await;

    println!("{{\"coordinator\":\"{coordinator_id}\",\"result\":\"ok\"}}");
    Ok(())
}

fn snapshot() -> ProfileSnapshot {
    ProfileSnapshot {
        name: "browser".to_owned(),
        port: 12_345,
        labels: Vec::new(),
        enabled: true,
        purpose: None,
        state: ProfileState::Healthy,
        pid: None,
        leased_by: None,
        last_error: None,
        started_by: None,
    }
}

fn one_winner(
    first: Result<CoordinatorLease, CoordinatorError>,
    second: Result<CoordinatorLease, CoordinatorError>,
) -> Result<CoordinatorLease> {
    match (first, second) {
        (Ok(winner), Err(loser)) | (Err(loser), Ok(winner)) => {
            assert_error(
                &loser,
                503,
                "no_free_profile",
                "contested reservation loser",
            )?;
            Ok(winner)
        }
        (Ok(_), Ok(_)) => bail!("contested reservation issued two leases"),
        (Err(first), Err(second)) => {
            bail!("contested reservation issued no lease: {first}; {second}")
        }
    }
}

fn assert_error(error: &CoordinatorError, status: u16, code: &str, context: &str) -> Result<()> {
    ensure!(
        error.status == status && error.code == code,
        "{context}: expected {status}/{code}, got {}/{}",
        error.status,
        error.code
    );
    Ok(())
}

async fn terminate_leader(database_url: &str, coordinator_id: &str) -> Result<()> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls)
        .await
        .context("connecting fixture terminator")?;
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    let rows = client
        .query(
            "SELECT lock.pid
             FROM pg_locks AS lock
             CROSS JOIN (SELECT hashtextextended('humanchrome-coordinator:' || $1, 0) AS advisory_key) AS expected
             WHERE lock.locktype='advisory' AND lock.granted AND lock.objsubid=1
               AND lock.classid::text::bigint=((expected.advisory_key >> 32) & 4294967295)
               AND lock.objid::text::bigint=(expected.advisory_key & 4294967295)",
            &[&coordinator_id],
        )
        .await
        .context("locating exact coordinator advisory-lock backend")?;
    ensure!(
        rows.len() == 1,
        "expected one exact coordinator advisory-lock backend, found {}",
        rows.len()
    );
    let pid: i32 = rows[0]
        .try_get("pid")
        .context("reading coordinator advisory-lock backend pid")?;
    let terminated: bool = client
        .query_one("SELECT pg_terminate_backend($1) AS terminated", &[&pid])
        .await
        .context("terminating exact coordinator advisory-lock backend")?
        .try_get("terminated")
        .context("reading coordinator backend termination result")?;
    ensure!(
        terminated,
        "PostgreSQL refused to terminate exact coordinator advisory-lock backend"
    );
    drop(client);
    driver.abort();
    Ok(())
}

fn test_database_url() -> Result<String> {
    let database_url =
        env::var("HC_TEST_POSTGRES_URL").context("HC_TEST_POSTGRES_URL is required")?;
    let parsed =
        url::Url::parse(&database_url).context("HC_TEST_POSTGRES_URL must be a PostgreSQL URL")?;
    ensure!(
        matches!(parsed.scheme(), "postgres" | "postgresql"),
        "HC_TEST_POSTGRES_URL must be a PostgreSQL URL"
    );
    let database = parsed.path().trim_start_matches('/');
    let test_name = database.split(['-', '_']).any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "test" | "tests" | "testing"
        )
    });
    ensure!(
        !database.is_empty() && !database.contains('/') && test_name,
        "HC_TEST_POSTGRES_URL must name an explicit disposable test database"
    );
    Ok(database_url)
}
