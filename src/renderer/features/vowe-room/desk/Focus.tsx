import { h, Fragment, useState } from '../journey.js';
import type { Scene } from '../../../../shared/canvas/index.js';
import { SceneGlimpse } from '../../canvas/SceneGlimpse.js';
import type { Thread } from '../contracts/model.js';
import { useNames } from '../state/directory.js';
import { mayWrite } from '../state/permissions.js';
import type { Tab } from '../state/ui.js';
import { AgentName, DEC_STATE, DecideEmpty, FsThread, NewDecision, NewWork, Who, needsMe, partsOf, type DeskProps } from './Desk.js';
import { DecisionDoc } from './DecisionDoc.js';
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

const KIND: Record<Thread['about']['kind'], string> = { part: 'On', edge: 'On a wire', scenario: 'On a failure', decision: 'On a decision', line: 'On a decision line', work: 'On work', step: 'On a plan step', pr: 'On a PR', check: 'On a check' };
const kindOf = (t: Thread) => (t.about.kind === 'part' ? `On ${t.about.name}` : KIND[t.about.kind]);

export function Focus(p: DeskProps) {
  const names = useNames();
  const { rec, me, act } = p;
  const [writing, setWriting] = useState<'decide' | 'work' | null>(null);
  const [draft, setDraft] = useState('');
  const at = focusTarget(rec, me, { fsec: p.fsec, openThread: p.openThread, inspect: p.inspect });
  const { tab, thread, decision, work } = at;
  const threads = rec.threads.filter((t) => t.status === 'open');
  const decisions = liveDecisions(rec);
  const earlier = rec.decisions.filter((d) => d.state === 'superseded');
  const needs = needsMe(rec, names);
  const counts = { discuss: threads.length, decide: decisions.length, work: rec.work.filter((w) => w.state !== 'resolved' && w.state !== 'closed').length };
  const sp: DeskProps = { ...p, shell: true, narrow: false, depth: 'focus', openThread: thread?.id ?? null, inspect: at.inspect };
  const writer = mayWrite(p.role);
  const lightOn = (parts: string[]) => () => act.light(parts);
  const lightOff = () => act.light(null);

  return (
    <div class="nx-fo">
      <section class="nx-fo-list" aria-label={`${p.room?.name ?? 'This room'}: Discuss, Decide and Work`}>
        <div class="nx-fo-head">
          <div class="nx-fo-name">{p.room?.name ?? 'This room'}</div>
          {p.room?.repo ? <div class="nx-fo-repo">{p.room.repo}</div> : null}
          <div class="nx-fo-tabs" role="tablist" aria-label="Sections">
            {(['discuss', 'decide', 'work'] as Tab[]).map((t, i) => (
              <button key={t} type="button" role="tab" class="nx-fo-tab" aria-selected={tab === t} data-tip={`${SECTION[t]} · ⌥${i + 1}`} onClick={() => act.fsec(t)}>
                {SECTION[t]}<span class="nx-fo-n">{counts[t] || ''}</span>
                {needs[t] ? <i class="nx-fo-dot" aria-label="something here needs you"></i> : null}
              </button>
            ))}
          </div>
        </div>
        <div class="nx-fo-items" role="listbox" aria-label={SECTION[tab]}>
          {tab === 'discuss' ? (
            <>
              <label class="rp-cm-reply nx-compose nx-fo-compose"><Who id={me} /><span class="rp-sr">New thread</span>
                <input type="text" placeholder="Start a thread about the system…" value={draft} disabled={!writer} onInput={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { act.newThread(draft.trim()); setDraft(''); } }} />
              </label>
              {threads.map((t) => {
                const last = t.replies[t.replies.length - 1];
                const owe = t.waiting === me;
                return (
                  <button key={t.id} type="button" role="option" class="nx-fo-row" aria-selected={thread?.id === t.id} onClick={() => act.thread(t.id)} onPointerEnter={lightOn(partsOf(t.about, rec))} onPointerLeave={lightOff}>
                    <span class={'nx-fo-k' + (owe ? ' is-needs' : '')}>{owe ? 'Waiting on you' : kindOf(t)}</span>
                    <span class="nx-fo-t">{threadTitle(t)}</span>
                    {last ? <span class="nx-fo-m">{names.nameOf(last.by)} · {last.ago} · {t.replies.length} message{t.replies.length > 1 ? 's' : ''}</span> : null}
                  </button>
                );
              })}
            </>
          ) : null}
          {tab === 'decide' ? (
            <>
              {writing === 'decide' ? <div class="nx-fo-pad"><NewDecision p={p} done={() => setWriting(null)} /></div>
                : <button type="button" class="nx-textbtn add nx-fo-add" disabled={!writer} onClick={() => setWriting('decide')}>+ Write a decision</button>}
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
                : <button type="button" class="nx-textbtn add nx-fo-add" disabled={!writer} onClick={() => setWriting('work')}>+ New work</button>}
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
        {tab === 'work' ? (work ? <div class="nx-inspector focus nx-fo-work"><WorkView w={work} p={sp} /></div> : <Empty kind="work" scene={null} />) : null}
      </section>
    </div>
  );
}

const EMPTY: Record<Tab, [string, string]> = {
  discuss: ['No conversations yet', 'A conversation here is about part of the system: select a part on the canvas and press C, or circle a region and ask. Threads stay with the room, between calls. Or start one from the list.'],
  decide: ['No decisions yet', 'A decision is what the room agrees to do and why. It counts once the people asked have signed it. Start one from a conversation, or write one.'],
  work: ['No work yet', 'Work is an objective with a plan. A person or a connected coding agent does it, and its pull requests stay together here. Start it from the list, or from a signed decision.'],
};

function Empty({ kind, scene }: { kind: Tab; scene: Scene | null }) {
  const [title, body] = EMPTY[kind];
  return (
    <div class="nx-fo-empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {scene && scene.nodes.length ? <figure class="nx-fo-glimpse"><SceneGlimpse scene={scene} /></figure> : null}
    </div>
  );
}

/** Room / Section / Item, for the band while Focus is open. */
export function focusCrumbs(p: Pick<DeskProps, 'rec' | 'me' | 'fsec' | 'openThread' | 'inspect'>): { section: string; item: string | null } {
  const at = focusTarget(p.rec, p.me, { fsec: p.fsec, openThread: p.openThread, inspect: p.inspect });
  return { section: SECTION[at.tab], item: at.thread ? threadTitle(at.thread) : at.decision?.title ?? at.work?.title ?? null };
}
