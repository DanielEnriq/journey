import { h } from '../../vendor/preact.js';
import { outlineFor } from '../../../shared/system/render/index.js';
import type { Provenance } from '../../../shared/system/model.js';
import type {
  Part, Point, SceneEdge, SceneGroup, SceneNode, SceneOverflow, ScenePortal, SceneSequence, SceneStub, SceneZone, SystemScene, Terminal,
} from '../../../shared/system/render/index.js';

// Drawing a scene: every shape comes from the scene (outlines, parts, routes); this file only decides
// strokes, type and how much to say at the current zoom. At "far" a component is its silhouette — the
// outline and the shapes of its parts — with its name held at a readable size; "near" adds the labels of
// its parts, its ports and the words on its relations.

export type Lod = 'far' | 'mid' | 'near';

export interface DrawOpts {
  lod: Lod;
  z: number;
  selected: string | null;
  /** Ids related to the selection: drawn at full strength while others recede a little. */
  related: Set<string>;
  hover: string | null;
  expanded: Set<string>;
  /** The step being shown, if a sequence plays. */
  step: number | null;
}

/** Screen-constant size in stage units: `px` on screen at zoom z. */
const sc = (px: number, z: number) => px / z;

export function roundedPath(pts: Point[], r = 8): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const la = Math.hypot(p.x - a.x, p.y - a.y), lb = Math.hypot(b.x - p.x, b.y - p.y);
    const rr = Math.min(r, la / 2, lb / 2);
    const p1 = { x: p.x - ((p.x - a.x) / (la || 1)) * rr, y: p.y - ((p.y - a.y) / (la || 1)) * rr };
    const p2 = { x: p.x + ((b.x - p.x) / (lb || 1)) * rr, y: p.y + ((b.y - p.y) / (lb || 1)) * rr };
    d += ` L${p1.x} ${p1.y} Q${p.x} ${p.y} ${p2.x} ${p2.y}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l.x} ${l.y}`;
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);

/* ---------- marks: provenance and status, by shape and word, never colour alone ---------- */

export function ProvMark({ p, x, y, s = 7 }: { p: Provenance; x: number; y: number; s?: number }) {
  const r = s / 2;
  switch (p) {
    case 'code': return <rect class="pm pm-code" x={x} y={y - r} width={s} height={s} rx={1} />;
    case 'inferred': return <g class="pm pm-inferred"><circle cx={x + r} cy={y} r={r} class="pm-ring" /><path d={`M${x + r} ${y - r} A${r} ${r} 0 0 0 ${x + r} ${y + r} Z`} /></g>;
    case 'interpretation': return <path class="pm pm-interp" d={`M${x + r} ${y - r - 0.5} L${x + s + 0.5} ${y} L${x + r} ${y + r + 0.5} L${x - 0.5} ${y} Z`} />;
    case 'proposed': return <circle class="pm pm-proposed" cx={x + r} cy={y} r={r} />;
    case 'observed': return <circle class="pm pm-observed" cx={x + r} cy={y} r={r} />;
  }
}

const STATUS_WORD: Record<string, string> = { changed: 'Δ changed', stale: 'stale', missing: 'missing', new: 'new', unknown: '? not fully indexed' };
const PROV_WORD: Record<Provenance, string> = { code: 'code', inferred: 'inferred', interpretation: 'interpretation', proposed: 'proposed', observed: 'observed' };

/* ---------- zones, groups ---------- */

