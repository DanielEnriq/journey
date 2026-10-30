import { h, Fragment, useState } from '../journey.js';
import type { Scene } from '../../../../shared/canvas/index.js';
import { SceneGlimpse } from '../../canvas/SceneGlimpse.js';
import type { Thread } from '../contracts/model.js';
import { useNames } from '../state/directory.js';
import { mayWrite } from '../state/permissions.js';
import type { Tab } from '../state/ui.js';
import { AboutGlyph, AgentName, DEC_STATE, DecideEmpty, DiscussList, FsThread, NewDecision, NewWork, Who, needsMe, partsOf, type DeskProps } from './Desk.js';
import { DecisionDoc } from './DecisionDoc.js';
import { Icon } from '../../../ui/icons.js';
import { WorkView, objectiveState } from './Work.js';
import { SECTION, focusTarget, liveDecisions, owesAnswer, owesSignature, threadTitle } from './focus-pick.js';

// Focus (full screen): the room's Desk as a place to read and write, not a panel grown wide. Three layers:
//   the sidebar  (sunken)  global, the same as everywhere; the room's window draws it
//   the list     (ground)  this room: its name, Discuss · Decide · Work, and that section's items
//   the page     (paper)   the open conversation, decision or plan at a reading measure, with its margin
// "For you" is Home's Inbox now. Each tab carries one dot, only when something there needs you. A section never
// opens on a blank page (focus-pick.ts); only an empty section shows an empty state, and it says how to start.
// The list and the page scroll on their own. ⌥1–3 switch sections; Esc or the collapse button returns to the
// same Desk tab, document and canvas view.


