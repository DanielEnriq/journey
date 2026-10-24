import { Fragment, h } from '../../../vendor/preact.js';
import { Note as NoteIcon, Question } from '../../../shared/components/icons.js';
import type { RoomController } from '../controller.js';
import { CAPTURE_KINDS, KIND_LABEL, type NodeView } from '../model.js';

// One part on the canvas: its face, what it draws inside itself for this view, and what hangs off it
// (the ask button, John's tab, notes, Vowe's pinned aside).

const srOnly = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';

export function Inside({ n }: { n: Pick<NodeView, 'part' | 'slots' | 'insts' | 'calls' | 'rows' | 'cols' | 'screen' | 'diff' | 'endpoint' | 'cap' | 'capCls'> }) {
  const smart = n.part.smart;
  return (
    <span class="sb">
      {smart === 'queue' && (
        <span class="slots">
          {n.slots?.map((sl) => (
            <span key={sl.id} class={sl.cls}>{sl.id}<small>{sl.note}</small>{sl.leased && <i style={`position:absolute;left:6px;bottom:4px;height:2px;border-radius:1px;background:var(--ink-4);width: ${sl.lease}%`}></i>}</span>
          ))}
        </span>
      )}
      {smart === 'worker' && n.insts?.map((it) => (
        <span key={it.name} class={it.cls}><span class={it.g}></span><span>{it.name}</span><span class="j">{it.job}</span></span>
      ))}
      {smart === 'calls' && (
        <span class="calls">
          {n.calls?.map((c, i) => <span key={i} class={c.cls}><span>{c.label}</span><span class="amt">{c.amt}</span><span class="ok">{c.mark}</span></span>)}
        </span>
      )}
      {smart === 'table' && (
        <span class="tbl">
          {n.rows?.map((r, i) => <span key={i} class={r.cls} style={`grid-template-columns: ${n.cols}`}><span>{r.a}</span><span>{r.b}</span><span class={r.cCls}>{r.c}</span></span>)}
        </span>
      )}
      {smart === 'screen' && n.screen && (
        <span class="scr">
          <span class="scr-bar"><i></i><i></i><i></i><span>checkout</span></span>
          <span class="scr-body">
            <span class="scr-h">Checkout</span><span class="scr-amt">$48.00 · Visa ··4242</span>
            {n.screen.bn && <span class={n.screen.bnCls}>{n.screen.bn}</span>}
            <span class={n.screen.btnCls}>{n.screen.btn}</span>
          </span>
        </span>
      )}
      {smart === 'diff' && <span class="diffb">{n.diff?.map((dl, i) => <span key={i} class={dl.cls}>{dl.t}</span>)}</span>}
      {smart === 'endpoint' && <span class="endpoint"><b>{n.endpoint}</b></span>}
      {n.cap && <span class={n.capCls}>{n.cap}</span>}
    </span>
  );
}

export function Part({ n, ctrl, decV, capQuote }: { n: NodeView; ctrl: RoomController; decV: number; capQuote: string }) {
  const s = ctrl.state, id = n.id, name = n.part.name;
  const pick = (e: MouseEvent) => {
    const cur = s.sel;
    if (e.shiftKey) ctrl.setState({ sel: cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id]), circle: null, asideOpen: null });
    else ctrl.setState({ sel: cur.length === 1 && cur[0] === id ? [] : [id], circle: null, asideOpen: null, capFor: null });
  };
  const a = n.aside;
  return (
    <div class={n.wrapCls} style={`transform: translate(${n.x}px, ${n.y}px); width: ${n.w}px; transition-delay: ${n.delay}ms`}>
      <button class={n.cls} type="button" aria-pressed={n.sel} style={`height: ${n.h}px`} onClick={pick}>
        <span class="face"><span class="pname">{name}</span><span class="ptech">{n.part.tech}</span></span>
        <Inside n={n} />
        {n.ev && <span class="evrow" style="margin-top:auto"><span class={n.ev.tone}><i></i>{n.ev.text}</span></span>}
      </button>
      <button class="part-ask" type="button" aria-label={`Ask Vowe about ${name}`} title="Ask about this"
        onClick={() => { ctrl.setState({ sel: [id], circle: null }); ctrl.converse([{ short: n.part.short, id }]); }}>
        <Question />
      </button>
      {n.peerTab && <span class="tab peer">John</span>}
      {n.meTab && <span class="tab me">You</span>}
      {n.notes.length > 0 && (
        <button class="notes-chip" type="button" aria-label={`${n.notes.length} notes on ${name}`} onClick={() => ctrl.setState({ sel: [id], asideOpen: null, capFor: null })}>
          <NoteIcon />{n.notes.length}
        </button>
      )}
      {a && !n.asideOpen && (
        <button class="vpin" type="button" aria-label={a.from} title={a.from} onClick={() => ctrl.setState({ asideOpen: a.id, sel: [], capFor: null })}>
          {a.needs ? <i></i> : <span class="orb"></span>}
        </button>
      )}
      {a && n.asideOpen && (
        <div class={n.asideCls} role="dialog" aria-label={a.from}>
          <span class="ah">{a.needs ? <span class="dot needs"></span> : <span class="orb"></span>}{a.from}</span>
          <p>{a.text}</p>
          <span class="acts">{a.acts.map((act) => <button key={act.label} class={act.cls} type="button" onClick={act.go}>{act.label}</button>)}</span>
        </div>
      )}
      {n.popOpen && (
        <div class={n.popCls} role="region" aria-label={`Notes on ${name}`}>
          {n.notes.map((nt) => (
            <div key={nt.id} class={nt.cls}>
              <span class="nt">{nt.kind}</span>
              <p>{nt.text}</p>
              <span class="by">
                <span class={nt.avCls}>{nt.initials}</span>{nt.who}
                {nt.linked && <><span>·</span><button class="link" type="button" onClick={() => ctrl.setState({ decOpen: true, decMode: 'card', desk: true })}>answered by decision v{decV}</button></>}
              </span>
              {nt.suggested && <span class="acts"><button class="mini" type="button" onClick={() => ctrl.keepNote(nt.id)}>Keep</button><button class="mini ghost" type="button" onClick={() => ctrl.dropNote(nt.id)}>Dismiss</button></span>}
              {nt.fresh && <span class="acts"><button class="mini ghost" type="button" onClick={() => ctrl.dropNote(nt.id)}>Undo</button></span>}
            </div>
          ))}
          {n.capOpen ? (
            <div class="capbox">
              <span class="q">“{capQuote}”</span>
              <span class="kinds">
                <button class="mini strong" type="button" onClick={() => ctrl.capture('note', id)}>Keep on {name}</button>
                <span class="or">or as</span>
                {CAPTURE_KINDS.map((k) => <button key={k} class="mini ghost" type="button" onClick={() => ctrl.capture(k, id)}>{KIND_LABEL[k]}</button>)}
              </span>
            </div>
          ) : (
            <button class="addnote" type="button" onClick={() => ctrl.setState({ capFor: id })}>Keep what was just said…</button>
          )}
        </div>
      )}
    </div>
  );
}

export { srOnly };
