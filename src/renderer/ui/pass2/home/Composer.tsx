// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Starting a room from Home, as Journey's composer does it. The sentence you type
 * becomes the room's goal, and its first words become the name (`roomFrom`).
 * A repository from this machine is optional; only its remote is shared.
 * Start room creates the room and opens its preview. It never starts a call.
 */
import { h } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';

import { Button } from '../../components.js';
import { Icon } from '../../icons.js';

export interface RepoOption { id: string; label: string }

/** Journey's rule (WelcomeScreen.roomFrom): a short name from the sentence, the whole sentence as the goal. */
export function roomFrom(text: string): { name: string; goal: string } {
  const name = text.length > 40 ? text.slice(0, 38).replace(/\s+\S*$/, '') + '…' : text;
  return { name, goal: text };
}

export interface ComposerProps {
  repos: RepoOption[];
  /** "added on this machine · only its remote is shared", or "none added on this machine yet". */
  repoNote: string;
  /** `repos.add()`: main's folder picker. Absent in a browser preview. */
  onAddRepo?: () => Promise<RepoOption | null>;
  onStart: (room: { name: string; goal: string; repo: string | null }) => void;
  busy?: boolean;
  error?: string | null;
  placeholder?: string;
  /** Starting points under the box; first run only. Filling one in doesn't create anything. */
  tries?: string[];
  /** The view's one vermilion action. False where something else is (returning Home). */
  primary?: boolean;
}

export function Composer({ repos, repoNote, onAddRepo, onStart, busy, error, placeholder = 'Describe a change, a bug, or a system…', tries = [], primary = true }: ComposerProps) {
  const [text, setText] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const [extra, setExtra] = useState<RepoOption[]>([]);
  const [picking, setPicking] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const all = repos.concat(extra.filter((r) => !repos.some((x) => x.id === r.id)));
  const label = all.find((r) => r.id === repo)?.label ?? null;
  useEffect(() => {
    if (!picking) return;
    const away = (e: PointerEvent) => { if (!pop.current?.contains(e.target as Node)) setPicking(false); };
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [picking]);
  const start = () => { const t = text.trim(); if (t && !busy) onStart({ ...roomFrom(t), repo }); };
  const add = () => { setPicking(false); onAddRepo?.().then((r) => { if (r) { setExtra((x) => x.concat([r])); setRepo(r.id); } }); };
  return (
    <div class="vh-composer-wrap">
      <div class={`vh-composer${busy ? ' is-busy' : ''}`}>
        <label class="vh-composer-in">
          <span class="v-sr">What are you building</span>
          <input type="text" value={text} placeholder={placeholder} disabled={busy}
            onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') start(); }} />
        </label>
        <div class="vh-composer-row">
          <div class="vh-repo-pick" ref={pop}>
            <button type="button" class="vh-repo-btn" aria-haspopup="listbox" aria-expanded={picking} onClick={() => setPicking(!picking)}>
              <Icon name="branch" size={14} />{label ?? 'No repository'}<Icon name="chevron" size={14} />
            </button>
            {picking ? (
              <div class="vh-repo-pop" role="listbox" aria-label="Repository">
                <span class="vh-repo-note">{repoNote}</span>
                {[null, ...all].map((r) => (
                  <button key={r?.id ?? 'none'} type="button" role="option" aria-selected={repo === (r?.id ?? null)} class={repo === (r?.id ?? null) ? 'is-on' : ''}
                    onClick={() => { setRepo(r?.id ?? null); setPicking(false); }}>
                    {r?.label ?? 'No repository'}{repo === (r?.id ?? null) ? <Icon name="check" size={14} /> : null}
                  </button>
                ))}
                {onAddRepo ? <button type="button" class="vh-repo-add" onClick={add}><Icon name="plus" size={14} />Add one from disk…</button> : null}
              </div>
            ) : null}
          </div>
          <span class="vh-composer-fine">{error ? <span class="vh-err-text">{error}</span> : 'Only you can see it until you invite someone.'}</span>
          <Button variant={primary ? 'signal' : 'ink'} loading={busy} disabled={!text.trim()} shortcut="↵" onClick={start}>Start room</Button>
        </div>
      </div>
      {tries.length ? (
        <div class="vh-tries">
          {tries.map((t) => <button key={t} type="button" class={`vh-try${text === t ? ' is-on' : ''}`} onClick={() => setText(t)}>{t}</button>)}
        </div>
      ) : null}
    </div>
  );
}
