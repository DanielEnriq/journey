import { h } from '../../vendor/preact.js';
import { useLayoutEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import type { Scene } from '../../../shared/canvas/index.js';
import { Inside } from '../room/canvas/Part.js';
import type { PartDef } from '../room/types.js';

// A real room's last shared view, as the room's preview shows it: the same still as the demo's Glimpse
// (room/preview/Glimpse.tsx), drawn from a saved canvas's scene. Nothing to press, no camera, no
// cursors: the canvas itself is in the call. The still sits in its own `.room-screen` scope, so the room's part
// styles (scoped to rooms) draw it the same on Home's Inbox as in a room.

/**
 * `lit`: the parts something is about; they're drawn lit and the rest step back (the Inbox's "Where it lives").
 * `height`: the most the still may take (300px of drawing by default).
 */
export function SceneGlimpse({ scene, lit, height }: { scene: Scene; lit?: string[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const vb = scene.viewBox;
  const pad = 28, k = width ? Math.min(1, (width - pad * 2) / vb[0], (height ? Math.max(40, height - pad * 2) : 300) / vb[1]) : 0;
  const on = new Set(lit ?? []);

  return (
    <div class="room-screen" style="height:auto">
      <div class="glimpse-view" ref={box} aria-hidden="true" style={`height:${Math.round(vb[1] * k + pad * 2)}px`}>
        {k > 0 && (
          <div class="glimpse-fit" style={`width:${vb[0]}px;height:${vb[1]}px;transform:translate(${(width - vb[0] * k) / 2}px, ${pad}px) scale(${k})`}>
            <div class="stage">
              {scene.bounds.map((b, i) => <div key={i} class="bound" style={`transform: translate(${b.x}px, ${b.y}px); width: ${b.w}px; height: ${b.h}px`}><span>{b.label}</span></div>)}
              {scene.wires.map((w, i) => <div key={i} class={'wire ' + w.c} style={`transform: translate(${w.x}px, ${w.y}px); width: ${w.w}px; height: ${w.h}px`}></div>)}
              {scene.labels.map((l, i) => <span key={i} class="wlabel" style={`transform: translate(${l.x}px, ${l.y}px)`}>{l.t}</span>)}
              {scene.steps.map((st) => (
                <div key={st.id} class={'step' + (st.tone ? ' ' + st.tone : '')} style={`transform: translate(${st.x}px, ${st.y}px)`}>
                  <span class="n">{st.n}</span>
                  <span class="t"><b>{st.title}</b><span>{st.sub}</span></span>
                </div>
              ))}
              {scene.nodes.map((n) => (
                <div key={n.key} class={'node' + (on.size ? (on.has(n.component) ? ' is-lit' : ' is-dim') : '')} style={`transform: translate(${n.rect[0]}px, ${n.rect[1]}px); width: ${n.rect[2]}px`}>
                  <div class={'part kind-' + n.kind + (n.proposed ? ' proposed' : '')} style={`height: ${n.rect[3]}px`}>
                    <span class="face"><span class="pname">{n.name}</span><span class="ptech">{n.tech}</span></span>
                    <Inside n={{ part: { smart: n.smart } as PartDef, ...n.state }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
