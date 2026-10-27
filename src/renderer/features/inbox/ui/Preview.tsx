import { h, Fragment, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import type { Scene } from '../../../../shared/canvas/index.js';
import { wordDiff } from '../../../../shared/vowe/plan.js';
import { IconButton, Spinner } from '../../../ui/components.js';
import { Icon } from '../../../ui/icons.js';
import { SceneGlimpse } from '../../canvas/SceneGlimpse.js';
import type { Decision, Line, Thread, VoweRecord, Work } from '../../vowe-room/contracts/model.js';
import { Diff } from '../../vowe-room/desk/Doc.js';
import type { PersonId } from '../../vowe-room/journey.js';
import { SOURCE_LABEL, SOURCE_TODAY, type InboxItem } from '../model.js';
import type { InboxSource, ItemContext } from '../source.js';
import { bodyKind, canMarkDone, canOpen } from './body.js';
import { Face, ItemMenu, nameIn, type ItemMenuActs, type People } from './bits.js';
import { ago } from './time.js';

// The reading page for one Inbox item: enough of its context to understand it and, where it's a small, safe
// act, to do it here (sign, answer, reply, authorize, allow, join). Anything bigger opens the room at the exact
// place. The bar: where it lives, then Snooze, Done (not for Needs you: those leave when discharged), Follow,
// and Open in room. Every act goes through the InboxSource; a refusal is shown where it was asked for.

export interface PreviewProps {
  it: InboxItem;
  source: InboxSource;
  now: string;
  me: PersonId | null;
  people: People;
  acts: ItemMenuActs;
  /** Set when the item no longer needs you: how it was resolved. */
  resolvedHow?: string;
  /** An accepted invitation's room. */
  onJoined(roomId: string): void;
}

/** The item's room record and canvas, read once per room through the source (it caches them). */
function useItemContext(source: InboxSource, roomId: string): { ctx: ItemContext | null; failed: boolean } {
  const [st, set] = useState<{ room: string; ctx: ItemContext | null; failed: boolean }>({ room: roomId, ctx: null, failed: false });
  useEffect(() => {
    let live = true;
    set({ room: roomId, ctx: null, failed: false });
    source.context(roomId).then((ctx) => { if (live) set({ room: roomId, ctx, failed: false }); }, () => { if (live) set({ room: roomId, ctx: null, failed: true }); });
    return () => { live = false; };
  }, [source, roomId]);
  return st.room === roomId ? st : { ctx: null, failed: false };
}

/** Runs an act, shows it busy, and keeps its refusal to show in place. */
function useAct() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (key: string, f: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    f().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(null));
  };
  return { busy, error, run };
}

