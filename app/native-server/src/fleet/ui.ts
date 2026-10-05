/**
 * A read-only status page for the fleet, served by the gateway itself so it is
 * reachable wherever the gateway is — over the tailnet, on the Tailscale
 * address, with no extra process to install.
 *
 * Read-only on purpose. The gateway refuses any request carrying an `Origin`
 * header, and a browser does not send one for a same-origin GET, so a polling
 * page works while a click-to-release button would not. Mutation stays on the
 * CLI and the `fleet_*` MCP tools, which is where an operator can see what they
 * are about to change.
 *
 * No external assets: the page has to work on a machine whose only route out is
 * Tailscale.
 */
export const FLEET_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chrome fleet</title>
<style>
  :root {
    --bg: #10131a; --panel: #171b24; --line: #262c38; --text: #e6e9ef;
    --muted: #8b93a4; --ok: #3ddc97; --warn: #f2c14e; --bad: #ff6b6b; --run: #6fb3ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  header {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
    padding: 18px 22px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  .sub { color: var(--muted); font-size: 12px; }
  .sub.right { margin-left: auto; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
         background: var(--muted); margin-right: 6px; vertical-align: middle; }
  .dot.live { background: var(--ok); }
  .dot.dead { background: var(--bad); }
  .tiles { display: flex; flex-wrap: wrap; gap: 12px; padding: 18px 22px; }
  .tile {
    flex: 1 1 150px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; padding: 12px 14px;
  }
  .tile .n { font-size: 26px; font-weight: 600; line-height: 1.1; }
  .tile .l { color: var(--muted); font-size: 11px; text-transform: uppercase;
             letter-spacing: .08em; margin-top: 2px; }
  main { padding: 0 22px 28px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 18px 0 8px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line);
           font-size: 13px; }
  th { color: var(--muted); font-weight: 600; font-size: 11px;
       text-transform: uppercase; letter-spacing: .06em; }
  tr:last-child td { border-bottom: none; }
  td.name { font-weight: 600; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 99px;
          font-size: 11px; border: 1px solid currentColor; }
  .s-healthy { color: var(--ok); } .s-running, .s-starting { color: var(--run); }
  .s-stopped { color: var(--muted); } .s-backoff { color: var(--warn); }
  .s-unreachable { color: var(--bad); }
  .err { color: var(--bad); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 12px; background: var(--panel);
           border: 1px solid var(--line); border-radius: 8px; }
  footer { color: var(--muted); font-size: 11px; padding: 0 22px 24px; }
</style>
</head>
<body>
<header>
  <h1>Chrome fleet</h1>
  <span class="sub" id="where"></span>
  <span class="sub right"><span class="dot" id="live"></span><span id="when">connecting…</span></span>
</header>

<div class="tiles" id="tiles"></div>

<main>
  <h2>Browsers</h2>
  <div id="profiles"></div>
  <h2>Leases</h2>
  <div id="leases"></div>
</main>

<footer>
  Read-only. Change state with <code>humanchrome-bridge fleet …</code> or the
  <code>fleet_*</code> MCP tools. Refreshing every 3s.
</footer>

<script>
const $ = (id) => document.getElementById(id);
const cell = (text, cls) => {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;            // textContent, never innerHTML: labels and
  return td;                        // error text come from outside this page
};
const pill = (state) => {
  const span = document.createElement('span');
  span.className = 'pill s-' + state;
  span.textContent = state;
  return span;
};
function age(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}
function tile(n, label, colour) {
  const box = document.createElement('div');
  box.className = 'tile';
  const big = document.createElement('div');
  big.className = 'n';
  big.textContent = String(n);
  if (colour) big.style.color = colour;
  const small = document.createElement('div');
  small.className = 'l';
  small.textContent = label;
  box.append(big, small);
  return box;
}
function table(head, rows) {
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'none';
    return empty;
  }
  const t = document.createElement('table');
  const thead = document.createElement('tr');
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.append(th);
  }
  t.append(thead);
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of row) {
      tr.append(value instanceof Node ? value : cell(String(value)));
    }
    t.append(tr);
  }
  return t;
}

async function refresh() {
  try {
    const [profiles, leases] = await Promise.all([
      fetch('/v1/profiles').then((r) => r.json()),
      fetch('/v1/leases').then((r) => r.json()),
    ]);
    const running = profiles.filter((p) => p.pid).length;
    const healthy = profiles.filter((p) => p.state === 'healthy').length;
    const bad = profiles.filter((p) => p.state === 'backoff' || p.state === 'unreachable').length;

    $('tiles').replaceChildren(
      tile(running, 'browsers running'),
      tile(healthy, 'healthy'),
      tile(profiles.length - healthy, 'not healthy', bad ? 'var(--bad)' : undefined),
      tile(leases.length, 'leased'),
    );

    $('profiles').replaceChildren(table(
      ['profile', 'state', 'pid', 'port', 'labels', 'purpose', 'enabled', 'leased by', 'last error'],
      profiles.map((p) => [
        cell(p.name, 'name'),
        pill(p.state),
        cell(p.pid ?? '—'),
        cell(p.port),
        cell(p.labels.join(', ') || '—', p.labels.length ? '' : 'muted'),
        cell(p.purpose ?? '—', p.purpose ? '' : 'muted'),
        cell(p.enabled ? 'yes' : 'no', p.enabled ? '' : 'muted'),
        cell(p.leasedBy ?? '—', p.leasedBy ? '' : 'muted'),
        cell(p.lastError ?? '—', p.lastError ? 'err' : 'muted'),
      ]),
    ));

    $('leases').replaceChildren(table(
      ['agent', 'profile', 'last seen'],
      leases.map((l) => [
        cell(l.agent, 'name'),
        cell(l.profile),
        cell(age(l.lastSeen)),
      ]),
    ));

    $('where').textContent = location.host;
    $('when').textContent = 'updated ' + new Date().toLocaleTimeString();
    $('live').className = 'dot live';
  } catch (error) {
    $('when').textContent = 'gateway unreachable';
    $('live').className = 'dot dead';
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
`;
