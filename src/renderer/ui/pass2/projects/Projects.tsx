// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Projects, as Journey models them: there's no project entity. There are
 * repositories added on this machine (`repos.list()`), and the repository each
 * room points to, as a shared identity such as `github.com/acme/payments`.
 *
 * A room finds your clone through `rooms.checkout` (origin match). Paths stay on
 * this machine, and the renderer names repositories by id.
 *
 * Adding one goes through main's folder picker (`repos.add()`) or through
 * `repos.detect()` ("Find repositories", two levels deep in ~/code, ~/projects
 * and similar; never ~/Documents or ~/Desktop).
 */
import { Fragment, h } from '../../../vendor/preact.js';
import { Button, Spinner } from '../../components.js';
import { Icon } from '../../icons.js';

import { ago, Note, Sheet } from '../common.js';
import type { DetectedRepository } from '../../../../shared/api.js';
import type { LocalRepoView, MissingRepoView } from '../types.js';

export interface ProjectsIndexProps {
  /** null while loading. */
  repos: LocalRepoView[] | null;
  missing: MissingRepoView[];
  onAddRepo?: () => void;
  onFindRepos?: () => void;
  onOpenRoom: (id: string) => void;
  onRemove?: (id: string) => void;
  now?: number;
}

export function ProjectsIndex({ repos, missing, onAddRepo, onFindRepos, onOpenRoom, onRemove, now }: ProjectsIndexProps) {
  return (
    <div class="vh-page vh-enter">
      <header class="vh-index-head">
        <div><div class="vh-eyebrow">Projects</div><h1>Repositories</h1></div>
        <div class="vh-ret-acts">
          {onFindRepos ? <Button variant="quiet" icon="search" onClick={onFindRepos}>Find repositories</Button> : null}
          {onAddRepo ? <Button variant="ink" icon="plus" onClick={onAddRepo}>Add a repository…</Button> : null}
        </div>
      </header>

      <section class="vh-proj-sec">
        <div class="vh-sec-h"><span class="v-label">On this machine</span><span class="vh-sec-note">Paths are only visible to you</span></div>
        {repos === null ? <div class="vh-invite-row"><Spinner />Reading your repositories…</div> : repos.length ? repos.map((r) => (
          <div key={r.id} class="vh-proj-row">
            <span><b>{r.name}</b><span class="vh-local"><Icon name="project" size={14} />{r.pathLabel}</span></span>
            <span class="vh-proj-rooms">{r.rooms.length ? r.rooms.map((x) => <button key={x.id} type="button" class="v-link" onClick={() => onOpenRoom(x.id)}>{x.name}</button>) : <span class="v-meta">Not in a room</span>}</span>
            <span class="v-meta">{r.remote ? <span class="vh-projchip"><Icon name="branch" size={14} />{r.remote}</span> : r.lastOpenedAt ? `Opened ${ago(r.lastOpenedAt, now)}` : 'Never opened'}</span>
            {onRemove ? <Button size="sm" variant="quiet" onClick={() => onRemove(r.id)}>Remove</Button> : <span />}
          </div>
        )) : (
          <p class="vh-empty">No repositories added yet. Add one with the folder picker. Picking a subfolder adds the whole repository it belongs to.</p>
        )}
      </section>

      {missing.length ? (
        <section class="vh-proj-sec">
          <div class="vh-sec-h"><span class="v-label">In your rooms, not on this machine</span></div>
          {missing.map((m) => (
            <div key={m.repository} class="vh-proj-row is-missing">
              <span><b>{m.repository.replace(/^github\.com\//, '')}</b><span class="vh-local is-missing"><Icon name="branch" size={14} />{m.repository}</span></span>
              <span class="vh-proj-rooms">{m.rooms.map((x) => <button key={x.id} type="button" class="v-link" onClick={() => onOpenRoom(x.id)}>{x.name}</button>)}</span>
              <span class="v-meta">Its Claude Code work can’t be read here.</span>
              {onAddRepo ? <Button size="sm" onClick={onAddRepo}>Add your clone…</Button> : <span />}
            </div>
          ))}
        </section>
      ) : null}

      <Note icon="lock">Rooms share a repository’s remote, never its path. Each member uses their own clone. Vowe reads Git and Claude Code sessions here, read-only, and shares nothing from them unless you do.</Note>
    </div>
  );
}

/** `repos.detect()` results. Adding one is `repos.addDetected(path)`. */
export function FindRepositoriesSheet({ found, adding, onAdd, onPick, onClose }: {
  /** null while looking. */
  found: DetectedRepository[] | null;
  adding: string | null;
  onAdd: (path: string) => void;
  onPick?: () => void;
  onClose: () => void;
}) {
  const home = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');
  return (
    <Sheet title="Find repositories" subtitle="Looked two levels deep in ~/code, ~/projects, ~/dev, ~/Developer, ~/src, ~/repos, ~/workspace and ~/GitHub." onClose={onClose} width={520}
      footer={<>{onPick ? <Button variant="quiet" icon="project" class="vh-foot-note" onClick={onPick}>Choose a folder…</Button> : null}<Button onClick={onClose}>Done</Button></>}>
      {found === null ? <div class="vh-invite-row"><Spinner />Looking…</div> : found.length ? (
        <div class="vh-choices">
          {found.map((r) => (
            <div key={r.path} class="vh-choice" style={{ cursor: 'default' }}>
              <Icon name="project" size={16} />
              <span class="vh-choice-main"><b>{r.name}</b><span class="v-meta">{home(r.path)}</span></span>
              <Button size="sm" loading={adding === r.path} disabled={!!adding && adding !== r.path} onClick={() => onAdd(r.path)}>Add</Button>
            </div>
          ))}
        </div>
      ) : (
        <p class="vh-empty">No new repositories there. Ones you’ve already added are left out. ~/Documents and ~/Desktop aren’t searched, because macOS would ask for access. Choose a folder instead.</p>
      )}
    </Sheet>
  );
}
