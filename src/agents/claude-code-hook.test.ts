// The hook script as Claude Code runs it: JSON on stdin, at most one spool file out. Plain Node: `pnpm test`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const script = join(import.meta.dirname, 'claude-code-hook.cjs');
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs the hook on one input; returns what it spooled, or null. */
function hook(input: object): Record<string, unknown> | null {
  const spool = mkdtempSync(join(tmpdir(), 'vowe-hook-'));
  dirs.push(spool);
  execFileSync(process.execPath, [script, spool], { input: JSON.stringify(input) });
  const files = readdirSync(spool);
  return files.length ? JSON.parse(readFileSync(join(spool, files[0]!), 'utf8')) : null;
}

const base = { session_id: 's1', cwd: '/code/acme', hook_event_name: 'Notification' };

describe('Notification', () => {
  test('keeps a permission prompt, and a question put to the user, with what was asked', () => {
    const asked = hook({ ...base, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    assert.deepEqual([asked?.type, asked?.summary, asked?.toolName], ['Notification', 'Claude needs your permission to use Bash', null]);
    assert.equal(hook({ ...base, notification_type: 'elicitation_dialog', message: 'Pick a region' })?.summary, 'Pick a region');
  });

  test('drops reminders that only say a finished turn is idle', () => {
    assert.equal(hook({ ...base, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), null);
    assert.equal(hook({ ...base, notification_type: 'auth_success', message: 'Signed in' }), null);
  });

  test('without a type, keeps only what reads as a permission prompt', () => {
    assert.equal(hook({ ...base, message: 'Claude needs your permission to use Edit' })?.type, 'Notification');
    assert.equal(hook({ ...base, message: 'Claude is waiting for your input' }), null);
  });
});
