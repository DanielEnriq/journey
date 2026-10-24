import type { Point, Word } from './types.js';

// Small pure helpers from the prototype: SVG paths for ink, point-in-lasso, and the live line's words.

/** The stage every view is drawn on; the camera fits each view's own drawing inside it. */
export const STAGE_W = 980;
export const STAGE_H = 660;
export const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

export function toD(pts: Point[], close: boolean) {
  if (!pts || pts.length < 2) return '';
  let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
  for (let i = 1; i < pts.length; i++) d += ' L' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
  return close ? d + ' Z' : d;
}

export function inside(pt: Point, poly: Point[]) {
  const [x, y] = pt;
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * A scripted line, word by word. `[the queue|queue]` points at a part while those words are spoken;
 * `{this|provider}` is a chip for something the speaker circled.
 */
export function parse(str: string): Word[] {
  const out: Word[] = [];
  const re = /\[([^\]|]+)\|([^\]]+)\]([^\s[{]*)|\{([^}|]+)\|([^}]+)\}([^\s[{]*)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    if (m[1]) {
      const ws = m[1].split(' '), ref = m[2], tail = m[3];
      ws.forEach((t, i) => out.push({ t, ref, tail: i === ws.length - 1 ? tail : '' }));
    } else if (m[4]) out.push({ t: m[4], chip: true, chipTo: m[5], tail: m[6] });
    else out.push({ t: m[7], tail: '' });
  }
  return out;
}

export function plain(words: Word[]) {
  return words.map((w) => w.t + (w.tail || '')).join(' ');
}

export const upperFirst = (t: string) => t.replace(/^\w/, (c) => c.toUpperCase());
