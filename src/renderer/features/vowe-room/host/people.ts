import type { Person } from '../../room/panel/types.js';
import type { RoomAccess } from '../../membership/model.js';
import { AGENT, type VoweRecord } from '../contracts/model.js';
import { DEFAULT_AGENT_NAME, type Directory } from '../state/directory.js';

// Pure pieces of the real room's host: the empty record, who the record can name, and when a message asks
// the assistant in. No Journey globals, so they're testable on their own.

export const EMPTY_RECORD: VoweRecord = { threads: [], decisions: [], work: [], notices: [], call: false, members: [], done: [], vowe: true, agents: [] };

/** "@Vowe" (or the assistant's current name) anywhere in a message. */
export function mentionsAgent(body: string, agentName: string): boolean {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s(])@(${esc(agentName)}|vowe)(?![\\w])`, "i").test(body);
}

const TONE: Record<string, Person['tone']> = { me: 'me', peer: 'peer', peer2: 'peer2', peer3: 'peer3', peer4: 'peer3' };

/** Everyone the record can name: the room's members and the agent. */
export function directoryOf(me: string, access: RoomAccess | null, agentName: string | undefined): Directory {
  const people: Record<string, Person> = {};
  for (const u of Object.values(access?.users ?? {})) people[u.id] = { id: u.id, name: u.name, initials: u.initials, kind: 'human', tone: u.id === me ? 'me' : TONE[u.tone] ?? 'peer' };
  const agent = agentName?.trim() || DEFAULT_AGENT_NAME;
  people[AGENT] = { id: AGENT, name: agent, initials: agent.slice(0, 1).toUpperCase(), kind: 'agent' };
  return { me, people, agentName: agent };
}

