import {
  relationKey, slug,
  type Anchor, type Diagnostic, type Entity, type EntityKind, type EntityLevel, type Evidence, type EvidenceKind, type IndexSymbol,
  type Provenance, type Relation, type RelationKind, type Sequence, type SourceRange,
} from '../../shared/system/model.js';
import { byString, shortHash } from '../../shared/system/registry-utils.js';
import type { Facts } from './facts.js';

// Collects entities, relations and evidence as the rules find them. Adding the same thing twice merges
// it, so rules can be written independently; every id is derived from content, so the same index always
// gives the same registry.

/** Caps how many evidence items a rolled-up relation carries; the rest are counted in a diagnostic-free attr. */
export const EVIDENCE_CAP = 12;

export interface EntityInput {
  id: string;
  kind: EntityKind;
  name: string;
  level: EntityLevel;
  parent?: string;
  summary?: string;
  anchors?: Anchor[];
  attrs?: Entity['attrs'];
  provenance: Provenance;
  confidence?: number;
  evidence?: string[];
}

export interface RelationInput {
  kind: RelationKind;
  from: string;
  to: string;
  label?: string;
  provenance: Provenance;
  confidence?: number;
  evidence: string[];
  via?: string[];
}

export class Builder {
  readonly entities = new Map<string, Entity>();
  readonly relations = new Map<string, Relation>();
  readonly evidence = new Map<string, Evidence>();
  readonly sequences = new Map<string, Sequence>();
  readonly diagnostics: Diagnostic[] = [];
  /** Which entity stands for an index symbol, most specific first wins (set by the rules). */
  readonly entityForSymbol = new Map<string, string>();

  constructor(readonly facts: Facts) {}

  ev(kind: EvidenceKind, summary: string, at: { range?: SourceRange; symbol?: string; rule?: string } = {}): string {
    const r = at.range;
    const key = [kind, at.symbol ?? '', at.rule ?? '', r ? `${r.file}:${r.start.line}:${r.start.col}:${r.end.line}:${r.end.col}` : '', r ? '' : summary].join('|');
    const id = `ev:${kind}:${shortHash(key)}`;
    if (!this.evidence.has(id)) {
      const fileHash = r ? this.facts.fileHash(r.file) : at.symbol ? this.facts.fileHash(at.symbol.split('#')[0]) : undefined;
      this.evidence.set(id, {
        id, kind, summary, ...(r ? { range: r } : {}), ...(at.symbol ? { symbol: at.symbol } : {}),
        ...(fileHash ? { fileHash } : {}), ...(at.rule ? { rule: at.rule } : {}),
      });
    }
    return id;
  }

  /** Evidence that a named rule decided something. One per rule and subject. */
  rule(rule: string, summary: string, subject = ''): string {
    const id = `ev:rule:${slug(rule)}:${shortHash(rule + '|' + subject)}`;
    if (!this.evidence.has(id)) this.evidence.set(id, { id, kind: 'rule', summary, rule });
    return id;
  }

  /** Evidence that a symbol is defined where it is. */
  def(s: IndexSymbol, summary?: string): string {
    return this.ev('definition', summary ?? `\`${s.name}\` is a ${s.kind} in ${s.file}`, { range: s.range, symbol: s.id });
  }

  anchor(s: IndexSymbol): Anchor { return { file: s.file, symbol: s.id, range: s.range, hash: s.hash }; }

  entity(e: EntityInput): Entity {
    const prev = this.entities.get(e.id);
    if (prev) {
      for (const a of e.anchors ?? []) if (!prev.anchors.some((p) => p.file === a.file && p.symbol === a.symbol)) prev.anchors.push(a);
      for (const ev of e.evidence ?? []) if (!prev.evidence.includes(ev)) prev.evidence.push(ev);
      Object.assign(prev.attrs, Object.fromEntries(Object.entries(e.attrs ?? {}).filter(([k]) => !(k in prev.attrs))));
      if (!prev.summary && e.summary) prev.summary = e.summary;
      if (!prev.parent && e.parent) prev.parent = e.parent;
      return prev;
    }
    const out: Entity = {
      id: e.id, kind: e.kind, name: e.name, level: e.level, anchors: [...(e.anchors ?? [])], attrs: { ...(e.attrs ?? {}) },
      provenance: e.provenance, evidence: [...(e.evidence ?? [])], status: 'current',
      ...(e.parent ? { parent: e.parent } : {}), ...(e.summary ? { summary: e.summary } : {}),
      ...(e.confidence !== undefined ? { confidence: round(e.confidence) } : {}),
    };
    this.entities.set(e.id, out);
    return out;
  }

  relate(r: RelationInput): Relation | undefined {
    if (r.from === r.to || !this.entities.has(r.from) || !this.entities.has(r.to)) return undefined;
    const id = relationKey(r.from, r.kind, r.to);
    const prev = this.relations.get(id);
    if (prev) {
      for (const ev of r.evidence) if (!prev.evidence.includes(ev)) prev.evidence.push(ev);
      for (const v of r.via ?? []) if (!(prev.via ??= []).includes(v)) prev.via.push(v);
      if (r.label && prev.label && prev.label !== r.label && !prev.label.split(', ').includes(r.label)) prev.label = [...prev.label.split(', '), r.label].sort(byString).join(', ');
      else if (r.label && !prev.label) prev.label = r.label;
      if (r.provenance === 'code' && prev.provenance === 'inferred') { prev.provenance = 'code'; delete prev.confidence; }
      else if (prev.confidence !== undefined && r.confidence !== undefined) prev.confidence = round(Math.max(prev.confidence, r.confidence));
      return prev;
    }
    const out: Relation = {
      id, kind: r.kind, from: r.from, to: r.to, provenance: r.provenance, evidence: [...r.evidence], status: 'current',
      ...(r.label ? { label: r.label } : {}), ...(r.confidence !== undefined && r.provenance !== 'code' ? { confidence: round(r.confidence) } : {}),
      ...(r.via?.length ? { via: [...r.via] } : {}),
    };
    this.relations.set(id, out);
    return out;
  }

  contains(parent: string, child: string, evidence: string[], provenance: Provenance = 'inferred', confidence?: number) {
    return this.relate({ kind: 'contains', from: parent, to: child, provenance, evidence, ...(confidence !== undefined ? { confidence } : {}) });
  }

  diag(d: Diagnostic) { this.diagnostics.push(d); }
}

export const round = (n: number) => Math.round(n * 100) / 100;

/** `CanvasSurface` → `Canvas surface`; `ipcTransport` → `IPC transport`; `room_canvases` → `Room canvases`. */
export function humanName(raw: string): string {
  const words = raw
    .replace(/^(create|make|build|new|use)(?=[A-Z])/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./:]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const ACRONYMS = new Set(['ipc', 'api', 'ui', 'sql', 'db', 'http', 'url', 'id', 'ai', 'llm', 'mcp', 'sdk', 'cli', 'tts', 'stt', 'rpc', 'json', 'css', 'html']);
  return words.map((w, i) => {
    const l = w.toLowerCase();
    if (ACRONYMS.has(l)) return l.toUpperCase();
    return i === 0 ? l[0].toUpperCase() + l.slice(1) : l;
  }).join(' ') || raw;
}

export const sortedById = <T extends { id: string }>(xs: Iterable<T>) => [...xs].sort((a, b) => byString(a.id, b.id));
