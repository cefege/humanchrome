/**
 * Element Fingerprint — fuzzy element identity check used to:
 * - Verify a selector matched the element we expected.
 * - Recover an element after HMR.
 * - Avoid "same selector, different element" mismatches.
 */

const FINGERPRINT_TEXT_MAX_LENGTH = 32;
const FINGERPRINT_MAX_CLASSES = 8;
const FINGERPRINT_SEPARATOR = '|';

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

function normalizeText(text: string, maxLength: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Compute a structural fingerprint for a DOM element.
 * Format: `tag|id=xxx|class=a.b.c|text=xxx`.
 *
 * @example
 * ```ts
 * computeFingerprint(buttonElement);
 * // => "button|id=submit-btn|class=btn.primary|text=Submit"
 * ```
 */
export function computeFingerprint(element: Element, options?: FingerprintOptions): string {
  const textMaxLength = options?.textMaxLength ?? FINGERPRINT_TEXT_MAX_LENGTH;
  const maxClasses = options?.maxClasses ?? FINGERPRINT_MAX_CLASSES;

  const parts: string[] = [];

  const tag = element.tagName?.toLowerCase() ?? 'unknown';
  parts.push(tag);

  const id = element.id?.trim();
  if (id) {
    parts.push(`id=${id}`);
  }

  const classes = Array.from(element.classList).slice(0, maxClasses);
  if (classes.length > 0) {
    parts.push(`class=${classes.join('.')}`);
  }

  const text = normalizeText(element.textContent ?? '', textMaxLength);
  if (text) {
    parts.push(`text=${text}`);
  }

  return parts.join(FINGERPRINT_SEPARATOR);
}

/**
 * Parse a fingerprint string back into structured form.
 *
 * @example
 * ```ts
 * parseFingerprint("button|id=submit|class=btn.primary|text=Submit");
 * // => { tag: "button", id: "submit", classes: ["btn", "primary"], text: "Submit", raw: "..." }
 * ```
 */
export function parseFingerprint(fingerprint: string): ElementFingerprint {
  const parts = fingerprint.split(FINGERPRINT_SEPARATOR);
  const result: ElementFingerprint = {
    tag: parts[0] ?? 'unknown',
    raw: fingerprint,
  };

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('id=')) {
      result.id = part.slice(3);
    } else if (part.startsWith('class=')) {
      result.classes = part.slice(6).split('.');
    } else if (part.startsWith('text=')) {
      result.text = part.slice(5);
    }
  }

  return result;
}

/**
 * Verify an element matches a stored fingerprint.
 * Tag must match exactly; id must match when the stored fingerprint has one.
 * Class and text are advisory (used for similarity scoring elsewhere).
 */
export function verifyFingerprint(element: Element, fingerprint: string): boolean {
  const stored = parseFingerprint(fingerprint);
  const currentTag = element.tagName?.toLowerCase() ?? 'unknown';

  if (stored.tag !== currentTag) {
    return false;
  }

  if (stored.id) {
    const currentId = element.id?.trim();
    if (stored.id !== currentId) {
      return false;
    }
  }

  return true;
}

/**
 * Similarity score in 0..1 between two fingerprints. 1 means full match.
 * Returns 0 immediately when tags differ.
 */
export function fingerprintSimilarity(a: string, b: string): number {
  const fpA = parseFingerprint(a);
  const fpB = parseFingerprint(b);

  let score = 0;
  let weights = 0;

  // Tag (weight 0.4): mismatch short-circuits to 0.
  const tagWeight = 0.4;
  weights += tagWeight;
  if (fpA.tag === fpB.tag) {
    score += tagWeight;
  } else {
    return 0;
  }

  // ID (weight 0.3).
  const idWeight = 0.3;
  if (fpA.id || fpB.id) {
    weights += idWeight;
    if (fpA.id === fpB.id) {
      score += idWeight;
    }
  }

  // Classes (weight 0.2) — Jaccard similarity.
  const classWeight = 0.2;
  if ((fpA.classes?.length ?? 0) > 0 || (fpB.classes?.length ?? 0) > 0) {
    weights += classWeight;
    const setA = new Set(fpA.classes ?? []);
    const setB = new Set(fpB.classes ?? []);
    const intersection = [...setA].filter((c) => setB.has(c)).length;
    const union = new Set([...(fpA.classes ?? []), ...(fpB.classes ?? [])]).size;
    if (union > 0) {
      score += classWeight * (intersection / union);
    }
  }

  // Text (weight 0.1) — simple equality / substring check.
  const textWeight = 0.1;
  if (fpA.text || fpB.text) {
    weights += textWeight;
    if (fpA.text && fpB.text) {
      const textA = fpA.text.toLowerCase();
      const textB = fpB.text.toLowerCase();
      if (textA === textB) {
        score += textWeight;
      } else if (textA.includes(textB) || textB.includes(textA)) {
        score += textWeight * 0.5;
      }
    }
  }

  return weights > 0 ? score / weights : 0;
}

/** Threshold-based "same element" check. Default threshold 0.7. */
export function fingerprintMatches(
  a: string,
  b: string,
  threshold = 0.7,
): { match: boolean; score: number } {
  const score = fingerprintSimilarity(a, b);
  return {
    match: score >= threshold,
    score,
  };
}
