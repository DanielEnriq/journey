import { invalid } from './errors.js';
import { ID_MAX, ID_PATTERN } from './model.js';

// The few checks every untrusted payload goes through, each naming where it failed: `args.component.kind`.

export type Obj = Record<string, unknown>;

export function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid('must be an object', path);
  return v as Obj;
}

/** Refuses fields the contract doesn't name, so a typo is an error rather than silently ignored. */
export function only(o: Obj, keys: readonly string[], path: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw invalid(`unknown field "${k}"`, path);
}

export function str(v: unknown, path: string, max = 500): string {
  if (typeof v !== 'string') throw invalid('must be a string', path);
  const t = v.trim();
  if (!t) throw invalid('must not be empty', path);
  if (t.length > max) throw invalid(`must be at most ${max} characters`, path);
  return t;
}

export const optStr = (v: unknown, path: string, max = 500) => v === undefined ? undefined : str(v, path, max);

export function id(v: unknown, path: string): string {
  if (typeof v !== 'string' || !ID_PATTERN.test(v) || v.length > ID_MAX) {
    throw invalid(`must be a stable id like "payment-worker" (lowercase letters, digits and dashes, at most ${ID_MAX})`, path);
  }
  return v;
}

export const optId = (v: unknown, path: string) => v === undefined ? undefined : id(v, path);

export function oneOf<T extends string>(v: unknown, options: readonly T[], path: string): T {
  if (typeof v !== 'string' || !options.includes(v as T)) throw invalid(`must be one of ${options.join(', ')}`, path);
  return v as T;
}

export function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw invalid(`must be a whole number from ${min} to ${max}`, path);
  return v;
}

export function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw invalid('must be a list', path);
  if (v.length > max) throw invalid(`must have at most ${max} items`, path);
  return v;
}

export function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw invalid('must be true or false', path);
  return v;
}

/** An SVG path of straight segments, as the canvas's pens draw them; nothing else gets into a `d`. */
const PATH = /^M-?\d+(\.\d+)? -?\d+(\.\d+)?( L-?\d+(\.\d+)? -?\d+(\.\d+)?)*( Z)?$/;
export function path(v: unknown, at: string): string {
  if (typeof v !== 'string' || v.length > 40_000 || !PATH.test(v)) throw invalid('must be a path of straight segments: "M1 2 L3 4 …"', at);
  return v;
}

export function strings(v: unknown, at: string, max: number, each = 200): Record<string, string> {
  const o = obj(v, at), out: Record<string, string> = {};
  const keys = Object.keys(o);
  if (keys.length > max) throw invalid(`must have at most ${max} entries`, at);
  for (const k of keys) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) throw invalid('keys must be simple words', `${at}.${k}`);
    out[k] = str(o[k], `${at}.${k}`, each);
  }
  return out;
}

export function table(v: unknown, at: string): string[][] {
  return arr(v, at, 30).map((row, i) => arr(row, `${at}[${i}]`, 8).map((c, j) => {
    if (typeof c !== 'string' || c.length > 80) throw invalid('must be text of at most 80 characters', `${at}[${i}][${j}]`);
    return c;
  }));
}