export function Zones({ zones, flow, z }: { zones: SceneZone[]; flow: 'right' | 'down'; z: number }) {
  return (
    <g class="zones" aria-hidden="true">
      {zones.map((zo, i) => (
        <g key={zo.id} class={`zone zone-${i % 2 ? 'b' : 'a'}`}>
          <rect x={zo.rect.x} y={zo.rect.y} width={zo.rect.w} height={zo.rect.h} class="zone-band" />
          {/* A runtime boundary is a wall: two hairlines. */}
          {zo.orient === 'row'
            ? <path class="zone-wall" d={`M${zo.rect.x} ${zo.rect.y} H${zo.rect.x + zo.rect.w} M${zo.rect.x} ${zo.rect.y + sc(3, z)} H${zo.rect.x + zo.rect.w}`} />
            : <path class="zone-wall" d={`M${zo.rect.x} ${zo.rect.y} V${zo.rect.y + zo.rect.h} M${zo.rect.x + sc(3, z)} ${zo.rect.y} V${zo.rect.y + zo.rect.h}`} />}
          <ZoneLabel zo={zo} z={z} />
        </g>
      ))}
    </g>
  );
}

/** A zone's name, wrapped to its gutter (rows) or across its top (a side column). */
function ZoneLabel({ zo, z }: { zo: SceneZone; z: number }) {
  const fs = Math.min(sc(10.5, z), 22);
  const words = zo.label.toUpperCase().split(' ');
  const width = zo.orient === 'row' ? 190 : zo.rect.w - 28;
  const lines: string[] = [];
  for (const w of words) {
    const l = lines[lines.length - 1];
    if (l && (l + ' ' + w).length * fs * 0.68 < width) lines[lines.length - 1] = l + ' ' + w; else lines.push(w);
  }
  return (
    <text class="zone-label" x={zo.rect.x + 14} y={zo.rect.y + fs * 1.9} style={{ fontSize: `${fs}px` }}>
      {lines.map((l, i) => <tspan key={i} x={zo.rect.x + 14} dy={i ? fs * 1.3 : 0}>{l}</tspan>)}
      {zo.basis === 'file-path' && <tspan class="zone-basis" x={zo.rect.x + 14} dy={fs * 1.5}>from file paths</tspan>}
    </text>
  );
}

export function Groups({ groups, z }: { groups: SceneGroup[]; z: number }) {
  return (
    <g class="groups" aria-hidden="true">
      {groups.map((g) => (
        <g key={g.id} class="group">
          <rect x={g.rect.x} y={g.rect.y} width={g.rect.w} height={g.rect.h} rx={18} />
          <text x={g.rect.x + 14} y={g.rect.y - sc(6, z)} style={{ fontSize: `${sc(10.5, z)}px` }}>{g.name} <tspan class="g-kind">· {g.kind}</tspan></text>
        </g>
      ))}
    </g>
  );
}

/* ---------- nodes ---------- */

export interface NodeHandlers {
  select(id: string, e?: MouseEvent): void;
  enter(id: string): void;
  down(id: string, e: PointerEvent): void;
  hover(id: string | null): void;
}

