import { buildScene, command, PAYMENT_SYSTEM, type Actor, type CanvasCommand, type Scene } from '../../../../shared/canvas/index.js';
import { account } from '../../../shared/account.js';
import { mockLog } from '../../../shared/mock.js';
import { memoryTransport } from '../../canvas/client.js';
import { DEMO_ME } from './record.js';

// The demo rooms' canvases: the real canvas engine (src/shared/canvas) over this window's local storage,
// so the demo's call draws on the same semantic canvas a real room's does. Payment Reliability starts
// with the payment system and the two views the room drew from it; the other rooms start empty.

const KEY = 'vowe.demo.canvas';
const you = (): Actor => ({ kind: 'human', id: DEMO_ME, name: account.state.user?.name || 'You' });
const JOHN: Actor = { kind: 'human', id: 'john', name: 'John' };
const VOWE: Actor = { kind: 'agent', id: 'vowe', name: 'Vowe' };

/** Who the next command is from: you, except while the demo is being set up. */
let acting: Actor | null = null;
export const demoCanvas = memoryTransport(() => acting ?? you(), KEY);

const ROOMS = ['payments', 'ledger', 'latency', 'webhooks'];

/** Draws Payment Reliability as the room left it: the system, its Failure flow, then Concurrency. */
export async function seedCanvases(): Promise<void> {
  ROOMS.forEach((id) => demoCanvas.forget(id));
  const steps: [Actor, CanvasCommand][] = [
    [JOHN, command('load_system', { ...PAYMENT_SYSTEM, replace: true })],
    [VOWE, command('show_view', { view: 'failure-flow', focus: 'payment-worker' })],
    [VOWE, command('add_failure', { component: 'payment-worker', mode: 'crash' })],
    [VOWE, command('show_view', { view: 'concurrency', focus: 'payment-worker', instances: 2 })],
  ];
  for (const [who, cmd] of steps) {
    acting = who;
    try {
      const { result } = await demoCanvas.execute('payments', cmd);
      if (!result.ok) mockLog('canvas', `couldn’t draw the demo’s ${cmd.name}`, result);
    } finally { acting = null; }
  }
  mockLog('canvas', 'drew Payment Reliability’s canvas (kept in this window only)');
}

export function clearCanvases(): void {
  ROOMS.forEach((id) => demoCanvas.forget(id));
}

/** The view a demo room was left on, as its preview and Home draw it; null before anything is drawn. */
export async function demoScene(roomId: string): Promise<{ scene: Scene; at: string; by: string | null } | null> {
  const { doc } = await demoCanvas.load(roomId);
  if (!Object.keys(doc.components).length) return null;
  const last = doc.history.at(-1);
  try { return { scene: buildScene(doc, doc.activeView), at: last?.at ?? new Date().toISOString(), by: last?.by.kind === 'human' ? last.by.id : null }; } catch { return null; }
}
