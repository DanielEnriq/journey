import { h } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import type { NewRoom as NewRoomInput } from '../room/data/sources.js';

// New room: a name, what the room is working toward, and an optional repository. Creating it opens
// the room's preview; nobody is called and the mic stays off. Repositories are examples until GitHub
// can be connected, and the sheet says so.

export function NewRoomSheet({ repos, onCreate, onClose }: { repos: string[]; onCreate(room: NewRoomInput): void; onClose(): void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  const ok = name.trim().length > 0;
  const submit = (e: Event) => {
    e.preventDefault();
    if (ok) onCreate({ name: name.trim(), goal: goal.trim(), repo });
  };
  return (
    <div class="nr-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form class="nr" role="dialog" aria-label="New room" onSubmit={submit}>
        <span class="nr-h">New room</span>
        <label class="nr-f"><span>Name</span><input ref={first} type="text" placeholder="Payment retries" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} /></label>
        <label class="nr-f"><span>Working toward <i>optional</i></span><input type="text" placeholder="Retries never charge a card twice." value={goal} onInput={(e) => setGoal((e.currentTarget as HTMLInputElement).value)} /></label>
        <div class="nr-f">
          <span>Repository <i>examples · GitHub isn’t connected in this build</i></span>
          <div class="nr-repos" role="radiogroup" aria-label="Repository">
            <button type="button" role="radio" aria-checked={repo === null} class={repo === null ? 'on' : ''} onClick={() => setRepo(null)}>None</button>
            {repos.map((r) => <button key={r} type="button" role="radio" aria-checked={repo === r} class={repo === r ? 'on' : ''} onClick={() => setRepo(r)}>{r}</button>)}
          </div>
        </div>
        <div class="nr-acts">
          <span class="nr-fine">Only you can see it until you invite someone.</span>
          <button class="nr-ghost" type="button" onClick={onClose}>Cancel</button>
          <button class="nr-go" type="submit" disabled={!ok}>Create room</button>
        </div>
      </form>
    </div>
  );
}