export function Node({ n, o, on }: { n: SceneNode; o: DrawOpts; on: NodeHandlers }) {
  const { x, y, w, h: ht } = n.rect;
  const near = o.lod === 'near' || o.expanded.has(n.id);
  const far = o.lod === 'far' && !near;
  const sel = o.selected === n.id;
  const recede = o.selected && !sel && !o.related.has(n.id);
  const cls = ['n', `f-${n.form}`, `p-${n.provenance}`, `s-${n.status}`, `e-${n.emphasis}`, sel && 'sel', recede && 'recede', n.ghost && 'ghost', o.hover === n.id && 'hov', n.affected && 'affected'].filter(Boolean).join(' ');
  const chip = n.head === ht;
  // At far, the name is held at a readable size on screen and fitted to the silhouette's width.
  const nameSize = far ? sc(12.5, o.z) : Math.max(14, sc(11.5, o.z));
  const nameChars = Math.floor((w - 28) / (nameSize * 0.56));
  const kindSize = far ? sc(10, o.z) : Math.max(10, sc(9, o.z));
  const statusWord = STATUS_WORD[n.status];
  return (
    <g
      class={cls} transform={`translate(${x} ${y})`} data-id={n.id}
      onPointerDown={(e: PointerEvent) => on.down(n.id, e)}
      onClick={(e: MouseEvent) => { e.stopPropagation(); on.select(n.id, e); }}
      onDblClick={(e: MouseEvent) => { e.stopPropagation(); if (n.enterable) on.enter(n.id); }}
      onPointerEnter={() => on.hover(n.id)} onPointerLeave={() => on.hover(null)}
    >
      <title>{`${n.name} — ${n.kindLabel}${n.summary ? `: ${n.summary}` : ''} (${PROV_WORD[n.provenance]}${statusWord ? `, ${statusWord}` : ''})`}</title>
      {(n.status === 'changed' || n.status === 'new') && <path class="halo" d={n.outline} />}
      <path class="n-body" d={n.outline} />
      {n.status === 'stale' || n.status === 'unknown' ? <path class="n-hatch" d={n.outline} /> : null}
      {n.form === 'interface' && <g class="win-dots">{[0, 1, 2].map((i) => <circle key={i} cx={w - 16 - i * 11} cy={15} r={3} />)}</g>}
      {n.form === 'external' && <path class="n-inner" d={outlineFor('external', w - 10, ht - 10)} transform="translate(5 5)" />}
      {n.parts.map((p) => <PartShape key={p.key} p={p} near={near} z={o.z} sel={o.selected} on={on} />)}
      {/* The head: name, then what it is and how we know. */}
      {!far
        ? <text class="n-name" x={14} y={chip ? 24 : 22} style={{ fontSize: `${nameSize}px` }}>{trunc(n.name, nameChars)}</text>
        : <FarName name={n.name} size={nameSize} w={w} />}
      {!far && (
        <g class="n-kind" style={{ fontSize: `${kindSize}px` }}>
          <ProvMark p={n.provenance} x={14} y={(chip ? 24 : 22) + kindSize * 1.35 - kindSize * 0.35} s={kindSize * 0.7} />
          <text x={14 + kindSize * 1.1} y={(chip ? 24 : 22) + kindSize * 1.35}>
            {n.kindLabel}{n.form === 'unknown' && n.kindLabel !== 'unknown' && !n.ghost ? ' (no form of its own)' : ''}
            {n.provenance !== 'code' ? ` · ${PROV_WORD[n.provenance]}` : ''}
            {n.provenance === 'inferred' && n.confidence !== undefined ? ` ${Math.round(n.confidence * 100)}%` : ''}
          </text>
        </g>
      )}
      {statusWord && n.status !== 'current' && (
        <g class={`n-status st-${n.status}`} transform={`translate(${w - 8} ${-sc(10, o.z)})`}>
          <rect x={-(statusWord.length * kindSize * 0.62 + 12)} y={-kindSize} width={statusWord.length * kindSize * 0.62 + 12} height={kindSize * 1.7} rx={kindSize * 0.85} />
          <text x={-6} y={kindSize * 0.25} text-anchor="end" style={{ fontSize: `${kindSize}px` }}>{statusWord}</text>
        </g>
      )}
      {n.affected && <text class="n-affected" x={w - 10} y={ht - 10} text-anchor="end" style={{ fontSize: `${kindSize}px` }}>touched by the change</text>}
      {n.enterable && near && !chip && (
        <g class="n-enter" transform={`translate(${w - 12} ${ht - 12})`} onClick={(e: MouseEvent) => { e.stopPropagation(); on.enter(n.id); }}>
          <title>{`Enter ${n.name} (${n.childCount} parts) — Enter`}</title>
          <rect x={-74} y={-17} width={74} height={20} rx={10} />
          <text x={-37} y={-3} text-anchor="middle">enter · {n.childCount}</text>
        </g>
      )}
      {n.placed === 'pinned' && near && <path class="n-pin" d={`M${w - 6} 6 l-6 0 l3 -5 z`} />}
      {sel && <path class="n-sel" d={n.outline} />}
    </g>
  );
}

