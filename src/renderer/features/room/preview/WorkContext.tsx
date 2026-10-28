import { Fragment, h } from '../../../vendor/preact.js';
import { useState } from '../../../vendor/preact-hooks.js';
import { ago } from '../../../shared/time.js';
import { STATUS_WORDS } from '../../work/status.js';
import { Icon } from '../../../ui/icons.js';
import type { Loaded } from '../../workspace/hooks.js';
import type { RepoChoice, RoomWorkContext, RoomWorkstream, Transcript, WorkCheck } from '../data/sources.js';
import { CodeText, Copy } from './code.js';
import { ContextMenu, type At, type MenuLine } from '../../../ui/pass2/shell/SpaceMenus.js';

// The coding work behind a room, read without joining the call: what is shared with the room, and
// what was only seen on your machine. Each workstream opens in place to show its evidence. Nothing
// here claims progress it didn't observe.

const DOT = { active: 'dot run', completed: 'dot live', attention: 'dot needs', unknown: 'dot hollow' };
const CHECK = { pass: 'passes', fail: 'fails', running: 'running', 'not-run': 'not run yet' };

function Check({ c }: { c: WorkCheck }) {
  return <div class={'wcheck ' + c.result}><span class="vi"></span><span>{c.text}</span><span class="vs">{CHECK[c.result]}</span></div>;
}

const ROLE = { user: 'Prompt', assistant: 'Claude', tool: 'Tool' };

/** The latest of the workstream's Claude Code session, read on request from its transcript. */
function TranscriptView({ load }: { load(): Promise<Transcript> }) {
  const [t, setT] = useState<{ state: 'idle' } | { state: 'loading' } | { state: 'ready'; value: Transcript } | { state: 'failed'; error: string }>({ state: 'idle' });
  const read = () => {
    setT({ state: 'loading' });
    load().then((value) => setT({ state: 'ready', value }), (err: Error) => setT({ state: 'failed', error: err.message }));
  };
  if (t.state === 'idle') return <span class="acts"><button class="mini ghost" type="button" onClick={read}>Read the session</button></span>;
  if (t.state === 'loading') return <span class="wnote"><span class="spinlet"></span>Reading the transcript…</span>;
  if (t.state === 'failed') return <span class="wnote">Couldn’t read the transcript: {t.error} <button class="linkish" type="button" onClick={read}>Try again</button></span>;
  const { title, total, lines } = t.value;
  return (
    <div class="wlog">
      <span class="rk2">{title}{total > lines.length ? ` · latest of ${total} messages` : ''}</span>
      <ul class="wtranscript">{lines.map((l) => <li key={l.id}><span><b>{ROLE[l.role]}</b> {l.text}</span><span class="when">{ago(l.at)}</span></li>)}</ul>
      <span class="acts"><button class="mini ghost" type="button" onClick={read}>Read again</button></span>
    </div>
  );
}

/** A room without a repository: connect one of the repositories added on this machine. */
export interface Connect {
  repos(): Promise<RepoChoice[]>;
  addRepo(): Promise<RepoChoice | null>;
  attach(repoId: string): Promise<void>;
  /** Why connecting failed last time, e.g. when the room was made. */
  error?: string;
}

function ConnectRepo({ c }: { c: Connect }) {
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(c.error ?? null);
  const run = (p: Promise<unknown>) => { setBusy(true); setError(null); p.catch((err: Error) => setError(err.message)).finally(() => setBusy(false)); };
  const list = () => run(c.repos().then(setRepos));
  const add = () => run(c.addRepo().then((r) => r ? c.attach(r.id) : undefined));
  return (
    <>
      {error && <span class="wnote">Couldn’t connect it: {error}</span>}
      {repos === null ? (
        <span class="acts"><button class="mini" type="button" disabled={busy} onClick={list}>Connect a repository</button></span>
      ) : (
        <span class="acts">
          {repos.map((r) => <button key={r.id} class="mini" type="button" disabled={busy} onClick={() => run(c.attach(r.id))}>{r.label}</button>)}
          <button class="mini ghost" type="button" disabled={busy} onClick={add}>Add one from disk…</button>
        </span>
      )}
      <span class="wnote">Only its remote is shared with the room; each member uses their own clone.</span>
    </>
  );
}

