// IMP-0119: the self-update watcher.
//
// Every build writes build-info.json beside the bundle with the same identity
// it baked into the bundle as __HC_BUILT_AT__ (wxt.config.ts). Every 30s, and
// once on start, this compares the two. A mismatch means the files on disk are
// not the code that is running, and chrome.runtime.reload() fixes that.
//
// Two ways to get there, both handled the same way:
//   - a new build was copied over the install dir while the SW was running;
//   - Chrome started a stored copy of an older SW after a browser restart.
//     Measured on the fleet: a restarted profile kept running the previous
//     build for good, because the old watcher took whatever it found on disk
//     as its baseline and so could never see that it was stale.
//
// One reload per on-disk build. If a reload does not take, reloading again
// every 30s would only cut every in-flight tool call short, so the build it
// was tried for is remembered in chrome.storage.local, which -- unlike
// storage.session -- survives the reload it is guarding.
//
// Safe in prod: the two identities match unless the bundle was rebuilt.
declare const __HC_BUILT_AT__: string;

const ALARM_NAME = 'hc-self-update-check';
const POLL_INTERVAL_MIN = 0.5;
const RELOADED_FOR_KEY = 'hc-self-update-reloaded-for';

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

async function readReloadedFor(): Promise<string | null> {
  try {
    const value = (await chrome.storage.local.get(RELOADED_FOR_KEY))[RELOADED_FOR_KEY];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function checkAndReload(): Promise<void> {
  const info = await fetchOnDiskInfo();
  if (!info?.builtAt || info.builtAt === __HC_BUILT_AT__) return;
  if ((await readReloadedFor()) === info.builtAt) return;
  try {
    await chrome.storage.local.set({ [RELOADED_FOR_KEY]: info.builtAt });
  } catch {
    // Without the guard a failed reload could repeat every 30s; skip it.
    return;
  }
  console.log(
    `[hc-self-update] disk build ${info.builtAt} is not the running ${__HC_BUILT_AT__} — reloading`,
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
