import { h } from '../../../vendor/preact.js';
import { Back } from '../../../shared/components/icons.js';
import type { RoomController } from '../controller.js';
import { DecisionCard } from '../decisions/DecisionCard.js';
import type { RoomModel } from '../model.js';
import { RoomPanel } from '../panel/RoomPanel.js';
import { toPanel } from './toPanel.js';

// "Where we are": the room panel (goal, decision, threads, what is running), fed from the room's
// state. The decision opens in place of the panel.

export function Desk({ ctrl, m }: { ctrl: RoomController; m: RoomModel }) {
  const s = ctrl.state;
  const openDec = (decMode: 'card' | 'handoff' = 'card') => ctrl.setState({ decOpen: true, decMode, desk: true });
  return (
    <aside class="desk" aria-label="Where the room is" aria-hidden={!s.desk}>
      {s.decOpen ? (
        <div class="desk-inner">
          <button class="back" type="button" style="align-self:flex-start;margin:0 0 12px -6px" onClick={() => ctrl.setState({ decOpen: false, decMode: 'card' })}><Back />Where we are</button>
          <DecisionCard ctrl={ctrl} m={m} />
        </div>
      ) : (
        <div class="desk-panel">
          <RoomPanel
            {...toPanel(ctrl, m)}
            onOpenDecision={() => openDec()}
            onSign={() => ctrl.signDec()}
            onProposeChange={() => { openDec(); ctrl.setDec({ amending: true, draft: s.dec.verify }); }}
            onHandOff={() => openDec('handoff')}
            onReply={(id, body) => ctrl.reply(id, body)}
            onShowAnchor={(id) => ctrl.goTo(id, { asideOpen: null })}
            onDismissBrief={() => ctrl.setState({ brief: false })}
            onShowBrief={() => { ctrl.setState({ brief: false }); ctrl.go('impl', { last: null }); }}
            onShowStream={s.handed ? () => ctrl.go('impl', { last: null }) : undefined}
          >
            {m.overlap && (
              <div class="overlap">
                <span>Both change <code>retry/worker.ts</code>. Git can merge them; nobody has run them together.</span>
                <button class="mini ask" type="button" onClick={() => ctrl.speak('vowe', 'Both change [the worker|worker]. The retry stream retries on timeout; this one reuses the key on retry, so they should agree. Nothing has run them together yet.')}>Ask Vowe</button>
              </div>
            )}
          </RoomPanel>
        </div>
      )}
    </aside>
  );
}
