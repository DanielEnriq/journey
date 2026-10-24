import { h } from '../../../vendor/preact.js';
import { Avatar, PresenceTag, TypingDots, liveTone } from './Presence.js';
import type { Decision, Person, PersonId } from './types.js';

interface Props {
  decision: Decision;
  people: Record<PersonId, Person>;
  meId: PersonId;
  pointed?: boolean;
  onOpen?: (id: string) => void;
  onSign?: (id: string, version: number) => void;
  onProposeChange?: (id: string) => void;
  onHandOff?: (id: string) => void;
}

/**
 * The room's current decision, as a signed document.
 *
 * One interaction model, one place for each thing:
 *  - Every approver has a slot. The viewer's empty slot *is* the sign control
 *    ("Sign v2"); there is no second Sign button and no "your signature next"
 *    label. It is the only amber on the card, because it is the only thing
 *    that needs the viewer.
 *  - The bottom-right corner always holds the single next step: "Propose a
 *    change" while the viewer has not signed, "Hand off…" once everyone has.
 *  - The bottom-left says who is in the decision right now, or failing that,
 *    how much history sits under it. Earlier versions peek out as plates.
 */
export function DecisionCard({
  decision: d,
  people,
  meId,
  pointed = false,
  onOpen,
  onSign,
  onProposeChange,
  onHandOff,
}: Props) {
  const me = d.approvers.find((a) => a.personId === meId);
  const signedCurrent = (signed: number | null): boolean => signed === d.version;
  const everyoneSigned = d.approvers.every((a) => signedCurrent(a.signedVersion));
  const agreed = d.status === 'agreed' || d.status === 'handed' || everyoneSigned;
  const needsMe = d.status === 'proposed' && !!me && !signedCurrent(me.signedVersion);
  const canHandOff = agreed && d.status !== 'handed';
  const proposer = people[d.proposedBy];
  const stack = Math.min(2, d.earlierVersions);

  const cardCls =
    'rp-dc' +
    (agreed ? ' rp-agreed' : ' rp-proposed') +
    (pointed ? ' rp-pointed' : '') +
    liveTone(d.presence, people);

  return (
    <div class={`rp-dcwrap rp-stk${stack}`}>
      <div class={cardCls}>
        <button class="rp-dc-main" type="button" onClick={() => onOpen?.(d.id)}>
          <span class="rp-dc-head">
            <span class="rp-dc-v">v{d.version}</span>
            <Avatar person={proposer} size={20} />
            <span>
              <b>{proposer?.name ?? 'Someone'}</b> proposed{d.proposedAgo ? ` · ${d.proposedAgo}` : ''}
            </span>
            <span class="rp-dc-open">
              Open
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <path d="M6 4l4 4-4 4" />
              </svg>
            </span>
          </span>
          <span class="rp-dc-title">{d.title}</span>
          <span class="rp-dc-verify">
            <b>Verify</b>
            <span>{d.verify}</span>
          </span>
        </button>

        <div class="rp-dc-sigs">
          {d.approvers.map((a) => {
            const person = people[a.personId];
            const mine = a.personId === meId;
            const ok = signedCurrent(a.signedVersion);
            const reviewing = d.presence?.personId === a.personId && d.presence.mode === 'reviewing' && !ok;

            if (mine && needsMe) {
              return (
                <button
                  key={a.personId}
                  class="rp-sig rp-sig-you"
                  type="button"
                  title={`Sign v${d.version} as written`}
                  onClick={() => onSign?.(d.id, d.version)}
                >
                  <Avatar person={person} size={18} pending />
                  Sign v{d.version}
                </button>
              );
            }

            const name = mine ? 'You' : (person?.name ?? 'Someone');
            const stale = !ok && a.signedVersion !== null;
            const text = ok
              ? `${name} signed`
              : reviewing
                ? `${name} reviewing`
                : stale
                  ? `${name} · signed v${a.signedVersion}`
                  : d.status === 'amending' && mine
                    ? 'You · amending'
                    : `${name} · not yet`;
            return (
              <span key={a.personId} class={`rp-sig${ok ? ' rp-ok' : reviewing ? '' : ' rp-wait'}`}>
                <Avatar person={person} size={18} />
                {text}
                {reviewing ? <TypingDots /> : null}
                {ok ? <span class="rp-sig-mark" aria-label="signed">✓</span> : null}
              </span>
            );
          })}
        </div>

        <div class="rp-dc-foot">
          {d.presence ? (
            <PresenceTag presence={d.presence} people={people} />
          ) : (
            <span class="rp-dc-hist">
              {d.status === 'handed' && d.handedTo
                ? `Handed to ${d.handedTo}`
                : d.earlierVersions > 0
                  ? `${d.earlierVersions} earlier version${d.earlierVersions > 1 ? 's' : ''}`
                  : 'First version'}
            </span>
          )}
          {needsMe ? (
            <button class="rp-link rp-end" type="button" onClick={() => onProposeChange?.(d.id)}>
              Propose a change
            </button>
          ) : null}
          {canHandOff ? (
            <button class="rp-mini rp-end" type="button" onClick={() => onHandOff?.(d.id)}>
              Hand off…
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