export function Focus(p: DeskProps) {
  const names = useNames();
  const { rec, me, act } = p;
  const [writing, setWriting] = useState<'decide' | 'work' | null>(null);
  const at = focusTarget(rec, me, { fsec: p.fsec, openThread: p.openThread, inspect: p.inspect });
  const { tab, thread, decision, work } = at;
  const decisions = liveDecisions(rec);
  const earlier = rec.decisions.filter((d) => d.state === 'superseded');
  const needs = needsMe(rec, names);
  const sp: DeskProps = { ...p, shell: true, narrow: false, depth: 'focus', openThread: thread?.id ?? null, inspect: at.inspect };
  const writer = mayWrite(p.role);
  const lightOn = (parts: string[]) => () => act.light(parts);
  const lightOff = () => act.light(null);

  return (
    <div class="nx-fo">
      <section class="nx-fo-list" aria-label={`${p.room?.name ?? 'This room'}: Discuss, Decide and Work`}>
        <div class="nx-fo-head">
          <div class="nx-fo-name">{p.room?.name ?? 'This room'}</div>
          {p.room?.repo ? <div class="nx-fo-repo"><Icon name="branch" size={14} />{p.room.repo.replace(/^(https?:\/\/)?(github\.com\/)?/, '')}</div> : null}
          <div class="nx-fo-tabs" role="tablist" aria-label="Sections">
            {(['discuss', 'decide', 'work'] as Tab[]).map((t, i) => (
              <button key={t} type="button" role="tab" class="nx-fo-tab" aria-selected={tab === t} data-tip={`${SECTION[t]} · ⌥${i + 1}`} onClick={() => act.fsec(t)}>
                {SECTION[t]}{needs[t] ? <i class="nx-fo-dot" aria-label="something here needs you"></i> : null}
              </button>
            ))}
          </div>
        </div>
        <div class="nx-fo-items" role="listbox" aria-label={SECTION[tab]}>
          {tab === 'discuss' ? (
            <>
              <DiscussList p={sp} />
            </>
          ) : null}
          {tab === 'decide' ? (
            <>
              {writing === 'decide' ? <div class="nx-fo-pad"><NewDecision p={p} done={() => setWriting(null)} /></div>
                : decisions.length || earlier.length ? <button type="button" class="nx-textbtn add nx-fo-add" disabled={!writer} onClick={() => setWriting('decide')}>+ Write a decision</button> : null}
              {[...decisions, ...earlier].map((d, i) => {
                const owe = owesSignature(d, me);
                return [
                  i === decisions.length && earlier.length ? <span key="earlier" class="nx-fo-h">Earlier versions</span> : null,
                  <button key={d.id} type="button" role="option" class="nx-fo-row" aria-selected={decision?.id === d.id} onClick={() => act.inspect({ kind: 'decision', id: d.id })} onPointerEnter={lightOn(d.parts)} onPointerLeave={lightOff}>
                    <span class={'nx-fo-k' + (owe ? ' is-needs' : '')}>{owe ? 'Needs your signature' : DEC_STATE[d.state]} · v{d.version}</span>
                    <span class="nx-fo-t">{d.title}</span>
                    <span class="nx-fo-m">{d.approvers.filter((a) => a.signed === d.version).length} of {d.approvers.length} signed · {d.ago}</span>
                  </button>,
                ];
              })}
            </>
          ) : null}
          {tab === 'work' ? (
            <>
              {writing === 'work' ? <div class="nx-fo-pad"><NewWork p={p} done={() => setWriting(null)} /></div>
                : rec.work.length ? <button type="button" class="nx-textbtn add nx-fo-add" disabled={!writer} onClick={() => setWriting('work')}>+ New work</button> : null}
              {rec.work.map((w) => {
                const st = objectiveState(w, rec, me);
                const owe = owesAnswer(w, me);
                return (
                  <button key={w.id} type="button" role="option" class="nx-fo-row" aria-selected={work?.id === w.id} onClick={() => act.inspect({ kind: 'work', id: w.id, section: owe ? 'run' : 'plan' })} onPointerEnter={lightOn(w.parts)} onPointerLeave={lightOff}>
                    <span class={'nx-fo-k' + (owe ? ' is-needs' : '')}>{owe ? `${w.doer?.name ?? 'Someone'} is waiting on you` : st.label}</span>
                    <span class="nx-fo-t">{w.title}</span>
                    <span class="nx-fo-m">{w.doer ? `${w.doer.name} · ` : ''}plan v{w.version} · {w.plan.filter((s) => s.state === 'done').length} of {w.plan.length} steps</span>
                  </button>
                );
              })}
            </>
          ) : null}
        </div>
        <div class="nx-fo-foot"><AgentName p={p} /></div>
      </section>
      <section class="nx-fo-page" aria-label={SECTION[tab]}>
        {tab === 'discuss' ? (thread ? <div class="nx-fo-thread"><FsThread t={thread} p={sp} /></div> : <Empty kind="discuss" scene={p.scene ?? null} />) : null}
        {tab === 'decide' ? (decision ? <div class="nx-inspector focus"><DecisionDoc d={decision} p={sp} /></div>
          : writing === 'decide' ? <Empty kind="decide" scene={null} /> : <div class="nx-fo-empty"><DecideEmpty p={sp} write={() => setWriting('decide')} /></div>) : null}
        {tab === 'work' ? (work ? <div class="nx-inspector focus nx-fo-work"><WorkView w={work} p={sp} /></div> : <Empty kind="work" scene={null} act={writing === 'work' || !writer ? undefined : ['New work', () => setWriting('work')]} />) : null}
      </section>
    </div>
  );
}

const EMPTY: Record<Tab, string> = { discuss: 'No threads yet', decide: 'No decisions yet', work: 'No work yet' };
const GLYPH = { discuss: 'part', decide: 'decision', work: 'work' } as const;

function Empty({ kind, scene, act }: { kind: Tab; scene: Scene | null; act?: [string, () => void] }) {
  return (
    <div class="nx-fo-empty">
      <p class="nx-empty3"><AboutGlyph a={GLYPH[kind]} />{EMPTY[kind]}</p>
      {act ? <div class="nx-fo-act"><button type="button" class="nx-btn primary" onClick={act[1]}>{act[0]}</button></div> : null}
      {scene && scene.nodes.length ? <figure class="nx-fo-glimpse"><SceneGlimpse scene={scene} /></figure> : null}
    </div>
  );
}

/** Room / Section / Item, for the band while Focus is open. */
export function focusCrumbs(p: Pick<DeskProps, 'rec' | 'me' | 'fsec' | 'openThread' | 'inspect'>): { section: string; item: string | null } {
  const at = focusTarget(p.rec, p.me, { fsec: p.fsec, openThread: p.openThread, inspect: p.inspect });
  return { section: SECTION[at.tab], item: at.thread ? threadTitle(at.thread) : at.decision?.title ?? at.work?.title ?? null };
}
