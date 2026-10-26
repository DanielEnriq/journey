import { useEffect } from '../../../vendor/preact-hooks.js';
import { Store } from '../../../shared/store.js';

// The window's own layout choices, the same on Home and in every room: the sidebar is shown or gone ("[" or
// the sidebar button), and it stays as you left it while you move between places and across relaunches.
// Kept on this machine only (localStorage); every read and write tolerates storage being unavailable.

/** The sidebar's width when shown. Home's shell and the room's window both lay out on it. */
export const SIDEBAR_W = 236;

const KEY = 'vowe.shell.sidebar';

function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'hidden'; } catch { return true; }
}

export const shellPrefs = new Store<{ sidebar: boolean }>({ sidebar: typeof localStorage === 'undefined' ? true : read() });

export function setSidebar(on: boolean) {
  shellPrefs.setState({ sidebar: on });
  try { localStorage.setItem(KEY, on ? 'shown' : 'hidden'); } catch { /* private window or blocked storage: the choice lasts this session */ }
}

export const toggleSidebar = () => setSidebar(!shellPrefs.state.sidebar);

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/* "[" shows or hides the sidebar, wherever you are (ignored while typing or with a modifier). Home's shell and a
   kept-alive room can both be mounted, so one listener serves every user of the hook. */
function onKey(e: KeyboardEvent) {
  if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  e.preventDefault();
  toggleSidebar();
}
let keyUsers = 0;
export function useSidebarKey() {
  useEffect(() => {
    if (keyUsers++ === 0) addEventListener('keydown', onKey);
    return () => { if (--keyUsers === 0) removeEventListener('keydown', onKey); };
  }, []);
}
