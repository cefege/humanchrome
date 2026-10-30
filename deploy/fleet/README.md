# Fleet coordinator deployment

This directory deploys the browserless coordinator only. Native Chrome workers
remain in their own GUI sessions and are reached through a Tailscale Operator
egress Service. The coordinator authenticates and routes browser HTTP/MCP
requests without exposing a public endpoint.

## Verified OVH facts (2026-10-28)

Read-only inspection through SSH alias `ovh1` established the following:

- `ovh1-8c32g` is reachable over Tailscale at
  `ovh1-8c32g.tail67850e.ts.net`; SSH user `almalinux` has passwordless sudo.
- It is a single Ready `k3s v1.36.4+k3s1` amd64 control-plane node. `/usr/local/bin/k3s kubectl` works under sudo; local macOS has neither `kubectl` nor a kubeconfig.
- The node has Docker `29.6.2`, Docker buildx, and `/usr/local/bin/k3s ctr`; its Docker daemon is accessible to `almalinux`. This supports the archive/import image path below.
- `local-path` is the default StorageClass. The database PVC deliberately uses that class and the coordinator is deliberately a single `Recreate` replica.
- Flux runs other applications, but this repository is not currently a Flux source. The manifests are applied explicitly rather than modifying another application's GitOps source.
- At initial inspection there was no Tailscale Kubernetes Operator. The current enrollment is recorded below; the existing Mac and OVH host devices remain user-owned and untagged.
- The OVH host has Node `v22.23.1`, pnpm `10.33.2`, OpenSSL `3.5.5`, and k3s'
  built-in Kustomize. The image build itself uses Node 24 inside Docker.
  Corepack is not installed on the host, which does not affect that image build.
- Helm was absent during inspection. The checksum-verified bootstrap below
  subsequently installed Helm `v4.3.1`. No registry login or usable remote
  image registry was discovered.

No live resource was created or changed during that inspection.

## Current verified private deployment

- Namespace: `humanchrome-fleet`; image:
  `humanchrome-coordinator:20261028-a168ad6e`.
- The coordinator and durable PostgreSQL are running on OVH. The Mac worker
  enrolls only `mac-1:browser`, in a root separate from the existing local fleet.
- Real browser HTTP/MCP control, two-worker isolation on one Mac, stale-lease
  rejection and worker-disconnection handling were exercised. Restarting
  PostgreSQL triggered automatic coordinator recovery; browser state and lease
  identities survived with the same database PVC.
- Tailscale Operator `1.98.4` is enrolled with a scoped OAuth client. Private
  ingress reaches the coordinator; its worker URL now uses
  `fleet-worker.humanchrome-fleet.svc.cluster.local`, not the OVH host's route.
- The private endpoint returned healthy/ready responses, rejected missing
  bearer credentials with HTTP 401, and served real single-tool MCP calls.
  Both proxy StatefulSets were restarted: their state Secret UIDs and tailnet
  device identities stayed unchanged. The browser DOM and workflow lease
  identity also survived, and a subsequent JavaScript-driven browser action
  completed. The smoke tab and lease were released afterward.
- The existing unrestricted tailnet grant was preserved; only the two
  required tag-owner definitions were added. Tailnet access is not restricted
  to admins by this deployment. Application bearer authentication remains
  mandatory.

The `local-path` PVC survives Pod restarts, not loss of the OVH disk. Back up
PostgreSQL and Kubernetes Secrets separately; neither replication nor backup
is provided by these manifests.

## One-time Tailscale prerequisites

Merge the following into the existing policy before installing the operator.
The verified current worker Mac address is `100.88.99.122`; it stays
user-owned and untagged. If the worker is moved to another Mac, change only
the `hosts` value after checking that Mac with `tailscale ip -4`.

```json
{
  "hosts": {
    "humanchrome-mac-worker": "100.88.99.122"
  },
  "tagOwners": {
    "tag:k8s-operator": ["autogroup:admin"],
    "tag:k8s": ["tag:k8s-operator"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["autogroup:admin"],
      "dst": ["tag:k8s:12301"]
    },
    {
      "action": "accept",
      "src": ["tag:k8s"],
      "dst": ["humanchrome-mac-worker:12310"]
    }
  ]
}
```

The first rule is deliberately limited to tailnet admins; replace its source
only with an already-authorized client group. Do not retag the existing Mac or
OVH node: the operator's dedicated proxies alone receive `tag:k8s`. The
coordinator's generated egress Service may still target the worker's MagicDNS
name, but this ACL destination must remain the explicit IP-backed `hosts`
alias, not an arbitrary MagicDNS name.

The narrower rules above do not override an existing allow-all ACL or grant.
The current tailnet retains its original unrestricted grant; tightening that
policy requires a separate review of other tailnet applications.

Create an OAuth client tagged `tag:k8s-operator` with write access to
`Services`, `Devices/Core`, and `Keys/Auth Keys`. Do not use Funnel.

