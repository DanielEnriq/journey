import type { PersonId } from '../vowe-room/journey.js';
import type { Inspect, Tab } from '../vowe-room/state/ui.js';

// The personal Inbox's data model: what an item is, why it is yours, and
// where opening it lands. Items are derived (model/derive.ts) from records Journey already keeps, plus a few
// sources it doesn't have yet; every item says which (`source`), so nothing is presented as more real than it is.

/**
 * Three tiers, decided by structure, never by how "important" text sounds:
 *   needs      you are the blocker: something is addressed to you and waits on you
 *   following  something you wrote, signed, own or chose to follow moved
 *   activity   the rest of what happened in your rooms, digested per room
 */
export type Tier = 'needs' | 'following' | 'activity';

/** What you owe, when an item needs you. The verb is the label on the row. */
export type Obligation = 'sign' | 'answer' | 'reply' | 'review' | 'authorize' | 'accept' | 'allow';

export const OBLIGATION_VERB: Record<Obligation, string> = {
  sign: 'Sign', answer: 'Answer', reply: 'Reply', review: 'Review', authorize: 'Authorize', accept: 'Join', allow: 'Allow',
};

/**
 * Where an item comes from, and whether Journey produces it today.
 *   record   Journey's room record (threads, replies, decisions, signatures, plans, questions, authorization)
 *   access   Journey's membership (invitations, roles)
 *   canvas   Journey's canvas (saved views, accepted proposals)
 *   local    observed on this machine only (Claude Code sessions, via WorkContextService)
 *   runner   NOT IN JOURNEY: an agent run's progress and stop conditions, from a dispatchable runner
 *   github   NOT IN JOURNEY: PR reviews and CI checks, from a GitHub integration
 */
export type Source = 'record' | 'access' | 'canvas' | 'local' | 'runner' | 'github';
export const SOURCE_TODAY: Record<Source, boolean> = { record: true, access: true, canvas: true, local: true, runner: false, github: false };
export const SOURCE_LABEL: Record<Source, string> = {
  record: 'Room record', access: 'Membership', canvas: 'Canvas', local: 'This Mac', runner: 'Agent runner · not in Journey yet', github: 'GitHub · not in Journey yet',
};

/** What an item is about: one subject, one row, however many events it gathered. */
export type SubjectKind = 'decision' | 'thread' | 'question' | 'plan' | 'run' | 'pr' | 'invitation' | 'room';
export interface Subject { kind: SubjectKind; id: string; title: string }

/** Where opening the item lands: the room, and the exact place in it. */
export interface Anchor {
  roomId: string;
  tab: Tab;
  inspect?: Inspect;
  thread?: string;
  /** Canvas parts to light when you arrive. */
  parts?: string[];
  /** In words, for the Open button: "Decide · Resume approved runs, v2". */
  label: string;
}

/** One thing that happened to a subject. Items keep their events, newest first. */
export interface InboxEvent {
  id: string;
  at: string;
  by: PersonId | null;
  text: string;
  source: Source;
}

export interface InboxItem {
  /** Stable for the subject and what's owed, so a new version to sign is a new item. */
  id: string;
  tier: Tier;
  subject: Subject;
  room: { id: string; name: string };
  /** room › part › object, for the second line and the preview. */
  path: string[];
  /** Who moved it last (null: the system). */
  actor: PersonId | null;
  /** The row's first line after the verb, in plain words. */
  headline: string;
  /** Why it is yours, and true: "Mira asked you to sign v2". */
  why: string;
  /** The same, in a few words for the row. */
  whyShort?: string;
  obligation?: Obligation;
  /** Something that can't proceed until this is done. */
  blocks?: string;
  /** A line of what was said, when that's the point. */
  excerpt?: { by: PersonId; text: string };
  /** Newest event time. */
  at: string;
  /** Needs you: since when it has waited on you. */
  waitingSince?: string;
  events: InboxEvent[];
  /** Events you haven't seen (opening the item clears them). */
  unseen: number;
  source: Source;
  anchor: Anchor;
  /** Raised within its tier, and the one-line reason it was raised. Never raised by a model's judgement. */
  raised?: string;
  /** Activity digests: grouped counts by what happened ("6 steps done", "14 checks passed"). */
  digest?: { label: string; n: number }[];
  /** Progress, for runs. */
  progress?: { done: number; of: number };
}

/** A `seen` count meaning you marked the item unread. */
export const UNREAD = -1;

/** What you did to items: kept per person (attention_done in Journey, plus snoozes and follows). */
export interface InboxMarks {
  /** Opened or marked done, with the event count you'd seen. */
  seen: Record<string, number>;
  done: Record<string, string>;
  snoozed: Record<string, { until: string; label: string }>;
  /** Subjects you follow without having taken part (or unfollowed though you did). */
  follow: Record<string, boolean>;
  /** Rooms whose activity you muted. */
  mutedRooms: string[];
}

/** Something that needed you and no longer does, and why: shown under Done, with Undo where it applies. */
export interface Resolved { item: InboxItem; how: string; at: string }

export interface InboxView {
  needs: InboxItem[];
  following: InboxItem[];
  activity: InboxItem[];
  resolved: Resolved[];
  snoozed: InboxItem[];
  /** "Since Friday 6:10 pm", when you've been away; null when you were here recently. */
  away: { since: string; label: string; summary: string } | null;
}
