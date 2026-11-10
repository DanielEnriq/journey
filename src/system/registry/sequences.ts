import { relationKey, slug, type CallFlow, type IndexSymbol, type SequenceStep, type SourceRange } from '../../shared/system/model.js';
import { byString } from '../../shared/system/registry-utils.js';
import type { Builder } from './builder.js';
import { calleeKey, channelKey } from './channels.js';
import type { Discovery } from './components.js';
import { topOf, within } from './facts.js';
import { entityOf, type Internals } from './internals.js';

// Code-derived sequences: what *can* happen, from call flows, resolved references and matched channels.
// The walker is generic: give it an entry symbol and it follows calls, boundaries (to the implementation
// that reaches storage), bridges, channels and SQL until the write. Which entries to walk is chosen from
// registry facts (interactions that produce commands; loops around a save that can return null).

export const SEQUENCE_RULES: Record<string, string> = {
  'sequence.command-path': 'For each command an interaction produces: from the gesture through the calls, boundaries, bridges and channels that reach a SQL write.',
  'sequence.retry-loop': 'A function whose call flow loops around a save that can return null (lost race) and re-reads before trying again.',
  'sequence.walk': 'A step is kept when it leads to a SQL write, or is a validator, an apply function or a command on the way.',
};

type Move =
  | { type: 'call'; target: IndexSymbol; range: SourceRange; ctx: string[]; guard?: string; callee: string }
  | { type: 'bridge'; comp: string; lit: string; range: SourceRange; ctx: string[]; guard?: string; callee: string }
  | { type: 'channel'; lit: string; range: SourceRange; ctx: string[]; guard?: string; callee: string }
  | { type: 'sql'; entity: string; lit: string; write: boolean; range: SourceRange; ctx: string[]; guard?: string; callee: string };

interface Draft extends Omit<SequenceStep, 'id'> {
  key?: string;
  /** The entity whose code made this move, for the relation travelled (defaults to the previous step). */
  from?: string;
}

export function buildSequences(b: Builder, d: Discovery, ins: Internals) {
  const W = new Walker(b, d, ins);
  commandPaths(b, d, ins, W);
  retryLoops(b, d, ins, W);
}

class Walker {
  private memo = new Map<string, boolean>();
  private bridgeFor = new Map<string, { comp: string; lit: string }>();
  readonly F;
  constructor(readonly b: Builder, readonly d: Discovery, readonly ins: Internals) {
    this.F = b.facts;
    for (const c of d.components.values()) if (c.role === 'bridge') for (const lit of (c.claims[0].extra.channels as string[] | undefined) ?? []) {
      const k = channelKey(lit);
      if (k && !this.bridgeFor.has(k)) this.bridgeFor.set(k, { comp: c.id, lit });
    }
  }

  ent(sym: string) { const e = entityOf(this.b, this.d, sym); return e && this.b.entities.has(e) ? e : undefined; }

  /** The calls, channels and SQL a symbol's body makes, in source order. */
  moves(sym: string): Move[] {
    const F = this.F;
    const out: Move[] = [];
    const flow: CallFlow | undefined = F.flows.get(sym);
    const refs = (F.refsFrom.get(sym) ?? []).filter((r) => r.kind === 'call' || r.kind === 'new');
    const lits = F.literalsIn.get(sym) ?? [];
    const steps = flow?.steps ?? refs.map((r) => ({ callee: F.symbols.get(r.to)?.name ?? r.to, calleeSymbol: r.to, range: r.range, ctx: [] as CallFlow['steps'][number]['ctx'], guard: undefined }));
    const used = new Set<string>();
    for (const st of steps) {
      const ctx = [...st.ctx];
      const lit = lits.find((l) => l.range.start.line === st.range.start.line && (st.callee.endsWith(l.method) || l.callee === st.callee));
      if (lit) {
        used.add(`${lit.range.start.line}:${lit.range.start.col}`);
        const m = this.literalMove(lit.literal, lit.method, st.callee, st.range, ctx, st.guard);
        if (m) { out.push(m); continue; }
      }
      const target = this.resolve(sym, st);
      if (target) { out.push({ type: 'call', target, range: st.range, ctx, guard: st.guard, callee: st.callee }); continue; }
      const k = calleeKey(st.callee);
      const hit = k ? this.bridgeFor.get(k) : undefined;
      if (hit) out.push({ type: 'bridge', comp: hit.comp, lit: hit.lit, range: st.range, ctx, guard: st.guard, callee: st.callee });
    }
    for (const l of lits) {
      if (used.has(`${l.range.start.line}:${l.range.start.col}`)) continue;
      const m = this.literalMove(l.literal, l.method, l.callee, l.range, [], undefined);
      if (m) out.push(m);
    }
    return out.sort((a, c) => a.range.start.line - c.range.start.line || a.range.start.col - c.range.start.col);
  }

