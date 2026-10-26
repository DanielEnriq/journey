import { AGENT, type Notice, type VoweRecord, type Thread } from '../contracts/model.js';
import type { Names } from './directory.js';
import { approvedOf, openChanges } from './plan.js';
import type { Tab } from './ui.js';

// One attention model. Every item is derived from the record (or is an info notice), has one kind, one
// person and one home object. For you lists them; tab dots and the band dot count the actionable ones;
// the canvas marks the parts they're about. Opening or acting on the object clears it everywhere.

export type AttnKind = 'respond' | 'approve' | 'review' | 'info';
/** Each item answers: what, why me, what happens when I click (cta), and what kind of attention it is. */
export interface Attn { id: string; kind: AttnKind; text: string; tab: Tab; to: Notice['to']; part?: string; ago: string; where?: string; why?: string; cta?: string }

const tabOf = (t: Thread): Tab => t.about.kind === 'step' || t.about.kind === 'work' || t.about.kind === 'pr' || t.about.kind === 'check' ? 'work' : t.about.kind === 'line' || t.about.kind === 'decision' ? 'decide' : 'discuss';
const whereOf = (t: Thread) => ({ part: '', edge: 'a wire', scenario: 'a failure', decision: 'a decision', line: 'a decision line', work: 'work', step: 'a plan step', pr: t.about.name.split(' · ')[0], check: 'a check' })[t.about.kind];

export function attention(rec: VoweRecord, n: Pick<Names, 'me' | 'nameOf' | 'agentName'>): Attn[] {
  const { me, nameOf } = n;
  const agent = n.agentName();
  const out: Attn[] = [];
  for (const t of rec.threads) {
    if (t.status !== 'open') continue;
    const last = t.replies[t.replies.length - 1];
    const offer = t.replies.find((r) => r.offer?.state === 'open' && rec.vowe);
    const waits = t.waiting === me && last.by !== me;
    // One item per thread: if it waits on you and carries Vowe's offer, the offer is what you answer.
    if (waits) out.push({ id: `t:${t.id}:${t.replies.length}`, kind: 'respond', text: offer ? `${nameOf(t.replies[0].by)} and ${agent}: ${offer.offer!.text}` : `${nameOf(last.by)}: ${last.body.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1').slice(0, 70)}${last.body.length > 70 ? '…' : ''}`, tab: tabOf(t), to: { tab: tabOf(t), id: t.id }, ago: last.ago, where: whereOf(t) || undefined });
    else for (const r of t.replies) if (r.offer?.state === 'open' && rec.vowe) out.push({ id: `o:${t.id}:${r.id}`, kind: 'review', text: `${agent} offers: ${r.offer.text}`, tab: r.offer.kind === 'decision' || r.offer.kind === 'revision' ? 'decide' : tabOf(t), to: { tab: tabOf(t), id: t.id }, ago: r.ago, where: whereOf(t) || undefined });
  }
  for (const d of rec.decisions) {
    const mine = d.approvers.find((a) => a.who === me);
    if (d.state === 'review' && mine && mine.signed !== d.version && !mine.changes) out.push({ id: `d:${d.id}:${d.version}`, kind: 'approve', text: `Sign decision v${d.version}: ${d.title}`, tab: 'decide', to: { tab: 'decide', id: d.id }, ago: d.ago });
    if (d.state === 'suggested') out.push({ id: `ds:${d.id}`, kind: 'review', text: `${agent} thinks there’s a decision: ${d.title}`, tab: 'decide', to: { tab: 'decide', id: d.id }, ago: d.ago });
    for (const l of d.lines) if (l.suggest && d.state !== 'superseded') out.push({ id: `ls:${d.id}:${l.id}`, kind: 'review', text: `${nameOf(l.suggest.by)} suggests an edit to decision v${d.version}`, tab: 'decide', to: { tab: 'decide', id: d.id }, ago: 'now' });
    const ch = d.approvers.filter((a) => a.changes && a.who !== me);
    if (d.state === 'review' && d.by.who === me) for (const a of ch) out.push({ id: `dc:${d.id}:${a.who}`, kind: 'respond', text: `${nameOf(a.who)} requested changes to v${d.version}`, tab: 'decide', to: { tab: 'decide', id: d.id }, ago: 'now' });
  }
  for (const w of rec.work) {
    if (w.owner !== me) continue;
    const oc = openChanges(w);
    const ap = approvedOf(w);
    if (oc.length) out.push({ id: `rv:${w.id}:${w.revision!.id}`, kind: 'review', text: `${nameOf(w.revision!.by)} suggests ${oc.length} change${oc.length > 1 ? 's' : ''} to the ${w.title} plan`, tab: 'work', to: { tab: 'work', id: w.id, inspect: true }, ago: 'now' });
    else if (w.doer && w.state === 'proposed' && !w.blocks) out.push({ id: `au:${w.id}:${w.version}`, kind: 'approve', text: `Authorize ${w.doer.name} to run ${w.title} plan v${w.version}`, tab: 'work', to: { tab: 'work', id: w.id, inspect: true }, ago: 'now' });
    else if (ap && ap.version !== w.version && w.state !== 'resolved' && !oc.length && w.log[w.log.length - 1]?.who !== AGENT) out.push({ id: `au:${w.id}:${w.version}`, kind: 'approve', text: `Plan v${w.version} is ready; ${w.doer?.name} is still on v${ap.version}`, tab: 'work', to: { tab: 'work', id: w.id, inspect: true }, ago: 'now' });
    if (w.question && !w.question.answer && !w.question.deferred && w.question.for === me) out.push({ id: `q:${w.id}:${w.question.id}`, kind: 'respond', text: `${w.doer?.name ?? 'The agent'} asks: ${w.question.text.slice(0, 64)}…`, tab: 'work', to: { tab: 'work', id: w.id, part: w.question.about }, part: w.question.about, ago: 'now' });
    if (w.scopeAsk) out.push({ id: `sc:${w.id}`, kind: 'approve', text: `${w.scopeAsk.by} needs permission for ${w.scopeAsk.adds}`, tab: 'work', to: { tab: 'work', id: w.id }, ago: 'now' });
    for (const p of w.prs) {
      const f = p.checks.filter((c) => c.state === 'fail');
      if (f.length && p.state !== 'closed' && p.state !== 'merged') out.push({ id: `ci:${p.id}:${f.map((c) => c.name).join()}`, kind: 'review', text: `#${p.num} failed ${f.map((c) => c.name).join(', ')}`, tab: 'work', to: { tab: 'work', id: w.id, inspect: true }, part: p.parts[0], ago: p.ago });
      if (p.review?.state === 'changes') out.push({ id: `pc:${p.id}`, kind: 'review', text: `${nameOf(p.review.by)} requested changes on #${p.num}`, tab: 'work', to: { tab: 'work', id: w.id, inspect: true }, ago: p.ago });
    }
    if (w.state === 'review' && w.prs.length && w.prs.every((x) => x.state === 'merged' || x.state === 'closed')) out.push({ id: `res:${w.id}`, kind: 'approve', text: `${w.title}: every PR merged and every check passes. Ready to resolve`, tab: 'work', to: { tab: 'work', id: w.id }, ago: 'now' });
  }
  for (const w of rec.work) for (const p of w.prs) if (p.review?.state === 'requested' && p.review.by === me) out.push({ id: `rr:${p.id}`, kind: 'review', text: `${nameOf(p.by)} asked you to review #${p.num}`, tab: 'work', to: { tab: 'work', id: w.id }, ago: p.ago });
  for (const n of rec.notices) if (n.for === me && n.level === 'info' && !n.read) out.push({ id: `n:${n.id}`, kind: 'info', text: n.text, tab: n.to.tab, to: n.to, ago: n.ago, part: n.to.part });
  const done = new Set(rec.done);
  return out.filter((a) => !done.has(a.id)).map((a) => ({ ...a, ...explain(a, rec) }));
}

