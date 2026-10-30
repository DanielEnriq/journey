import { h } from '../../vendor/preact.js';
import { useEffect, useRef } from '../../vendor/preact-hooks.js';
import type { AgentApprovalRequest, AgentError, AgentEvent, JourneyApi, RoomAgentReply } from '../../../shared/api.js';
import { snapshotOf } from '../../../shared/canvas/index.js';
import { Store, useStore } from '../../shared/store.js';
import { agentOverIpc, type VoiceTurnHandle } from '../../shared/vowe-voice.js';
import type { CanvasClient } from './client.js';

// Asking Vowe in a room by text: the question, what it's about (what you selected or circled), the
// streamed answer, approvals, and what the canvas did with Vowe's requests, in the call's captions
// panel. The turn runs in this person's main process, on their own model sign-in (src/assistant), and
// its canvas requests run on the room's canvas there (main/vowe-canvas.ts); this only shows them.

export interface AskState {
  open: boolean;
  /** Names of what the next or current question is about. */
  about: { selected: string[]; circled: string[]; names: string[] };
  question: string | null;
  answer: string;
  status: 'idle' | 'thinking' | 'answering' | 'done' | 'stopped' | 'failed';
  error: AgentError | null;
  approval: AgentApprovalRequest | null;
  /** What the canvas did that people should know: a proposal waiting on them, or a request it declined. */
  canvas: string[];
  /** Which provider answered, and how it's billed. */
  provider: string | null;
  /** The thread Vowe is writing feedback for, while it does. */
  reviewing: string | null;
  /** The tool call it's in the middle of, as the model made it; null between calls. */
  doing: { tool: string; input: unknown } | null;
}

const NOTHING = { selected: [], circled: [], names: [] };

export class AskVowe {
  readonly store = new Store<AskState>({ open: false, about: NOTHING, question: null, answer: '', status: 'idle', error: null, approval: null, canvas: [], provider: null, reviewing: null, doing: null });
  private conversationId: string | null = null;
  private turn: VoiceTurnHandle | null = null;
  private recent: { speaker: string; text: string }[] = [];

  constructor(
    private readonly roomId: string,
    private readonly client: CanvasClient,
    private readonly me: () => { userId: string | null; name: string | null },
    private readonly agent: JourneyApi['agent'] = window.journey.agent,
  ) {}

  get busy() { const s = this.store.state; return s.status === 'thinking' || s.status === 'answering' || s.reviewing !== null; }

  /** Opens the panel about what was selected or circled (or nothing: the whole canvas). */
  open(about: AskState['about'] = NOTHING) {
    if (this.busy) return;
    this.store.setState({ open: true, about });
  }

  close() { this.stop(); this.store.setState({ open: false }); }

  ask(text: string) {
    const question = text.trim();
    const { userId, name } = this.me();
    if (!question || this.busy) return;
    if (!userId) { this.store.setState({ status: 'failed', error: { code: 'not-authorized', message: 'Sign in to Vowe to ask in a room.', retryable: false } }); return; }
    const { about } = this.store.state;
    this.store.setState({ question, answer: '', status: 'thinking', error: null, approval: null, canvas: [], doing: null });
    this.turn = agentOverIpc(this.agent).ask({
      roomId: this.roomId,
      participant: { userId, name },
      question,
      recentTurns: this.recent.slice(-6),
      canvas: snapshotOf(this.client.store.state.doc, about),
      conversationId: this.conversationId,
      source: 'text',
    }, (e) => this.on(e, question, name));
  }

  stop() { if (this.busy) this.turn?.cancel(); }

  /** What you just said to your Vowe in the call: its turn (CallVoice runs it) shows here like a typed ask. */
  heard(question: string) {
    this.store.setState({ open: true, question, answer: '', status: 'thinking', error: null, approval: null, canvas: [], doing: null });
  }

  /**
   * What you said in the call that your Vowe chimed in on, unasked: followed like heard(), but the panel
   * stays shut, so the captions keep showing the conversation.
   */
  overheard(question: string) {
    this.store.setState({ question, answer: '', status: 'thinking', error: null, approval: null, canvas: [], doing: null });
  }

