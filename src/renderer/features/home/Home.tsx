import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useMemo, useState } from '../../vendor/preact-hooks.js';
import type { Scene } from '../../../shared/canvas/index.js';
import type { DetectedRepository, IncomingInvitation, InviteKey, Repository, RoomCheckout } from '../../../shared/api.js';
import { account, cancelSignIn, firstName, initials, linkSignInMethod, loadSignInMethods, signInMethods, signOut, unlinkSignInMethod } from '../../shared/account.js';
import { chatgpt } from '../../shared/chatgpt.js';
import { ChatGptSection, ChatGptWelcome } from '../../shared/components/Account.js';
import { useStore } from '../../shared/store.js';
import { useThemeSetting } from '../../shared/theme/theme.js';
import { AccountMenu, SignInMethodsSheet } from '../../ui/pass2/auth/Account.js';
import { SessionSplash } from '../../ui/pass2/auth/SessionSplash.js';
import { Sheet } from '../../ui/pass2/common.js';
import { HomeFirst } from '../../ui/pass2/home/HomeFirst.js';
import { HomeReturning } from '../../ui/pass2/home/HomeReturning.js';
import { InvitationsIndex } from '../../ui/pass2/invites/InviteGate.js';
import { FindRepositoriesSheet, ProjectsIndex } from '../../ui/pass2/projects/Projects.js';
import { RoomsIndex } from '../../ui/pass2/rooms/RoomsIndex.js';
import { AppShell, type ShellRoute } from '../../ui/pass2/shell/AppShell.js';
import type { AccountView, CanvasPreview, CanvasSketch, DecisionItem, LocalRepoView, MissingRepoView, NeedItem, Person, RoomCard, WorkItem } from '../../ui/pass2/types.js';
import type { NewRoom, RepoChoice } from '../room/data/sources.js';
import type { PersonRef, RoomSummary } from '../room/types.js';
import { acrossRooms, localWork, realStatus, realWorkspace, repositories, retryRooms, roomCheckouts, roomScene } from '../workspace/real/workspace.js';
import type { InboxSource } from '../inbox/source.js';

// Home, Rooms, Projects and Invitations (Design Pass 2), inside the Pass 2 shell. The components in
// ui/pass2 never fetch: this reads what they show from the real workspace (rooms and their records,
// invitations, rooms.checkout, each room's canvas, this machine's repositories and their Claude Code
// work) and maps it to their view models. What Journey can't know is passed as null, so it's left out.
//
// The demo (Payment Reliability, from the developer menu) shows the same pages over its example rooms
// only: no repositories, invitations, work or canvases are read for it, and nothing real appears in it.

export type HomePage = ShellRoute;

export interface HomeProps {
  page: HomePage;
  demo: boolean;
  rooms: RoomSummary[];
  /** The composer's repositories: this machine's, or the demo's examples. */
  repos: RepoChoice[];
  repoNote: string;
  /** Adds a repository from disk for the composer; absent in the demo. */
  onAddRepo?: () => Promise<RepoChoice | null>;
  /** Why the rooms couldn't be read; shown instead of pretending there are none. */
  notice: string | null;
  onNavigate(page: HomePage): void;
  onOpenRoom(id: string): void;
  /** Makes the room and opens its preview; rejects with a message to show. Never starts a call. */
  onCreate(room: NewRoom): Promise<void>;
  /** Opens the New room sheet; with a repository, the sheet starts on it. */
  onNewRoom(repo?: string | null): void;
  /** Absent in the demo: its pages have no invitations or link field. */
  onOpenInvite?(key: InviteKey): void;
  /** The New room sheet, when open. */
  overlay?: ComponentChildren;
  /** An invite being opened: shown in place of the page. */
  invite?: ComponentChildren;
  /** The workspace's Inbox (activeInbox's source); null while there is none. */
  inbox?: InboxSource | null;
  /** The Inbox item the route selects (#/home/i/<id>), or null. */
  selected?: string | null;
  /** Selects an Inbox item (a history entry, so back and forward walk them); null clears it. */
  onSelect?(id: string | null): void;
}

const TONE: Record<PersonRef['tone'], 1 | 2 | 3 | 4> = { me: 1, peer: 2, p2: 3, p3: 4 };
const personOf = (p: PersonRef, i: number): Person => ({ id: `${p.name}-${i}`, name: p.name, initials: p.initials, tone: TONE[p.tone] });
/** "~/code/payments": for its owner's eyes only. */
const pathLabel = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

