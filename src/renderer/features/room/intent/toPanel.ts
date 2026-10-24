import type { RoomController } from '../controller.js';
import type { RoomModel } from '../model.js';
import { shortAgo } from '../../../shared/time.js';
import type { Person, RoomPanelProps, Stream } from '../panel/types.js';
import type { Person as RoomPerson } from '../types.js';

// The room's state as the panel's view model. The panel takes plain props; this reads them off the
// controller and the derived model, so the live demo (signing, amending, handing off, the coding
// agent's progress) keeps driving the right column.

/** The viewer. The demo's call is always played as Daniel. */
const ME = 'daniel';

type Data = Omit<RoomPanelProps, `on${string}` | 'children'>;

export function toPanel(ctrl: RoomController, m: RoomModel): Data {
  const s = ctrl.state, d = s.dec;
  return {
    meId: ME,
    subtitle: m.roomSub,
    people: Object.fromEntries(Object.entries(m.people).map(([id, p]) => [id, toPerson(id, p)])),
    goal: m.goal,
    brief: s.brief ? [
      { tone: 'ask', text: 'John signed v3; it went to Claude Code with all three checks.' },
      { tone: 'quiet', text: 'Claude Code changed 4 files in its own worktree.' },
      { tone: 'live', text: '2 of 3 checks pass. Provider timeout is still running.' },
      { tone: 'needs', text: 'It has one question for the room, pinned on the provider.' },
    ] : undefined,
    decision: {
      id: 'decision',
      version: d.v,
      title: m.decisionText.what,
      verify: d.verify,
      proposedBy: 'john',
      approvers: [
        { personId: 'john', signedVersion: d.sig.john || null },
        { personId: ME, signedVersion: d.sig.daniel || null },
      ],
      status: s.handed ? 'handed' : d.amending ? 'amending' : m.approved ? 'agreed' : 'proposed',
      handedTo: s.handed ? s.handedTo : undefined,
      earlierVersions: d.history.length,
      presence: d.reviewing && d.sig.john !== d.v ? { personId: 'john', mode: 'reviewing' } : undefined,
    },
    decisionPointed: s.liveRef === 'decision',
    // Notes pinned to a part are the room's open threads.
    threads: s.notes.filter((n) => n.on).map((n) => ({
      id: n.id,
      kind: n.kind,
      anchor: { id: n.on, name: m.openRows.find((r) => r.id === n.id)?.onName ?? n.on },
      root: { id: n.id + '-root', authorId: n.suggested ? 'vowe' : n.who, body: n.text, ago: shortAgo(n.at ?? null) },
      replies: (s.replies[n.id] ?? []).map((r) => ({ id: r.id, authorId: r.who, body: r.body, ago: shortAgo(r.at), fresh: Date.now() - Date.parse(r.at) < 4000 })),
    })),
    setAside: [{ label: 'Distributed lock', reason: 'unless idempotency keys can’t cover a provider timeout.' }],
    streams: streams(ctrl, m),
  };
}

function streams(ctrl: RoomController, m: RoomModel): Stream[] {
  const s = ctrl.state;
  const running: Stream[] = m.running.map((w) => ({ id: w.title, title: w.title, agent: w.agent, meta: w.meta, state: w.state }));
  if (!s.handed) return running;
  return running.concat({
    id: 'handoff',
    title: 'Idempotent processing',
    agent: s.handedTo,
    meta: `${m.branch} · from decision v${s.dec.v}`,
    state: m.qOpen ? 'needs' : s.p >= 4 ? 'done' : 'running',
    line: m.idemLine,
    files: m.hasFiles ? m.files.map((f) => ({ path: f.path, added: Number(f.a) || 0, removed: Number(f.d.replace('−', '')) || 0 })) : undefined,
  });
}

/** The room's avatar class (`mav`, `mav peer`, `mav p2`, `mav vowe`) carries the person's tone. */
function toPerson(id: string, p: RoomPerson): Person {
  if (p.av.includes('vowe')) return { id, name: p.name, initials: p.initials, kind: 'agent' };
  const tone = p.av.includes('p3') ? 'peer3' : p.av.includes('p2') ? 'peer2' : p.av.includes('peer') ? 'peer' : 'me';
  return { id, name: p.name, initials: p.initials, kind: 'human', tone };
}
