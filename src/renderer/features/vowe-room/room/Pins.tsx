import { h, Fragment } from '../journey.js';
import type { VoweRecord } from '../contracts/model.js';
import { useNames } from '../state/directory.js';

/** Comments pinned on the canvas (Journey's RoomPin): who left it and the start of what they said. */
export function Pins({ rec, place, hidden, open }: { rec: VoweRecord; place: (x: number, y: number) => { x: number; y: number }; hidden: boolean; open(threadId: string): void }) {
  const { person } = useNames();
  if (hidden) return null;
  return (
    <>
      {rec.threads.filter((t) => t.at && t.status === 'open' && t.about.kind === 'part' && t.replies.length).map((t) => {
        const q = place(t.at!.x, t.at!.y);
        const a = person(t.replies[0].by);
        const body = t.replies[0].body;
        return (
          <button key={t.id} type="button" class="pin saved nx-pin" style={`transform: translate(${q.x - 10}px, ${q.y - 20}px)`} onClick={() => open(t.id)}>
            <span class={'head ' + (a.tone === 'me' ? '' : a.tone ?? '')}>{a.initials}</span>
            <span class="pin-note">{body.length > 26 ? body.slice(0, 24) + '…' : body}</span>
          </button>
        );
      })}
    </>
  );
}
