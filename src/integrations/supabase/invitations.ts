import type {
  IncomingInvitation,
  InviteKey,
  InviteResolution,
  LinkExpiry,
  RoomInvitation,
  RoomLink,
  RoomRole,
} from '../../shared/api.js';
import type { Cloud } from './index.js';
import { RoomError, toRoomError } from './rooms.js';

/**
 * Invitations into rooms. The rules live in supabase/migrations/*_room_invitations.sql, behind
 * SECURITY DEFINER functions: owners invite and make links, the person an invitation is for accepts
 * it, and accepting only ever makes you a member (never puts you in the call). This module shapes the
 * calls and turns refusals into a RoomError whose `reason` names the designed state to show.
 *
 * There's no web landing page yet, so a link is `vowe://join/<token>`, redeemed by pasting it into the
 * app (Join with an invite). Email invitations need no link: whoever signs in with the invited address
 * finds them waiting (`mine`). Tokens are never logged or stored here; the database keeps a hash.
 */

export type InvitationService = ReturnType<typeof createInvitationService>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 128 bits, base64url without padding (private.new_invite_token). */
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const ROLES: RoomRole[] = ['owner', 'member', 'viewer'];
const EXPIRIES: LinkExpiry[] = ['24h', '7d', '30d'];
const MAX_EMAILS = 50;

export const INVITE_LINK_PREFIX = 'vowe://join/';

/** The link someone shares. */
export function inviteUrl(token: string): string {
  return INVITE_LINK_PREFIX + token;
}

/**
 * The token in whatever someone pasted: the link, the link inside a sentence, or the bare token.
 * Null if there isn't one.
 */
export function parseInviteToken(text: string): string | null {
  const value = text.trim();
  const inLink = /vowe:\/\/join\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(value) ?? /\/j\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(value);
  if (inLink) return inLink[1]!;
  return TOKEN.test(value) ? value : null;
}

type InvitationRow = {
  id: string;
  room_id: string;
  kind: 'email' | 'link';
  email: string | null;
  domain: string | null;
  role: RoomRole;
  status: RoomInvitation['status'];
  invited_by: string;
  sent_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  resends: number;
  uses: number;
};

const COLUMNS = 'id, room_id, kind, email, domain, role, status, invited_by, sent_at, expires_at, accepted_at, revoked_at, resends, uses';