  private literalMove(lit: string, method: string, callee: string, range: SourceRange, ctx: string[], guard?: string): Move | undefined {
    const sql = this.ins.sqlEntity.get(lit);
    if (sql) return { type: 'sql', entity: sql, lit, write: sql.startsWith('store-function:') || /^(insert|update|upsert|delete)$/.test(method), range, ctx, guard, callee };
    if (this.d.channels.invoked.get(lit)?.some((l) => l.range.start.line === range.start.line && l.file === range.file)) return { type: 'channel', lit, range, ctx, guard, callee };
    return undefined;
  }

  /** The symbol a flow step calls: as the index resolved it, or the reference at the same place. */
  resolve(sym: string, st: { callee: string; calleeSymbol?: string; range: SourceRange }): IndexSymbol | undefined {
    const F = this.F;
    if (st.calleeSymbol && F.symbols.has(st.calleeSymbol)) return F.symbols.get(st.calleeSymbol);
    const last = st.callee.split('.').pop()!.replace(/\(.*$/, '');
    const refs = F.refsWithin(sym).filter((r) => (r.kind === 'call' || r.kind === 'new') && r.range.start.line === st.range.start.line);
    const named = refs.filter((r) => F.symbols.get(r.to)?.name === last);
    const hit = named.find((r) => within(r.range, st.range) || within(st.range, r.range)) ?? named[0];
    return hit ? F.symbols.get(hit.to) : undefined;
  }

  /** Where a call through a boundary really goes: the implementers' matching members (or the implementers). */
  implementations(target: IndexSymbol): IndexSymbol[] {
    const F = this.F;
    const iface = F.containerOf(target);
    const bd = iface ? this.d.boundaries.get(iface) : undefined;
    if (!bd) return [];
    return bd.implementers.map((id) => {
      const impl = F.symbols.get(id)!;
      return F.memberSymbols(id).find((m) => m.name === target.name) ?? impl;
    }).filter((s) => !F.isTest(s.file)).sort((a, c) => byString(a.id, c.id));
  }

  /** True when the symbol's code can lead to a SQL write. */
  reachesWrite(sym: string, depth = 0): boolean {
    const hit = this.memo.get(sym);
    if (hit !== undefined) return hit;
    if (depth > 24) return false;
    this.memo.set(sym, false);
    let ok = false;
    for (const m of this.moves(sym)) {
      if (m.type === 'sql') ok = m.write || this.writesAfter(m.entity).length > 0;
      else if (m.type === 'channel' || m.type === 'bridge') ok = this.handlersOf(m.lit).some((t) => this.reachesWrite(t.id, depth + 1));
      else {
        const impls = this.implementations(m.target);
        ok = impls.length ? impls.some((t) => this.reachesWrite(t.id, depth + 1)) : this.reachesWrite(m.target.id, depth + 1);
      }
      if (ok) break;
    }
    this.memo.set(sym, ok);
    return ok;
  }

  handlersOf(lit: string): IndexSymbol[] { return (this.d.served.get(lit) ?? []).flatMap((e) => e.targets); }

  /** Tables a store function writes, from SQL relations already built. */
  writesAfter(entity: string): string[] {
    return [...this.b.relations.values()].filter((r) => r.kind === 'writes' && r.from === entity).map((r) => r.to).sort(byString);
  }

  notable(t: IndexSymbol): boolean {
    const e = this.ent(t.id);
    const ent = e ? this.b.entities.get(e) : undefined;
    if (!ent || ent.level === 'component') return false;
    return ent.kind === 'validator' || ent.kind === 'command' || (ent.kind === 'function' && ent.attrs.role === 'apply');
  }

  callEv(sym: string, callee: string, range: SourceRange) {
    return this.b.ev('flow', `\`${this.F.symbols.get(sym)?.id.split('#')[1] ?? sym}\` calls \`${callee}\``, { range, symbol: sym });
  }

  /** Follows a symbol's moves to the write. */
  walk(sym: string, out: Draft[], seen: Set<string>, opts: { subject?: string; depth?: number; all?: boolean } = {}): boolean {
    const depth = opts.depth ?? 0;
    if (seen.has(sym) || depth > 16 || out.length > 48) return false;
    seen.add(sym);
    const from = this.ent(sym);
    const push = (dr: Draft) => out.push({ ...(from && dr.from === undefined ? { from } : {}), ...dr });
    for (const m of this.moves(sym)) {
      if (this.wrote(out)) return true;
      if (m.type === 'call') {
        const t = m.target;
        const impls = this.implementations(t);
        if (impls.length) {
          const via = impls.filter((i) => this.reachesWrite(i.id));
          if (!via.length && !opts.all) continue;
          const be = this.ent(t.id);
          if (be) push({ entity: be, label: `${m.callee}(…)`, detail: 'through the boundary', ctx: m.ctx, ...(m.guard ? { guard: m.guard } : {}), evidence: [this.callEv(sym, m.callee, m.range)], key: t.id });
          for (const i of (via.length ? via : impls).slice(0, 1)) {
            const ie = this.ent(i.id);
            if (ie) push({ ...(be ? { from: be } : {}), entity: ie, label: `${i.id.split('#')[1]}`, detail: `implements \`${t.name}\``, ctx: m.ctx, evidence: [this.b.def(i), this.b.rule('sequence.walk', SEQUENCE_RULES['sequence.walk'])], key: i.id });
            this.walk(i.id, out, seen, { ...opts, depth: depth + 1 });
          }
          continue;
        }
        if (this.reachesWrite(t.id)) {
          const te = this.ent(t.id);
          if (te) push({ entity: te, label: `${m.callee}(…)`, ctx: m.ctx, ...(m.guard ? { guard: m.guard } : {}), evidence: [this.callEv(sym, m.callee, m.range), this.b.def(t)], key: t.id });
          this.walk(t.id, out, seen, { ...opts, depth: depth + 1 });
        } else if (this.notable(t)) {
          const te = this.ent(t.id)!;
          push({ entity: te, label: `${m.callee}(…)`, ctx: m.ctx, ...(m.guard ? { guard: m.guard } : {}), evidence: [this.callEv(sym, m.callee, m.range), this.b.def(t)], key: t.id });
          if (opts.subject && this.ins.applyFns.has(t.id)) {
            const cmd = this.ins.commandsOf.get(this.ins.applyFns.get(t.id)!)?.get(opts.subject);
            if (cmd) push({ entity: cmd, from: this.ent(t.id), label: `handler '${opts.subject}'`, detail: 'dispatched by command name', ctx: m.ctx, evidence: [...this.b.entities.get(cmd)!.evidence.slice(0, 2), this.b.rule('role.engine', 'The apply function dispatches through the table by the command\'s name.', t.id)] });
          }
        }
      } else if (m.type === 'bridge' || m.type === 'channel') {
        const handlers = this.handlersOf(m.lit);
        if (!opts.all && !handlers.some((h) => this.reachesWrite(h.id))) continue;
        if (m.type === 'bridge') push({ entity: m.comp, label: `${m.callee}(…)`, detail: `the bridge invokes '${m.lit}'`, ctx: m.ctx, evidence: [this.callEv(sym, m.callee, m.range), this.b.rule('relation.bridge-api', 'A call named like a channel goes through the bridge that invokes it.')] });
        const ep = this.ins.endpointByChannel.get(m.lit);
        const site = this.d.channels.handled.get(m.lit)?.[0];
        if (ep && site) push({ entity: ep, ...(m.type === 'bridge' ? { from: m.comp } : {}), label: `'${m.lit}'`, detail: `handled by \`${site.callee}\``, ctx: [], evidence: [this.b.ev('literal', `\`${site.callee}('${m.lit}', …)\` registers a handler`, { range: site.range, symbol: site.in })] });
        for (const h of handlers.slice(0, 1)) {
          const he = this.ent(h.id);
          if (he) push({ ...(ep ? { from: ep } : {}), entity: he, label: `${h.name}(…)`, detail: `serves '${m.lit}'`, ctx: [], evidence: [this.b.def(h)], key: h.id });
          this.walk(h.id, out, seen, { ...opts, depth: depth + 1 });
        }
      } else if (m.type === 'sql') {
        if (!m.write && !opts.all) continue;
        push({ entity: m.entity, label: `${m.callee}('${m.lit}')`, ctx: m.ctx, ...(m.guard ? { guard: m.guard } : {}), evidence: [this.b.ev('literal', `\`${m.callee}('${m.lit}')\``, { range: m.range, symbol: sym })] });
        for (const t of this.writesAfter(m.entity)) {
          const rel = this.b.relations.get(relationKey(m.entity, 'writes', t))!;
          out.push({ entity: t, from: m.entity, label: `writes ${this.b.entities.get(t)!.name}`, ctx: [], evidence: rel.evidence.slice(0, 3), key: 'write' });
        }
      }
    }
    return this.wrote(out);
  }

  /** The path has reached a write: what comes after (the return trip) is not part of it. */
  wrote(out: Draft[]) { return out.some((d) => d.key === 'write' || (d.entity.startsWith('table:') && /^writes /.test(d.label))); }
}

/** Gives drafts ids and the relation travelled into each. */
function finish(b: Builder, drafts: Draft[], prefix: string): SequenceStep[] {
  return drafts.map((dr, i) => {
    const { key: _k, from: caller, ...step } = dr;
    const from = caller ?? drafts[i - 1]?.entity;
    let relation: string | undefined;
    if (from && from !== dr.entity) {
      for (const kind of ['calls', 'sends', 'handles', 'writes', 'reads', 'produces', 'renders', 'implements']) {
        const fwd = relationKey(from, kind, dr.entity), back = relationKey(dr.entity, kind, from);
        if (b.relations.has(fwd)) { relation = fwd; break; }
        if (kind === 'implements' && b.relations.has(back)) { relation = back; break; }
      }
    }
    const out: SequenceStep = { id: `${prefix}${i + 1}`, ...step, ...(relation ? { relation } : {}) };
    if (!out.ctx?.length) delete out.ctx;
    return out;
  });
}

function commandPaths(b: Builder, d: Discovery, ins: Internals, W: Walker) {
  const F = b.facts;
  const rule = b.rule('sequence.command-path', SEQUENCE_RULES['sequence.command-path']);
  const done = new Set<string>();
  const produced = [...b.relations.values()].filter((r) => r.kind === 'produces' && b.entities.get(r.from)?.kind === 'interaction')
    .sort((a, c) => (Number(b.entities.get(a.from)!.attrs.order ?? 0) - Number(b.entities.get(c.from)!.attrs.order ?? 0)) || byString(a.id, c.id));
  for (const rel of produced) {
    if (done.has(rel.to)) continue;
    const cmd = b.entities.get(rel.to)!;
    const key = String(cmd.attrs.key ?? cmd.name);
    const inter = b.entities.get(rel.from)!;
    const sites = (ins.interactionSites.get(inter.id) ?? []).filter((s) => s.branch);
    const lit = sites.flatMap((cs) => (F.literalsInFile.get(cs.file) ?? []).filter((l) => l.literal === key && within(l.range, cs.branch!)).map((l) => ({ cs, l })))[0];
    if (!lit) continue;
    const surface = W.ent(lit.l.in);
    if (!surface) continue;
    const drafts: Draft[] = [
      { entity: inter.id, label: `${inter.name}: \`${lit.cs.subject} === '${lit.cs.literal}'\``, detail: 'the gesture', evidence: [b.ev('comparison', `\`${lit.cs.subject} === '${lit.cs.literal}'\` guards the branch`, { range: lit.cs.range, symbol: lit.cs.in })] },
      { entity: surface, label: `${lit.l.callee}('${key}', …)`, detail: `in \`${lit.l.in.split('#')[1] ?? lit.l.in}\``, evidence: [b.ev('literal', `\`${lit.l.callee}('${key}', …)\` issues the command`, { range: lit.l.range, symbol: lit.l.in })] },
    ];
    // What the issuing call reaches: as resolved, or the reference with that name from the same symbol.
    const target = (lit.l.calleeSymbol && F.symbols.get(lit.l.calleeSymbol))
      || W.resolve(lit.l.in, { callee: lit.l.callee, range: lit.l.range })
      || F.refsWithin(lit.l.in).map((r) => F.symbols.get(r.to)).find((s) => s?.name === lit.l.method && s.kind === 'method' && W.reachesWrite(s.id));
    const seen = new Set<string>();
    if (target && target.id !== topOf(lit.l.in)) {
      const te = W.ent(target.id);
      if (te && te !== surface) drafts.push({ entity: te, label: `${target.id.split('#')[1]}(…)`, evidence: [b.def(target)], key: target.id });
      W.walk(target.id, drafts, seen, { subject: key });
    }
    if (drafts.length < 3 || !W.wrote(drafts)) continue;
    done.add(rel.to);
    const steps = finish(b, drafts, 's');
    const loops = steps.filter((s) => s.ctx?.includes('loop'));
    const id = `sequence:command-path:${slug(key)}`;
    b.sequences.set(id, {
      id, title: `How '${key}' travels: from the ${inter.name.toLowerCase()} gesture to ${storeName(b, steps[steps.length - 1].entity)}`, kind: 'code-path', subject: cmd.id,
      steps, provenance: 'inferred', evidence: [rule, ...rel.evidence.slice(0, 2)],
      notes: [
        'Derived from code: a possible path, not a recorded run.',
        ...(loops.length ? [`${loops.map((s) => s.label).join(', ')} run${loops.length === 1 ? 's' : ''} inside a loop${loops[0].guard ? ` (\`${loops[0].guard}\`)` : ''}.`] : []),
      ],
    });
  }
}

function retryLoops(b: Builder, d: Discovery, ins: Internals, W: Walker) {
  const F = b.facts;
  const rule = b.rule('sequence.retry-loop', SEQUENCE_RULES['sequence.retry-loop']);
  const cands: { flow: CallFlow; at: number; save: IndexSymbol; score: number }[] = [];
  for (const flow of [...F.index.flows].sort((a, c) => byString(a.symbol, c.symbol))) {
    if (F.isTest(flow.symbol.split('#')[0])) continue;
    flow.steps.forEach((st, i) => {
      if (!st.ctx.includes('loop')) return;
      const t = W.resolve(flow.symbol, st);
      if (!t) return;
      const nullable = [t, ...W.implementations(t)].some((s) => /\bnull\b/.test(F.returnType(s) ?? s.signature ?? ''));
      const rereads = flow.steps.slice(i + 1).some((x) => x.ctx.includes('loop') && !x.ctx.includes('catch'));
      if (!nullable || !rereads) return;
      const writes = W.reachesWrite(t.id) || W.implementations(t).some((s) => W.reachesWrite(s.id));
      if (!writes && !/commit|save|write|put|persist|store/i.test(t.name)) return;
      cands.push({ flow, at: i, save: t, score: (writes ? 2 : 0) + flow.steps.filter((x) => x.ctx.includes('loop')).length });
    });
  }
  cands.sort((a, c) => c.score - a.score || byString(a.flow.symbol, c.flow.symbol));
  const seenFns = new Set<string>();
  for (const cand of cands) {
    if (seenFns.has(cand.flow.symbol)) continue;
    seenFns.add(cand.flow.symbol);
    const fn = F.symbols.get(cand.flow.symbol);
    const home = W.ent(cand.flow.symbol);
    if (!fn || !home) continue;
    const drafts: Draft[] = [];
    let firstLoop = -1, saveEnd = -1, afterSave = -1, lastLoop = -1, afterLoop = -1, saved = -1;
    cand.flow.steps.forEach((st, i) => {
      if (st.ctx.includes('catch')) return;
      const t = W.resolve(cand.flow.symbol, st);
      const e = t ? W.ent(t.id) : undefined;
      // An error built as an argument is part of the call around it, not a step of its own.
      if (!t || !e || (t.kind === 'class' && /Error$/.test(t.name) && cand.flow.steps.slice(i + 1).some((x) => x.range.start.line === st.range.start.line))) return;
      const inLoop = st.ctx.includes('loop');
      if (!inLoop && firstLoop >= 0 && afterLoop < 0) afterLoop = drafts.length;
      if (inLoop && firstLoop < 0) firstLoop = drafts.length;
      if (inLoop && i > cand.at && afterSave < 0 && saved >= 0) afterSave = drafts.length;
      const said = (F.literalsIn.get(cand.flow.symbol) ?? []).filter((l) => l.range.start.line === st.range.start.line && l.literal.length <= 24 && !/\s/.test(l.literal)).map((l) => `${l.callee}('${l.literal}')`);
      drafts.push({ entity: e, from: home, label: `${st.callee}(…)`, ...(said.length ? { detail: said.join(', ') } : {}), ctx: [...st.ctx], ...(st.guard ? { guard: st.guard } : {}), evidence: [W.callEv(cand.flow.symbol, st.callee, st.range)], key: t.id });
      if (i === cand.at) {
        // Where the save really goes, to the write; then the branch the null result takes.
        const impl = W.implementations(t).find((s) => W.reachesWrite(s.id));
        if (impl) {
          const ie = W.ent(impl.id);
          if (ie) drafts.push({ entity: ie, from: e, label: impl.id.split('#')[1], detail: `implements \`${t.name}\``, ctx: [...st.ctx], evidence: [b.def(impl)], key: impl.id });
          const sub: Draft[] = [];
          W.walk(impl.id, sub, new Set([cand.flow.symbol]));
          for (const s of sub) drafts.push({ ...s, ctx: [...st.ctx, ...(s.ctx ?? []).filter((c) => !st.ctx.includes(c as never))] });
        }
        saveEnd = drafts.length - 1;
        const guard = cand.flow.steps.map((x) => x.guard).find((g) => g && /null/.test(g));
        saved = drafts.length;
        drafts.push({
          entity: home, from: home, label: `saved: returns the new revision`, detail: `when \`${t.name}\` returns a value (not null)`, ctx: [...st.ctx.filter((c) => c !== 'await'), 'branch'],
          ...(guard ? { guard } : {}), evidence: [rule, W.callEv(cand.flow.symbol, st.callee, st.range)],
        });
      }
      if (inLoop) lastLoop = drafts.length - 1;
    });
    if (saveEnd < 0 || firstLoop < 0 || lastLoop < 0) continue;
    if (afterLoop < 0 && drafts.length > lastLoop + 1) afterLoop = lastLoop + 1;
    const loopGuard = cand.flow.steps.find((x) => x.ctx.includes('loop') && x.guard)?.guard;
    const limit = loopGuard ? constantIn(b, loopGuard, fn.file) : undefined;
    const steps = finish(b, drafts, 'r');
    const idOf = (i: number) => steps[i]?.id;
    steps[saveEnd].next = [idOf(saved), idOf(afterSave >= 0 ? afterSave : lastLoop)].filter(Boolean) as string[];
    steps[saved].next = [];
    if (lastLoop !== saved) steps[lastLoop].next = [idOf(firstLoop), ...(afterLoop >= 0 ? [idOf(afterLoop)] : [])].filter(Boolean) as string[];
    if (afterLoop >= 0) { steps[afterLoop].detail = `after the last attempt${steps[afterLoop].detail ? `: ${steps[afterLoop].detail}` : ''}`; steps[afterLoop].next = []; }
    for (const s of steps.slice(firstLoop, lastLoop + 1)) if (loopGuard && s.ctx?.includes('loop') && !s.guard) s.guard = loopGuard;
    const id = seenFns.size === 1 ? 'sequence:save-retry' : `sequence:save-retry:${slug(fn.name)}`;
    const reload = steps[afterSave >= 0 ? afterSave : lastLoop];
    b.sequences.set(id, {
      id, title: `Saving under contention: \`${fn.name}\` retries when \`${cand.save.name}\` loses the race`, kind: 'code-path',
      subject: home, steps, provenance: 'inferred', evidence: [rule, b.def(fn)],
      notes: [
        'Derived from code: a possible path, not a recorded run.',
        `If \`${cand.save.name}\` returns null (someone saved first), \`${fn.name}\` ${reload ? `runs ${reload.label}` : 're-reads'} and goes round again${loopGuard ? ` while \`${loopGuard}\`` : ''}${limit ? ` (${limit.name} = ${limit.value})` : ''}.`,
        ...(afterLoop >= 0 ? [`After the last attempt: ${steps[afterLoop].label}.`] : []),
      ],
    });
  }
  void d; void ins;
}

function storeName(b: Builder, id: string): string {
  let cur: string | undefined = id;
  while (cur) { const e = b.entities.get(cur); if (!e) break; if (e.level === 'component') return e.name; cur = e.parent; }
  return b.entities.get(id)?.name ?? id;
}

/** `attempt < MAX_ATTEMPTS` → MAX_ATTEMPTS and its literal value, when the index has it. */
function constantIn(b: Builder, guard: string, file: string): { name: string; value: string } | undefined {
  const F = b.facts;
  for (const m of guard.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    const s = (F.inFile.get(file) ?? []).find((x) => x.name === m[1]) ?? b.facts.index.symbols.find((x) => x.name === m[1] && x.kind === 'variable');
    if (!s) continue;
    const v = s.attrs?.value ?? /=\s*([^;]+)$/.exec(s.signature ?? '')?.[1]?.trim();
    if (v !== undefined) return { name: m[1], value: String(v) };
  }
  return undefined;
}