export function Preview(p: PreviewProps) {
  const { it } = p;
  const [menu, setMenu] = useState(false);
  const { ctx, failed } = useItemContext(p.source, it.room.id);
  const following = it.tier === 'following';
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo?.(0, 0); }, [it.id]);
  return (
    <>
      <div class="vi-bar">
        <div class="vi-path" aria-label="Where it lives">
          {it.path.map((x, i) => <Fragment key={i}>{i ? <i aria-hidden="true">/</i> : null}{i === 0 ? <b>{x}</b> : <span>{x}</span>}</Fragment>)}
        </div>
        <div class="vi-bar-acts">
          <span class="vi-menuwrap">
            <IconButton icon="snooze" label="Snooze" tip="Snooze" aria-haspopup="menu" aria-expanded={menu} active={menu} onClick={() => setMenu(!menu)} />
            {menu ? <ItemMenu it={it} now={p.now} only="snooze" acts={p.acts} onClose={() => setMenu(false)} /> : null}
          </span>
          {canMarkDone(it) && !p.resolvedHow ? <IconButton icon="check" label="Done" tip="Done · E" onClick={() => p.acts.done(it)} /> : null}
          <IconButton icon={following ? 'unfollow' : 'follow'} label={following ? 'Unfollow' : 'Follow'} active={following} onClick={() => p.acts.follow(it, !following)} />
          {canOpen(it) ? (
            <>
              <span class="vi-sep" aria-hidden="true" />
              <button type="button" class="v-btn v-btn-sm vi-open" data-tip={it.anchor.label} data-tip-end="" onClick={() => p.acts.open(it)} aria-label={`Open in room: ${it.anchor.label}`}>
                Open in room<kbd class="v-kbd">↵</kbd>
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div class="vi-page-body" ref={body} tabIndex={-1}>
        <article class="vi-doc">
          {p.resolvedHow ? <div class="vi-done"><Icon name="check" />{p.resolvedHow}</div> : null}
          <Body {...p} rec={ctx?.record ?? null} loading={!ctx && !failed} />
          {failed ? <p class="vi-unreal"><Icon name="info" />Couldn’t read {it.room.name}’s record just now. Open the room to see it.</p> : null}
          <Where it={it} scene={ctx?.scene ?? null} />
          {!SOURCE_TODAY[it.source] ? <p class="vi-unreal"><Icon name="info" />From {SOURCE_LABEL[it.source]}.</p> : null}
        </article>
      </div>
    </>
  );
}

function Where({ it, scene }: { it: InboxItem; scene: Scene | null }) {
  if (!scene || !it.anchor.parts?.length) return null;
  return (
    <div class="vi-block">
      <div class="vi-block-h">Where it lives</div>
      <figure class="vi-glimpse">
        <SceneGlimpse scene={scene} lit={it.anchor.parts} height={220} />
        <figcaption><Icon name="canvas" />Opens at {it.anchor.label}</figcaption>
      </figure>
    </div>
  );
}

type BodyProps = PreviewProps & { rec: VoweRecord | null; loading: boolean };

function Body(p: BodyProps) {
  const { it, rec } = p;
  const kind = bodyKind(it);
  if (rec) {
    if (kind === 'sign') { const d = rec.decisions.find((x) => x.id === it.subject.id); if (d) return <SignDecision {...p} d={d} rec={rec} />; }
    if (kind === 'question') { const w = rec.work.find((x) => x.question?.id === it.subject.id) ?? rec.work.find((x) => x.id === it.subject.id); if (w?.question) return <AgentQuestion {...p} w={w} />; }
    if (kind === 'thread') { const t = rec.threads.find((x) => x.id === it.subject.id); if (t) return <Conversation {...p} t={t} />; }
    if (kind === 'authorize' || kind === 'allow') { const w = rec.work.find((x) => x.id === it.subject.id); if (w) return <PlanAsk {...p} w={w} allow={kind === 'allow'} />; }
  }
  if (kind === 'invitation') return <Invitation {...p} />;
  return <Generic {...p} />;
}

function Kicker({ tone, children, when }: { tone?: 'needs' | 'agent'; children: ComponentChildren; when: string }) {
  return <div class={'vi-kicker' + (tone ? ` is-${tone}` : '')}>{children}<i aria-hidden="true">·</i><span class="vi-when">{when}</span></div>;
}

function Failure({ error }: { error: string | null }) {
  return error ? <p class="vi-error" role="alert"><Icon name="warn" />{error}</p> : null;
}

const LINE_WORD: Record<Line['kind'], string> = { decide: 'Decides', because: 'Because', assume: 'Assumes', open: 'Open', scope: 'Scope' };

function SignDecision({ it, d, rec, now, me, people, source, loading }: BodyProps & { d: Decision; rec: VoweRecord }) {
  const name = nameIn(people, me);
  const [changes, setChanges] = useState<string | null>(null);
  const act = useAct();
  const prev = rec.decisions.find((x) => x.title === d.title && x.version === d.version - 1) ?? (d.revises ? rec.decisions.find((x) => x.version === d.revises!.version && x.id !== d.id && x.title === d.title) : undefined);
  const signedPrev = !!me && !!prev?.approvers.some((a) => a.who === me && a.signed === prev.version);
  const mine = d.approvers.find((a) => a.who === me);
  const signed = mine?.signed === d.version;
  void loading;
  return (
    <>
      <Kicker tone="needs" when={ago(it.waitingSince ?? it.at, now)}>Needs your signature</Kicker>
      <h2 class="vi-title">{d.title}</h2>
      <p class="vi-lede"><b>{name(d.by.who)}</b> asked you to sign <b>v{d.version}</b>.{d.revises ? <> It revises v{d.revises.version}{signedPrev ? ', which you signed' : ''}: {d.revises.why}</> : null}</p>
      <div class="vi-signers" aria-label="Signatures">
        {d.approvers.map((a) => (
          <span key={a.who} class={'vi-signer' + (a.who === me && a.signed !== d.version ? ' is-you' : '')}>
            <Face id={a.who} people={people} size={20} />{name(a.who)}
            {a.signed === d.version ? <span class="vi-ok">signed</span> : a.changes ? <span>asked for changes</span> : a.who === me ? <span>waiting on you</span> : <span>not yet</span>}
          </span>
        ))}
      </div>
      {it.blocks ? <div class="vi-block"><div class="vi-blocks"><Icon name="info" /><span><b>Waiting on this:</b> {it.blocks}.</span></div></div> : null}
      <div class="vi-block">
        <div class="vi-block-h">The decision{prev ? <em>changes since v{prev.version} marked</em> : null}</div>
        <ul class="vi-lines">
          {d.lines.map((l) => {
            const old = prev?.lines.find((x) => x.id === l.id);
            return (
              <li key={l.id}>
                <span class="vi-k">{LINE_WORD[l.kind]}</span>
                <span>
                  {old && old.text !== l.text ? <Diff a={old.text} b={l.text} diff={wordDiff} /> : l.text}
                  {prev && !old ? <span class="vi-newmark">new in v{d.version}</span> : null}
                  {l.overturned ? <span class="vi-flag"><Icon name="info" /><span><b>{name(l.overturned.by)} challenged this:</b> {l.overturned.why}</span></span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {signed ? <div class="vi-done"><Icon name="check" />You signed v{d.version}{d.state === 'agreed' ? '. It’s agreed.' : '.'}</div>
        : changes !== null ? (
          <div class="vi-compose">
            <textarea aria-label="What should change" placeholder="What should change?" value={changes} onInput={(e) => setChanges(e.currentTarget.value)} ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus(); } }} />
            <div class="vi-crow">
              <button type="button" class="v-btn v-btn-quiet v-btn-sm" onClick={() => setChanges(null)}>Cancel</button>
              <button type="button" class="v-btn v-btn-ink v-btn-sm" disabled={!changes.trim() || !!act.busy} onClick={() => act.run('changes', () => source.requestChanges(it, changes.trim()))}>{act.busy === 'changes' ? 'Sending…' : 'Request changes'}</button></div>
          </div>
        ) : (
          <div class="vi-acts">
            <button type="button" class="v-btn v-btn-ink" disabled={!!act.busy} onClick={() => act.run('sign', () => source.sign(it))}>{act.busy === 'sign' ? 'Signing…' : `Sign v${d.version}`}</button>
            <button type="button" class="v-btn" disabled={!!act.busy} onClick={() => setChanges('')}>Request changes</button>
          </div>
        )}
      <Failure error={act.error} />
    </>
  );
}

function AgentQuestion({ it, w, now, me, people, source }: BodyProps & { w: Work }) {
  const name = nameIn(people, me);
  const q = w.question!;
  const [pick, setPick] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const act = useAct();
  const n = q.step ? w.plan.findIndex((s) => s.id === q.step) + 1 : 0;
  const step = n ? w.plan[n - 1] : undefined;
  const asker = w.doer?.name ?? name(it.actor);
  const [head, ...rest] = q.text.split(/(?<=\?)\s/);
  const text = pick !== null ? q.options[pick] + (note.trim() ? ` · ${note.trim()}` : '') : note.trim();
  const mine = q.for === me;
  return (
    <>
      <Kicker tone="agent" when={ago(it.waitingSince ?? it.at, now)}>{asker} {mine ? 'is waiting on you' : 'asked'}</Kicker>
      <h2 class="vi-title is-q">{head}</h2>
      {rest.length ? <p class="vi-lede">{rest.join(' ')}</p> : null}
      <dl class="vi-facts">
        {step ? <><dt>Paused at</dt><dd>Step {n}: {step.text}</dd></> : null}
        <dt>The plan</dt><dd>{w.title} · {w.plan.filter((s) => s.state === 'done').length} of {w.plan.length} steps done</dd>
        <dt>Owner</dt><dd>{name(w.owner)}</dd>
      </dl>
      {q.answer ? <div class="vi-done"><Icon name="check" />{name(q.answer.by)} answered: {q.answer.text}</div> : mine ? (
        <div class="vi-block">
          <div class="vi-block-h">Your answer</div>
          {q.options.length ? (
            <div class="vi-opts" role="radiogroup" aria-label="Your answer">
              {q.options.map((o, i) => (
                <button key={o} type="button" role="radio" aria-checked={pick === i} class="vi-opt" onClick={() => setPick(i)}>
                  <span class="vi-radio" aria-hidden="true" /><span>{o}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div class="vi-compose">
            <textarea aria-label={q.options.length ? 'A note with your answer' : 'Your answer'} placeholder={q.options.length ? 'Note' : `Answer ${asker}…`} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
            <div class="vi-crow">
              <button type="button" class="v-btn v-btn-ink v-btn-sm" disabled={!text || !!act.busy} onClick={() => act.run('answer', () => source.answer(it, text))}>{act.busy ? 'Answering…' : 'Answer'}</button></div>
          </div>
        </div>
      ) : null}
      <Failure error={act.error} />
    </>
  );
}

const refText = (s: string) => s.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1');

function Conversation({ it, t, now, me, people, source }: BodyProps & { t: Thread }) {
  const name = nameIn(people, me);
  const [body, setBody] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const act = useAct();
  const needs = it.tier === 'needs';
  const firstNew = t.replies.findIndex((r) => r.fresh && r.by !== me);
  useEffect(() => { if (needs) ta.current?.focus({ preventScroll: true }); }, [it.id]);
  const send = () => { const b = body.trim(); if (b && !act.busy) act.run('reply', () => source.reply(it, b).then(() => setBody(''))); };
  const last = t.replies[t.replies.length - 1];
  return (
    <>
      <Kicker tone={needs ? 'needs' : undefined} when={ago(needs ? it.waitingSince ?? it.at : it.at, now)}>{needs ? `${name(it.actor)} asked you` : it.raised ?? 'A conversation you’re in'}</Kicker>
      <h2 class="vi-title">{t.title && !['Question', 'Note'].includes(t.title) ? t.title : `On ${/^the /i.test(t.about.name) ? '' : 'the '}${t.about.name}`}</h2>
      {t.about.kind === 'line' && t.quote ? <p class="vi-lede"><b>“{t.quote}”</b></p> : null}
      <div class="vi-block vi-convo">
        {t.replies.map((r, i) => (
          <Fragment key={r.id}>
            {i === firstNew && i > 0 ? <div class="vi-newline">New</div> : null}
            <div class={'vi-msg' + (firstNew > 0 && i < firstNew ? ' is-old' : '')}>
              <Face id={r.by} people={people} size={24} />
              <div class="vi-b"><div class="vi-n"><b>{name(r.by)}</b><span>{r.ago}</span></div>{refText(r.body)}</div>
            </div>
          </Fragment>
        ))}
      </div>
      <div class="vi-compose is-reply">
        <textarea ref={ta} aria-label="Reply" placeholder={`Reply to ${name(it.actor ?? last?.by)}…`} value={body} onInput={(e) => setBody(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div class="vi-crow"><button type="button" class="v-btn v-btn-ink v-btn-sm vi-open" disabled={!body.trim() || !!act.busy} onClick={send}>{act.busy ? 'Sending…' : <>Reply<kbd class="v-kbd">⌘↵</kbd></>}</button></div>
      </div>
      <Failure error={act.error} />
    </>
  );
}

function PlanAsk({ it, w, allow, now, me, people, source }: BodyProps & { w: Work; allow: boolean }) {
  const name = nameIn(people, me);
  const act = useAct();
  return (
    <>
      <Kicker tone="needs" when={ago(it.waitingSince ?? it.at, now)}>{allow ? 'Asks for more scope' : 'Needs your authorization'}</Kicker>
      <h2 class="vi-title">{w.title}</h2>
      <p class="vi-lede">{it.why}.</p>
      {allow && w.scopeAsk ? (
        <div class="vi-block"><div class="vi-blocks"><Icon name="info" /><span><b>{w.scopeAsk.by} asks:</b> {w.scopeAsk.text} <span class="vi-quiet">Adds: {w.scopeAsk.adds}</span></span></div></div>
      ) : null}
      <div class="vi-block">
        <div class="vi-block-h">Plan v{w.version}<em>{w.doer ? `${w.doer.name} does it` : 'nobody chosen yet'} · {name(w.owner)} owns it</em></div>
        <ol class="vi-steps">{w.plan.map((s) => <li key={s.id} class={s.state === 'done' ? 'is-done' : ''}>{s.text}</li>)}</ol>
      </div>
      {w.may.length || w.mayNot.length || w.askWhen.length ? (
        <dl class="vi-facts">
          {w.may.length ? <><dt>May</dt><dd>{w.may.join(' · ')}</dd></> : null}
          {w.mayNot.length ? <><dt>May not</dt><dd>{w.mayNot.join(' · ')}</dd></> : null}
          {w.askWhen.length ? <><dt>Asks when</dt><dd>{w.askWhen.join(' · ')}</dd></> : null}
        </dl>
      ) : null}
      {allow ? (
        <div class="vi-acts">
          <button type="button" class="v-btn v-btn-ink" disabled={!!act.busy} onClick={() => act.run('allow', () => source.allowScope(it, true))}>{act.busy === 'allow' ? 'Allowing…' : 'Allow'}</button>
          <button type="button" class="v-btn" disabled={!!act.busy} onClick={() => act.run('deny', () => source.allowScope(it, false))}>Keep the plan as it is</button>
        </div>
      ) : w.authorized ? <div class="vi-done"><Icon name="check" />{name(w.authorized.by)} authorized it ({w.authorized.scope}).</div> : (
        <div class="vi-acts">
          <button type="button" class="v-btn v-btn-ink" disabled={!!act.busy} onClick={() => act.run('authorize', () => source.authorize(it))}>{act.busy ? 'Authorizing…' : `Authorize plan v${w.version}`}</button>
        </div>
      )}
      <Failure error={act.error} />
    </>
  );
}

function Invitation({ it, now, me, people, source, onJoined }: BodyProps) {
  const name = nameIn(people, me);
  const act = useAct();
  return (
    <>
      <Kicker tone="needs" when={ago(it.at, now)}>An invitation</Kicker>
      <h2 class="vi-title">{it.room.name}</h2>
      <p class="vi-lede">{it.actor ? <><b>{name(it.actor)}</b> invited you. </> : null}{it.why}.</p>
      {it.excerpt ? <div class="vi-block vi-convo"><div class="vi-msg"><Face id={it.excerpt.by} people={people} /><div class="vi-b"><div class="vi-n"><b>{name(it.excerpt.by)}</b></div>{it.excerpt.text}</div></div></div> : null}
      <div class="vi-acts">
        <button type="button" class="v-btn v-btn-ink" disabled={!!act.busy} onClick={() => act.run('yes', () => source.acceptInvitation(it, true).then((id) => { if (id) onJoined(id); }))}>{act.busy === 'yes' ? 'Joining…' : 'Join the room'}</button>
        <button type="button" class="v-btn" disabled={!!act.busy} onClick={() => act.run('no', () => source.acceptInvitation(it, false))}>Decline</button>
      </div>
      <Failure error={act.error} />
    </>
  );
}

function Generic({ it, now, me, people, rec, loading }: BodyProps) {
  const name = nameIn(people, me);
  return (
    <>
      <Kicker tone={it.tier === 'needs' ? 'needs' : undefined} when={ago(it.at, now)}>{it.tier === 'needs' ? 'Needs you' : it.tier === 'activity' ? 'In your rooms' : it.raised ?? 'Following'}</Kicker>
      <h2 class="vi-title is-sm">{it.headline}</h2>
      {it.why === `In ${it.room.name}` ? null : <p class="vi-lede">{it.why}.</p>}
      {it.excerpt ? <div class="vi-block vi-convo"><div class="vi-msg"><Face id={it.excerpt.by} people={people} /><div class="vi-b"><div class="vi-n"><b>{name(it.excerpt.by)}</b></div>{refText(it.excerpt.text)}</div></div></div> : null}
      {it.progress ? (
        <div class="vi-block"><div class="vi-progress is-lg" aria-label={`${it.progress.done} of ${it.progress.of} steps done`}>{Array.from({ length: it.progress.of }, (_, i) => <i key={i} class={i < it.progress!.done ? 'is-done' : i === it.progress!.done ? 'is-wait' : ''} />)}</div></div>
      ) : null}
      {it.digest?.length && it.events.length > 1 ? <p class="vi-lede is-sm">{it.digest.map((d) => `${d.n} ${d.label}`).join(' · ')}</p> : null}
      {it.events.length > 1 ? (
        <div class="vi-block">
          <div class="vi-block-h">{it.events.length} updates</div>
          <ul class="vi-events">{it.events.map((e) => <li key={e.id}><i aria-hidden="true" /><span>{e.text}</span><em>{ago(e.at, now)}</em></li>)}</ul>
        </div>
      ) : null}
      {loading && !rec && bodyKind(it) !== 'generic' && bodyKind(it) !== 'invitation' ? <p class="vi-quiet vi-loading"><Spinner label="Reading the room" /> Reading {it.room.name}…</p> : null}
    </>
  );
}
