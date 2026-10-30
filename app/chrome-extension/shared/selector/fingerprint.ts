/**
 * Element Fingerprint — fuzzy element identity check used to:
 * - Verify a selector matched the element we expected.
 * - Recover an element after HMR.
 * - Avoid "same selector, different element" mismatches.
 */
import { selectorPolicy } from 'humanchrome-shared';

export interface ElementFingerprint {
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  raw: string;
}

export interface FingerprintOptions {
  textMaxLength?: number;
  maxClasses?: number;
}

function fingerprintInput(element: Element): {
  tagName?: string;
  id?: string;
  classes: string[];
  textContent?: string;
} {
  return {
    tagName: element.tagName,
    id: element.id,
    classes: Array.from(element.classList),
    textContent: element.textContent ?? undefined,
  };
}

/** Computes a structural fingerprint from DOM fields gathered once by the host. */
export function computeFingerprint(element: Element, options?: FingerprintOptions): string {
  return selectorPolicy.computeRustFingerprint(fingerprintInput(element), options);
}

/** Parses a raw fingerprint without changing its optional-field presence or `raw` input. */
export function parseFingerprint(fingerprint: string): ElementFingerprint {
  return selectorPolicy.parseRustFingerprint(fingerprint);
}

/** Verifies the tag/id portion of a stored fingerprint against a live DOM element. */
export function verifyFingerprint(element: Element, fingerprint: string): boolean {
  return selectorPolicy.verifyRustFingerprint(element.tagName, element.id, fingerprint);
}

/** Returns the existing weighted structural-fingerprint similarity score. */
export function fingerprintSimilarity(a: string, b: string): number {
  return selectorPolicy.rustFingerprintSimilarity(a, b);
}

/** Applies the existing inclusive fingerprint-match threshold. */
export function fingerprintMatches(
  a: string,
  b: string,
  threshold = 0.7,
): { match: boolean; score: number } {
  return selectorPolicy.rustFingerprintMatches(a, b, threshold);
}
