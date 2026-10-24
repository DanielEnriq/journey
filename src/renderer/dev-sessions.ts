// Temporary developer screen: browse a repository's Claude Code sessions and read their history.
// Self-contained so it can be deleted without touching the rest of the renderer.

import type {
  ClaudeCodeActivity,
  ClaudeCodeBlock,
  ClaudeCodeEvent,
  ClaudeCodeHooksStatus,
  ClaudeCodeMessage,
  ClaudeCodeSession,
  JourneyApi,
  Repository,
} from '../shared/api.js';

const PAGE_SIZE = 50;

export function setupDevSessions(api: JourneyApi, attempt: (action: () => Promise<unknown>) => Promise<void>) {
  const { claudeCode, context } = api;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const repoEl = $<HTMLSelectElement>('cc-repo');
  const sessionsEl = $<HTMLUListElement>('cc-sessions');
  const detailEl = $('cc-detail');
  const metaEl = $('cc-meta');
  const messagesEl = $('cc-messages');
  const earlierEl = $<HTMLButtonElement>('cc-earlier');
  const activityEl = $<HTMLUListElement>('cc-activity');
  const hooksEl = $('cc-hooks');
  const hooksToggleEl = $<HTMLButtonElement>('cc-hooks-toggle');
  const contextEl = $<HTMLDetailsElement>('cc-context');

  let sessions: ClaudeCodeSession[] = [];
  let selectedId: string | null = null;
  /** Index of the oldest message shown. */
  let shownFrom = 0;
  /** Bumped on every selection, so a slow response for a previous one is dropped. */
  let generation = 0;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

  function setRepositories(list: Repository[], preferredId?: string) {
    const before = repoEl.value;
    const wanted = before || preferredId;
    repoEl.replaceChildren(...list.map((r) => Object.assign(el('option', r.name), { value: r.id })));
    if (list.some((r) => r.id === wanted)) repoEl.value = wanted!;
    repoEl.disabled = !list.length;
    if (repoEl.value !== before || !list.length) {
      closeSession();
      void attempt(loadSessions);
    }
  }

  async function loadSessions() {
    const repositoryId = repoEl.value;
    if (!repositoryId) {
      renderActivity([]);
      return renderSessions([], 'Add a repository first.');
    }
    const [list, events] = await Promise.all([claudeCode.sessions(repositoryId), claudeCode.activity(repositoryId), loadHooks(), loadContext()]);
    if (repositoryId !== repoEl.value) return;
    renderSessions(list, 'No Claude Code sessions for this repository.');
    renderActivity(events);
    if (selectedId && list.some((s) => s.id === selectedId)) await openSession(selectedId);
    else closeSession();
  }

  /** On a hook event: update states and the feed without reloading the open conversation. */
  async function refreshLive() {
    const repositoryId = repoEl.value;
    if (!repositoryId) return;
    const [list, events] = await Promise.all([claudeCode.sessions(repositoryId), claudeCode.activity(repositoryId), loadContext()]);
    if (repositoryId !== repoEl.value) return;
    renderSessions(list, 'No Claude Code sessions for this repository.');
    renderActivity(events);
    const open = selectedId && list.find((s) => s.id === selectedId);
    if (open) renderMeta(open);
  }

  function renderActivity(events: ClaudeCodeEvent[]) {
    activityEl.replaceChildren();
    if (!events.length) activityEl.append(el('li', 'No hook events yet. Install the hooks, then start a new Claude Code session.', 'empty'));
    for (const e of events.slice(0, 50)) {
      const title = sessions.find((s) => s.id === e.sessionId)?.title ?? e.sessionId.slice(0, 8);
      const what = [e.type, e.toolName].filter(Boolean).join(' · ') + (e.subagent ? ' (subagent)' : '') + ` · ${e.source}`;
      const li = el('li');
      const info = el('div');
      info.append(el('div', `${what}${e.summary ? ` — ${e.summary}` : ''}`), el('div', `${new Date(e.timestamp).toLocaleTimeString()} · ${title}`, 'path'));
      li.append(info);
      activityEl.append(li);
    }
  }

  async function loadHooks(status?: ClaudeCodeHooksStatus) {
    const s = status ?? (await claudeCode.hooksStatus());
    const label = { installed: 'Hooks installed', 'not-installed': 'Hooks not installed', outdated: 'Hooks out of date' }[s.state];
    hooksEl.textContent = s.error ?? `${label} in ${s.settingsPath}${s.state === 'installed' ? ' (applies to sessions started after installing)' : ''}`;
    hooksToggleEl.hidden = Boolean(s.error);
    hooksToggleEl.textContent = s.state === 'installed' ? 'Remove hooks' : 'Install hooks';
    hooksToggleEl.onclick = () =>
      attempt(async () => loadHooks(await (s.state === 'installed' ? claudeCode.uninstallHooks() : claudeCode.installHooks())));
  }

  /** The combined work context, shown only while its panel is open. */
  async function loadContext() {
    const repositoryId = repoEl.value;
    if (!contextEl.open || !repositoryId) return;
    const work = await context.work(repositoryId);
    if (repositoryId !== repoEl.value) return;
    $('cc-workstreams').replaceChildren(
      ...work.workstreams.map((w) => {
        const links = w.sessions.map((l) => l.branch);
        const counts = (['same', 'different', 'detached', 'unknown'] as const).map((b) => `${links.filter((x) => x === b).length} ${b}`).join(', ');
        const li = el('li');
        const info = el('div');
        info.append(
          el('div', `${w.branch ?? `detached at ${w.head?.slice(0, 7) ?? '?'}`}${w.mainWorktree ? ' (main worktree)' : ''}`),
          el('div', `${w.worktreePath} · ${w.changedFiles ?? '?'} changed files · sessions by branch: ${counts}`, 'path'),
        );
        li.append(info);
        return li;
      }),
    );
    $('cc-context-json').textContent = JSON.stringify(work, null, 2);
  }

  function renderSessions(list: ClaudeCodeSession[], empty: string) {
    sessions = list;
    sessionsEl.replaceChildren();
    if (!list.length) sessionsEl.append(el('li', empty, 'empty'));
    for (const s of list) {
      const li = el('li');
      const info = el('div');
      info.append(el('div', s.title), el('div', `${when(s.lastModifiedAt)} · ${s.gitBranch ?? 'no branch'} · ${s.cwd ?? ''}`, 'path'));
      li.append(info, renderState(s.activity));
      li.classList.toggle('selected', s.id === selectedId);
      info.onclick = () => attempt(() => openSession(s.id));
      sessionsEl.append(li);
    }
  }

  function closeSession() {
    selectedId = null;
    detailEl.hidden = true;
  }

  async function openSession(id: string) {
    const repositoryId = repoEl.value;
    const mine = ++generation;
    selectedId = id;
    renderSessions(sessions, '');
    // Messages first: reading them is what makes the message count known.
    const page = await claudeCode.messages(repositoryId, id, { limit: PAGE_SIZE });
    const session = await claudeCode.session(repositoryId, id);
    if (mine !== generation) return;
    if (!session) {
      closeSession();
      throw new Error('That session is gone; refresh the list.');
    }
    renderMeta(session);
    shownFrom = page.offset;
    messagesEl.replaceChildren(...page.messages.map(renderMessage));
    earlierEl.hidden = shownFrom === 0;
    detailEl.hidden = false;
    messagesEl.scrollTop = messagesEl.scrollHeight; // open at the latest message
  }

  async function loadEarlier() {
    if (!selectedId || shownFrom === 0) return;
    const mine = generation;
    const offset = Math.max(0, shownFrom - PAGE_SIZE);
    const page = await claudeCode.messages(repoEl.value, selectedId, { offset, limit: shownFrom - offset });
    if (mine !== generation) return;
    // Keep the reader's place while older messages are added above.
    const fromBottom = messagesEl.scrollHeight - messagesEl.scrollTop;
    messagesEl.prepend(...page.messages.map(renderMessage));
    messagesEl.scrollTop = messagesEl.scrollHeight - fromBottom;
    shownFrom = page.offset;
    earlierEl.hidden = shownFrom === 0;
  }

  function renderState(activity: ClaudeCodeActivity | null) {
    const state = activity?.state ?? 'unknown';
    const label = { active: 'active', 'turn-completed': 'turn done', ended: 'ended', unknown: 'unknown' }[state];
    const badge = el('span', label, `cc-state ${state}`);
    badge.title = activity ? `${activity.lastEvent.type} at ${when(activity.lastEvent.timestamp)} (from ${activity.lastEvent.source})` : 'No activity observed';
    return badge;
  }

  function renderMeta(s: ClaudeCodeSession) {
    const rows: [string, string][] = [
      ['Session', s.id],
      ['Title', s.title],
      ['Directory', s.cwd ?? '—'],
      ['Branch', s.gitBranch ?? '—'],
      ['Created', when(s.createdAt)],
      ['Last modified', when(s.lastModifiedAt)],
      ['Messages', s.messageCount === null ? 'unknown' : String(s.messageCount)],
      ['Transcript', s.fileSize === null ? '—' : `${Math.round(s.fileSize / 1024)} KB`],
      ['State', s.activity ? `${s.activity.state} (last ${s.activity.lastEvent.type} at ${when(s.activity.lastEvent.timestamp)})` : 'unknown (no hook events)'],
    ];
    metaEl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
  }

  function renderMessage(m: ClaudeCodeMessage) {
    const box = el('div', undefined, `cc-msg ${m.role}`);
    const head = el('div', `${m.role}${m.parentToolUseId ? ' (subagent)' : ''} · ${when(m.timestamp)}`, 'status');
    box.append(head, ...m.blocks.map(renderBlock));
    return box;
  }

  function renderBlock(b: ClaudeCodeBlock): HTMLElement {
    const more = (truncated: boolean) => (truncated ? '\n… (truncated)' : '');
    const collapsible = (summary: string, body: string, className?: string) => {
      const d = el('details', undefined, className);
      d.append(el('summary', summary), el('pre', body));
      return d;
    };
    switch (b.type) {
      case 'text':
        return el('div', b.text + more(b.truncated), 'cc-text');
      case 'thinking':
        return collapsible('Thinking', b.text + more(b.truncated));
      case 'tool_use':
        return collapsible(`Tool: ${b.name}`, b.input.text + more(b.input.truncated), 'cc-tool');
      case 'tool_result':
        return collapsible(b.isError ? 'Tool error' : 'Tool result', b.output.text + more(b.output.truncated), b.isError ? 'cc-tool cc-error' : 'cc-tool');
      case 'image':
        return el('div', '[image]', 'status');
      case 'other':
        return el('div', `[${b.kind}]`, 'status');
    }
  }

  repoEl.onchange = () => {
    closeSession();
    void attempt(loadSessions);
  };
  $('cc-refresh').onclick = () => attempt(loadSessions);
  earlierEl.onclick = () => attempt(loadEarlier);
  contextEl.ontoggle = () => attempt(loadContext);

  // Events arrive in bursts (one per tool call); refresh once per burst.
  let pending: ReturnType<typeof setTimeout> | undefined;
  claudeCode.onEvent(() => {
    clearTimeout(pending);
    pending = setTimeout(() => void attempt(refreshLive), 300);
  });

  return { setRepositories };
}
