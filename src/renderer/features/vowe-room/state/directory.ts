import { createContext } from '../../../vendor/preact.js';
import { useContext } from '../../../vendor/preact-hooks.js';
import type { Person, PersonId } from '../../room/panel/types.js';
import { AGENT } from '../contracts/model.js';

// Who is who in this room, provided once by <VoweRoom> from its props (Journey's people directory and the
// organization's agent name) and read by every component through context. No module state, no globals.

export interface Directory {
  /** The signed-in person (Journey's session user id). */
  me: PersonId;
  /** Everyone the record can mention: members, invited reviewers, the agent, integrations (e.g. GitHub). */
  people: Readonly<Record<PersonId, Person>>;
  /** The agent's displayed name in this organization; its identity (glyph, attribution) never changes. */
  agentName: string;
}

export interface Names {
  me: PersonId;
  nameOf(id: PersonId): string;
  agentName(): string;
  person(id: PersonId): Person;
}

export const DEFAULT_AGENT_NAME = 'Vowe';

export function names(dir: Directory): Names {
  const agent = dir.agentName.trim() || DEFAULT_AGENT_NAME;
  return {
    me: dir.me,
    agentName: () => agent,
    nameOf: (id) => (id === AGENT ? agent : dir.people[id]?.name ?? id),
    // Someone the directory doesn't know (left the org, not loaded yet) still renders, as their id.
    person: (id) => dir.people[id] ?? { id, name: id === AGENT ? agent : id, initials: (id[0] ?? '?').toUpperCase(), kind: id === AGENT ? 'agent' : 'human', tone: 'peer3' },
  };
}

export const DirectoryContext = createContext<Directory>({ me: '', people: {}, agentName: DEFAULT_AGENT_NAME });

export function useNames(): Names {
  return names(useContext(DirectoryContext));
}
