/**
 * SVG icon factories for the Effects control list UI.
 *
 * Extracted from `effects-control.ts` to isolate ~120 LoC of `createElementNS`
 * boilerplate from the main factory.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create a single-path SVG icon with currentColor strokes.
 */
export function createSvgIcon(pathD: string, viewBox = '0 0 24 24'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  return svg;
}

export function createPlusIcon(): SVGElement {
  return createSvgIcon('M12 5v14M5 12h14');
}

export function createTrashIcon(): SVGElement {
  return createSvgIcon('M9 6h6M10 6l.5-1.5h3L14 6M7 6l1 14h8l1-14');
}

export function createAdjustIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const lines = document.createElementNS(SVG_NS, 'path');
  lines.setAttribute('d', 'M4 5H16 M4 10H16 M4 15H16');
  lines.setAttribute('stroke', 'currentColor');
  lines.setAttribute('stroke-width', '2');
  lines.setAttribute('stroke-linecap', 'round');
  lines.setAttribute('stroke-linejoin', 'round');
  svg.append(lines);

  const knobs: ReadonlyArray<readonly [number, number]> = [
    [7, 5],
    [13, 10],
    [9, 15],
  ];

  for (const [cx, cy] of knobs) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '1.6');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2');
    svg.append(circle);
  }

  return svg;
}

export function createEyeIcon(enabled: boolean): SVGElement {
  if (enabled) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const outline = document.createElementNS(SVG_NS, 'path');
    outline.setAttribute('d', 'M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z');
    outline.setAttribute('stroke', 'currentColor');
    outline.setAttribute('stroke-width', '2');
    outline.setAttribute('stroke-linecap', 'round');
    outline.setAttribute('stroke-linejoin', 'round');

    const iris = document.createElementNS(SVG_NS, 'circle');
    iris.setAttribute('cx', '12');
    iris.setAttribute('cy', '12');
    iris.setAttribute('r', '3');
    iris.setAttribute('stroke', 'currentColor');
    iris.setAttribute('stroke-width', '2');

    svg.append(outline, iris);
    return svg;
  }

  return createSvgIcon(
    'M3 3l18 18M10.6 10.6A3 3 0 0012 15a3 3 0 002.4-4.4M9.5 5.8A10.7 10.7 0 0112 5c6 0 9.5 7 9.5 7a17.4 17.4 0 01-3.1 4.1M6.2 6.2A17.8 17.8 0 002.5 12s3.5 7 9.5 7c1 0 1.9-.2 2.8-.5',
  );
}

export function createIconButton(ariaLabel: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'we-effects-icon-btn';
  btn.setAttribute('aria-label', ariaLabel);
  return btn;
}