/** A part's name as a tile label: spoken names run long ("the electron main process"), tiles fit a word or two. */
const tileLabel = (name: string) => { const t = name.replace(/^the\s+/i, '').replace(/\s*\(.*\)$/, ''); return t.length > 18 ? `${t.slice(0, 17).trimEnd()}…` : t; };

/** A sketch tile's footprint on the card, in percent of its width and height (with a little air). */
const SKETCH_TILE = { w: 27, h: 22 };

/** The room's last shared view, drawn small: its parts where the scene puts them, and who talks to whom. */
function sketchOf(scene: Scene): CanvasSketch | null {
  const [vw, vh] = scene.viewBox;
  const at = (x: number, y: number) => ({ x: Math.min(86, Math.max(14, (x / vw) * 100)), y: Math.min(84, Math.max(16, (y / vh) * 100)) });
  const seen = new Set<string>();
  const nodes: CanvasSketch['nodes'] = [];
  // Tiles are a fixed size on a small card, so two parts close together in the scene would land on each other:
  // a part whose tile would overlap one already drawn is left out, and the next one is drawn instead.
  const clear = (p: { x: number; y: number }) => nodes.every((o) => Math.abs(o.x - p.x) >= SKETCH_TILE.w || Math.abs(o.y - p.y) >= SKETCH_TILE.h);
  for (const n of scene.nodes) {
    if (seen.has(n.component) || nodes.length >= 5) continue;
    const p = at(n.rect[0] + n.rect[2] / 2, n.rect[1] + n.rect[3] / 2);
    if (!clear(p)) continue;
    seen.add(n.component);
    nodes.push({ id: n.key, label: tileLabel(n.short || n.name), kind: n.kind[0].toUpperCase() + n.kind.slice(1), ...p, state: n.proposed ? 'proposed' : undefined });
  }
  for (const s of scene.steps) {
    if (nodes.length >= 5) break;
    const p = at(s.x + 90, s.y + 30);
    if (!clear(p)) continue;
    nodes.push({ id: s.id, label: tileLabel(s.short || s.title), kind: `Step ${s.n}`, ...p });
  }
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasSketch['edges'] = [];
  for (const [from, tos] of Object.entries(scene.neighbours)) {
    for (const to of tos) if (from < to && ids.has(from) && ids.has(to)) edges.push({ from, to });
  }
  return { nodes, edges };
}

/** Each room's last shared view, loaded once per room shown (one canvas read per card). */
function useStills(ids: string[], enabled: boolean): Map<string, CanvasPreview> {
  const [stills, setStills] = useState(() => new Map<string, CanvasPreview>());
  const key = ids.join(',');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    for (const id of ids) {
      if (stills.has(id)) continue;
      stills.set(id, { status: 'loading' });
      roomScene(id).then(
        ({ scene }) => { const sketch = scene && sketchOf(scene); return sketch ? { status: 'ready' as const, sketch, viewName: scene!.name } : { status: 'empty' as const }; },
        () => ({ status: 'unavailable' as const }),
      ).then((p) => { if (live) setStills((m) => new Map(m).set(id, p)); });
    }
    setStills((m) => new Map(m));
    return () => { live = false; };
  }, [key, enabled]);
  return stills;
}

