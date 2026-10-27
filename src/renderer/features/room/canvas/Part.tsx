import { h } from '../../../vendor/preact.js';
import type { PartState } from '../data/sources.js';
import type { PartDef } from '../types.js';

// What a part on the canvas draws inside itself for the view it's in.

const srOnly = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';

export function Inside({ n }: { n: PartState & { part: PartDef } }) {
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

export { srOnly };
