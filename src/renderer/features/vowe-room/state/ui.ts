import { Store, type CanvasRef, type PersonId } from '../journey.js';

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
  /** The rooms panel is open. */
  side: boolean;
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
  /** Full screen: which section the rail shows (For you, or one of the three surfaces). */
  fsec: 'foryou' | Tab;
}

export const initialUi = (): UiState => ({
  tool: 'select', sel: [], open: null, openTab: 'ports', whatIf: null, reveal: 99, latency: 4, ask: null,
  vowe: 'listening', voweLine: 'Listening', said: [], cc: true, muted: false,
  deskOpen: true, tab: 'discuss', inspect: null, focusOn: true, thread: null,
  side: false, flash: null, since: false, sinceOpen: true, noticesOpen: false, draft: null, note: null,
  insW: 760, toast: null, everywhere: false, depth: 'compact', prevDepth: null, lens: 'call', myView: null, compare: null, fsec: 'discuss',
});

export const makeUi = () => new Store<UiState>(initialUi());
export type Ui = Store<UiState>;
