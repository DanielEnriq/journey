import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useState } from '../../vendor/preact-hooks.js';
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
import { InboxHome } from '../inbox/ui/InboxHome.js';
import { RoomsQuiet, YourRooms } from '../inbox/ui/YourRooms.js';
import { activeInbox, type InboxSource } from '../inbox/source.js';
import { InvitationsIndex } from '../../ui/pass2/invites/InviteGate.js';
import { FindRepositoriesSheet, ProjectsIndex } from '../../ui/pass2/projects/Projects.js';
import { AppShell, type ShellRoute } from '../../ui/pass2/shell/AppShell.js';
import type { AccountView, LocalRepoView, MissingRepoView, WorkItem } from '../../ui/pass2/types.js';
import type { NewRoom, RepoChoice } from '../room/data/sources.js';
import type { RoomSummary } from '../room/types.js';
import { localWork, realStatus, realWorkspace, repositories, roomCheckouts } from '../workspace/real/workspace.js';

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
  /** New room, in the repository whose + was pressed in the sidebar (null: none chosen). */
  onNewRoom(repo?: string | null): void;
  /** Joins a room's call (asking first if you're in another); absent: opening the room offers it. */
  onJoinCall?(id: string): void;
  /** Absent in the demo: its pages have no invitations or link field. */
  onOpenInvite?(key: InviteKey): void;
  /** The New room sheet, when open. */
  overlay?: ComponentChildren;
  /** An invite being opened: shown in place of the page. */
  invite?: ComponentChildren;
  /** The workspace's Inbox; when absent, the one in `activeInbox`. With neither, Home shows its rooms instead. */
  inbox?: InboxSource | null;
  /** The Inbox item selected (from the route, `#/home/i/<id>`); undefined keeps it inside Home. */
  selected?: string | null;
  onSelect?(id: string | null): void;
}

/** "~/code/payments": for its owner's eyes only. */
const pathLabel = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

export function Home(p: HomeProps) {
  const { user } = useStore(account);
  const real = !p.demo;
  const status = useStore(realStatus);
  const [theme, pickTheme] = useThemeSetting();
  const gpt = useStore(chatgpt);
  const methods = useStore(signInMethods);
  const [menu, setMenu] = useState(false);
  const { source: active } = useStore(activeInbox);
  const inbox = p.inbox !== undefined ? p.inbox : active;
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

  // You have no rooms once they've been read (or right away in the demo): Home welcomes you instead.
  const noRooms = !p.rooms.length && !(real && status.state === 'loading');

  const localViews: LocalRepoView[] | null = local && local.map((r) => ({
    id: r.id, name: r.name, pathLabel: pathLabel(r.path), lastOpenedAt: r.lastOpenedAt, remote: null,
    rooms: p.rooms.filter((x) => checkouts.get(x.id)?.repositoryId === r.id).map((x) => ({ id: x.id, name: x.name })),
  }));
  // Rooms whose repository has been checked and isn't cloned on this machine (null means checked, not found).
  const missingHere = new Set(p.rooms.filter((r) => r.repo && checkouts.get(r.id) === null).map((r) => r.id));
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
  else if (p.page === 'projects') {
    page = <ProjectsIndex repos={localViews} missing={missing} onAddRepo={addRepo} onFindRepos={findRepos} onOpenRoom={p.onOpenRoom}
      onRemove={real ? (id) => { repositories.remove(id).then(reloadRepos, (err: Error) => setRepoError(err.message)); } : undefined} />;
  } else if (p.page === 'invitations') {
    page = <InvitationsIndex invitations={invitations} onOpen={p.onOpenInvite} />;
  } else if (noRooms) {
    page = <HomeFirst firstName={firstName(user)} composer={composer} invitations={invitations ?? []} onOpenInvite={p.onOpenInvite}
      repoCount={local?.length ?? 0} onAddRepo={addRepo} onFindRepos={findRepos} notice={notice} />;
  } else {
    // The Inbox is bound as soon as you're signed in; until then, your rooms on their own.
    const rooms = (needs?: Record<string, number>, now = new Date().toISOString()) => (
      <YourRooms rooms={p.rooms} now={now} needs={needs ?? {}} scene={(id) => inbox ? inbox.context(id).then((c) => c.scene) : Promise.resolve(null)}
        onRoom={p.onOpenRoom} onJoin={p.onJoinCall ?? p.onOpenRoom} work={real ? work : null} missing={missingHere} />
    );
    page = inbox
      ? <InboxHome source={inbox} firstName={firstName(user)} selected={p.selected} onSelect={p.onSelect} onOpenRoom={p.onOpenRoom}
          quiet={<RoomsQuiet rooms={p.rooms} now={new Date().toISOString()} />} notice={notice}
          idle={(st) => rooms(needsByRoom(st.view.needs), st.now)} />
      : rooms();
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
      rooms={p.rooms} onOpenRoom={p.onOpenRoom} onNewRoom={(repo) => p.onNewRoom(repo ?? null)} onAccount={() => setMenu(!menu)} accountOpen={menu} overlay={overlay}
      fixed={p.page === 'home' && !p.invite && !!inbox && !noRooms}>
      {page}
    </AppShell>
  );
}

/** How many Needs-you items each room has. */
function needsByRoom(items: { room: { id: string } }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.room.id] = (out[it.room.id] ?? 0) + 1;
  return out;
}