/** Work with nothing observed for this long fades back, so what's moving stands out. */
const STALE_MS = 3 * 3600_000;

const num = (s: string) => Number(s.replace(/[^\d]/g, '')) || 0;

/** The diff, as line counts where they're known and a file count where only that is. */
function Diff({ w }: { w: RoomWorkstream }) {
  if (w.files?.length) {
    const a = w.files.reduce((n, f) => n + num(f.a), 0), d = w.files.reduce((n, f) => n + num(f.d), 0);
    return <span class="wdiff" title={`${w.files.length} ${w.files.length === 1 ? 'file' : 'files'} changed`}><span class="fa">+{a}</span><span class="fd">−{d}</span></span>;
  }
  return w.changedFiles ? <span class="wdiff">{w.changedFiles} {w.changedFiles === 1 ? 'file' : 'files'}</span> : null;
}

const GLYPH = { pass: '✓', fail: '✕', running: '' } as const;

/** Checks by result, each count named in its tooltip. Checks not run yet aren't counted. */
function Checks({ checks }: { checks: WorkCheck[] }) {
  return (
    <span class="wglyphs">
      {(['pass', 'fail', 'running'] as const).map((r) => {
        const of = checks.filter((c) => c.result === r);
        return of.length ? <span key={r} class={'wg ' + r} data-tip={of.map((c) => c.text).join(', ')}>{r === 'running' ? <span class="wring"></span> : GLYPH[r]}{of.length}</span> : null;
      })}
    </span>
  );
}

/** Whose turn it is: yours where it runs here or you attached it, else whoever's Mac it's on. */
export const waitsOnYou = (w: RoomWorkstream) => !w.by || w.by.tone === 'me';
const WAITING_FOR = { permission: 'permission', input: 'an answer' } as const;
const waitingLine = (w: RoomWorkstream) => {
  const who = waitsOnYou(w) ? 'you' : w.by!.name;
  const head = w.waitingOn ? `Waiting on ${who} for ${WAITING_FOR[w.waitingOn]}` : `Waiting on ${who}`;
  return [head, w.here === false || w.waitingOn ? w.lastActivity : null].filter(Boolean).join(' · ');
};

