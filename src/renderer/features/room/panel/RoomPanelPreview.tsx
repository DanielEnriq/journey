import { h } from '../../../vendor/preact.js';
import { useEffect, useState } from '../../../vendor/preact-hooks.js';
import { RoomPanel } from './RoomPanel.js';
import { paymentRoom } from './fixtures.js';
import type { Decision, Thread } from './types.js';

/**
 * Dev-only harness: the panel on fixture data, with the presence timeline from
 * the design canvas and local handlers standing in for the room store. In Vowe it is
 * the developer menu's "Room panel" screen (#/dev/room-panel); never mount it in a room.
 */
export function RoomPanelPreview() {
  const [threads, setThreads] = useState<Thread[]>(paymentRoom.threads);
  const [decision, setDecision] = useState<Decision>(paymentRoom.decision!);

  useEffect(() => {
    const at = (ms: number, fn: () => void): number => window.setTimeout(fn, ms);
    const setPresence = (id: string | null, mode: 'reading' | 'typing' = 'reading'): void =>
      setThreads((ts) => ts.map((t) => ({ ...t, presence: t.id === id ? { personId: 'john', mode } : undefined })));
    const timers = [
      at(1400, () => setPresence('n2')),
      at(5200, () => setPresence('n5', 'typing')),
      at(10400, () => {
        setThreads((ts) =>
          ts.map((t) =>
            t.id === 'n5'
              ? { ...t, presence: { personId: 'john', mode: 'reading' }, replies: [...t.replies, { id: 'n5-1', authorId: 'john', body: 'Alert when a lease expires with no ack. Srikar owns that metric.', ago: 'now', fresh: true }] }
              : t,
          ),
        );
      }),
      at(14500, () => {
        setPresence(null);
        setDecision((d) => ({ ...d, presence: { personId: 'john', mode: 'reading' } }));
      }),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <div style={{ width: 352, height: '100vh', background: 'var(--rail)' }}>
      <RoomPanel
        {...paymentRoom}
        threads={threads}
        decision={decision}
        onSign={(_, v) =>
          setDecision((d) => ({
            ...d,
            approvers: d.approvers.map((a) => (a.personId === paymentRoom.meId ? { ...a, signedVersion: v } : a)),
            status: d.approvers.every((a) => a.personId === paymentRoom.meId || a.signedVersion === v) ? 'agreed' : d.status,
          }))
        }
        onReply={(id, body) =>
          setThreads((ts) =>
            ts.map((t) => (t.id === id ? { ...t, replies: [...t.replies, { id: `${id}-${Date.now()}`, authorId: paymentRoom.meId, body, ago: 'now', fresh: true }] } : t)),
          )
        }
      />
    </div>
  );
}
