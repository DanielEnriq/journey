// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * New room, with the same fields as Journey's `NewRoomSheet`:
 * - a name;
 * - what it's working toward (optional);
 * - a repository (optional): one added on this machine, or "Add one from disk…".
 *
 * Creating it opens the room's preview. Nobody is called and the mic stays off.
 */
import { Fragment, h } from '../../../vendor/preact.js';
import { useState } from '../../../vendor/preact-hooks.js';

import { Button } from '../../components.js';
import { Icon } from '../../icons.js';

import { Sheet } from '../common.js';
import type { RepoOption } from '../home/Composer.js';

export interface CreateRoomProps {
  repos: RepoOption[];
  repoNote: string;
  onAddRepo?: () => Promise<RepoOption | null>;
  /** Rejects with a message to show (RoomFailure.message). */
  onCreate: (room: { name: string; goal: string; repo: string | null }) => Promise<void>;
  onClose: () => void;
  /** The repository to start on (New room from a project); null or absent: none chosen. */
  initialRepo?: string | null;
}

export function CreateRoomSheet({ repos, repoNote, onAddRepo, onCreate, onClose }: CreateRoomProps) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const [extra, setExtra] = useState<RepoOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = repos.concat(extra.filter((r) => !repos.some((x) => x.id === r.id)));
  const ok = name.trim().length > 0 && !busy;
  const submit = (e?: Event) => {
    e?.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    onCreate({ name: name.trim(), goal: goal.trim(), repo }).catch((err: Error) => { setBusy(false); setError(err.message); });
  };
  const add = () => onAddRepo?.().then((r) => { if (r) { setExtra((x) => x.concat([r])); setRepo(r.id); } }, (err: Error) => setError(err.message));
  return (
    <Sheet title="New room" onClose={onClose} width={520}
      footer={<>
        <span class={`vh-foot-note ${error ? 'vh-err-text' : 'vh-hint'}`} role={error ? 'alert' : undefined}>{error ?? 'Only you can see it until you invite someone.'}</span>
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button variant="ink" loading={busy} disabled={!ok} onClick={() => submit()}>{busy ? 'Creating…' : 'Create room'}</Button>
      </>}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <label>
          <span class="vh-label">Name</span>
          <input class="vh-name-input" data-autofocus type="text" placeholder="Payment retries" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label>
          <span class="vh-label">Working toward <i class="vh-opt">optional</i></span>
          <div class="v-field"><input type="text" placeholder="Retries never charge a card twice." value={goal} onInput={(e) => setGoal((e.currentTarget as HTMLInputElement).value)} /></div>
        </label>
        <div>
          <span class="vh-label">Repository <i class="vh-opt">{repoNote}</i></span>
          <div class="vh-choices" role="radiogroup" aria-label="Repository">
            {[null, ...all].map((r) => {
              const on = repo === (r?.id ?? null);
              return (
                <button key={r?.id ?? 'none'} type="button" role="radio" aria-checked={on} class={`vh-choice${on ? ' is-on' : ''}`} onClick={() => setRepo(r?.id ?? null)}>
                  <span class="vh-radio" />
                  <span class="vh-choice-main"><b>{r?.label ?? 'None'}</b>{r ? null : <span class="v-meta">You can connect one later from the room.</span>}</span>
                </button>
              );
            })}
            {onAddRepo ? <button type="button" class="vh-choice vh-choice-add" onClick={add}><Icon name="plus" size={14} /><span class="vh-choice-main"><b>Add one from disk…</b><span class="v-meta">Only its remote is shared with the room.</span></span></button> : null}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
