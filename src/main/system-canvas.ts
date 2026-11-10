import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { SavedView } from '../shared/system/api.js';
import type { Interpretation } from '../shared/system/model.js';
import { createSystemService, type SystemService } from '../system/service.js';
import { isAppPage } from './window.js';

// The system canvas inside the app: a Developer menu window showing dist/renderer/system.html, and the
// `system:*` channels its page calls through the preload (window.journey.system). The same Node service
// the dev server uses (src/system/service.ts) answers them, keeping its cache, saved views and traces
// under userData/system. It reads only the Journey checkout the app runs from; a renderer never sends
// a path, only a repository id the service handed out.

const SYSTEM_PAGE = join(import.meta.dirname, '..', 'renderer', 'system.html');
const SYSTEM_URL = pathToFileURL(SYSTEM_PAGE).href;

const isSystemPage = (url: string) => url.split(/[?#]/)[0] === SYSTEM_URL;

let service: SystemService | null = null;
const system = () => service ??= createSystemService({ home: join(app.getPath('userData'), 'system') });

/** Parses an untrusted IPC argument, naming it in the error. */
function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${what} is invalid: ${result.error.issues[0]?.message ?? 'unexpected value'}`);
  return result.data;
}
const repoId = z.string().trim().min(1).max(200);
const line = z.number().int().min(0).max(10_000_000);
// Views and interpretations are checked in full by the service; here only their outline and size.
const outline = (v: unknown, max: number) => typeof v === 'object' && v !== null && JSON.stringify(v).length <= max;
const savedView = z.custom<SavedView>((v) => outline(v, 512 * 1024) && outline((v as SavedView).request, 512 * 1024), 'Expected a saved view');
const interpretation = z.custom<Interpretation>((v) => outline(v, 64 * 1024) && outline((v as Interpretation).op, 64 * 1024), 'Expected an interpretation');

/** Like ipc.ts's `handle`: only our own pages may call, and here the system page may too. */
function handle(channel: string, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const url = event.senderFrame?.url ?? '';
    if (!event.senderFrame || !(isAppPage(url) || isSystemPage(url))) throw new Error(`Blocked ${channel} from untrusted sender ${url || '(gone)'}`);
    return handler(...args);
  });
}

export function registerSystemIpc() {
  handle('system:repos', () => system().repos());
  handle('system:open', (repo, opts) => system().open(parse(repoId, repo, 'Repository id'), parse(z.object({ reindex: z.boolean().optional() }).strict().optional(), opts, 'Options')));
  handle('system:freshness', (repo) => system().freshness(parse(repoId, repo, 'Repository id')));
  handle('system:refresh', (repo) => system().refresh(parse(repoId, repo, 'Repository id')));
  // The service confines the path to the repository (no absolute paths, `..` or symlinks out of it).
  handle('system:source', (repo, file, start, end, context) => system().source(
    parse(repoId, repo, 'Repository id'), parse(z.string().min(1).max(1000), file, 'File'),
    parse(line, start, 'Start'), parse(line, end, 'End'), parse(z.number().int().min(0).max(50).optional(), context, 'Context'),
  ));
  handle('system:fixtures', () => system().fixtures());
  handle('system:fixture', (id) => system().fixture(parse(repoId, id, 'Fixture id')));
  handle('system:views', (repo) => system().views(parse(repoId, repo, 'Repository id')));
  handle('system:saveView', (repo, view) => system().saveView(parse(repoId, repo, 'Repository id'), parse(savedView, view, 'View')));
  handle('system:traces', (repo) => system().traces(parse(repoId, repo, 'Repository id')));
  handle('system:addInterpretation', (repo, i) => system().addInterpretation(parse(repoId, repo, 'Repository id'), parse(interpretation, i, 'Interpretation')));
}

let win: BrowserWindow | null = null;

/** Developer ▸ System canvas: one window, focused if it's already open. */
export function openSystemWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) { win.focus(); return win; }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'System canvas',
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Same rules as the main window: only this page, external links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => { if (!isSystemPage(url)) event.preventDefault(); });
  win.on('closed', () => { win = null; });
  void win.loadFile(SYSTEM_PAGE);
  return win;
}