/** At a distance the name is the landmark: held at a readable size above the silhouette, wrapped onto two lines, never cut. */
function FarName({ name, size, w }: { name: string; size: number; w: number }) {
  const per = Math.max(6, Math.floor((w - 20) / (size * 0.55)));
  const words = name.split(' ');
  const lines: string[] = [];
  for (const word of words) {
    const l = lines[lines.length - 1];
    if (l !== undefined && (l + ' ' + word).length <= per) lines[lines.length - 1] = l + ' ' + word;
    else lines.push(word);
  }
  const shown = lines.length > 2 ? [lines[0], lines.slice(1).join(' ')] : lines;
  const y = -size * 0.45 - (shown.length - 1) * size * 1.08;
  return (
    <text class="n-name far" x={2} y={y} style={{ fontSize: `${size}px` }}>
      {shown.map((l, i) => <tspan key={i} x={2} dy={i ? size * 1.08 : 0}>{l}</tspan>)}
    </text>
  );
}

function PartShape({ p, near, z, sel, on }: { p: Part; near: boolean; z: number; sel: string | null; on: NodeHandlers }) {
  const r = p.rect;
  const isSel = !!p.entity && sel === p.entity;
  const click = p.entity ? (e: MouseEvent) => { e.stopPropagation(); on.select(p.entity!, e); } : undefined;
  if (p.role.startsWith('compartment:')) {
    const role = p.role.slice(12);
    return (
      <g class={`pt-comp c-${role}`}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={5} />
        {near && <text class="pt-comp-label" x={r.x + 6} y={r.y + 12}>{p.label}</text>}
      </g>
    );
  }
  switch (p.role) {
    case 'slot':
      return <rect class="pt-slot" x={r.x} y={r.y} width={r.w} height={r.h} rx={3}><title>An empty place where work waits — structure only. A recorded trace would fill it.</title></rect>;
    case 'plug':
      return <g class="pt-plug"><rect x={r.x} y={r.y} width={r.w} height={r.h} rx={2} /><path d={`M${r.x + r.w} ${r.y + 7} h5 M${r.x + r.w} ${r.y + r.h - 7} h5`} /></g>;
    case 'boundary':
      return <rect class="pt-wall" x={r.x} y={r.y + 4} width={r.w} height={r.h - 8} rx={2} />;
    case 'more':
      return near ? <text class="pt-more" x={r.x + 4} y={r.y + 11}>{p.label}</text> : null;
    case 'bus':
      // An event bus: the line events travel along, with taps where publishers and subscribers attach.
      return (
        <g class="pt-bus">
          <path d={`M${r.x} ${r.y + r.h / 2} H${r.x + r.w}`} />
          {[0.2, 0.4, 0.6, 0.8].map((t) => <circle key={t} cx={r.x + r.w * t} cy={r.y + r.h / 2} r={3.2} />)}
          {near && p.label && <text x={r.x} y={r.y - 6}>{p.label}</text>}
        </g>
      );
    case 'signature':
      return near ? <text class="pt-sig" x={r.x} y={r.y + 10}>{trunc(p.label ?? '', Math.floor(r.w / 6.2))}</text> : null;
    default: {
      const table = p.role === 'table';
      const pin = p.role === 'endpoint';
      const ticket = p.role === 'command';
      const chars = Math.floor((r.w - (table ? 18 : pin ? 16 : 10)) / 6.4);
      const tk = 5;
      // Commands are tickets (notched), endpoints are sockets on the service's wall, tables are drawers.
      const shape = ticket
        ? <path d={`M${r.x} ${r.y} H${r.x + r.w} V${r.y + r.h / 2 - tk} A${tk} ${tk} 0 0 0 ${r.x + r.w} ${r.y + r.h / 2 + tk} V${r.y + r.h} H${r.x} V${r.y + r.h / 2 + tk} A${tk} ${tk} 0 0 0 ${r.x} ${r.y + r.h / 2 - tk} Z`} />
        : <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={table ? 2 : pin ? 9 : 4} />;
      return (
        <g class={`pt-chip pt-${p.role} ${table ? 'pt-table' : ''} ${p.provenance && p.provenance !== 'code' ? `p-${p.provenance}` : ''} ${p.status && p.status !== 'current' ? `s-${p.status}` : ''} ${isSel ? 'sel' : ''}`} onClick={click} data-part={p.entity}>
          <title>{`${p.label ?? ''}${p.detail ? ` — ${p.detail}` : ''}${p.note ? `\n${p.note}` : ''}`}</title>
          {shape}
          {table && <path class="pt-handle" d={`M${r.x + 6} ${r.y + r.h / 2 - 3} v6`} />}
          {pin && <g class="pt-socket"><path d={`M${r.x - 4} ${r.y + r.h / 2} H${r.x + 4}`} /><circle cx={r.x + 9} cy={r.y + r.h / 2} r={3.4} /></g>}
          {near
            ? <text x={r.x + (table ? 14 : pin ? 17 : 6)} y={r.y + r.h / 2 + 3.6}>{trunc(p.label ?? '', chars)}</text>
            : <rect class="pt-ghostline" x={r.x + 6} y={r.y + r.h / 2 - 1.5} width={Math.min(r.w - 12, (p.label?.length ?? 6) * 5)} height={3} rx={1.5} />}
          {near && p.status && p.status !== 'current' && <text class="pt-st" x={r.x + r.w - 4} y={r.y + r.h / 2 + 3.4} text-anchor="end">{p.status === 'changed' ? 'Δ' : p.status === 'new' ? 'new' : p.status === 'missing' ? '×' : p.status === 'stale' ? '~' : '?'}</text>}
          {z > 1.4 && p.note && <text class="pt-note" x={r.x + 6} y={r.y + r.h + 9}>{trunc(p.note, Math.floor(r.w / 5))}</text>}
        </g>
      );
    }
  }
}

