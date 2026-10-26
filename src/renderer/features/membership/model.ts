import type { IncomingInvitation, InviteContext, InviteKey, InvitePerson, InviteResolution, LinkExpiry, MembershipErrorCode, RoomRole } from '../../../shared/api.js';

// Room membership as the screens see it: people, their access, invitations and the room's link, already
// resolved for the person looking. The components are presentational (ported from the room-membership
// design); a MembershipSource (features/workspace/real) reads and changes the real thing. The database and
// the LiveKit token services enforce every rule below; this copy only decides what to show or explain.

export type Role = RoomRole;
export type UserId = string;

/** Colour is identity: one tone per person, everywhere in the room. */
export type Tone = 'me' | 'peer' | 'peer2' | 'peer3' | 'peer4';

export interface User {
  id: UserId;
  name: string;
  email: string;
  initials: string;
  tone: Tone;
}

/**
 * Where a member is right now. `room` (has the room open) and `call` (connected to its LiveKit call) are
 * separate: being in the room never puts anyone in the call, and never opens a mic.
 */
export type MemberPresence = 'call' | 'room' | 'away';

export interface Member {
  userId: UserId;
  role: Role;
  joinedAt: number;
  presence: MemberPresence;
  /** On the call and talking right now. */
  speaking?: boolean;
  /** On the call with their mic off. */
  muted?: boolean;
}

export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

/** An email invitation, bound to one address. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: InviteStatus;
  invitedBy: UserId;
  sentAt: number;
  expiresAt: number;
  acceptedAt?: number;
  revokedAt?: number;
  resends: number;
}

export type { LinkExpiry };

/**
 * The room's link. Its token is shown once, to the owner who made it: `url` is null when this window
 * didn't make it (another owner did, or the app restarted), and copying then means making a new one.
 */
export interface InviteLink {
  id: string;
  url: string | null;
  role: Role;
  expiry: LinkExpiry;
  expiresAt: number;
  domain: string | null;
  status: 'active' | 'revoked' | 'expired';
  uses: number;
  createdBy: UserId;
}

export type MembershipError = MembershipErrorCode;
export type Result = { ok: true } | { ok: false; error: MembershipError; detail?: string };

/** Everything the share dialog and the People panel show about one room, for the person looking. */
export interface RoomAccess {
  roomId: string;
  roomName: string;
  viewerId: UserId;
  users: Record<UserId, User>;
  members: Member[];
  invites: Invitation[];
  link: InviteLink | null;
  /** Who to ask when you can't do something: the first owner, by name. */
  ownerName: string;
  /** Your email domain, offered when limiting a link. */
  domain: string | null;
}

export interface LinkSettings {
  role: Role;
  expiry: LinkExpiry;
  domain: string | null;
}

/** Why a room went away while you had it open. */
export interface AccessLost {
  kind: 'removed' | 'left' | 'room_gone';
  byName?: string;
  /** The room's name, kept for saying what was lost. */
  roomName?: string;
}

