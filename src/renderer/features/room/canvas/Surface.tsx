import { Fragment, h } from '../../../vendor/preact.js';
import { useEffect, useRef } from '../../../vendor/preact-hooks.js';
import {
  Arrow, Back, ClearInk, Cursor, ToolCircle, ToolComment, ToolDraw, ToolPan, ToolSelect, ZoomIn, ZoomOut,
} from '../../../shared/components/icons.js';
import { CallBar, type CallControls } from '../call/CallBar.js';
import type { RoomController } from '../controller.js';
import type { RoomModel } from '../model.js';
import type { Tool } from '../types.js';
import { Part, srOnly } from './Part.js';

// The shared canvas: the stage the camera moves over, and the controls that float above it.

const TOOLS: { id: Tool; label: string; title: string; Icon: () => h.JSX.Element }[] = [
  { id: 'select', label: 'Select', title: 'Select · V', Icon: ToolSelect },
  { id: 'pan', label: 'Pan', title: 'Pan · H', Icon: ToolPan },
  { id: 'circle', label: 'Circle a region', title: 'Circle · O', Icon: ToolCircle },
  { id: 'draw', label: 'Draw', title: 'Draw · P', Icon: ToolDraw },
  { id: 'comment', label: 'Comment', title: 'Comment · C', Icon: ToolComment },
];

export function Alternatives({ cls }: { cls: string }) {
  return (
    <>
      <div class={`alt aside-off ${cls}`} style="transform: translate(0px, 200px)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h3>A · Distributed lock</h3><span class="tag">set aside</span></div>
        <p>One worker holds a lock on the payment while it charges; the others wait.</p>
        <ul>
          <li><span class="mark">+</span>Concurrent pickup can’t both charge</li>
          <li><span class="mark">−</span>New coordination infrastructure to run</li>
          <li><span class="mark">−</span>A crash while holding the lock still needs recovery</li>
        </ul>
        <div class="foot"><span class="tag">reopen if keys can’t cover a provider timeout</span></div>
      </div>
      <div class={`alt ${cls}`} style="transform: translate(530px, 200px); transition-delay: 60ms">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h3>B · Idempotent processing</h3><span class="tag ask">in the decision</span></div>
        <p>Every attempt carries the same key; a repeated key returns the first result instead of charging again.</p>
        <ul>
          <li><span class="mark">+</span>Duplicate pickup becomes harmless</li>
          <li><span class="mark">+</span>No coordination between workers</li>
          <li><span class="mark">−</span>Every side effect has to be keyed</li>
        </ul>
        <div class="foot"><span class="tag">check · concurrent pickup</span><span class="tag">check · crash after charge</span></div>
      </div>
    </>
  );
}