/* ---------- relations ---------- */

function angle(a: Point, b: Point) { return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI; }

export function TerminalMark({ t, at, deg }: { t: Terminal; at: Point; deg: number }) {
  if (t === 'none') return null;
  const shape = (() => {
    switch (t) {
      case 'arrow': return <path class="t-fill" d="M0 0 L-10 -4.6 L-10 4.6 Z" />;
      case 'open-arrow': return <path class="t-line" d="M-9 -5 L0 0 L-9 5" />;
      case 'bracket': return <path class="t-line t-heavy" d="M-9 -7 H-1 V7 H-9" />;
      case 'tap': return <path class="t-line" d="M0 -6 A6 6 0 0 0 0 6" />;
      case 'ring': return <circle class="t-hollow" cx={-5} cy={0} r={4.2} />;
      case 'bar': return <path class="t-line" d="M0 -6 V6" />;
      case 'triangle': return <path class="t-hollow" d="M0 0 L-11 -6.5 L-11 6.5 Z" />;
      case 'tick': return <path class="t-line" d="M-12 -1 L-8 4 L-1 -6" />;
      case 'diamond': return <path class="t-fill" d="M0 0 L-6 -4.5 L-12 0 L-6 4.5 Z" />;
      case 'chevron': return <path class="t-line" d="M-7 -5 L-2 0 L-7 5 M-12 -5 L-7 0 L-12 5" />;
      case 'socket': return <g><circle class="t-hollow" cx={-6} cy={0} r={5.5} /><circle class="t-fill" cx={-6} cy={0} r={2} /></g>;
    }
  })();
  return <g transform={`translate(${at.x} ${at.y}) rotate(${deg})`}>{shape}</g>;
}

