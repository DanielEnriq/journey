import { Fragment, h } from '../../../vendor/preact.js';
import type { RoomController } from '../controller.js';
import type { RoomModel } from '../model.js';

// Coding agents at work in this room: what was already running, and the decision handed off here.

export function Workstreams({ ctrl, m }: { ctrl: RoomController; m: RoomModel }) {
  const s = ctrl.state;
  return (
    <div class="rsec">
      <span class="rk">Running<span>{s.handed ? '2 streams' : '1 stream'}</span></span>
      {m.running.map((w) => (
        <div key={w.title} class="stream">
          <div class="top"><span class="dot run"></span>{w.title}<span class="who">{w.agent}</span></div>
          <span class="mono">{w.meta}</span>
        </div>
      ))}
      {s.handed && (
        <>
          <div class={m.idemCls}>
            <div class="top"><span class={m.idemDot}></span>Idempotent processing<span class="who">{s.handedTo}</span></div>
            <span class="mono">{m.branch} · from decision v{s.dec.v}</span>
            <span class="line">{m.idemLine}</span>
            <span class="acts">
              <button class="mini" type="button" onClick={() => ctrl.go('impl', { last: null })}>See it on the canvas</button>
              {m.hasFiles && (
                <button class="mini ghost" type="button" aria-expanded={s.filesOpen} onClick={() => ctrl.setState({ filesOpen: !s.filesOpen })}>
                  {s.filesOpen ? 'Hide files' : `${m.files.length} files changed`}
                </button>
              )}
            </span>
            {m.hasFiles && s.filesOpen && (
              <div class="files">{m.files.map((f) => <div key={f.path} class="file"><span class="fn">{f.path}</span><span class="fa">+{f.a}</span><span class="fd">{f.d}</span></div>)}</div>
            )}
          </div>
          {m.overlap && (
            <div class="overlap">
              <span>Both change <code>retry/worker.ts</code>. Git can merge them; nobody has run them together.</span>
              <button class="mini ask" type="button" onClick={() => ctrl.speak('vowe', 'Both change [the worker|worker]. The retry stream retries on timeout; this one reuses the key on retry, so they should agree. Nothing has run them together yet.')}>Ask Vowe</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
