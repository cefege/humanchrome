import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CdpPipe } from './cdp';
import { EXTENSION_ID } from '../scripts/constant';

export const LABEL_FILE = '.hc-label.html';

/**
 * With several browsers on screen at once, nothing distinguishes them: every
 * window is "Google Chrome". A labelled tab gives each one an identity the OS
 * surfaces for free — the macOS window title, Mission Control and the Dock
 * tooltip all show the active tab's title.
 */
export function labelFor(profile: { name: string; purpose?: string }): string {
  return profile.purpose ?? profile.name;
}

/**
 * A purpose is bound fleet-wide, so its colour is derived from the tag rather
 * than from anything local: the same tag is the same colour on every machine,
 * so "the amber one" identifies the same browser everywhere.
 */
export function colourFor(label: string): string {
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
  }
  // Hue 40-320 keeps the muddy yellow-greens out, and the lightness is chosen
  // so the worst case over any tag still takes white text legibly.
  const hue = (hash % 280) + 40;
  return hslToHex(hue, 60, 30);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  const [r, g, b] =
    hue < 60
      ? [chroma, secondary, 0]
      : hue < 120
        ? [secondary, chroma, 0]
        : hue < 180
          ? [0, chroma, secondary]
          : hue < 240
            ? [0, secondary, chroma]
            : hue < 300
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  return `#${[r, g, b]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * `theme-color` is what actually tints the tab strip; the body colour only
 * matters for the moment the tab is opened.
 */
export function labelHtml(label: string, colour: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="theme-color" content="${colour}" />
    <title>${escapeHtml(label)}</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        background: ${colour};
        color: #fff;
        font: 600 42px/1.2 -apple-system, system-ui, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    </style>
  </head>
  <body>${escapeHtml(label)}</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    character === '&'
      ? '&amp;'
      : character === '<'
        ? '&lt;'
        : character === '>'
          ? '&gt;'
          : character === '"'
            ? '&quot;'
            : '&#39;',
  );
}

export function labelUrl(profileDir: string): string {
  return `file://${path.join(profileDir, LABEL_FILE)}`;
}

function isLabelTarget(url: string): boolean {
  return url.includes(LABEL_FILE);
}

/** The tab a label lives in, or null when this browser has none. */
export async function findLabelTarget(
  cdp: CdpPipe,
): Promise<{ targetId: string; url: string } | null> {
  const targets = await cdp.send('Target.getTargets', {});
  const targetInfos =
    (targets.result as { targetInfos?: Array<{ targetId: string; url: string }> })?.targetInfos ??
    [];
  return targetInfos.find((target) => isLabelTarget(target.url)) ?? null;
}

/**
 * Replaces any previous label tab with one carrying the current label, then
 * focuses it so the window title picks it up. Throws when CDP refuses to create
 * the tab; the supervisor treats a labelling failure as cosmetic.
 */
export async function applyWindowLabel(
  cdp: CdpPipe,
  profileDir: string,
  label: string,
): Promise<boolean> {
  const url = labelUrl(profileDir);
  await fs.writeFile(path.join(profileDir, LABEL_FILE), labelHtml(label, colourFor(label)));
  // The replacement is created before the old one is closed. Doing it the other
  // way round means a failed create leaves the browser with no label at all,
  // which is the one outcome worse than a stale label.
  const created = await cdp.send('Target.createTarget', { url });
  if (created.error) {
    throw new Error(`Target.createTarget failed: ${created.error.message ?? 'unknown'}`);
  }
  const targetId = (created.result as { targetId?: string } | undefined)?.targetId;
  if (!targetId) return false;

  const targets = await cdp.send('Target.getTargets', {});
  const stale = (
    (targets.result as { targetInfos?: Array<{ targetId: string; url: string }> })?.targetInfos ??
    []
  ).filter((target) => isLabelTarget(target.url) && target.targetId !== targetId);
  for (const target of stale) {
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
  }
  await cdp.send('Target.activateTarget', { targetId });
  return true;
}

/**
 * The extension re-opens its own welcome page on every launch and focuses it,
 * which would leave every window titled "Welcome to HumanChrome" — the exact
 * confusion this feature exists to remove. A fleet profile is driven, not
 * onboarded, so that tab is closed once the label has been placed.
 */
export async function closeOnboardingTabs(cdp: CdpPipe): Promise<number> {
  const targets = await cdp.send('Target.getTargets', {});
  // Matched by origin and target type, not by path: the extension navigates its
  // onboarding tab around, and a worker or service worker under the same origin
  // is the extension itself and must never be closed.
  const welcome = (
    (
      targets.result as {
        targetInfos?: Array<{ targetId: string; url: string; type: string }>;
      }
    )?.targetInfos ?? []
  ).filter(
    (target) =>
      target.type === 'page' && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`),
  );
  for (const target of welcome) {
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
  }
  return welcome.length;
}
