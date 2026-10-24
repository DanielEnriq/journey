import { h } from '../../../vendor/preact.js';
import { useState } from '../../../vendor/preact-hooks.js';
import { DecisionCard } from './DecisionCard.js';
import { Avatar } from './Presence.js';
import { ThreadStacks } from './ThreadStacks.js';
import type { RoomPanelProps, Stream } from './types.js';

/**
 * "Where we are": the right-hand panel of a room.
 *
 * Content only. The shell owns the column (width, collapse, the 40px chrome
 * band above it) exactly as it does for the left panel; this component fills
 * that column and scrolls inside it. Purely presentational: every fact comes in
 * through props and every act goes out through a callback.
 */
export function RoomPanel(props: RoomPanelProps) {
  const { people, meId, subtitle, goal, brief, decision, threads, setAside = [], streams } = props;

  return (
    <div class="rp-panel" aria-label="Where the room is">
      <div class="rp-rhead">
        <span class="rp-eyebrow">Where we are</span>
        {subtitle ? <span class="rp-sub">{subtitle}</span> : null}
      </div>

      {brief && brief.length ? (
        <div class="rp-since" role="status">
          <b>Since you were last here</b>
          <ul>
            {brief.map((item, i) => (
              <li key={i}>
                <span class={`rp-dot rp-dot-${item.tone}`} />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          <div class="rp-since-acts">
            <button class="rp-mini rp-ghost" type="button" onClick={props.onDismissBrief}>
              Dismiss
            </button>
            <button class="rp-mini" type="button" onClick={props.onShowBrief}>
              Show me
            </button>
          </div>
        </div>
      ) : null}

      {goal ? (
        <section class="rp-sec rp-first">
          <p class="rp-goal">{goal.text}</p>
          <span class="rp-goal-by">
            <Avatar person={people[goal.by]} size={16} />
            {goal.by === meId ? 'Your' : `${people[goal.by]?.name ?? 'Someone'}’s`} goal for this room
          </span>
        </section>
      ) : null}

      {decision ? (
        <section class="rp-sec">
          <span class="rp-rk">
            Decision<span>{decisionStatus(props)}</span>
          </span>
          <DecisionCard
            decision={decision}
            people={people}
            meId={meId}
            pointed={props.decisionPointed}
            onOpen={props.onOpenDecision}
            onSign={props.onSign}
            onProposeChange={props.onProposeChange}
            onHandOff={props.onHandOff}
          />
        </section>
      ) : null}

      <section class="rp-sec">
        <span class="rp-rk">
          Threads<span>{threads.length} open</span>
        </span>
        <ThreadStacks threads={threads} people={people} meId={meId} onReply={props.onReply} onShowAnchor={props.onShowAnchor} />
        {setAside.map((s) => (
          <div key={s.label} class="rp-setaside">
            <s>{s.label}</s> set aside, {s.reason}
          </div>
        ))}
      </section>

      <section class="rp-sec">
        <span class="rp-rk">
          Running<span>{streams.length} {streams.length === 1 ? 'stream' : 'streams'}</span>
        </span>
        {streams.map((s) => (
          <StreamRow key={s.id} stream={s} onShow={props.onShowStream} />
        ))}
        {props.children}
      </section>
    </div>
  );
}

function decisionStatus({ decision: d, meId }: RoomPanelProps): string {
  if (!d) return '';
  if (d.status === 'handed') return d.handedTo ? `with ${d.handedTo}` : 'handed off';
  if (d.status === 'amending') return 'being amended';
  const signed = d.approvers.filter((a) => a.signedVersion === d.version);
  if (signed.length === d.approvers.length) return 'agreed';
  const mine = d.approvers.find((a) => a.personId === meId);
  return mine && mine.signedVersion !== d.version ? 'waiting on you' : 'waiting on others';
}

function StreamRow({ stream: s, onShow }: { stream: Stream; onShow?: (id: string) => void }) {
  const [filesOpen, setFilesOpen] = useState(false);
  const dot = s.state === 'needs' ? 'needs' : s.state === 'done' ? 'live' : 'run';
  return (
    <div class={`rp-stream${s.state === 'needs' ? ' rp-needs' : ''}`}>
      <div class="rp-stream-top">
        <span class={`rp-dot rp-dot-${dot}`} />
        {s.title}
        <span class="rp-stream-who">{s.agent}</span>
      </div>
      <span class="rp-mono">{s.meta}</span>
      {s.line ? <span class="rp-stream-line">{s.line}</span> : null}
      {onShow || s.files?.length ? (
        <span class="rp-stream-acts">
          {onShow ? (
            <button class="rp-mini" type="button" onClick={() => onShow(s.id)}>
              See it on the canvas
            </button>
          ) : null}
          {s.files?.length ? (
            <button class="rp-mini rp-ghost" type="button" aria-expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>
              {filesOpen ? 'Hide files' : `${s.files.length} files changed`}
            </button>
          ) : null}
        </span>
      ) : null}
      {filesOpen && s.files ? (
        <div class="rp-files">
          {s.files.map((f) => (
            <div key={f.path} class="rp-file">
              <span class="rp-fn">{f.path}</span>
              <span class="rp-fa">+{f.added}</span>
              <span class="rp-fd">{f.removed ? `−${f.removed}` : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