  /**
   * A voice turn's events: the answer as it's spoken, approvals it waits on, what the canvas did. One
   * that needs you (an approval) or failed opens the panel, so it's never waiting or failing out of sight.
   */
  follow(e: AgentEvent) {
    if (this.store.state.reviewing) return;
    this.on(e, this.store.state.question ?? '', this.me().name);
    if (e.type === 'approval.requested' || e.type === 'turn.failed') this.store.setState({ open: true });
  }

  /**
   * Vowe's feedback on a comment just pinned: a turn in the same conversation (so what this person
   * allowed still holds), whose answer `post` saves as Vowe's reply in the comment's thread. Its
   * question isn't shown; an approval it needs opens the panel. Skipped while another turn runs.
   */
  feedback(threadId: string, comment: string, on: { component: string; name: string } | null, post: (text: string) => Promise<void>) {
    const { userId, name } = this.me();
    if (!userId || this.busy) return;
    const where = on ? `on ${on.name}` : 'on the canvas';
    const question = `${name ?? 'Someone'} just pinned this comment ${where}: "${comment}". Reply in that comment's thread. If it asks you something, answer it; when it asks for code, show the lines in a fenced block. Otherwise give brief, specific feedback (one to three sentences): whether it holds up against the system on the canvas, and what to check or change. Point at the part if it helps. Don't restate the comment.`;
    this.store.setState({ reviewing: threadId, error: null, doing: null });
    let text = '';
    this.turn = agentOverIpc(this.agent).ask({
      roomId: this.roomId,
      participant: { userId, name },
      question,
      recentTurns: this.recent.slice(-6),
      canvas: snapshotOf(this.client.store.state.doc, on ? { selected: [on.component], circled: [] } : NOTHING),
      conversationId: this.conversationId,
      source: 'text',
    }, (e) => {
      const s = this.store.state;
      switch (e.type) {
        case 'turn.started': this.conversationId = e.conversationId; return;
        case 'text.final': text = e.text; return;
        case 'tool.started': return this.store.setState({ doing: { tool: e.call.name, input: e.call.input } });
        case 'tool.finished': return this.store.setState({ doing: null });
        case 'approval.requested': return this.store.setState({ open: true, approval: e.request });
        case 'canvas.applied': if (!e.result.ok) this.store.setState({ canvas: s.canvas.concat([`The canvas didn’t take one of Vowe’s changes: ${e.result.error.message}`]) }); return;
        case 'turn.completed': case 'turn.cancelled': case 'turn.failed': {
          this.turn = null;
          const said = (e.reply.text || text).trim();
          this.store.setState({ reviewing: null, approval: null, doing: null, ...(e.type === 'turn.failed' ? { error: e.error } : {}) });
          if (e.type === 'turn.completed' && said) {
            this.recent.push({ speaker: name ?? 'Me', text: `Comment ${where}: ${comment}` }, { speaker: 'Vowe', text: said });
            void post(said.slice(0, 4000)).catch(() => {});
          }
          return;
        }
      }
    });
  }

  answer(approved: boolean) {
    const a = this.store.state.approval;
    if (!a) return;
    this.store.setState({ approval: null });
    void this.agent.approve(a.id, approved);
  }