For a replacement OVH node, `install-helm-ovh.sh` installs
[Helm v4.3.1](https://github.com/helm/helm/releases/tag/v4.3.1) after checking
its [published checksum](https://get.helm.sh/helm-v4.3.1-linux-amd64.tar.gz.sha256sum).
Then run the checked-in Operator installer. It prompts for OAuth material
without printing it and stores it in the `tailscale/operator-oauth` Secret:

```sh
cd /path/to/humanchrome
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin \
  KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  ./deploy/fleet/install-tailscale-operator.sh
```

The installer pins chart `1.98.4`, creates the operator's CRDs, and configures
operator proxies with `tag:k8s`. It does not enable the API server proxy,
Funnel, or public ingress.

Tailscale's workload identity federation is supported by the Operator, but is
not a safe substitute on this cluster as currently configured: its OIDC issuer
is `https://kubernetes.default.svc.cluster.local`, while Tailscale requires a
publicly reachable issuer and discovery endpoints. Do not expose the private
Kubernetes API merely to avoid the OAuth Secret; use the OAuth client above
unless that prerequisite is deliberately redesigned and approved.

## Build, configure, and deploy

Run these commands from an exact source checkout on `ovh1`. Do not build an
arm64 Mac image for this amd64 node.
On this OVH node, run Kubernetes-facing scripts with `sudo -n` and an explicit
PATH including `/usr/local/bin`: its k3s kubeconfig is root-readable and sudo's
default PATH omits the installed tools. Do not loosen kubeconfig permissions.
The image builder runs as `almalinux` and uses sudo for the containerd import.

```sh
cd /path/to/humanchrome
image="humanchrome-coordinator:$(git rev-parse --short=12 HEAD)"

# Supply the full MagicDNS FQDN and port selected by `fleet worker init`.
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin ./deploy/fleet/generate-secrets.sh \
  --worker-id mac-1 \
  --worker-fqdn '<worker-full-name.tailnet.ts.net>' \
  --worker-port 12310 \
  --client-id default

# Build locally on OVH and make the exact immutable tag visible to k3s.
./deploy/fleet/build-and-import-ovh.sh --image "$image"

# Applies the coordinator, durable PostgreSQL, and private Tailscale ingress.
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin ./deploy/fleet/deploy.sh --image "$image"
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin ./deploy/fleet/verify.sh
```

### OAuth-blocked staging only

Before the Operator OAuth prerequisite exists, the coordinator and its isolated
PostgreSQL database can still be smoke-tested safely through SSH port-forward.
After generating the Secret and importing the image above, run:

```sh
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin ./deploy/fleet/deploy.sh --image "$image" --without-tailscale
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin ./deploy/fleet/verify.sh --without-tailscale
```

This leaves the Service cluster-internal; it does **not** create a Tailscale
ingress or working egress path, and is not the final private deployment.
For end-to-end staging on this already-connected OVH host, a worker's direct
Tailscale URL can be configured explicitly while testing its existing host
route. This does not validate the Operator egress identity. Before accepting
the final deployment, switch the worker URL to its egress Service, install the
Operator and run verification without `--without-tailscale`.

`generate-secrets.sh` requires two distinct 32+ character bearer tokens: the
native worker token and the coordinator client token. It generates the
PostgreSQL password only on first use; later runs preserve that password while
replacing the coordinator configuration. The resulting `coordinator.json`
registers the worker at
`http://fleet-worker.humanchrome-fleet.svc.cluster.local:12310`; the generated
ExternalName Service is a Tailscale egress proxy to the supplied MagicDNS
worker, so no worker Tailnet IP is embedded in the coordinator configuration.

The first production coordinator enrollment contains only `mac-1`. Its native
worker configuration must explicitly allow only the `browser` profile. Do not
add any temporary second-worker smoke-test identity to
`fleet-coordinator-config`; remove that worker locally before the production
Secret is generated.

The native worker can use an explicitly approved empty seed source. Its default
daily-profile seed remains subject to the worker's Google/cookie gate; a failed
gate is an error, never a silent fallback to an empty profile.

The initial Mac worker keeps its own dedicated `HC_FLEET_ROOT`; it does not
share the existing standalone fleet root. Worker inventory is static in the
coordinator Secret: to add or replace a worker, update `coordinator.json` in
`fleet-coordinator-config` with the complete intended `workers` array, then
roll the coordinator Deployment. `deploy.sh` performs that rollout after every
apply; for a Secret-only change, run:

```sh
sudo /usr/local/bin/k3s kubectl -n humanchrome-fleet rollout restart deployment/fleet-coordinator
sudo /usr/local/bin/k3s kubectl -n humanchrome-fleet rollout status deployment/fleet-coordinator --timeout=10m
```

The coordinator never implicitly migrates a lease or replays a browser request.

`build-and-import-ovh.sh` uses Docker only as a local builder, saves an archive,
and imports it into k3s containerd. `imagePullPolicy: IfNotPresent` keeps k3s
from attempting a registry pull. Every deployment must use a new tag.

The coordinator `Service` is `ClusterIP` with `tailscale.com/expose: "true"`.
The Operator creates the private ingress proxy and its persistent state Secret.
There is no LoadBalancer address, Ingress, Funnel annotation, or public
network endpoint in these manifests. Coordinator client keys, worker keys,
database credentials, and `coordinator.json` remain Kubernetes Secret data;
neither deployment script prints them.

## Connect an MCP client

For clients supporting `${ENV}` expansion in MCP configuration:

```json
{
  "mcpServers": {
    "humanchrome-cloud": {
      "type": "http",
      "url": "http://humanchrome-fleet-coordinator.tail67850e.ts.net:12301/v1/pool/research/mcp",
      "headers": {
        "Authorization": "Bearer ${HUMANCHROME_COORDINATOR_TOKEN}",
        "X-Humanchrome-Agent": "research-workflow"
      }
    }
  }
}
```

Set the token through the client's secret/environment configuration, never in
Git. The initial non-admin token is `agentToken` in the private
`~/Library/Application Support/humanchrome-coordinator/ovh-bootstrap.json`.
The Operator OAuth credential is separate: it belongs in
`tailscale/operator-oauth`, not in MCP client configuration.

This checkout's `.mcp.json` uses that environment variable and the private OVH
endpoint. OMP's higher-priority `.omp/mcp.json` resolves the same header through
a command: it uses `HUMANCHROME_COORDINATOR_TOKEN` when set, otherwise reads
`agentToken` from the private bootstrap file above. Neither configuration
contains a literal bearer token. Set `HUMANCHROME_AGENT` to a distinct, stable
workflow name when separate clients need separate assignments.

Existing clients load the changed configuration on their MCP reload or next
session; the configuration was verified with an authenticated MCP handshake
and `tools/list`, including the upgraded MCP client.

This HTTP connection travels inside encrypted Tailscale; it is not publicly
reachable. Each independent workflow needs a distinct, stable agent name.
With the current single browser, only one workflow can hold it at a time.
Use `/v1/fleet/mcp` on the same origin for fleet management; lifecycle actions
require an admin client. Add workers through the coordinator Secret as
described above, without changing the client endpoint.

## Verification and recovery

Coordinator health is intentionally database-dependent: a lost PostgreSQL
singleton connection returns HTTP 503 and requires a coordinator Pod restart
after PostgreSQL is healthy again. A worker being offline does not make the
coordinator health check fail or cause it to restart.

`verify.sh` verifies Postgres and coordinator rollouts, waits for the egress
Service's standalone `TailscaleProxyReady` condition, then finds only the two
operator-namespace proxy StatefulSets labelled as children of
`fleet-coordinator` and `fleet-worker` in this namespace. It verifies each
proxy's `TS_KUBE_SECRET` state Secret and active tailnet identity before
checking `/healthz` and `/readyz` over a temporary cluster-local port-forward.

Uncertain or aborted browser actions are quarantined durably and are never
automatically replayed. An administrator may call
`POST /v1/profiles/<workerId:profile>/recover` only after the profile has no
live lease or active work; release the caller's lease or wait for its TTL first.
Recovery restarts the browser and clears execution uncertainty only after that
known restart, while retaining the worker's fence generation.

To exercise identity recovery after a Tailscale proxy restart, run:

```sh
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin ./deploy/fleet/verify.sh --restart-tailscale-proxies
```

That restart is intentional: it records each selected proxy's
`TS_KUBE_SECRET` object UID and live tailnet identity, rolls only that
StatefulSet, then proves both are unchanged after recovery. It neither reads
nor prints Secret values. Do not delete the operator-created Tailscale state
Secrets or the `fleet-postgres` PVC during a rollout: the former preserves
Tailnet identity and the latter preserves the canonical lease and inventory
database.

The live smoke also exposed a selector-click problem tracked as IMP-0192 in
the [backlog](../../docs/improvement-backlog.md): a successful
`chrome_click_element` response did not invoke a visible button's handler.
JavaScript-driven actions worked. The private routing and restart checks do
not imply that this separate click-tool contract passed.

To inspect application restarts without changing anything:

```sh
sudo /usr/local/bin/k3s kubectl -n humanchrome-fleet get pods
sudo /usr/local/bin/k3s kubectl -n humanchrome-fleet get statefulset,deployment,service
sudo /usr/local/bin/k3s kubectl -n humanchrome-fleet get events --sort-by=.lastTimestamp
```

## Isolated coordinator database smoke test

Do not point coordinator smoke tests at the existing `recomphub/postgres` or
`roost/roost-coordinator-postgres` workloads. A disposable database can be
started on OVH loopback and accessed through an SSH tunnel:

```sh
ssh -L 15432:127.0.0.1:15432 ovh1 \
  'docker run --rm --name humanchrome-coordinator-smoke \
    -e POSTGRES_USER=fleet -e POSTGRES_PASSWORD=fleet -e POSTGRES_DB=fleet \
    -p 127.0.0.1:15432:5432 postgres:17-alpine'
```

Use `postgresql://fleet:fleet@127.0.0.1:15432/fleet` only while that temporary
container is running. It is a separate database, bound to OVH loopback, and is
removed on exit.
