import { Store } from '../../../shared/store.js';
import type { CanvasRef, PersonId } from '../journey.js';

// Your own state in the room: tool, selection, the Desk's tab and size, what's open. Never shared, so
// nobody else's layout moves when you open something; what others see of it goes through presence.

/** How deep the Desk opens: the sidebar, side by side with the canvas, or the full-width Focus workspace. */
export type Depth = 'compact' | 'expanded' | 'focus';
export type Tool = 'select' | 'pan' | 'circle' | 'draw' | 'erase' | 'comment';
export type VoweMode = 'listening' | 'understanding' | 'investigating' | 'preparing' | 'explaining' | 'clarifying' | 'proposing' | 'awaiting' | 'interrupted' | 'uncertain' | 'error' | 'off';
/** A line said in the call, as Journey's captions carry it. */
export interface Said { who: PersonId; text: string; partial?: boolean }

export type Tab = 'discuss' | 'decide' | 'work';
export type WorkSection = 'plan' | 'run' | 'prs' | 'outcome';
export type Inspect = { kind: 'decision'; id: string; line?: string } | { kind: 'work'; id: string; step?: string; pr?: string; section?: WorkSection; thread?: string; quote?: string } | null;

export interface UiState {
  tool: Tool;
  sel: CanvasRef[];
  open: string | null;
  openTab: 'ports' | 'evidence' | 'code' | 'activity';
  whatIf: string | null;
  reveal: number;
  latency: number;
  ask: { id: string; refs: CanvasRef[]; names: string[]; x: number; y: number } | null;
  vowe: VoweMode;
  voweLine: string;
  said: Said[];
  cc: boolean;
  muted: boolean;
  /** The Desk: shown or collapsed, compact or widened into an inspector, and which tab. */
  deskOpen: boolean;
  tab: Tab;
  inspect: Inspect;
  /** Show only what's about the part you've selected. */
  focusOn: boolean;
  /** Which thread is open in Discuss. */
  thread: string | null;
  flash: string | null;
  since: boolean;
  sinceOpen: boolean;
  noticesOpen: boolean;
  draft: { x: number; y: number; on: { component: string; name: string } | null } | null;
  note: string | null;
  /** The widened Desk's width (the divider). */
  insW: number;
  toast: { text: string; undo?: () => void } | null;
  /** Discuss: only conversations about the system, or every thread. */
  everywhere: boolean;
  depth: Depth;
  /** Where Focus returns to. */
  prevDepth: Depth | null;
  /** Canvas lens: follow the call's shared view, or a personal one. */
  lens: 'call' | 'mine';
  myView: string | null;
  /** Plan/decision document: compare with an earlier version. */
  compare: number | null;
  /** Full screen: which section Focus shows (For you is Home's Inbox now). */
  fsec: Tab;
  /** Full screen: the section whose composer fills the page (a new thread, decision or work), if one does. */
  fwrite: Tab | null;
}

export const initialUi = (): UiState => ({
  tool: 'select', sel: [], open: null, openTab: 'ports', whatIf: null, reveal: 99, latency: 4, ask: null,
  vowe: 'listening', voweLine: 'Listening', said: [], cc: true, muted: false,
  deskOpen: true, tab: 'discuss', inspect: null, focusOn: true, thread: null,
  flash: null, since: false, sinceOpen: true, noticesOpen: false, draft: null, note: null,
  insW: 760, toast: null, everywhere: false, depth: 'compact', prevDepth: null, lens: 'call', myView: null, compare: null, fsec: 'discuss', fwrite: null,
});

// Moving anywhere else in the Desk puts down what you were writing in full screen, whichever path moved you
// (a tab, a thread, an Inbox anchor, leaving full screen), unless the move itself opens the composer.
const MOVES = ['tab', 'fsec', 'inspect', 'thread', 'depth'] as const;
class UiStore extends Store<UiState> {
  setState(p: Partial<UiState>) {
    const moved = !('fwrite' in p) && this.state.fwrite && MOVES.some((k) => k in p && p[k] !== this.state[k]);
    super.setState(moved ? { ...p, fwrite: null } : p);
  }
}

export const makeUi = (): Ui => new UiStore(initialUi());
export type Ui = Store<UiState>;