/** Why this is yours, and what the button does. */
function explain(a: Attn, rec: VoweRecord): { why: string; cta?: string } {
  const p = a.id.split(':')[0];
  const t = rec.threads.find((x) => x.id === a.to.id);
  switch (p) {
    case 't': return { why: t?.linked?.some((l) => l.kind === 'line') ? 'It challenges a decision you signed, and it’s waiting on you' : 'Someone is waiting on your reply', cta: 'Reply' };
    case 'o': return { why: 'It’s an offer in a thread you’re in. Nothing happens unless someone accepts', cta: 'See the offer' };
    case 'd': return { why: 'You’re asked to sign this version', cta: 'Read and sign' };
    case 'ds': return { why: 'From a conversation you’re in', cta: 'Look at it' };
    case 'ls': return { why: 'It edits a decision you’re reviewing', cta: 'Review the edit' };
    case 'dc': return { why: 'You wrote this version', cta: 'See what to change' };
    case 'rv': return { why: 'You own this plan', cta: 'Review the changes' };
    case 'au': return { why: 'You own this plan; nothing runs until it’s authorized', cta: 'Review and authorize' };
    case 'q': return { why: 'It paused to ask you; it’s working on other steps meanwhile', cta: 'Answer' };
    case 'sc': return { why: 'It hit the edge of what you authorized', cta: 'Decide' };
    case 'ci': return { why: 'It’s on work you own', cta: 'See the failing check' };
    case 'pc': return { why: 'It’s on work you own', cta: 'See the review' };
    case 'res': return { why: 'You own it; resolving is a person’s call', cta: 'Review the outcome' };
    case 'rr': return { why: 'You were asked to review on GitHub', cta: 'Open the PR' };
    default: return { why: 'For your information' };
  }
}

export const actionable = (a: Attn) => a.kind === 'respond' || a.kind === 'approve';

/** Suggestions (an agent's or a person's) that something be decided or edited: they live in Decide's Suggested group. */
export const isSuggestion = (a: Attn) => /^(o|ds|ls):/.test(a.id) && a.tab === 'decide';
/** What marks a tab: a filled dot when something there needs you, a ring when there's something new to look at. */
export function tabMark(items: Attn[], tab: string): 'needs' | 'new' | null {
  const here = items.filter((x) => x.tab === tab && x.kind !== 'info');
  return here.some(actionable) ? 'needs' : here.length ? 'new' : null;
}
