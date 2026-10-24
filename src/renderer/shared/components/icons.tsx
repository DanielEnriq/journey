import { h } from '../../vendor/preact.js';

// The design's inline stroke icons, verbatim. Sizes come from the surrounding CSS unless given.
// Preact sets SVG attributes as written, so they stay kebab-case.

export const PanelLeft = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"></rect><path d="M6 3v10"></path></svg>
);
export const PanelRight = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"></rect><path d="M10 3v10"></path></svg>
);
export const Compose = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.4 3a1.4 1.4 0 0 1 2 2L7 12.4l-3 1 1-3z"></path></svg>
);
export const Back = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5"></path></svg>
);
export const Close = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>
);
export const Question = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6.2a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.5M8 12.2v.1"></path></svg>
);
export const Note = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5h7l3 3v8H3z M10 2.5v3h3"></path></svg>
);
export const Arrow = ({ angle }: { angle: number }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" style={{ transform: `rotate(${angle}deg)` }} aria-hidden="true"><path d="M2 6h7M6.5 3 9.5 6l-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
);
export const Cursor = ({ color }: { color: string }) => (
  <svg width="16" height="18" viewBox="0 0 16 18"><path d="M1.5 1.5 14 9.2l-5.6 1.2-3 5.6z" fill={color} stroke="#fff" stroke-width="1.2" stroke-linejoin="round"></path></svg>
);

export const ToolSelect = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.8 12.6 8 8.6 8.9 6.8 12.8z"></path></svg>
);
export const ToolPan = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.2 8V4.2a1 1 0 0 1 2 0V7.6M7.2 7.4V3.4a1 1 0 0 1 2 0v4M9.2 7.4V4.4a1 1 0 0 1 2 0V9c0 2.6-1.6 4.4-3.8 4.4-1.5 0-2.4-.7-3.3-2L2.8 9.5a1 1 0 0 1 1.6-1.1l.8.9"></path></svg>
);
export const ToolCircle = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M12.6 5.2C11.6 3.4 9.9 2.6 8 2.6 4.9 2.6 2.6 5 2.6 8s2.4 5.4 5.6 5.4c3.1 0 5.2-2.3 5.2-5.1 0-1.3-.4-2.4-1.1-3.3"></path></svg>
);
export const ToolDraw = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12.5c2-3.5 3.6-5 5-4.2 1.4.8-.6 3.4.8 3.9 1.2.4 2.6-1.4 5.2-5.7"></path></svg>
);
export const ToolComment = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M3 3.5h10v7H7.4L4.5 13v-2.5H3z"></path></svg>
);
export const ClearInk = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.6 3.2 13 6.6 7.4 12.2H4.6L3 10.6z M6 6.8l3.4 3.4M4.6 12.2H13"></path></svg>
);
export const ZoomIn = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8"></path></svg>
);
export const ZoomOut = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8"></path></svg>
);

export const Mic = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="5.8" y="2" width="4.4" height="7.6" rx="2.2"></rect><path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2"></path>{muted && <path d="M2.5 2.5l11 11"></path>}</svg>
);
export const Captions = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3.5" width="12" height="9" rx="2"></rect><path d="M7 7.2a1.6 1.6 0 1 0 0 1.6M11.4 7.2a1.6 1.6 0 1 0 0 1.6"></path></svg>
);
export const Leave = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.4 9.6c3.4-3 7.8-3 11.2 0l-1.4 1.8-2.2-1v-1.6a6.6 6.6 0 0 0-4 0v1.6l-2.2 1z"></path></svg>
);

export const Repo = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4.5" cy="3.5" r="1.6"></circle><circle cx="4.5" cy="12.5" r="1.6"></circle><circle cx="11.5" cy="6" r="1.6"></circle><path d="M4.5 5.1v5.8M11.5 7.6c0 2.4-3 2.2-6.2 3.6"></path></svg>
);
export const HomeMic = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5"></rect><path d="M3 7.6a5 5 0 0 0 10 0M8 12.6v1.8"></path></svg>
);

/* Not in the design: the way back to the workspace from a room. */
export const Home = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.2 8 2.8l5.5 4.4V13a.6.6 0 0 1-.6.6H9.6V10H6.4v3.6H3.1a.6.6 0 0 1-.6-.6z"></path></svg>
);
