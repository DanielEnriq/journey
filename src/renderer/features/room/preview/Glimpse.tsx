import { h } from '../../../vendor/preact.js';
import { useLayoutEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import { Alternatives } from '../canvas/Surface.js';
import { Inside } from '../canvas/Part.js';
import type { RoomController } from '../controller.js';
import { deriveRoom } from '../model.js';
import { STAGE_H, STAGE_W } from '../geometry.js';

// A still of the view last shared on the call: the same parts, wires and evidence the canvas draws,
// scaled to fit and with nothing to press. It is a window into the room, not the canvas: no camera,
// selection, notes, asides or cursors.

export function Glimpse({ ctrl }: { ctrl: RoomController }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ox = ctrl.ox, oy = ctrl.oy;
  const m = deriveRoom(ctrl);
  ctrl.ox = ox; ctrl.oy = oy; // the canvas owns the camera offset
  const vb = m.def.viewBox || [STAGE_W, STAGE_H];
  const pad = 28, k = width ? Math.min(1, (width - pad * 2) / vb[0], 300 / vb[1]) : 0;
  const s = ctrl.state;

  return (
    <div class="glimpse-view" ref={box} aria-hidden="true" style={`height:${Math.round(vb[1] * k + pad * 2)}px`}>
      {k > 0 && (
        <div class="glimpse-fit" style={`width:${vb[0]}px;height:${vb[1]}px;transform:translate(${(width - vb[0] * k) / 2}px, ${pad}px) scale(${k})`}>
          <div class="stage">
            {m.bounds.filter((b) => !b.cls.includes('gone')).map((b, i) => <div key={i} class={b.cls} style={`transform: translate(${b.x}px, ${b.y}px); width: ${b.w}px; height: ${b.h}px`}><span>{b.label}</span></div>)}
            {m.wires.filter((w) => !w.cls.includes('gone')).map((w, i) => <div key={i} class={w.cls} style={`transform: translate(${w.x}px, ${w.y}px); width: ${w.w}px; height: ${w.h}px`}></div>)}
            {m.wlabels.filter((l) => !l.cls.includes('gone')).map((l, i) => <span key={i} class={l.cls} style={`transform: translate(${l.x}px, ${l.y}px)`}>{l.t}</span>)}
            {m.steps.filter((st) => !st.cls.includes('gone')).map((st) => (
              <div key={st.key} class={st.cls.replace(' focus', '')} style={`transform: translate(${st.x}px, ${st.y}px)`}>
                <span class="n">{st.n}</span>
                <span class="t"><b>{st.title}</b><span>{st.sub}</span></span>
              </div>
            ))}
            {m.view === 'alternatives' && <Alternatives cls="" />}
            {m.view === 'impl' && (
              <div class="verify" style="transform: translate(0px, 410px)">
                <div class="vh"><b>Checking decision v{s.dec.v}</b><span>{m.verifyCount}</span></div>
                {m.vcases.map((c) => <div key={c.text} class={c.cls}><span class="vi"></span><span>{c.text}</span><span class="vs">{c.status}</span></div>)}
              </div>
            )}
            {m.nodes.filter((n) => !n.wrapCls.includes('gone')).map((n) => (
              <div key={n.id} class="node" style={`transform: translate(${n.x}px, ${n.y}px); width: ${n.w}px`}>
                <div class={'part kind-' + n.part.kind + (n.part.proposed ? ' proposed' : '')} style={`height: ${n.h}px`}>
                  <span class="face"><span class="pname">{n.part.name}</span><span class="ptech">{n.part.tech}</span></span>
                  <Inside n={n} />
                  {n.ev && <span class="evrow" style="margin-top:auto"><span class={n.ev.tone}><i></i>{n.ev.text}</span></span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