export function createInvitationService(client: () => Promise<Cloud>) {
  async function signedIn(): Promise<Cloud> {
    const supabase = await client();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw toRoomError(error);
    if (!data.session) throw new RoomError('signed-out', 'Sign in to use rooms');
    return supabase;
  }

  async function read(supabase: Cloud, roomId: string, ids?: string[]): Promise<RoomInvitation[]> {
    let query = supabase.from('room_invitations').select(COLUMNS).eq('room_id', roomId).order('sent_at', { ascending: false });
    if (ids) query = query.in('id', ids);
    const { data, error } = await query;
    if (error) throw toRoomError(error);
    return (data as InvitationRow[]).map(invitation);
  }

  return {
    /** The room's invitations, newest first. Members see them; only owners change them. */
    async list(roomId: string): Promise<RoomInvitation[]> {
      const id = requireId(roomId, 'Room');
      return read(await signedIn(), id);
    },

    /** Owners invite people by email with a role; each address can then accept in the app. */
    async send(roomId: string, emails: string[], role: RoomRole): Promise<RoomInvitation[]> {
      const id = requireId(roomId, 'Room');
      if (!Array.isArray(emails) || !emails.length || emails.length > MAX_EMAILS || emails.some((e) => typeof e !== 'string')) {
        throw new RoomError('invalid', `Invite between 1 and ${MAX_EMAILS} email addresses`, 'invalid_email');
      }
      const supabase = await signedIn();
      const { data, error } = await supabase.rpc('invite_to_room', { room: id, emails, invite_role: requireRole(role) });
      if (error) throw toRoomError(error);
      const ids = data.map((row) => row.invitation_id);
      return ids.length ? read(supabase, id, ids) : [];
    },

    /** Owners make the room's link, replacing the live one. The URL carries the only copy of the token. */
    async createLink(roomId: string, settings: { role: RoomRole; expiry: LinkExpiry; domain: string | null }): Promise<RoomLink> {
      const id = requireId(roomId, 'Room');
      if (typeof settings !== 'object' || settings === null) throw new RoomError('invalid', 'Link settings are missing');
      const role = requireRole(settings.role);
      if (role === 'owner') throw new RoomError('invalid', 'A link can’t make anyone an owner', 'not_permitted');
      if (!EXPIRIES.includes(settings.expiry)) throw new RoomError('invalid', 'Expiry must be 24h, 7d or 30d');
      const domain = settings.domain === null ? null : requireDomain(settings.domain);
      const supabase = await signedIn();
      const { data, error } = await supabase.rpc('create_room_link', { room: id, link_role: role, valid_for: settings.expiry, only_domain: domain ?? undefined });
      if (error) throw toRoomError(error);
      const made = data[0];
      if (!made) throw new RoomError('unknown', 'The link wasn’t made');
      const [row] = await read(supabase, id, [made.invitation_id]);
      if (!row) throw new RoomError('unknown', 'The link wasn’t made');
      return { invitation: row, url: inviteUrl(made.token) };
    },

    /** Owners withdraw an email invitation or turn the link off. */
    async revoke(invitationId: string): Promise<void> {
      const id = requireId(invitationId, 'Invitation');
      const { error } = await (await signedIn()).rpc('revoke_room_invitation', { invitation: id });
      if (error) throw toRoomError(error);
    },

    /** Email invitations sent to the address you're signed in with, still waiting. */
    async mine(): Promise<IncomingInvitation[]> {
      const { data, error } = await (await signedIn()).rpc('my_room_invitations');
      if (error) throw toRoomError(error);
      return data.map((r) => ({
        id: r.invitation_id,
        roomId: r.room_id,
        roomName: r.room_name,
        role: r.role,
        inviterName: r.inviter_name,
        sentAt: r.sent_at,
        expiresAt: r.expires_at,
      }));
    },

    /** What an invitation would do for you, in the order the landing explains it. */
    async resolve(key: InviteKey): Promise<InviteResolution> {
      const { data, error } = await (await signedIn()).rpc('resolve_room_invitation', args(key));
      if (error) throw toRoomError(error);
      return data as unknown as InviteResolution;
    },

    /** Makes you a member with the invitation's role, and returns the room's id. Never joins the call. */
    async accept(key: InviteKey): Promise<string> {
      const { data, error } = await (await signedIn()).rpc('accept_room_invitation', args(key));
      if (error) throw toRoomError(error);
      return data;
    },
  };
}

function args(key: InviteKey): { token?: string; invitation?: string } {
  if (typeof key === 'object' && key !== null) {
    if ('token' in key && typeof key.token === 'string') {
      if (!TOKEN.test(key.token)) throw new RoomError('not-found', 'This invitation isn’t valid', 'invite_not_found');
      return { token: key.token };
    }
    if ('invitationId' in key) return { invitation: requireId(key.invitationId, 'Invitation') };
  }
  throw new RoomError('invalid', 'Name an invitation by its token or id');
}

function invitation(row: InvitationRow): RoomInvitation {
  const lapsed = row.status === 'pending' && Date.parse(row.expires_at) <= Date.now();
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    email: row.email,
    domain: row.domain,
    role: row.role,
    status: lapsed ? 'expired' : row.status,
    invitedBy: row.invited_by,
    sentAt: row.sent_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    resends: row.resends,
    uses: row.uses,
  };
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RoomError('invalid', `${what} id must be a UUID`);
  return value.toLowerCase();
}

function requireRole(value: unknown): RoomRole {
  if (!ROLES.includes(value as RoomRole)) throw new RoomError('invalid', 'Role must be owner, member or viewer');
  return value as RoomRole;
}

function requireDomain(value: unknown): string {
  const domain = typeof value === 'string' ? value.trim().toLowerCase().replace(/^@/, '') : '';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new RoomError('invalid', 'That isn’t an email domain, like acme.com');
  return domain;
}
