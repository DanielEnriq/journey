import { RoomController, type Scenario } from './controller.js';
import type { RoomSources } from './data/sources.js';

// The Payment Reliability call's canvas, kept across leaving and rejoining: the room persists, so
// whatever was drawn, noted, signed or handed off is still there when you come back. Replaced when the
// developer menu loads the demo scenario again.

let current: { scenario: Scenario; ctrl: RoomController } | null = null;
const listeners = new Set<() => void>();

export function demoController(sources: RoomSources, scenario: Scenario): RoomController {
  if (current?.scenario === scenario) return current.ctrl;
  current?.ctrl.dispose();
  const ctrl = new RoomController(sources, { scenario });
  ctrl.suspend(); // nobody is in the call yet
  current = { scenario, ctrl };
  ctrl.store.subscribe(() => listeners.forEach((l) => l()));
  listeners.forEach((l) => l());
  return ctrl;
}

/** The demo canvas, if one has been opened since the scenario was loaded. */
export const peekDemo = () => current?.ctrl ?? null;

export function resetDemo() {
  current?.ctrl.dispose();
  current = null;
  listeners.forEach((l) => l());
}

export function onDemoChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
