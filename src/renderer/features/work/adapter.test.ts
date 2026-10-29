// WorkContextService's shapes, as a room presents them. Plain Node: `pnpm test`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ClaudeCodeEvent, ClaudeCodeSession, WorkContext, Workstream } from '../../../shared/api.js';
import { toRoomWorkContext, toRoomWorkstream } from './adapter.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function event(sessionId: string, at: string, extra: Partial<ClaudeCodeEvent> = {}): ClaudeCodeEvent {
  return { id: `${sessionId}:${at}`, sessionId, type: 'PostToolUse', source: 'transcript', timestamp: at, cwd: null, toolName: 'Edit', summary: 'src/pay.ts', subagent: false, filePath: null, ...extra };
}

function session(id: string, title: string): ClaudeCodeSession {
  return { id, title, firstPrompt: null, cwd: null, gitBranch: null, createdAt: null, lastModifiedAt: NOW.toString(), fileSize: null, messageCount: null, activity: null };
}

function workstream(extra: Partial<Workstream> = {}): Workstream {
  return { id: 'ws1', repositoryId: 'repo1', worktreePath: '/code/acme-retry', mainWorktree: false, branch: 'payments/retry', head: 'abc', changedFiles: 3, sessions: [], lastActivity: null, ...extra };
}

describe('toRoomWorkstream', () => {
  test('names the work after its most recent linked session and keeps only that work’s events', () => {
    const recent = event('s1', minutesAgo(2));
    const w = workstream({ sessions: [{ sessionId: 's1', basis: 'cwd', branch: 'same', sessionBranch: 'payments/retry' }], lastActivity: recent });
    const r = toRoomWorkstream(w, { sessions: [session('other', 'Unrelated'), session('s1', 'Add retry worker')], activity: [recent, event('other', minutesAgo(1))] }, NOW);
    assert.equal(r.title, 'Add retry worker');
    assert.equal(r.status, 'active');
    assert.equal(r.visibility, 'local');
    assert.equal(r.sessions, 1);
    assert.equal(r.lastActivity, 'Used Edit: src/pay.ts');
    assert.deepEqual(r.observed, [{ at: recent.timestamp, text: 'Used Edit: src/pay.ts' }]);
  });

  test('falls back to the branch, then the worktree folder; quiet work is unknown, never done', () => {
    const stale = event('s1', minutesAgo(60), { type: 'Stop', toolName: null, summary: null });
    assert.equal(toRoomWorkstream(workstream({ lastActivity: stale }), { sessions: [], activity: [] }, NOW).status, 'unknown');
    assert.equal(toRoomWorkstream(workstream(), { sessions: [], activity: [] }, NOW).title, 'payments/retry');
    const detached = toRoomWorkstream(workstream({ branch: null }), { sessions: [], activity: [] }, NOW);
    assert.equal(detached.title, 'acme-retry');
    assert.equal(detached.lastActivityAt, null);
  });

  test('a session that asked for permission or an answer waits on its user, however long ago it asked, until it moves on', () => {
    const asked = event('s1', minutesAgo(120), { type: 'Notification', source: 'hook', toolName: null, summary: 'Claude needs your permission to use Bash' });
    const r = toRoomWorkstream(workstream({ lastActivity: asked }), { sessions: [], activity: [] }, NOW);
    assert.deepEqual([r.status, r.waitingOn, r.lastActivity], ['attention', 'permission', 'Asked: Claude needs your permission to use Bash']);
    const question = event('s1', minutesAgo(1), { type: 'Notification', source: 'hook', toolName: null, summary: 'Which database should I use?' });
    assert.equal(toRoomWorkstream(workstream({ lastActivity: question }), { sessions: [], activity: [] }, NOW).waitingOn, 'input');
    const moved = toRoomWorkstream(workstream({ lastActivity: event('s1', minutesAgo(1)) }), { sessions: [], activity: [] }, NOW);
    assert.deepEqual([moved.status, moved.waitingOn], ['active', undefined]);
  });
});

test('toRoomWorkContext carries the repository name and generation time', () => {
  const context = {
    generatedAt: minutesAgo(0),
    repository: { repository: { id: 'repo1', name: 'acme-payments', path: '/code/acme' } },
    workstreams: [workstream()],
    sessions: [],
    unplacedSessions: [],
    activity: [],
  } as unknown as WorkContext;
  const room = toRoomWorkContext(context);
  assert.equal(room.repo, 'acme-payments');
  assert.equal(room.generatedAt, context.generatedAt);
  assert.equal(room.workstreams.length, 1);
});