/** A room's access, and the changes owners and members make to it. Real: features/workspace/real. */
export interface MembershipSource {
  /** What's known now; null until the room has been read. */
  access(roomId: string): RoomAccess | null;
  /** Reads the room's members and invitations again. */
  load(roomId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  invite(roomId: string, emails: string[], role: Role): Promise<Result>;
  /** Sends a pending, expired or withdrawn invitation again, with the same role. */
  resend(roomId: string, invitationId: string): Promise<Result>;
  revokeInvite(roomId: string, invitationId: string): Promise<Result>;
  /** Makes the room's link, replacing the live one: any change to a link's settings makes a new one. */
  createLink(roomId: string, settings: LinkSettings): Promise<Result>;
  revokeLink(roomId: string): Promise<Result>;
  changeRole(roomId: string, userId: UserId, role: Role): Promise<Result>;
  remove(roomId: string, userId: UserId): Promise<Result>;
  /** You leave the room (and its call). */
  leave(roomId: string): Promise<Result>;
  /** Set when you lost access to a room you had open. */
  lost(roomId: string): AccessLost | null;
  /** Forgets a lost room once you've moved on from it. */
  dismissLost(roomId: string): void;
}

/** Invitations from your side: waiting for you, and what a pasted link would do. */
export interface InviteSource {
  mine(): Promise<IncomingInvitation[]>;
  resolve(key: InviteKey): Promise<InviteResolution>;
  /** Makes you a member; resolves with the room's id. Never joins the call. */
  accept(key: InviteKey): Promise<string>;
  /** Declines an email invitation sent to you: it leaves your list until it's sent again. */
  decline?(invitationId: string): Promise<void>;
}

/* ---------- The permission matrix, in one place. Components ask can(); they never test roles. ---------- */

export type Ability =
  | 'invite' | 'create_link' | 'manage_access' | 'change_role' | 'remove_member'
  | 'edit_canvas' | 'comment' | 'sign_decision' | 'talk' | 'join_call';

const MATRIX: Record<Ability, Role[]> = {
  invite: ['owner'],
  create_link: ['owner'],
  manage_access: ['owner'],
  change_role: ['owner'],
  remove_member: ['owner'],
  edit_canvas: ['owner', 'member'],
  comment: ['owner', 'member', 'viewer'],
  sign_decision: ['owner', 'member'],
  talk: ['owner', 'member'],
  join_call: ['owner', 'member', 'viewer'],
};

export function can(role: Role | null | undefined, ability: Ability): boolean {
  return !!role && MATRIX[ability].includes(role);
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };

export const ROLE_HINT: Record<Role, string> = {
  owner: 'Manages who’s in the room',
  member: 'Talks, edits, signs decisions',
  viewer: 'Listens and comments',
};

/** Copy for each error, written for the person who hit it. */
export const ERROR_COPY: Record<MembershipError, { title: string; body: string }> = {
  invalid_email: { title: 'That doesn’t look like an email', body: 'Check the address and try again.' },
  not_permitted: { title: 'You can’t do that here', body: 'Ask an owner of this room.' },
  last_owner: { title: 'This room needs an owner', body: 'Make someone else an owner first.' },
  invite_expired: { title: 'This invite has expired', body: 'Invites last 7 days. Ask whoever sent it for a new one.' },
  invite_revoked: { title: 'This invite was withdrawn', body: 'The person who sent it took it back. Ask them for a new one.' },
  invite_used: { title: 'This invite was already used', body: 'Each email invite works once. If it was you, open the room from your rooms list.' },
  invite_not_found: { title: 'This invite link isn’t valid', body: 'It may be incomplete. Copy it again from the original message.' },
  wrong_account: { title: 'This invite is for a different account', body: 'Sign in with the account it was sent to (Google or GitHub, same email).' },
  domain_not_allowed: { title: 'This link is limited to one company', body: 'Your account isn’t on the allowed domain.' },
  link_revoked: { title: 'This link was turned off', body: 'The room’s owner turned it off. Ask them for a new one.' },
  room_gone: { title: 'This room no longer exists', body: 'It was deleted by its owner.' },
  rate_limited: { title: 'Too many invites at once', body: 'Wait a minute, then try again.' },
  network: { title: 'Couldn’t reach Vowe', body: 'Check your connection and try again.' },
};

/* ---------- Small pure helpers. ---------- */

export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function until(when: number, now: number): string {
  const s = Math.round((when - now) / 1000);
  if (s <= 0) return 'expired';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'tomorrow' : `in ${d} days`;
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
export function isEmail(s: string): boolean {
  return EMAIL.test(s.trim());
}

export function initialsFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? local[0] ?? '?';
  const b = parts[1]?.[0] ?? '';
  return (a + b).toUpperCase();
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The token in whatever someone pasted: the `vowe://join/…` link, the link inside a sentence, or the bare
 * token. Null if there isn't one. (The same rule as integrations/supabase/invitations.ts.)
 */
export function inviteTokenIn(text: string): string | null {
  const value = text.trim();
  const inLink = /vowe:\/\/join\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(value) ?? /\/j\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(value);
  if (inLink) return inLink[1]!;
  return /^[A-Za-z0-9_-]{22}$/.test(value) ? value : null;
}

/**
 * What an invite looks like once you're signed in: whether it's for this account, a preview of the room,
 * and joining it (ui/pass2/invites/InviteGate.tsx renders it). Joining the room is all it does; the call
 * is a separate, later choice.
 */
export type LandingState =
  | { kind: 'checking' }
  | { kind: 'wrong-account'; invite: InviteContext; signedInAs: string }
  | { kind: 'preview'; invite: InviteContext; room: { id: string; name: string; goal: string | null; members: InvitePerson[] }; joining?: boolean }
  | { kind: 'already-member'; roomId: string; roomName: string }
  | { kind: 'error'; error: MembershipError; invite?: InviteContext; signedInAs?: string };
