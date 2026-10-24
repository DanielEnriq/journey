import type { JourneyApi, Repository, Theme, User } from '../shared/api.js';

declare global {
  interface Window {
    journey: JourneyApi;
  }
}

const { auth, settings, repos } = window.journey;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const userEl = $('user');
const reposEl = $<HTMLUListElement>('repos');
const themeEl = $<HTMLSelectElement>('theme');
const errorEl = $('error');

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

$('add-repo').onclick = () =>
  attempt(async () => {
    if (await repos.add()) renderRepos(await repos.list());
  });

themeEl.onchange = () => attempt(() => settings.update({ theme: themeEl.value as Theme }));

auth.onChange(renderUser);
attempt(async () => {
  const [user, list, current] = await Promise.all([auth.getUser(), repos.list(), settings.get()]);
  renderUser(user);
  renderRepos(list);
  themeEl.value = current.theme;
});
