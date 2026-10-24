import { Fragment, h } from '../../../vendor/preact.js';
import { Back } from '../../../shared/components/icons.js';
import type { RoomController } from '../controller.js';
import { DecisionCard } from '../decisions/DecisionCard.js';
import type { RoomModel } from '../model.js';
import { Workstreams } from '../work/Workstreams.js';

// "Where we are": the room's goal, its decision, what is still open, and what is running. The decision
// opens in place of the list.

export function Desk({ ctrl, m }: { ctrl: RoomController; m: RoomModel }) {
  const s = ctrl.state;
  const openDec = () => ctrl.setState({ decOpen: true, decMode: 'card', desk: true });
  return (
    <aside class="desk" aria-label="Where the room is" aria-hidden={!s.desk}>
      <div class="desk-inner">
        {s.decOpen ? (
          <>
            <button class="back" type="button" style="align-self:flex-start;margin:0 0 12px -6px" onClick={() => ctrl.setState({ decOpen: false, decMode: 'card' })}><Back />Where we are</button>
            <DecisionCard ctrl={ctrl} m={m} />
          </>
        ) : (
          <>
            <div class="rhead"><span class="eyebrow">Where we are</span><span style="font-size:11.5px;color:var(--ink-8)">{m.roomSub}</span></div>

            {s.brief && (
              <div class="since" role="status">
                <b>Since you were last here</b>
                <ul>
                  <li><span class="dot ask"></span><span>John signed v3; it went to Claude Code with all three checks.</span></li>
                  <li><span class="dot"></span><span>Claude Code changed 4 files in its own worktree.</span></li>
                  <li><span class="dot live"></span><span>2 of 3 checks pass. Provider timeout is still running.</span></li>
                  <li><span class="dot needs"></span><span>It has one question for the room, pinned on the provider.</span></li>
                </ul>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                  <button class="mini ghost" type="button" onClick={() => ctrl.setState({ brief: false })}>Dismiss</button>
                  <button class="mini" type="button" onClick={() => { ctrl.setState({ brief: false }); ctrl.go('impl', { last: null }); }}>Show me</button>
                </div>
              </div>
            )}

            <div class="rsec" style="border-top:0;padding-top:0">
              <p class="goal-line">{m.goal.text}</p>
              <span class="goal-by"><span class={m.people[m.goal.by].av}>{m.people[m.goal.by].initials}</span>{m.people[m.goal.by].full}’s goal for this room</span>
            </div>

            <div class="rsec">
              <span class="rk">Decision<span>{m.statusLabel}</span></span>
              <button class={m.rdecCls} type="button" onClick={openDec}>
                <span class="t">{m.decisionText.what}</span>
                <span class={'m' + (m.needsSign ? ' needs' : '')}>{m.needsSign && <span class="dot needs"></span>}{m.rdecMeta}</span>
              </button>
            </div>

            <div class="rsec">
              <span class="rk">Open<span>{m.openRows.length}</span></span>
              {m.openRows.map((r) => (
                <button key={r.id} class={r.cls} type="button" onClick={() => ctrl.goTo(r.on, { asideOpen: null })}>
                  <span class="rt">{r.text}</span>
                  <span class="rm"><b>{r.kind}</b>on {r.onName} · {r.who}</span>
                </button>
              ))}
              <div class="setaside"><s>Distributed lock</s> set aside, unless idempotency keys can’t cover a provider timeout.</div>
            </div>

            <Workstreams ctrl={ctrl} m={m} />
          </>
        )}
      </div>
    </aside>
  );
}
