// Everything this prototype takes from Journey, imported from Journey's own source (latest main), so the
// room's shell, call bar, panel pieces and canvas engine are the real ones, not redrawings.

export { h, Fragment, type ComponentChildren } from '../../vendor/preact.js';
export { useEffect, useMemo, useRef, useState, useLayoutEffect } from '../../vendor/preact-hooks.js';
export { Store, useStore } from '../../shared/store.js';
export {
  Arrow, ClearInk, Cursor, Note as NoteIcon, ToolCircle, ToolComment, ToolDraw, ToolPan, ToolSelect, ZoomIn, ZoomOut,
  PanelLeft, PanelRight, Compose, Back, Close, Question, Mic, Captions, Leave,
} from '../../shared/components/icons.js';
export { Lights, Chrome, Who, roomLine } from '../room/shell.js';
export { CallBar, type CallControls } from '../room/call/CallBar.js';
export { Inside } from '../room/canvas/Part.js';
export { inside, STAGE_H, STAGE_W, toD } from '../room/geometry.js';
export { Avatar, PresenceTag, TypingDots, liveTone } from '../room/panel/Presence.js';
export type { Person, PersonId, Comment, ThreadKind, Approver, Presence, PersonTone } from '../room/panel/types.js';
export type { RoomSummary, PersonRef } from '../room/types.js';
export { CanvasClient, type CanvasTransport, type CanvasPeer } from '../canvas/client.js';
export * as canvas from '../../../shared/canvas/index.js';
export type {
  Actor, Annotation, CanvasRef, CanvasDocument, CanvasPresence, CommandArgs, CommandName, CommandResult, Scene, SceneNode, StoredCanvas,
} from '../../../shared/canvas/index.js';
