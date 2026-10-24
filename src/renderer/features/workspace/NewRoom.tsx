import { h } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import type { NewRoom as NewRoomInput, RepoChoice } from '../room/data/sources.js';

// New room: a name, what the room is working toward, and an optional repository. Creating it opens
// the room's preview; nobody is called and the mic stays off. In the app the repositories are the ones
// added on this machine (only their remote is shared); in the demo they are examples, and it says so.

export function NewRoomSheet({ repos, repoNote, onAddRepo, onCreate, onClose }: {
  repos: RepoChoice[];
  /** What the repository list is, beside its label. */
  repoNote: string;
  /** Adds a repository from disk; absent in the demo. */
  onAddRepo?: () => Promise<RepoChoice | null>;
  onCreate(room: NewRoomInput): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const [extra, setExtra] = useState<RepoChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  const ok = name.trim().length > 0 && !busy;
  const submit = (e: Event) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    onCreate({ name: name.trim(), goal: goal.trim(), repo }).catch((err: Error) => { setBusy(false); setError(err.message); });
  };
  const add = () => {
    onAddRepo?.().then((r) => { if (r) { setExtra((x) => x.concat([r])); setRepo(r.id); } }, (err: Error) => setError(err.message));
  };
  const all = repos.concat(extra.filter((r) => !repos.some((x) => x.id === r.id)));
  return (
    <div class="nr-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form class="nr" role="dialog" aria-label="New room" onSubmit={submit}>
        <span class="nr-h">New room</span>
        <label class="nr-f"><span>Name</span><input ref={first} type="text" placeholder="Payment retries" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} /></label>
        <label class="nr-f"><span>Working toward <i>optional</i></span><input type="text" placeholder="Retries never charge a card twice." value={goal} onInput={(e) => setGoal((e.currentTarget as HTMLInputElement).value)} /></label>
        <div class="nr-f">
          <span>Repository <i>{repoNote}</i></span>
          <div class="nr-repos" role="radiogroup" aria-label="Repository">
            <button type="button" role="radio" aria-checked={repo === null} class={repo === null ? 'on' : ''} onClick={() => setRepo(null)}>None</button>
            {all.map((r) => <button key={r.id} type="button" role="radio" aria-checked={repo === r.id} class={repo === r.id ? 'on' : ''} onClick={() => setRepo(r.id)}>{r.label}</button>)}
            {onAddRepo && <button type="button" onClick={add}>Add one from disk…</button>}
          </div>
        </div>
        <div class="nr-acts">
          <span class="nr-fine">{error ?? 'Only you can see it until you invite someone.'}</span>
          <button class="nr-ghost" type="button" onClick={onClose}>Cancel</button>
          <button class="nr-go" type="submit" disabled={!ok}>{busy ? 'Creating…' : 'Create room'}</button>
        </div>
      </form>
    </div>
  );
}
