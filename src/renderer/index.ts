import type { JourneyApi, Repository, Room, Theme, User, Workspace } from '../shared/api.js';
import { CallController, type CallParticipant, type CallSnapshot } from './call.js';

declare global {
  interface Window {
    journey: JourneyApi;
  }
}

const { auth, settings, repos, workspaces, rooms, calls } = window.journey;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const userEl = $('user');
const reposEl = $<HTMLUListElement>('repos');
const themeEl = $<HTMLSelectElement>('theme');
const errorEl = $('error');
const workspaceEl = $<HTMLSelectElement>('workspace');
const roomsEl = $<HTMLUListElement>('rooms');
const callEl = $('call');
const call = new CallController(calls);
/** Rooms of the selected workspace, for labelling the call. */
let roomList: Room[] = [];

/** Runs an action, showing any failure in the error line instead of swallowing it. */
async function attempt(action: () => Promise<unknown>) {
  errorEl.textContent = '';
  try {
    await action();
  } catch (err) {
    // Electron prefixes IPC errors with "Error invoking remote method '…': Error: ".
    errorEl.textContent = String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

function button(label: string, onClick: () => Promise<unknown>) {
  const el = document.createElement('button');
  el.textContent = label;
  el.onclick = () => attempt(onClick);
  return el;
}

function renderUser(user: User | null) {
  userEl.replaceChildren();
  if (user) {
    if (user.picture) {
      const img = document.createElement('img');
      img.src = user.picture;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      userEl.append(img);
    }
    userEl.append(user.name ?? user.email, button('Sign out', () => auth.signOut()));
  } else {
    userEl.append(button('Sign in with Google', () => auth.signIn()));
  }
}

function renderRepos(list: Repository[]) {
  reposEl.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No repositories yet.';
    reposEl.append(li);
  }
  for (const repo of list) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('div');
    const path = document.createElement('div');
    name.textContent = repo.name;
    path.className = 'path';
    path.textContent = path.title = repo.path;
    info.append(name, path);
    li.append(info, button('Remove', async () => {
      await repos.remove(repo.id);
      renderRepos(await repos.list());
    }));
    reposEl.append(li);
  }
}

/** Cloud features need Supabase and a signed-in user; say so in place of the list rather than as an error. */
async function renderWorkspaces(user: User | null) {
  let list: Workspace[] = [];
  let unavailable: string | null = user ? null : 'Sign in to see your rooms.';
  if (user) {
    try {
      list = await workspaces.list();
    } catch (err) {
      unavailable = String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  }
  const selected = workspaceEl.value;
  workspaceEl.replaceChildren(
    ...list.map((ws) => {
      const option = document.createElement('option');
      option.value = ws.id;
      option.textContent = ws.name;
      return option;
    }),
  );
  if (list.some((ws) => ws.id === selected)) workspaceEl.value = selected;
  workspaceEl.disabled = !list.length;
  for (const form of document.forms) if (form.id !== 'new-workspace') form.hidden = !list.length;
  $('new-workspace').hidden = Boolean(unavailable);
  if (unavailable || !list.length) {
    roomList = [];
    return renderRooms(unavailable ?? 'Create a workspace to add rooms.');
  }
  roomList = await rooms.list(workspaceEl.value);
  renderRooms();
}

function renderRooms(empty = 'No rooms yet.') {
  roomsEl.replaceChildren();
  if (!roomList.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = empty;
    roomsEl.append(li);
  }
  const { roomId, status } = call.snapshot;
  for (const room of roomList) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.textContent = room.name;
    li.append(name);
    if (room.id === roomId && status !== 'idle') {
      const here = document.createElement('span');
      here.className = 'status';
      here.textContent = 'In call';
      li.append(here);
    } else {
      li.append(button('Join call', () => call.join(room.id)));
    }
    roomsEl.append(li);
  }
}

function renderParticipant(p: CallParticipant) {
  const li = document.createElement('li');
  if (p.avatarUrl) {
    const img = document.createElement('img');
    img.src = p.avatarUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (p.isSpeaking) img.className = 'speaking';
    li.append(img);
  }
  const name = document.createElement('div');
  name.textContent = `${p.name ?? 'Someone'}${p.isLocal ? ' (you)' : ''}`;
  if (p.isSpeaking && !p.avatarUrl) name.className = 'speaking';
  const state = document.createElement('span');
  state.className = 'status';
  state.textContent = [p.isMuted ? 'muted' : null, p.connection === 'lost' ? 'connection lost' : p.connection === 'poor' ? 'poor connection' : null]
    .filter(Boolean)
    .join(' · ');
  li.append(name, state);
  return li;
}

const STATUS_LABEL: Record<CallSnapshot['status'], string> = {
  idle: '',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
};

function renderCall(snapshot: CallSnapshot) {
  const active = snapshot.status !== 'idle';
  callEl.hidden = !active && !snapshot.error;
  $('call-head').hidden = !active;
  $('call-room').textContent = roomList.find((r) => r.id === snapshot.roomId)?.name ?? 'Call';
  $('call-status').textContent = STATUS_LABEL[snapshot.status];
  $('call-error').textContent = snapshot.error ?? '';
  $('call-audio').hidden = !snapshot.audioBlocked;
  const mute = $<HTMLButtonElement>('call-mute');
  mute.textContent = snapshot.micEnabled ? 'Mute' : 'Unmute';
  mute.disabled = snapshot.status !== 'connected';
  $('call-participants').replaceChildren(...snapshot.participants.map(renderParticipant));
  renderRooms();
}

$('call-leave').onclick = () => attempt(() => call.leave());
$('call-mute').onclick = () => attempt(() => call.setMuted(call.snapshot.micEnabled));
$('call-audio').onclick = () => attempt(() => call.startAudio());
workspaceEl.onchange = () => attempt(() => renderWorkspaces(currentUser));

/** Submits a one-field form, clearing it on success. */
function onSubmit(id: string, action: (name: string) => Promise<unknown>) {
  const form = $<HTMLFormElement>(id);
  form.onsubmit = (event) => {
    event.preventDefault();
    const input = form.elements.namedItem('name') as HTMLInputElement;
    attempt(async () => {
      await action(input.value.trim());
      input.value = '';
    });
  };
}
onSubmit('new-workspace', async (name) => {
  const ws = await workspaces.create(name);
  await renderWorkspaces(currentUser);
  workspaceEl.value = ws.id;
  await renderWorkspaces(currentUser);
});
onSubmit('new-room', async (name) => {
  await rooms.create(workspaceEl.value, name);
  await renderWorkspaces(currentUser);
});

let currentUser: User | null = null;

$('add-repo').onclick = () =>
  attempt(async () => {
    if (await repos.add()) renderRepos(await repos.list());
  });

themeEl.onchange = () => attempt(() => settings.update({ theme: themeEl.value as Theme }));

auth.onChange((user) => {
  currentUser = user;
  renderUser(user);
  if (!user) void call.leave(); // the token outlives sign-out; don't stay in the call
  attempt(() => renderWorkspaces(user));
});
call.onChange(renderCall);
attempt(async () => {
  const [user, list, current] = await Promise.all([auth.getUser(), repos.list(), settings.get()]);
  currentUser = user;
  renderUser(user);
  await renderWorkspaces(user);
  renderRepos(list);
  themeEl.value = current.theme;
});