  private on(e: AgentEvent, question: string, name: string | null) {
    const s = this.store.state;
    switch (e.type) {
      case 'turn.started':
        this.conversationId = e.conversationId;
        this.store.setState({ provider: `${e.provider.name}${e.provider.billing === 'chatgpt-plan' ? ' · your ChatGPT plan' : ''}` });
        return;
      case 'text.delta': return this.store.setState({ status: 'answering', answer: s.answer + e.delta });
      case 'text.final': return this.store.setState({ answer: e.text });
      case 'tool.started': return this.store.setState({ doing: { tool: e.call.name, input: e.call.input } });
      case 'tool.finished': return this.store.setState({ doing: null });
      case 'approval.requested': return this.store.setState({ approval: e.request });
      case 'canvas.applied': {
        const r = e.result;
        const line = !r.ok ? `The canvas didn’t take one of Vowe’s changes: ${r.error.message}`
          : r.applied === 'proposed' && r.name === 'propose_change' ? `${r.message} Accept or reject it on the canvas.`
          : null;
        if (line) this.store.setState({ canvas: s.canvas.concat([line]) });
        return;
      }
      case 'turn.completed': return this.end(e.reply, question, name, 'done');
      case 'turn.cancelled': return this.end(e.reply, question, name, 'stopped');
      case 'turn.failed': this.store.setState({ error: e.error }); return this.end(e.reply, question, name, 'failed');
    }
  }

  private end(reply: RoomAgentReply, question: string, name: string | null, status: AskState['status']) {
    this.turn = null;
    if (status === 'done') this.recent.push({ speaker: name ?? 'Me', text: question }, { speaker: 'Vowe', text: reply.text });
    this.store.setState({ status, approval: null, doing: null, ...(reply.text ? { answer: reply.text } : {}) });
  }
}

/** The answer's **bold** as bold; the rest as written (no other markdown is rendered). */
function emphasis(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
}

/** The ask, in the call's captions panel. */
export function AskVowePanel({ ask }: { ask: AskVowe }) {
  const s = useStore(ask.store);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (s.open) input.current?.focus(); }, [s.open, s.about]);
  if (!s.open) return null;
  const busy = s.status === 'thinking' || s.status === 'answering';
  const about = s.about.names.length ? s.about.names.join(', ') : null;
  const submit = (e: Event) => {
    e.preventDefault();
    const el = input.current;
    if (el && el.value.trim()) { ask.ask(el.value); el.value = ''; }
  };
  return (
    <div class="captions ask-vowe" role="region" aria-label="Ask Vowe" aria-live="polite">
      {s.question && <div class="prevline">You · {s.question}</div>}
      {s.question && !(s.status === 'failed' && !s.answer) && (
        <div class="curline">
          <span class="spk">Vowe</span>
          <span class="words">{s.answer ? emphasis(s.answer) : s.status === 'thinking' ? 'Thinking…' : '…'}</span>
          {s.status === 'stopped' && <span class="cut">— stopped</span>}
        </div>
      )}
      {s.error && (
        <div class="curline" role="alert">
          <span class="spk">Not answered</span>
          <span class="words">{s.error.message}</span>
          {s.error.manageUrl && <a class="mini ghost" href={s.error.manageUrl} target="_blank" rel="noreferrer">Manage usage</a>}
        </div>
      )}
      {s.approval && (
        <div class="curline">
          <span class="spk">Allow?</span>
          <span class="words"><b>{s.approval.title}</b> {s.approval.detail}</span>
          <span class="acts">
            <button class="mini ask" type="button" onClick={() => ask.answer(true)}>Allow</button>
            <button class="mini ghost" type="button" onClick={() => ask.answer(false)}>Not now</button>
          </span>
        </div>
      )}
      {s.canvas.map((line, i) => <div key={i} class="prevline">{line}</div>)}
      <form class="curline" onSubmit={submit}>
        <span class="spk">You</span>
        <label class="ask-field"><span class="sr">Ask Vowe</span>
          <input ref={input} type="text" disabled={busy} placeholder={about ? `Ask Vowe about ${about}…` : 'Ask Vowe about the system…'}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (busy) ask.stop(); else ask.close(); } }} />
        </label>
        <span class="acts">
          {busy ? <button class="mini ghost" type="button" onClick={() => ask.stop()}>Stop</button>
            : <button class="mini ask" type="submit">Ask</button>}
          <button class="mini ghost" type="button" aria-label="Close" onClick={() => ask.close()}>Close</button>
        </span>
      </form>
      {s.provider && s.answer && <div class="prevline">Answered by {s.provider}. Only you see this panel; changes to the canvas are shared.</div>}
    </div>
  );
}