export function Home(p: HomeProps) {
  const { user } = useStore(account);
  const real = !p.demo;
  const status = useStore(realStatus);
  const [theme, pickTheme] = useThemeSetting();
  const gpt = useStore(chatgpt);
  const methods = useStore(signInMethods);
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<null | 'methods' | 'model' | 'find'>(null);
  const [leaving, setLeaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // What's read for your real rooms only.
  const [invitations, setInvitations] = useState<IncomingInvitation[] | null>(real ? null : []);
  const [local, setLocal] = useState<Repository[] | null>(real ? null : []);
  const [checkouts, setCheckouts] = useState(() => new Map<string, RoomCheckout | null>());
  const [work, setWork] = useState<WorkItem[] | null>(null);
  const [found, setFound] = useState<DetectedRepository[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);

  const reloadRepos = () => { if (real) repositories.list().then(setLocal, () => setLocal([])); };
  useEffect(() => { if (real) realWorkspace.invites.mine().then(setInvitations, () => setInvitations([])); }, [real, p.rooms.length]);
  // The composer's list changes when the New room sheet adds one; re-read ours with it.
  useEffect(reloadRepos, [real, p.repos]);
  const repoRooms = p.rooms.filter((r) => r.repo).map((r) => r.id).join(',');
  useEffect(() => { if (real) roomCheckouts(repoRooms ? repoRooms.split(',') : []).then(setCheckouts); }, [real, repoRooms, local]);
  useEffect(() => {
    if (!real || !local) return;
    localWork(local).then((all) => setWork(all.map(({ repository, stream: w }) => ({
      id: w.id, title: w.title, agent: w.agent, repository, branch: w.branch, status: w.status, lastActivity: w.lastActivity, lastActivityAt: w.lastActivityAt,
    }))), () => setWork(null));
  }, [real, local]);

  // A canvas read per card that's on screen: Home shows six, the Rooms page all of them.
  const shown = p.page === 'rooms' ? p.rooms : p.page === 'home' ? p.rooms.slice(0, 6) : [];
  const stills = useStills(shown.map((r) => r.id), real);

  const cards: RoomCard[] | null = real && status.state === 'loading' && !p.rooms.length ? null : p.rooms.map((r) => {
    const others = (list: PersonRef[] | undefined) => (list ?? []).filter((x) => x.tone !== 'me').map(personOf);
    const here = others(r.here), inCall = others(r.inCall);
    const co = checkouts.get(r.id);
    return {
      id: r.id,
      name: r.name,
      role: r.role ?? 'owner',
      repository: r.repo,
      checkout: !r.repo || co === undefined ? null : co ? 'here' : 'missing',
      activity: { text: r.activity, at: r.activityAt },
      needs: r.needs,
      presence: here.length || inCall.length ? { here, inCall } : null,
      preview: real ? stills.get(r.id) ?? { status: 'loading' } : { status: 'unavailable' },
    };
  });

  const across = useMemo(() => (real ? acrossRooms() : { signatures: [], decisions: [] }), [real, p.rooms]);
  const needs: NeedItem[] = real
    ? [...(invitations ?? []).map((invitation) => ({ kind: 'invitation' as const, invitation })), ...across.signatures.map((s) => ({ kind: 'signature' as const, ...s }))]
    : p.rooms.filter((r) => r.needs).map((r) => ({ kind: 'room' as const, roomId: r.id, roomName: r.name, text: r.needs! }));
  const decisions: DecisionItem[] | null = real ? across.decisions : null;

  const localViews: LocalRepoView[] | null = local && local.map((r) => ({
    id: r.id, name: r.name, pathLabel: pathLabel(r.path), lastOpenedAt: r.lastOpenedAt, remote: null,
    rooms: p.rooms.filter((x) => checkouts.get(x.id)?.repositoryId === r.id).map((x) => ({ id: x.id, name: x.name })),
  }));
  const missing: MissingRepoView[] = [];
  for (const r of p.rooms) {
    if (!r.repo || checkouts.get(r.id) !== null) continue;
    const m = missing.find((x) => x.repository === r.repo);
    if (m) m.rooms.push({ id: r.id, name: r.name }); else missing.push({ repository: r.repo, rooms: [{ id: r.id, name: r.name }] });
  }

  const addRepo = real ? () => { setRepoError(null); repositories.add().then(reloadRepos, (err: Error) => setRepoError(err.message)); } : undefined;
  const findRepos = real ? () => { setFound(null); setSheet('find'); repositories.detect().then(setFound, () => setFound([])); } : undefined;
  const addFound = (path: string) => {
    setAdding(path);
    repositories.addDetected(path).then(
      () => { setFound((f) => f?.filter((x) => x.path !== path) ?? null); reloadRepos(); },
      (err: Error) => setRepoError(err.message),
    ).finally(() => setAdding(null));
  };

  const start = (room: NewRoom) => {
    setCreating(true);
    setCreateError(null);
    p.onCreate(room).catch((err: Error) => setCreateError(`Couldn’t create the room: ${err.message}`)).finally(() => setCreating(false));
  };
  const composer = { repos: p.repos, repoNote: p.repoNote, onAddRepo: p.onAddRepo, onStart: start, busy: creating, error: createError };

  if (!user) return null;
  const me: AccountView = { name: user.name || user.email, email: user.email, initials: initials(user.name || user.email) || '?', provider: user.provider };
  const out = () => { setMenu(false); setLeaving(true); signOut().finally(() => setLeaving(false)); };
  const busyLinking = methods.busy !== null && !methods.methods?.find((m) => m.provider === methods.busy)?.linked;
  const openMethods = () => { setMenu(false); setSheet('methods'); void loadSignInMethods(); };
  const notice = p.notice ?? repoError;

  let page: ComponentChildren;
  if (p.invite) page = p.invite;
  else if (p.page === 'rooms') {
    page = <RoomsIndex rooms={cards} onOpen={p.onOpenRoom} onNewRoom={p.onNewRoom} onJoinLink={() => p.onNavigate('invitations')}
      error={real && status.state === 'failed' ? status.error : null} onRetry={real ? () => void retryRooms() : undefined} />;
  } else if (p.page === 'projects') {
    page = <ProjectsIndex repos={localViews} missing={missing} onAddRepo={addRepo} onFindRepos={findRepos} onOpenRoom={p.onOpenRoom}
      onRemove={real ? (id) => { repositories.remove(id).then(reloadRepos, (err: Error) => setRepoError(err.message)); } : undefined} />;
  } else if (p.page === 'invitations') {
    page = <InvitationsIndex invitations={invitations} onOpen={p.onOpenInvite} />;
  } else if (cards && !cards.length) {
    page = <HomeFirst firstName={firstName(user)} composer={composer} invitations={invitations ?? []} onOpenInvite={p.onOpenInvite}
      repoCount={local?.length ?? 0} onAddRepo={addRepo} onFindRepos={findRepos} notice={notice} />;
  } else {
    page = <HomeReturning firstName={firstName(user)} rooms={cards} needs={needs} work={real ? work : null} decisions={decisions}
      repos={real ? localViews : null} missing={missing} composer={composer} notice={notice} onOpenRoom={p.onOpenRoom} onOpenInvite={p.onOpenInvite}
      onNewRoom={p.onNewRoom} onSeeRooms={() => p.onNavigate('rooms')} onSeeProjects={() => p.onNavigate('projects')} onAddRepo={addRepo} />;
  }

  const overlay = (
    <>
      {menu && (
        <AccountMenu account={me} theme={theme ?? 'system'} chatgpt={gpt.status ?? null} onTheme={pickTheme} onManageSignIn={openMethods}
          onChatGpt={() => { setMenu(false); setSheet('model'); }} onSignOut={out} onClose={() => setMenu(false)} signingOut={leaving} />
      )}
      {sheet === 'methods' && (
        <SignInMethodsSheet methods={methods.methods} busy={methods.busy} linking={busyLinking} error={methods.error}
          onLink={(x) => void linkSignInMethod(x)} onUnlink={(x) => void unlinkSignInMethod(x)} onCancel={() => void cancelSignIn()}
          onOpenModel={gpt.status?.enabled ? () => setSheet('model') : undefined} onClose={() => setSheet(null)} />
      )}
      {sheet === 'model' && (
        <Sheet title="Vowe’s model" subtitle="Separate from how you sign in. It never signs you in to Vowe." width={440} onClose={() => setSheet(null)}>
          <div class="vh-model"><ChatGptSection /></div>
        </Sheet>
      )}
      {sheet === 'find' && <FindRepositoriesSheet found={found} adding={adding} onAdd={addFound} onPick={addRepo} onClose={() => setSheet(null)} />}
      {p.overlay}
      {leaving && <SessionSplash label="Signing out…" account={me} />}
      <ChatGptWelcome />
    </>
  );

  return (
    <AppShell route={p.invite ? 'invitations' : p.page} onNavigate={p.onNavigate} account={me} invitationCount={invitations?.length ?? 0}
      rooms={p.rooms.map((r) => ({ id: r.id, name: r.name, needs: !!r.needs, live: r.inCall.some((x) => x.tone !== 'me') }))}
      onOpenRoom={p.onOpenRoom} onNewRoom={p.onNewRoom} onAccount={() => setMenu(!menu)} accountOpen={menu} overlay={overlay}>
      {page}
    </AppShell>
  );
}
