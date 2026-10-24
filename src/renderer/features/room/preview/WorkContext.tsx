import { Fragment, h } from '../../../vendor/preact.js';
import { ago } from '../../../shared/time.js';
import { STATUS_WORDS } from '../../work/status.js';
import type { Loaded } from '../../workspace/hooks.js';
import type { RoomWorkContext, RoomWorkstream, WorkCheck } from '../data/sources.js';

// The coding work behind a room, read without joining the call: what is shared with the room, and
// what was only seen on your machine. Each workstream opens in place to show its evidence. Nothing
// here claims progress it didn't observe.

const DOT = { active: 'dot run', completed: 'dot live', attention: 'dot needs', unknown: 'dot hollow' };
const CHECK = { pass: 'passes', fail: 'fails', running: 'running', 'not-run': 'not run yet' };

function Check({ c }: { c: WorkCheck }) {
  return <div class={'wcheck ' + c.result}><span class="vi"></span><span>{c.text}</span><span class="vs">{CHECK[c.result]}</span></div>;
}

function Stream({ w, open, toggle, share, onJoin }: { w: RoomWorkstream; open: boolean; toggle(): void; share(): void; onJoin(): void }) {
  const passing = w.checks?.filter((c) => c.result === 'pass').length ?? 0;
  return (
    <div class={'stream wstream' + (w.status === 'attention' ? ' needs' : '') + (open ? ' open' : '')}>
      <button class="wtop" type="button" aria-expanded={open} onClick={toggle}>
        <span class="top"><span class={DOT[w.status]}></span>{w.title}<span class="who">{w.agent}</span></span>
        <span class="line">
          {w.status === 'attention' ? 'Paused on a question for the room.' : w.lastActivity ?? 'No activity observed.'}
          {w.lastActivityAt && <span class="when"> · {ago(w.lastActivityAt)}</span>}
        </span>
        {w.checks && w.checks.length > 0 && <span class="line">{passing} of {w.checks.length} checks pass</span>}
      </button>
      {open && (
        <div class="winspect">
          <span class="mono">{w.branch ?? 'detached'} · {w.worktree}</span>
          <span class="wstate">{STATUS_WORDS[w.status]}{w.status === 'unknown' && w.lastActivityAt ? `: nothing observed for ${ago(w.lastActivityAt).replace(' ago', '')}, so it may have stopped` : ''}{w.fromDecision ? ` · from decision ${w.fromDecision}` : ''}</span>
          {w.question && (
            <div class="wq">
              <p>{w.question}</p>
              <span class="acts"><button class="mini ask" type="button" onClick={onJoin}>Answer it in the call</button></span>
            </div>
          )}
          {w.checks && w.checks.length > 0 && <div class="wchecks">{w.checks.map((c) => <Check key={c.text} c={c} />)}</div>}
          {w.files && w.files.length > 0 && (
            <div class="files">{w.files.map((f) => <div key={f.path} class="file"><span class="fn">{f.path}</span><span class="fa">+{f.a}</span><span class="fd">{f.d}</span></div>)}</div>
          )}
          <div class="wlog">
            <span class="rk2">Observed</span>
            <ul>{w.observed.slice(0, 4).map((o, i) => <li key={i}><span>{o.text}</span><span class="when">{ago(o.at)}</span></li>)}</ul>
          </div>
          <span class="wfoot">
            {w.changedFiles !== null && <span>{w.changedFiles} {w.changedFiles === 1 ? 'file' : 'files'} changed</span>}
            <span>{w.sessions} {w.sessions === 1 ? 'session' : 'sessions'}</span>
            {w.visibility === 'local' && <button class="mini" type="button" onClick={share}>Share with the room</button>}
          </span>
        </div>
      )}
    </div>
  );
}

export function WorkContext({ work, repo, openId, setOpen, share, onJoin }: {
  work: Loaded<RoomWorkContext> & { retry(): void };
  repo: string | null;
  openId: string | null;
  setOpen(id: string | null): void;
  share(id: string): void;
  onJoin(): void;
}) {
  const ctx = work.value;
  const head = <span class="rk">Work<span>{repo ?? 'no repository'}</span></span>;
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
  if (!ctx.repo) return <div class="rsec">{head}<span class="wnote">No repository is attached to this room, so there’s no coding work to show.</span></div>;
  if (!ctx.workstreams.length) return <div class="rsec">{head}<span class="wnote">No Claude Code sessions found in {ctx.repo} yet.</span></div>;
  const shared = ctx.workstreams.filter((w) => w.visibility === 'room'), local = ctx.workstreams.filter((w) => w.visibility === 'local');
  const row = (w: RoomWorkstream) => <Stream key={w.id} w={w} open={openId === w.id} toggle={() => setOpen(openId === w.id ? null : w.id)} share={() => share(w.id)} onJoin={onJoin} />;
  return (
    <>
      <div class="rsec">
        {head}
        {work.state === 'failed' && <span class="wnote">Couldn’t refresh; showing what was read {ago(ctx.generatedAt)}. <button class="linkish" type="button" onClick={work.retry}>Try again</button></span>}
        {shared.length ? shared.map(row) : <span class="wnote">Nothing shared with the room yet.</span>}
      </div>
      {local.length > 0 && (
        <div class="rsec">
          <span class="rk">On your machine<span>only you see these</span></span>
          {local.map(row)}
        </div>
      )}
    </>
  );
}
