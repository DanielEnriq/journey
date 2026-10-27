import { useEffect } from '../../../vendor/preact-hooks.js';
import { Store } from '../../../shared/store.js';

// The window's own layout choices, the same on Home and in every room: the sidebar is shown or gone ("[" or
// the sidebar button), and it stays as you left it while you move between places and across relaunches.
// Kept on this machine only (localStorage); every read and write tolerates storage being unavailable.

/** The sidebar's width when shown, until you drag its edge; dragging stays between the min and max. Home's shell and
    the room's window both lay out on it, through --vh-sidebar-w on the document. */
export const SIDEBAR_W = 236;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 400;

const KEY = 'vowe.shell.sidebar';
const WIDTH_KEY = 'vowe.shell.sidebarWidth';

const clampWidth = (w: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w)));

function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'hidden'; } catch { return true; }
}

function readWidth(): number {
  try { const w = Number(localStorage.getItem(WIDTH_KEY)); return w ? clampWidth(w) : SIDEBAR_W; } catch { return SIDEBAR_W; }
}

const stored = typeof localStorage !== 'undefined';
export const shellPrefs = new Store<{ sidebar: boolean; width: number }>({ sidebar: stored ? read() : true, width: stored ? readWidth() : SIDEBAR_W });

const applyWidth = (w: number) => { if (typeof document !== 'undefined') document.documentElement.style.setProperty('--vh-sidebar-w', `${w}px`); };
applyWidth(shellPrefs.state.width);

/** Sets the sidebar's width (clamped); `keep` saves it for next time, which a drag does only when you let go. */
export function setSidebarWidth(w: number, keep = true) {
  const width = clampWidth(w);
  if (width !== shellPrefs.state.width) { shellPrefs.setState({ width }); applyWidth(width); }
  if (keep) try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* the width lasts this session */ }
}

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
