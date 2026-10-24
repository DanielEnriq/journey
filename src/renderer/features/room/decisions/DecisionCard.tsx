import { Fragment, h } from '../../../vendor/preact.js';
import { Close } from '../../../shared/components/icons.js';
import type { RoomController } from '../controller.js';
import type { RoomModel } from '../model.js';
import type { AgentTarget } from '../types.js';

// The decision, opened from the desk: its versions, who signed which, amending its checks, and the
// handoff package a coding agent receives.

const srOnly = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
const TARGETS: { id: AgentTarget; name: string }[] = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }];

export function DecisionCard({ ctrl, m }: { ctrl: RoomController; m: RoomModel }) {
  const s = ctrl.state, d = s.dec, t = m.decisionText;
  if (s.decMode === 'handoff') return (
    <div class={m.decovCls} role="dialog" aria-label="Decision">
      <div class="dh">
        <b style="font-size:14.5px;color:var(--ink-bright)">Hand off v{d.v}</b>
        <button class="icon-button" type="button" aria-label="Back to the decision" style="margin-left:auto" onClick={() => ctrl.setState({ decMode: 'card' })}><Close /></button>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div class="seg" role="group" aria-label="Coding agent">
          {TARGETS.map((x) => <button key={x.id} class={s.target === x.id ? 'on' : ''} type="button" aria-pressed={s.target === x.id} onClick={() => ctrl.setState({ target: x.id })}>{x.name}</button>)}
        </div>
        <span class="mono" style="font-size:10.5px;color:var(--ink-8)">new worktree · {m.branch}</span>
      </div>
      <div class="pkg">
        <div class="pk"><span class="lbl">Do</span><span style="color:var(--ink-bright);font-weight:500">{t.what}</span></div>
        <div class="pk"><span class="lbl">Goal</span><span>{t.goal}</span></div>
        <div class="pk"><span class="lbl">Avoid</span><span>{t.avoid}</span></div>
        <div class="pk"><span class="lbl">Check</span><span>{d.verify}</span></div>
        <div class="pk"><span class="lbl">Because</span><span>{t.why}</span></div>
        <div class="pk"><span class="lbl">Views</span><span class="chips-l"><span class="tag">Failure flow</span>{s.built && <span class="tag">Concurrency</span>}</span></div>
      </div>
      <p class="stays">Stays in the room: who said what, the discussion, and why the lock was set aside. If {m.targetName} hits something that contradicts this, it comes back here as a question.</p>
      <div class="dacts">
        <button class="cta" type="button" onClick={() => ctrl.sendHandoff()}>Send to {m.targetName}</button>
        <button class="mini ghost" type="button" onClick={() => ctrl.setState({ decMode: 'card' })}>Cancel</button>
      </div>
    </div>
  );

  return (
    <div class={m.decovCls} role="dialog" aria-label="Decision">
      <div class="dh">
        <span class={m.statusTagCls}>{m.statusLabel}</span>
        <span class="ver">v{d.v}</span>
      </div>
      <div class="what">{t.what}</div>
      <dl class="fields">
        <dt>Goal</dt><dd>{t.goal}</dd>
        <dt>Avoid</dt><dd>{t.avoid}</dd>
        <dt>Check</dt>
        <dd>
          {d.amending ? (
            <div style="display:flex;flex-direction:column;gap:6px">
              <label style="display:flex"><span style={srOnly}>What to check</span><input class="field-edit" type="text" value={d.draft} onInput={(e) => ctrl.setDec({ draft: (e.currentTarget as HTMLInputElement).value })} /></label>
              {m.suggShow && (
                <button class="sugg" type="button" onClick={() => ctrl.setDec({ draft: (d.draft || d.verify).replace(/;?\s*$/, '') + '; ' + m.suggestion })}>
                  <span class="orb"></span>Add “{m.suggestion}”, from Srikar’s point about leases
                </button>
              )}
            </div>
          ) : (
            <><span>{m.diffKeep}</span>{m.diffHas && <ins class="add">{m.diffAdd}</ins>}</>
          )}
        </dd>
        <dt>Because</dt><dd>{t.because}</dd>
      </dl>
      {d.amending ? (
        <div class="dacts">
          <button class="cta" type="button" onClick={() => ctrl.proposeNext()}>Propose v{d.v + 1}</button>
          <button class="mini ghost" type="button" onClick={() => ctrl.setDec({ amending: false })}>Cancel</button>
          <span style="font-size:11.5px;color:var(--ink-8)">Signatures reset</span>
        </div>
      ) : (
        <>
          <span class="approvers">Approvers: Daniel and John, named when this was drafted. Srikar contributed but isn’t one.</span>
          <div class="stamps">
            <span class={m.johnStamp.cls}><span class="avatar peer">JM</span>{m.johnStamp.text}</span>
            <span class={m.youStamp.cls}><span class="avatar">DE</span>{m.youStamp.text}</span>
          </div>
          <div class="dacts">
            {m.youCanSign && <button class="mini strong" type="button" onClick={() => ctrl.signDec()}>Sign v{d.v}</button>}
            {m.canHand && <button class="cta" type="button" onClick={() => ctrl.setState({ decMode: 'handoff' })}>Prepare handoff</button>}
            {m.canAmend && <button class="mini ghost" type="button" onClick={() => ctrl.setDec({ amending: true, draft: d.verify })}>Amend</button>}
          </div>
        </>
      )}
      {s.handed && <div class="answered">With {s.handedTo} as v{d.v}. This card stays the record of what was agreed.</div>}
      {s.question === 'answered' && <div class="answered"><b>You answered {s.handedTo}:</b> {s.qAnswer} The decision itself didn’t change.</div>}
      {d.history.map((x) => <div key={x.v} class="hist"><span class="old">v{x.v}</span><span>{x.verify} · signed by {x.by} · superseded</span></div>)}
    </div>
  );
}
