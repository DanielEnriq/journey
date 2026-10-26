import { h, Fragment } from '../journey.js';
import type { VoweRecord } from '../contracts/model.js';
import { useNames } from '../state/directory.js';

/** How far a pin's note can reach right of its point (avatar, gap, the note at its widest). */
const PIN_REACH = 270;

/** Where a comment pinned on a part shows in the view on screen. A pin is stored as one point with no view, so it
 * keeps that point while it still lies on its part as this view draws it; otherwise it sits at the part's top-right
 * corner here, and a view that leaves the part out shows no pin for it. Pins on the canvas itself keep their point. */
export function pinPoint(at: { x: number; y: number }, part: string, partRect: (component: string) => number[] | null): { x: number; y: number } | null {
  if (part === 'canvas') return at;
  const r = partRect(part);
  if (!r) return null;
  const [x, y, w, h] = r, slack = 24;
  if (at.x >= x - slack && at.x <= x + w + slack && at.y >= y - slack && at.y <= y + h + slack) return at;
  return { x: x + w - 18, y: y + 4 };
}

/** Comments pinned on the canvas (Journey's RoomPin): who left it and the start of what they said. Near the right
 * edge the note opens to the left of the avatar instead, so the pin stays where it was dropped and still reads. */
export function Pins({ rec, place, width, partRect, hidden, open }: { rec: VoweRecord; place: (x: number, y: number) => { x: number; y: number }; width: number; partRect: (component: string) => number[] | null; hidden: boolean; open(threadId: string): void }) {
  const { person } = useNames();
  if (hidden) return null;
  return (
    <>
      {rec.threads.filter((t) => t.at && t.status === 'open' && t.about.kind === 'part' && t.replies.length).map((t) => {
        const at = pinPoint(t.at!, t.about.id, partRect);
        if (!at) return null;
        const q = place(at.x, at.y);
        const a = person(t.replies[0].by);
        const body = t.replies[0].body;
        const flip = width > 0 && q.x + PIN_REACH > width;
        return (
          <button key={t.id} type="button" class={'pin saved nx-pin' + (flip ? ' nx-pin-flip' : '')} style={flip ? `transform: translate(${q.x + 10}px, ${q.y - 20}px) translateX(-100%)` : `transform: translate(${q.x - 10}px, ${q.y - 20}px)`} onClick={() => open(t.id)}>
            <span class={'head ' + (a.tone === 'me' ? '' : a.tone ?? '')}>{a.initials}</span>
            <span class="pin-note">{body.length > 26 ? body.slice(0, 24) + '…' : body}</span>
          </button>
        );
      })}
    </>
  );
}