export function Edge({ e, o, onSelect, onHover }: { e: SceneEdge; o: DrawOpts; onSelect(id: string): void; onHover(id: string | null): void }) {
  const d = roundedPath(e.points, 10);
  const g = e.grammar;
  const sel = o.selected === e.id;
  const recede = o.selected && !sel && !o.related.has(e.id);
  const n = e.points.length;
  const cls = ['edge', `l-${g.line}`, `k-${e.kind}`, `p-${e.provenance}`, `s-${e.status}`, `e-${e.emphasis}`, sel && 'sel', recede && 'recede', o.hover === e.id && 'hov', e.back && 'back'].filter(Boolean).join(' ');
  const showLabel = (o.lod !== 'far' || sel || o.hover === e.id) && (e.label || e.count > 1);
  const lbl = `${e.label ?? ''}${e.count > 1 ? `${e.label ? ' · ' : ''}${e.count} relations` : ''}`;
  const fs = Math.max(10.5, sc(9.5, o.z));
  return (
    <g class={cls} data-id={e.id} onClick={(ev: MouseEvent) => { ev.stopPropagation(); onSelect(e.id); }} onPointerEnter={() => onHover(e.id)} onPointerLeave={() => onHover(null)}>
      <title>{`${g.says}${e.label ? ` · ${e.label}` : ''}${e.count > 1 ? ` · rolled up from ${e.count} relations` : ''} (${PROV_WORD[e.provenance]})`}</title>
      <path class="e-hit" d={d} />
      {g.line === 'double' && <path class="e-double-under" d={d} />}
      <path class="e-line" d={d} />
      {g.line === 'double' && <path class="e-double-gap" d={d} />}
      <TerminalMark t={g.end} at={e.points[n - 1]} deg={angle(e.points[n - 2], e.points[n - 1])} />
      <TerminalMark t={g.start} at={e.points[0]} deg={angle(e.points[1], e.points[0])} />
      {e.crossings.map((c, i) => {
        // The gate where a relation leaves one runtime for another.
        const seg = e.points.findIndex((p, k) => k < n - 1 && between(c.at, p, e.points[k + 1]));
        const deg = seg >= 0 ? angle(e.points[seg], e.points[seg + 1]) : 0;
        return <g key={i} class="e-gate" transform={`translate(${c.at.x} ${c.at.y}) rotate(${deg})`}><path d="M-3 -7 V7 M3 -7 V7" /></g>;
      })}
      {e.provenance === 'inferred' && e.labelAt && !showLabel && o.lod !== 'far' && (
        // Inferred: a small ≈ seal on the line (the legend and inspector say which rule).
        <g class="e-inferred" transform={`translate(${e.labelAt.x} ${e.labelAt.y})`}><circle r={Math.max(7, sc(6, o.z))} /><text y={Math.max(7, sc(6, o.z)) * 0.45} text-anchor="middle" style={{ fontSize: `${Math.max(11, sc(10, o.z))}px` }}>≈</text></g>
      )}
      {e.provenance === 'inferred' && showLabel && e.labelAt && <text class="e-inferred-w" x={e.labelAt.x} y={e.labelAt.y + fs * 1.7} text-anchor="middle" style={{ fontSize: `${fs * 0.9}px` }}>≈ inferred</text>}
      {showLabel && e.labelAt && (
        <g class="e-label" transform={`translate(${e.labelAt.x} ${e.labelAt.y})`}>
          <rect x={-(lbl.length * fs * 0.31) - 6} y={-fs * 0.85} width={lbl.length * fs * 0.62 + 12} height={fs * 1.6} rx={fs * 0.4} />
          <text text-anchor="middle" y={fs * 0.33} style={{ fontSize: `${fs}px` }}>{lbl}</text>
        </g>
      )}
    </g>
  );
}

function between(p: Point, a: Point, b: Point) {
  const eps = 0.6;
  return p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps && p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps;
}