export function Surface({ ctrl, m, call, banner }: { ctrl: RoomController; m: RoomModel; call: CallControls; banner?: h.JSX.Element | null }) {
  const s = ctrl.state, ref = useRef<HTMLElement>(null);
  useEffect(() => { if (ref.current) ctrl.observe(ref.current); }, [ctrl]);
  // Wheel needs a non-passive listener so ⌘-scroll zooms the canvas instead of the page.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => ctrl.wheel(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ctrl]);
  const circle = s.circle;

  return (
    <section ref={ref} class={m.surfaceCls} tabIndex={0}
      aria-label="Shared canvas · V select, H pan, O circle, P draw, C comment, 1–7 views, [ and ] panels, + − 0 zoom, pinch or ⌘-scroll to zoom"
      onPointerDown={(e) => ctrl.down(e)} onPointerMove={(e) => ctrl.move(e)} onPointerUp={() => ctrl.up()} onPointerCancel={() => ctrl.up()}>
      <div class="world" style={`transform: translate(${m.camX}px, ${m.camY}px) scale(${m.camZ})`}>
        <div class={`stage ${m.stageCls}`}>
          {m.bounds.map((b, i) => <div key={i} class={b.cls} style={`transform: translate(${b.x}px, ${b.y}px); width: ${b.w}px; height: ${b.h}px`}><span>{b.label}</span></div>)}
          {m.wires.map((w, i) => <div key={i} class={w.cls} style={`transform: translate(${w.x}px, ${w.y}px); width: ${w.w}px; height: ${w.h}px; transition-delay: ${w.delay}ms`}></div>)}
          {m.wlabels.map((l, i) => <span key={i} class={l.cls} style={`transform: translate(${l.x}px, ${l.y}px)`}>{l.t}</span>)}
          {m.steps.map((st) => (
            <div key={st.key} class={st.cls} style={`transform: translate(${st.x}px, ${st.y}px); transition-delay: ${st.delay}ms`}>
              <span class="n">{st.n}</span>
              <span class="t"><b>{st.title}</b><span>{st.sub}</span></span>
            </div>
          ))}

          <Alternatives cls={m.altCls} />

          <div class={`verify ${m.verifyCls}`} style="transform: translate(0px, 410px)">
            <div class="vh"><b>Checking decision v{s.dec.v}</b><span>{m.verifyCount}</span></div>
            {m.vcases.map((c) => <div key={c.text} class={c.cls}><span class="vi"></span><span>{c.text}</span><span class="vs">{c.status}</span></div>)}
          </div>

          {m.nodes.map((n) => <Part key={n.id} n={n} ctrl={ctrl} decV={s.dec.v} capQuote={m.capQuote} />)}

          <svg class="ink" viewBox="0 0 980 620" aria-hidden="true">
            <path class="stroke" d={m.inkD}></path>
            <path class="stroke" d={m.strokeD}></path>
            <path class={m.circleCls} d={circle ? circle.d : ''}></path>
            <path class="lasso live" d={m.lassoD}></path>
          </svg>
          {s.marquee && <div class="marquee" style={`transform: translate(${s.marquee.x}px, ${s.marquee.y}px); width: ${s.marquee.w}px; height: ${s.marquee.h}px`}></div>}
          {circle && (
            <div class="lasso-ask" style={`transform: translate(${m.circleX}px, ${m.circleY}px)`}>
              <span class="lbl">{m.circleLabel}</span>
              <div class="items">{circle.items.map((ci) => <span key={ci.id || ci.short} class="tag">{ci.short}</span>)}</div>
              <div class="row2">
                <button class="mini ask" type="button" onClick={() => { ctrl.setState({ circle: { ...circle, asked: true } }); ctrl.converse(circle.items); }}>Ask Vowe about this</button>
                <button class="mini ghost" type="button" onClick={() => ctrl.setState({ circle: null })}>Clear</button>
              </div>
            </div>
          )}
          {m.pins.map((p, i) => (
            <div key={i} class="pin" style={`transform: translate(${p.x}px, ${p.y}px)`}>
              <span class="head">DE</span>
              <label style="display:flex"><span style={srOnly}>Comment</span><input type="text" placeholder="Add a comment…" /></label>
            </div>
          ))}
          {m.ctx && (
            <div class="ctx" style={`transform: translate(${m.ctx.x}px, ${m.ctx.y}px)`}>
              {s.sel.length > 1 && <><span class="n">{m.ctxCount} selected</span><span class="sep"></span></>}
              <button type="button" onClick={m.askSel}>{m.ctxAsk}</button>
              <span class="sep"></span>
              <button type="button" onClick={() => ctrl.setState({ sel: [], capFor: null })}>Done</button>
            </div>
          )}
          <div class="cursor" style={`transform: translate(${m.def.cursor[0]}px, ${m.def.cursor[1]}px)`} aria-hidden="true">
            <Cursor color="var(--peer)" />
            <span class={m.cursorLabelCls}>John</span>
          </div>
          {s.srikar === 'present' && (
            <div class="cursor p2" style={`transform: translate(${m.def.cursor2[0]}px, ${m.def.cursor2[1]}px)`} aria-hidden="true">
              <Cursor color="var(--peer2)" />
              <span class={m.cursorLabelCls}>Srikar</span>
            </div>
          )}
        </div>
      </div>

      <div class="surface-head">
        <div class="seg" role="group" aria-label="Saved views">
          {m.tabs.map((t) => <button key={t.id} class={t.cls} type="button" title={t.title} aria-pressed={t.on} onClick={() => ctrl.go(t.id, { last: null })}>{t.name}</button>)}
        </div>
        {m.backLabel && <button class="back" type="button" onClick={() => ctrl.go(s.prev!, { last: null })}><Back />{m.backLabel}</button>}
        <span class={m.provCls}>{m.def.provenance}</span>
        <div class="recipe-wrap">
          <button class="recipe-btn" type="button" aria-expanded={s.recipeOpen} onClick={() => ctrl.setState({ recipeOpen: !s.recipeOpen })}><span class="orb"></span>How Vowe drew this</button>
          {s.recipeOpen && (
            <div class="recipe" role="region" aria-label="How Vowe drew this view">
              {m.recipeRows.map((r, i) => <div key={i} class={r.cls}><span class="rk2">{r.k}</span><span>{r.v}</span></div>)}
            </div>
          )}
        </div>
      </div>

      {m.receipt && (
        <div class="receipt" role="status">
          <span class="orb small"></span>
          <span>Vowe {m.receipt.verb} <b>{m.receipt.name}</b> {m.receipt.how}</span>
          <button class="mini ghost" type="button" onClick={() => ctrl.undoView(m.receipt!.which)}>Undo</button>
          <button class="mini" type="button" onClick={() => ctrl.keepView(m.receipt!.which)}>Keep view</button>
        </div>
      )}

      {m.edgeCursors.map((ec) => (
        <button key={ec.name} class={ec.cls} type="button" title={`Go to ${ec.name}`} style={`transform: translate(${ec.x}px, ${ec.y}px)`} onClick={ec.go}><Arrow angle={ec.a} />{ec.name}</button>
      ))}

      <div class="tools" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
        {TOOLS.map(({ id, label, title, Icon }) => (
          <button key={id} class={s.tool === id ? 'on' : ''} type="button" aria-label={label} title={title} aria-pressed={s.tool === id} onClick={() => ctrl.setState({ tool: id })}><Icon /></button>
        ))}
        {m.hasInk && (
          <button type="button" aria-label="Clear your ink in this view" title="Clear your ink" onClick={() => ctrl.setState({ ink: { ...s.ink, [m.view]: [] }, pins: { ...s.pins, [m.view]: [] } })}><ClearInk /></button>
        )}
        <span class="rule"></span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => ctrl.zoomBy(1.25)}><ZoomIn /></button>
        <button class="zoom" type="button" aria-label="Fit the view" title="Fit" onClick={() => ctrl.setCam({ x: 0, y: 0, z: 1 })}>{m.zoomPct}</button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => ctrl.zoomBy(0.8)}><ZoomOut /></button>
      </div>

      {m.ccShow && (
        <div class="captions" aria-live="polite">
          {m.prev && <div class="prevline">{m.prev.who} · {m.prev.text}</div>}
          <div class="curline">
            <span class="spk">{m.lineName}</span>
            <span class="words">{m.lineWords.map((w, i) => <span key={i} class={w.cls}>{w.t}{w.chip && <small>→ {w.chipTo}</small>}{w.tail}</span>)}</span>
            {m.lineCut && <span class="cut">— interrupted</span>}
          </div>
        </div>
      )}

      {banner}
      <CallBar c={call} />
    </section>
  );
}