function Stream({ w, open, toggle, detach, transcript, onJoin, onMenu }: {
  w: RoomWorkstream; open: boolean; toggle(): void; detach?: () => void; transcript?: () => Promise<Transcript>; onJoin(): void;
  onMenu?: (at: At) => void;
}) {
  const stale = w.status !== 'attention' && !!w.lastActivityAt && Date.now() - Date.parse(w.lastActivityAt) > STALE_MS;
  const away = w.here === false;
  return (
    <div class={'stream wstream' + (w.status === 'attention' && waitsOnYou(w) ? ' needs' : '') + (open ? ' open' : '') + (stale ? ' stale' : '')}
      onContextMenu={onMenu && ((e: MouseEvent) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); })}>
      <button class="wtop" type="button" aria-expanded={open} onClick={toggle}
        onKeyDown={onMenu && ((e: KeyboardEvent) => {
          if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu({ x: r.left, y: r.bottom + 4 });
        })}>
        <span class="top">
          <span class={DOT[w.status]}></span><span class="wt">{w.title}</span>
          {w.by
            ? <span class={`avatar wface ${w.by.tone === 'me' ? '' : w.by.tone}`} title={`${w.agent} on ${w.by.tone === 'me' ? 'your Mac' : `${w.by.name}’s Mac`}`}>{w.by.initials}</span>
            : <span class="who">{w.agent}</span>}
        </span>
        <span class="line">
          {w.status === 'attention' ? waitingLine(w) : w.lastActivity ?? 'No activity observed.'}
          {w.lastActivityAt && <span class="when"> · {ago(w.lastActivityAt)}</span>}
        </span>
      </button>
      {/* Outside the row's button: the branch copies on its own. */}
      <span class="wmeta">
        {w.branch && <Copy text={w.branch} label={`the branch ${w.branch}`} />}
        <Diff w={w} />
        {w.checks && w.checks.length > 0 && <Checks checks={w.checks} />}
      </span>
      {open && (
        <div class="winspect">
          {w.worktree && <span class="wpath">{w.branch ? null : 'Detached · '}<Copy text={w.worktree} label="the worktree's path" /></span>}
          <span class="wstate">{STATUS_WORDS[w.status]}{w.status === 'unknown' && w.lastActivityAt ? `: nothing observed for ${ago(w.lastActivityAt).replace(' ago', '')}, so it may have stopped` : ''}{w.fromDecision ? ` · from decision ${w.fromDecision}` : ''}</span>
          {w.question && (
            <div class="wq">
              <p>{w.question}</p>
              <span class="acts"><button class="mini ask" type="button" onClick={onJoin}>Answer it in the call</button></span>
            </div>
          )}
          {w.checks && w.checks.length > 0 && <div class="wchecks">{w.checks.map((c) => <Check key={c.text} c={c} />)}</div>}
          {w.files && w.files.length > 0 && (
            <div class="files">{w.files.map((f) => <div key={f.path} class="file"><span class="fn">{f.path}</span><span class="fa">+{num(f.a)}</span><span class="fd">−{num(f.d)}</span></div>)}</div>
          )}
          {w.observed.length > 0 && (
            <div class="wlog">
              <span class="rk2">Observed</span>
              <ul>{w.observed.slice(0, 4).map((o, i) => <li key={i}><span><CodeText text={o.text} /></span><span class="when">{ago(o.at)}</span></li>)}</ul>
            </div>
          )}
          <span class="wfoot">
            {away ? <span>On {w.by ? `${w.by.name}’s Mac` : 'another Mac'}; its transcript stays there</span> : <span>{w.sessions} {w.sessions === 1 ? 'session' : 'sessions'}</span>}
            {detach && <button class="mini ghost" type="button" onClick={detach}>Detach</button>}
          </span>
          {!away && transcript && w.sessions > 0 && <TranscriptView load={transcript} />}
        </div>
      )}
    </div>
  );
}