export function Stub({ s, o, onSelect }: { s: SceneStub; o: DrawOpts; onSelect(id: string): void }) {
  if (o.lod === 'far' && o.selected !== s.node) return null;
  const fs = Math.max(10.5, sc(9.5, o.z));
  const word = s.reason === 'not-indexed' ? `${s.count} not indexed` : `${s.count} outside the view`;
  const end = s.direction === 'out' ? s.points[1] : s.points[0];
  const left = s.direction === 'in';
  return (
    <g class={`stub r-${s.reason}`} onClick={(e: MouseEvent) => { e.stopPropagation(); onSelect(s.id); }}>
      <title>{`${word}: ${s.kinds.join(', ')} — ${s.others.slice(0, 6).join(', ')}${s.others.length > 6 ? '…' : ''}`}</title>
      <path d={`M${s.points[0].x} ${s.points[0].y} L${s.points[1].x} ${s.points[1].y}`} />
      {s.reason === 'not-indexed' && <path class="stub-break" d={`M${end.x} ${end.y - 6} l4 3 l-4 3 l4 3`} />}
      {(o.lod !== 'far' || o.selected === s.node) && (
        <text x={end.x + (left ? -6 : 6)} y={end.y + fs * 0.35} text-anchor={left ? 'end' : 'start'} style={{ fontSize: `${fs}px` }}>{word}</text>
      )}
    </g>
  );
}

export function Portal({ p, o, on }: { p: ScenePortal; o: DrawOpts; on: { select(id: string): void; follow(id: string): void } }) {
  const { x, y, w, h: ht } = p.rect;
  const sel = o.selected === p.id;
  const arrow = { left: '←', right: '→', top: '↑', bottom: '↓' }[p.side];
  return (
    <g class={`portal ${sel ? 'sel' : ''}`} transform={`translate(${x} ${y})`} data-id={p.id}
      onClick={(e: MouseEvent) => { e.stopPropagation(); on.select(p.id); }} onDblClick={(e: MouseEvent) => { e.stopPropagation(); on.follow(p.id); }}>
      <title>{`${p.name} (${p.kindLabel}) — outside this component, ${p.side}. ${p.count} relation(s). Double-click to go there.`}</title>
      <path class="portal-body" d={outlineFor(p.form, w, ht)} />
      <text class="portal-name" x={12} y={22}>{arrow} {trunc(p.name, 22)}</text>
      <text class="portal-kind" x={12} y={40}>{p.kindLabel} · outside · {p.count} relation{p.count === 1 ? '' : 's'}</text>
    </g>
  );
}

export function Overflow({ ov, z, onOpen }: { ov: SceneOverflow; z: number; onOpen(o: SceneOverflow): void }) {
  const r = ov.rect;
  return (
    <g class="overflow" onClick={(e: MouseEvent) => { e.stopPropagation(); onOpen(ov); }}>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={r.h / 2} />
      <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 4} text-anchor="middle" style={{ fontSize: `${Math.max(11, sc(10, z))}px` }}>+{ov.hidden.length} more here</text>
    </g>
  );
}

export function Frame({ scene, z, name, kind }: { scene: SystemScene; z: number; name: string; kind: string }) {
  const f = scene.level.frame;
  if (!f) return null;
  const root = scene.level.root!;
  return (
    <g class="frame" transform={`translate(${f.x} ${f.y})`} data-id={root}>
      <path class="frame-body" d={outlineFor(scene.level.form ?? 'module', f.w, f.h)} />
      <text class="frame-name" x={28} y={44} style={{ fontSize: `${Math.max(22, sc(16, z))}px` }}>{name}</text>
      <text class="frame-kind" x={28} y={44 + Math.max(18, sc(14, z))} style={{ fontSize: `${Math.max(11, sc(10, z))}px` }}>{kind} · entered — its parts keep the places they had inside it</text>
    </g>
  );
}

/* ---------- sequences ---------- */

