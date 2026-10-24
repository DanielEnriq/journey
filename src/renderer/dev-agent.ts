// Temporary developer screen: a text conversation with Vowe's collaborator agent about a repository
// or one of its workstreams. Self-contained so it can be deleted without touching the rest of the renderer.

import type { AgentApprovalRequest, AgentReply, AgentToolCall, JourneyApi, Repository } from '../shared/api.js';

export function setupDevAgent(api: JourneyApi, attempt: (action: () => Promise<unknown>) => Promise<void>) {
  const { agent, context } = api;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const repoEl = $<HTMLSelectElement>('ag-repo');
  const workstreamEl = $<HTMLSelectElement>('ag-workstream');
  const statusEl = $('ag-status');
  const logEl = $('ag-log');
  const approvalsEl = $('ag-approvals');
  const formEl = $<HTMLFormElement>('ag-form');
  const inputEl = $<HTMLTextAreaElement>('ag-input');
  const sendEl = $<HTMLButtonElement>('ag-send');

  let conversationId: string | null = null;
  /** Where tool calls for the pending answer are listed as they happen. */
  let pendingEl: HTMLElement | null = null;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  function setRepositories(list: Repository[], preferredId?: string) {
    const before = repoEl.value;
    const wanted = before || preferredId;
    repoEl.replaceChildren(...list.map((r) => Object.assign(el('option', r.name), { value: r.id })));
    if (list.some((r) => r.id === wanted)) repoEl.value = wanted!;
    repoEl.disabled = sendEl.disabled = !list.length;
    if (repoEl.value !== before) void attempt(changeRepository);
  }

  async function changeRepository() {
    newConversation();
    const repositoryId = repoEl.value;
    workstreamEl.replaceChildren(Object.assign(el('option', 'Whole repository'), { value: '' }));
    if (!repositoryId) return;
    const workstreams = await context.workstreams(repositoryId);
    if (repositoryId !== repoEl.value) return;
    workstreamEl.append(
      ...workstreams.map((w) =>
        Object.assign(el('option', `${w.branch ?? `detached ${w.head?.slice(0, 7) ?? ''}`}${w.mainWorktree ? ' (main worktree)' : ` · ${w.worktreePath}`}`), { value: w.id }),
      ),
    );
  }

  function newConversation() {
    if (conversationId) void agent.reset(conversationId);
    conversationId = null;
    logEl.replaceChildren(el('div', 'Ask about the work in this repository, e.g. "What is Claude Code working on?"', 'empty'));
    approvalsEl.replaceChildren();
  }

  function describeCall(call: AgentToolCall) {
    const input = JSON.stringify(call.input);
    return `${call.error ? '✗' : '→'} ${call.name}${input && input !== '{}' ? ` ${input}` : ''}${call.error ? ` — ${call.error}` : ''}`;
  }

  function addMessage(role: 'user' | 'agent', text: string) {
    logEl.querySelector('.empty')?.remove();
    const box = el('div', undefined, `ag-msg ${role}`);
    box.append(el('div', role === 'user' ? 'You' : 'Vowe', 'status'), el('div', text, 'cc-text'));
    logEl.append(box);
    logEl.scrollTop = logEl.scrollHeight;
    return box;
  }

  function renderReply(box: HTMLElement, reply: AgentReply) {
    box.querySelector('.cc-text')!.textContent = reply.text || '(no answer)';
    const notes = { answered: '', 'step-limit': ' · stopped investigating at the step limit', truncated: ' · answer cut off at the output limit', refused: ' · declined' };
    box.querySelector('.status')!.textContent = `Vowe · ${reply.model ?? ''}${notes[reply.stop]}`;
    if (reply.toolCalls.length) {
      const d = el('details', undefined, 'cc-tool');
      d.append(el('summary', `${reply.toolCalls.length} tool call${reply.toolCalls.length === 1 ? '' : 's'}`), el('pre', reply.toolCalls.map(describeCall).join('\n')));
      box.append(d);
    }
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text || !repoEl.value) return;
    inputEl.value = '';
    sendEl.disabled = true;
    addMessage('user', text);
    const box = addMessage('agent', 'Looking…');
    pendingEl = el('pre', undefined, 'status');
    box.append(pendingEl);
    try {
      const reply = await agent.send(conversationId, { repositoryId: repoEl.value, workstreamId: workstreamEl.value || null }, text);
      conversationId = reply.conversationId;
      pendingEl.remove();
      renderReply(box, reply);
    } catch (err) {
      box.remove();
      throw err;
    } finally {
      pendingEl = null;
      sendEl.disabled = false;
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function showApproval(request: AgentApprovalRequest) {
    const card = el('div', undefined, 'ag-approval');
    const answer = (approved: boolean) => attempt(async () => {
      card.remove();
      await agent.approve(request.id, approved);
    });
    const allow = el('button', 'Share');
    const deny = el('button', "Don't share");
    allow.onclick = () => answer(true);
    deny.onclick = () => answer(false);
    card.append(el('strong', request.title), el('div', request.detail, 'status'), allow, deny);
    approvalsEl.append(card);
  }

  agent.onApproval(showApproval);
  agent.onToolCall(({ call }) => {
    if (pendingEl) pendingEl.textContent += `${describeCall(call)}\n`;
  });
  repoEl.onchange = () => attempt(changeRepository);
  $('ag-new').onclick = () => newConversation();
  formEl.onsubmit = (e) => {
    e.preventDefault();
    void attempt(send);
  };
  inputEl.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendEl.disabled) void attempt(send);
    }
  };

  void attempt(async () => {
    const s = await agent.status();
    statusEl.textContent = `${s.provider} · ${s.model}${s.configured ? '' : ' · no credentials found: set ANTHROPIC_API_KEY in .env and restart'}`;
  });
  newConversation();

  return { setRepositories };
}
