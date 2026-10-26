import type { VoweRecord } from '../contracts/model.js';
import type { PartMarks } from '../canvas/Surface.js';

/** What hangs on each canvas part, from the record: its open threads, the decision governing it, the work and
 *  PRs on it, and what changed since you were here. The canvas draws these as marks on the parts. */
export function marksOf(rec: VoweRecord): Record<string, PartMarks> {
  const out: Record<string, PartMarks> = {};
  const at = (id: string) => (out[id] ??= { threads: 0 });
  for (const t of rec.threads) if (t.status === 'open' && t.about.kind === 'part') at(t.about.id).threads++;
  const cur = rec.decisions.filter((d) => d.state === 'agreed').pop();
  if (cur) cur.parts.forEach((c) => { at(c).governed = `v${cur.version}`; });
  for (const w of rec.work) {
    for (const c of w.parts) {
      const prs = w.prs.filter((p) => p.parts.includes(c) && p.state !== 'closed');
      if (prs.length) at(c).prs = prs.map((p) => ({ id: '#' + p.num, state: p.checks.some((k) => k.state === 'fail') ? 'review' : p.state }));
      else if (w.state === 'running' && w.doer) at(c).agent = { text: `${w.doer.name} · changing` };
    }
    if (w.question && !w.question.answer && w.doer) at(w.question.about).agent = { text: `${w.doer.name} asks`, needs: true };
  }
  for (const s of rec.since?.items ?? []) for (const c of s.parts ?? []) if (!at(c).since) at(c).since = s.mark ?? s.text;
  return out;
}