export function SequenceLayer({ seq, o, onSelect }: { seq: SceneSequence; o: DrawOpts; onSelect(stepId: string): void }) {
  const cur = o.step;
  const observed = seq.kind === 'trace';
  const fs = Math.max(11, sc(11, o.z));
  const R = Math.max(10, sc(9, o.z));
  const byId = new Map(seq.steps.map((s) => [s.id, s]));
  return (
    <g class={`seq ${observed ? 'seq-observed' : 'seq-possible'}`}>
      {seq.segments.map((sg, i) => {
        const a = byId.get(sg.from)!, b = byId.get(sg.to)!;
        const travelled = cur !== null && b.index <= cur && a.index < cur + (sg.kind === 'loop' ? 1 : 0) && (sg.kind !== 'loop' || a.index <= cur);
        const d = sg.kind === 'loop' ? roundedPath(sg.points, 16) : curve(sg.points[0], sg.points[1]);
        const mid = sg.kind === 'loop' ? { x: (sg.points[1].x + sg.points[2].x) / 2, y: sg.points[1].y } : { x: (sg.points[0].x + sg.points[1].x) / 2, y: (sg.points[0].y + sg.points[1].y) / 2 };
        return (
          <g key={i} class={`seg seg-${sg.kind} ${travelled ? 'done' : ''} ${cur !== null && a.index === cur - 1 && b.index === cur ? 'now' : ''}`}>
            <path class="seg-under" d={d} />
            <path class="seg-line" d={d} />
            {sg.kind !== 'next' && (o.lod !== 'far' || sg.kind === 'loop') && (
              <text class="seg-guard" x={mid.x} y={mid.y + (sg.kind === 'loop' ? fs * 1.4 : -fs * 0.6)} text-anchor="middle" style={{ fontSize: `${fs * 0.95}px` }}>
                {sg.kind === 'loop' ? '↺ ' : '⑂ '}{sg.guard ?? (sg.kind === 'loop' ? 'repeats' : 'branches')}
              </text>
            )}
          </g>
        );
      })}
      {seq.steps.map((s) => {
        const isCur = cur === s.index;
        const done = cur !== null && s.index < cur;
        const r = isCur ? R * 1.35 : R;
        return (
          <g key={s.id} class={`stn ${isCur ? 'cur' : ''} ${done ? 'done' : ''} ${s.failure ? 'fail' : ''} ${s.on ? '' : 'off'}`} transform={`translate(${s.at.x} ${s.at.y})`}
            onClick={(e: MouseEvent) => { e.stopPropagation(); onSelect(s.id); }} data-step={s.id}>
            <title>{`${s.index + 1}. ${s.label}${s.guard ? ` (if ${s.guard})` : ''}${s.time !== undefined ? ` · at ${s.time} ms (recorded)` : ''}`}</title>
            {isCur && <circle class="stn-halo" r={r * 1.9} />}
            <circle class="stn-dot" r={r} />
            <text class="stn-n" y={r * 0.38} text-anchor="middle" style={{ fontSize: `${r * 1.05}px` }}>{s.index + 1}</text>
            {s.failure && <path class="stn-fail" d={`M${r * 0.9} ${-r * 1.6} l${r * 0.9} ${r * 0.9} m0 ${-r * 0.9} l${-r * 0.9} ${r * 0.9}`} />}
            {isCur && (
              <g class="stn-callout" transform={`translate(${r * 1.6} ${-r * 1.9})`}>
                <rect x={0} y={-fs * 1.1} width={Math.min(60, s.label.length + 4) * fs * 0.6 + 16} height={fs * 1.8} rx={fs * 0.5} />
                <text x={8} y={fs * 0.15} style={{ fontSize: `${fs}px` }}>{trunc(s.label, 60)}</text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

function curve(a: Point, b: Point): string {
  // A soft S between stations, so the path reads as travel rather than another relation.
  const dx = (b.x - a.x) * 0.5;
  return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
}

export function Patterns() {
  return (
    <defs>
      <pattern id="sc-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="7" class="hatch-line" />
      </pattern>
      <pattern id="sc-dots" width="24" height="24" patternUnits="userSpaceOnUse">
        <circle cx="1" cy="1" r="1" class="grid-dot" />
      </pattern>
    </defs>
  );
}