export function WorkContext({ work, repo, openId, setOpen, attach, detach, transcript, connect, addClone, onJoin, bare }: {
  work: Loaded<RoomWorkContext> & { retry(): void };
  repo: string | null;
  openId: string | null;
  setOpen(id: string | null): void;
  /** Attaches work on this Mac to the room; absent where attaching isn't built. */
  attach?: (id: string) => Promise<void>;
  detach?: (id: string) => Promise<void>;
  transcript?: (id: string) => Promise<Transcript>;
  /** Offered when the room has no repository. */
  connect?: Connect;
  /** Offered when the room's repository isn't added on this machine. */
  addClone?: () => Promise<void>;
  onJoin(): void;
  /** Inside a card that names it already: no heading of its own. */
  bare?: boolean;
}) {
  const [menu, setMenu] = useState<{ at: At; label: string; lines: MenuLine[]; width?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctx = work.value;
  // The repository is the window's subtitle already; the inspector doesn't say it again.
  const head = bare ? null : <span class="rk">Work</span>;
  const run = (p: Promise<void>) => { setError(null); p.catch((err: Error) => setError(err.message)); };
  if (work.state === 'loading') {
    return <div class="rsec">{head}<span class="wnote"><span class="spinlet"></span>Looking for work in {repo ?? 'this room'}…</span></div>;
  }
  if (!ctx) {
    return (
      <div class="rsec">{head}
        <span class="wnote">Couldn’t read the work context just now. Nothing about it is shown rather than something stale.</span>
        <span class="acts"><button class="mini" type="button" onClick={work.retry}>Try again</button></span>
      </div>
    );
  }
  // Where the room's attachments can't be read, everything on this Mac shows as before.
  const attached = ctx.workstreams.filter((w) => w.visibility === 'room' || ctx.unattached);
  const loose = ctx.unattached ? [] : ctx.workstreams.filter((w) => w.visibility === 'local')
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const canAttach = !!attach && !!ctx.canAttach;
  const rowMenu = (w: RoomWorkstream) => {
    const lines: MenuLine[] = [
      ...(w.branch ? [{ icon: 'copy', label: 'Copy Branch Name', run: () => { void navigator.clipboard.writeText(w.branch!); } } as MenuLine] : []),
      ...(w.worktree ? [{ icon: 'copy', label: 'Copy Worktree Path', run: () => { void navigator.clipboard.writeText(w.worktree); } } as MenuLine] : []),
      ...(detach && w.detachable ? ['sep' as const, { label: 'Detach from Room', run: () => run(detach(w.id)) }] : []),
    ];
    return lines.length ? (at: At) => setMenu({ at, label: w.title, lines }) : undefined;
  };
  const addMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      at: { x: r.left, y: r.bottom + 4 }, label: 'Add Session', width: 360,
      lines: [
        { section: 'On this Mac' },
        ...loose.slice(0, 12).map((w): MenuLine => ({
          label: w.title, detail: w.branch && w.branch !== w.title ? w.branch : undefined, hint: [w.branch, w.lastActivityAt && ago(w.lastActivityAt)].filter(Boolean).join(' · '),
          run: () => run(attach!(w.id)),
        })),
      ],
    });
  };
  const row = (w: RoomWorkstream) => (
    <Stream key={w.id} w={w} open={openId === w.id} toggle={() => setOpen(openId === w.id ? null : w.id)}
      detach={detach && w.detachable && !ctx.unattached ? () => run(detach(w.id)) : undefined}
      transcript={transcript && (() => transcript(w.id))} onJoin={onJoin} onMenu={ctx.unattached ? undefined : rowMenu(w)} />
  );
  const blocked = !ctx.repo
    ? <><span class="wnote">No repository is attached to this room, so there’s no coding work to show.</span>{connect && <ConnectRepo c={connect} />}</>
    : ctx.unavailable
      ? <><span class="wnote">{ctx.unavailable}</span>{addClone && <span class="acts"><button class="mini" type="button" onClick={() => { addClone().then(work.retry, () => {}); }}>Add your clone…</button></span>}</>
      : null;
  return (
    <div class="rsec">
      {head}
      {work.state === 'failed' && <span class="wnote">Couldn’t refresh; showing what was read {ago(ctx.generatedAt)}. <button class="linkish" type="button" onClick={work.retry}>Try again</button></span>}
      {attached.map(row)}
      {blocked}
      {!blocked && !attached.length && (
        <span class="wnote">{ctx.unattached ? `No Claude Code sessions found in ${ctx.repo} yet.` : loose.length && canAttach ? 'Attach a session to share it with the room.' : 'No sessions attached to this room yet.'}</span>
      )}
      {error && <span class="wnote">{error}</span>}
      {canAttach && loose.length > 0 && (
        <button type="button" class="wadd" aria-haspopup="menu" onClick={addMenu}>
          <Icon name="plus" size={14} /><span>Add Session</span><span class="wadd-n">{loose.length} on this Mac</span>
        </button>
      )}
      {menu && <ContextMenu at={menu.at} label={menu.label} lines={menu.lines} width={menu.width} onClose={() => setMenu(null)} />}
    </div>
  );
}
