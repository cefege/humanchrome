// IMP-0119: dev-mode self-update watcher.
//
// The single biggest source of dev friction is "rebuild the extension →
// forget to click reload in chrome://extensions → debug the wrong-code-is-
// running symptom for an hour". This watcher closes the loop by polling a
// tiny build-info.json file inside the extension's own bundle and calling
// chrome.runtime.reload() when its builtAt timestamp changes between
// polls.
//
// How it works
//   1. The extension's postbuild step (scripts/sync-installed.mjs) writes
//      build-info.json into .output/chrome-mv3/ and mirrors it to the
//      install dir, with a fresh ISO timestamp on every build.
//   2. chrome.alarms.create({ periodInMinutes: 0.5 }) fires every 30s,
//      surviving SW idle shutdowns (regular setInterval does NOT).
//   3. On first poll after an extension reload, the SW reads
//      build-info.json's builtAt and stashes it in chrome.storage.session.
//      Subsequent polls compare the current builtAt to the stashed one.
//      Mismatch → call chrome.runtime.reload(), which respawns the SW
//      against the new bundle on disk.
//
// One-time bootstrap: a manual chrome://extensions reload is needed
// exactly once to deploy this code into the running SW. After that,
// `pnpm build:extension` triggers an auto-reload within ~30s. No clicks.
//
// Safe in prod: builtAt only changes when the bundle actually rebuilt,
// so this is a no-op outside a dev loop.

const ALARM_NAME = 'hc-self-update-check';
const POLL_INTERVAL_MIN = 0.5;
const STORAGE_KEY = 'hc-self-update-last-built-at';

interface BuildInfo {
  buildHash?: string;
  builtAt?: string;
}

async function fetchOnDiskInfo(): Promise<BuildInfo | null> {
  try {
    const url = chrome.runtime.getURL('build-info.json') + '?cb=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as BuildInfo;
  } catch {
    return null;
  }
}

async function readStoredBuiltAt(): Promise<string | null> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const val = result[STORAGE_KEY];
    return typeof val === 'string' ? val : null;
  } catch {
    return null;
  }
}

async function writeStoredBuiltAt(value: string): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: value });
  } catch {
    /* session storage transient — fine */
  }
}

async function checkAndReload(): Promise<void> {
  const info = await fetchOnDiskInfo();
  if (!info?.builtAt) return;
  const lastSeen = await readStoredBuiltAt();
  if (lastSeen === null) {
    // First poll after this SW spawned — adopt current builtAt as baseline.
    await writeStoredBuiltAt(info.builtAt);
    return;
  }
  if (info.builtAt === lastSeen) return;
  console.log(
    `[hc-self-update] disk builtAt=${info.builtAt} differs from baseline ${lastSeen} — reloading`,
  );
  // setTimeout(0) lets the current event loop unwind so any in-flight
  // message responses flush before the SW dies.
  setTimeout(() => chrome.runtime.reload(), 0);
}

export function initSelfUpdateWatcher(): void {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void checkAndReload();
  });
  // Fire immediately on startup so a stale SW that just came out of idle
  // catches an in-the-meantime rebuild without waiting up to 30s.
  void checkAndReload();
}
