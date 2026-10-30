import type { Decision, Thread, VoweRecord, Work } from '../contracts/model.js';
import type { Inspect, Tab } from '../state/ui.js';

// What Focus opens, as pure rules (tested in focus-pick.test.ts). A section never opens on a blank page: it
// restores what you last had open, else what waits on you, else the newest. Only a section with nothing in
// it has nothing to show.

export function pickThread(rec: VoweRecord, me: string, current: string | null): Thread | null {
  const open = rec.threads.filter((t) => t.status === 'open');
  // One you opened stays open, resolved or not (the resolved fold opens those, and resolving keeps it in view).
  return rec.threads.find((t) => t.id === current) ?? open.find((t) => t.waiting === me) ?? open[open.length - 1] ?? null;
}

/** A decision in review that you were asked to sign and haven't signed at this version. */
export const owesSignature = (d: Decision, me: string) =>
  d.state === 'review' && d.approvers.some((a) => a.who === me && a.signed !== d.version && !a.changes);

export const liveDecisions = (rec: VoweRecord) => rec.decisions.filter((d) => d.state !== 'superseded' && d.state !== 'dismissed');

export function pickDecision(rec: VoweRecord, me: string, current: string | null): Decision | null {
  const live = liveDecisions(rec);
  // One you opened stays open even when it's an earlier version (history and Led to can open those).
  return rec.decisions.find((d) => d.id === current) ?? live.find((d) => owesSignature(d, me)) ?? live[live.length - 1] ?? null;
}

/** Work with a question for you that nobody has answered. */
export const owesAnswer = (w: Work, me: string) => !!w.question && w.question.for === me && !w.question.answer && !w.question.deferred;

export function pickWork(rec: VoweRecord, me: string, current: string | null): Work | null {
  return rec.work.find((w) => w.id === current) ?? rec.work.find((w) => owesAnswer(w, me)) ?? rec.work[0] ?? null;
}

export interface FocusTarget { tab: Tab; thread: Thread | null; decision: Decision | null; work: Work | null; inspect: Inspect }

/**
 * The section on screen and what its page shows. `inspect` is what the page's documents act on: what you
 * opened when it's in this section, else the picked item (opened at its plan, or its run when it asks you).
 */
export function focusTarget(rec: VoweRecord, me: string, s: { fsec: Tab; openThread: string | null; inspect: Inspect }): FocusTarget {
  const tab = s.fsec;
  const thread = tab === 'discuss' ? pickThread(rec, me, s.openThread) : null;
  const decision = tab === 'decide' ? pickDecision(rec, me, s.inspect?.kind === 'decision' ? s.inspect.id : null) : null;
  const work = tab === 'work' ? pickWork(rec, me, s.inspect?.kind === 'work' ? s.inspect.id : null) : null;
  const inspect: Inspect = decision
    ? (s.inspect?.kind === 'decision' && s.inspect.id === decision.id ? s.inspect : { kind: 'decision', id: decision.id })
    : work
      ? (s.inspect?.kind === 'work' && s.inspect.id === work.id ? s.inspect : { kind: 'work', id: work.id, section: owesAnswer(work, me) ? 'run' : 'plan' })
      : null;
  return { tab, thread, decision, work, inspect };
}

/** The title an item goes by in the list, the page and the band's crumbs. */
export const threadTitle = (t: Thread) =>
  t.title && !['Question', 'Note'].includes(t.title) ? t.title : (t.replies[0]?.body ?? t.about.name).replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1');

export const SECTION: Record<Tab, string> = { discuss: 'Discuss', decide: 'Decide', work: 'Work' };
