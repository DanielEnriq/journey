import { mockLog } from '../../shared/mock.js';
import { Store } from '../../shared/store.js';
import type { CallDataSource } from '../room/data/sources.js';

// Whether you are in a call, and in which room. Separate from the room (which persists) and from the
// canvas (which belongs to the call): joining connects, leaving disconnects, and the canvas only shows
// while this says connected. A call is never rejoined on relaunch, and the mic is never opened here.

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'leaving' | 'dropped' | 'failed';

export interface CallState {
  roomId: string | null;
  status: CallStatus;
  error: string | null;
}

export class CallSession {
  readonly store = new Store<CallState>({ roomId: null, status: 'idle', error: null });

  constructor(private readonly call: CallDataSource) {}

  get state() { return this.store.state; }

  /** True while you are in this room's call, or on your way in or out of it. */
  inRoom(roomId: string) { return this.state.roomId === roomId && this.state.status !== 'idle' && this.state.status !== 'failed'; }

  async join(roomId: string) {
    if (this.state.status === 'connecting') return false;
    if (this.state.roomId && this.state.roomId !== roomId && this.state.status === 'connected') await this.leave();
    this.store.setState({ roomId, status: 'connecting', error: null });
    try {
      await this.call.join(roomId);
      if (this.state.roomId !== roomId) return false;
      this.store.setState({ status: 'connected' });
      return true;
    } catch (err) {
      this.store.setState({ status: 'failed', error: (err as Error).message });
      return false;
    }
  }

  async leave() {
    const { roomId } = this.state;
    if (!roomId) return;
    this.store.setState({ status: 'leaving' });
    try { await this.call.leave(roomId); } finally { this.store.setState({ roomId: null, status: 'idle', error: null }); }
  }

  /** Developer menu: the connection drops, as a network change would. */
  drop() {
    if (this.state.status !== 'connected') return;
    mockLog('call', 'connection dropped (dev menu)');
    this.store.setState({ status: 'dropped' });
  }

  dismissError() { if (this.state.status === 'failed') this.store.setState({ roomId: null, status: 'idle', error: null }); }
}
