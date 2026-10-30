/**
 * DOM Path — index-based addressing of an element within a DOM tree.
 *
 * Used for element tracking, fast recovery when a selector breaks, and
 * structural comparison.
 */

/**
 * An array of child indices from the root to the target element.
 *
 * @example
 * ```
 * [0, 2, 1] means:
 * root
 *  └─ children[0]
 *      └─ children[2]
 *          └─ children[1]  <- target element
 * ```
 */
export type DomPath = number[];

/**
 * Compute the DOM path of an element by walking from the element up to the
 * nearest Document or ShadowRoot, recording each child index along the way.
 */
export function computeDomPath(element: Element): DomPath {
  const path: DomPath = [];
  let current: Element | null = element;

  while (current) {
    const parent: Element | null = current.parentElement;

    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(current);
      if (index >= 0) {
        path.unshift(index);
      }
      current = parent;
      continue;
    }

    // Element with no parentElement may still be a direct child of a
    // ShadowRoot or Document — handle those explicitly.
    const parentNode = current.parentNode;
    if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
      const children = Array.from(parentNode.children);
      const index = children.indexOf(current);
      if (index >= 0) {
        path.unshift(index);
      }
    }

    break;
  }

  return path;
}

/**
 * Locate an element by walking the given DOM path from `root`.
 * Returns null if the path does not resolve.
 */
export function locateByDomPath(root: Document | ShadowRoot, path: DomPath): Element | null {
  if (path.length === 0) {
    return null;
  }

  let current: Element | null = root.children[path[0]] ?? null;

  for (let i = 1; i < path.length && current; i++) {
    const index = path[i];
    current = current.children[index] ?? null;
  }

  return current;
}

