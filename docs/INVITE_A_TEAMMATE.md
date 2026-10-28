# Invite a teammate into a room

How the room owner brings another engineer into a real (hosted) Vowe room, and what the link does. The
teammate's side, from installing to joining, is in [ENGINEER_SETUP.md](ENGINEER_SETUP.md).

## Which rooms can be shared

- **Real rooms** live in the hosted Supabase project, at `#/room/<uuid>`. Their threads, decisions and
  canvas persist, and only members can read them. These are the rooms Share works for.

Inviting someone adds them to that exact room. No copy is made, and the room's contents stay as they are.

## Owner: make and send the link

1. Open the room and click **Share** (top right). Only owners can invite.
2. Under **Invite link**, choose:
   - **Role:** **Member** (talks, comments, signs decisions) or **Viewer** (listens and comments).
   - **Who:** "Anyone signed in to Vowe", or limit it to one email domain.
   - **Expiry:** 24 hours, 7 days or 30 days.
3. Click **Create link**, then **Copy link**. The link is shown **once**, when it's made. If you lose it,
   click **Create a new link**, which turns the old one off.
4. Send it to your teammate privately (a DM, not a public channel or issue). Until it expires or is turned
   off, anyone who has it and signs in can join with that role.
5. Send them [ENGINEER_SETUP.md](ENGINEER_SETUP.md), plus the four `.env` values it asks for (separately and
   privately).
6. If your Google OAuth consent screen is in **Testing**, add their Google email as a test user first (Google
   Cloud Console → APIs & Services → OAuth consent screen → Test users). Otherwise Google blocks their sign-in.

Prefer email-bound invites? **Share → invite by email** makes an invitation that only an account with that verified email (Google, or GitHub as primary email)
can accept. Anyone else signed in is told it's for someone else.

To revoke: **Share → Turn off link**, or withdraw a pending email invitation from the access list. Anyone who
uses it afterwards is told it no longer works. People who already joined keep their membership until you
remove them under **People**.

## The link

```
vowe://join/<token>
```

- `<token>` is 22 random URL-safe characters.
- The database stores only its hash (`room_invitations.token_hash`), so the token can't be read back. That's
  why it's shown once.
- The link names no machine, path or session. It works from any computer that has Vowe installed and signed in.
- **Opening it:**
  - Clicking the link doesn't open Vowe yet: nothing registers the `vowe://` scheme with macOS.
  - The supported path is to paste it into Home's **"Paste an invite link to join a room"** field.
  - That field also accepts the link inside a longer message, or the bare token.
- **Installation is required** before accepting. There's no hosted landing page yet, and the app is run from
  source (see ENGINEER_SETUP.md).

## What the hosted database enforces

These rules live in SECURITY DEFINER functions and row-level security, in
`supabase/migrations/20261027010000_room_invitations.sql`. They are deployed to the hosted project.

| Rule | How |
|---|---|
| Only owners invite or make links | `private.is_room_owner(room)`, checked in the function |
| Links expire | `expires_at` (24h, 7d or 30d). Expired links are refused with `invite_expired` |
| Links can be revoked | Turning a link off, or making a new one, sets `status = 'revoked'`. Use is then refused with `link_revoked` |
| Email invitations are bound to one account | The accepter's verified email must match. Otherwise `wrong_account` |
| Domain-limited links | The accepter's email domain must match. Otherwise `domain_not_allowed` |
| Accepting grants only that room | It inserts a `room_members` row for the invited room, plus `workspace_members` for that room's workspace. No other room becomes readable. |
| The owner stays the owner | Accepting can grant only the invitation's role (`member` or `viewer`) |
| Membership persists | It's stored in Postgres, so it survives restarts and sign-out/sign-in |
| Calls admit members only | The `livekit-token` function issues a token only to members of the room (and its workspace) |

## What's been verified, and what hasn't

**Verified:**
- **Automated, against a local Supabase stack** (`src/integrations/supabase/invitations.test.ts` and
  `rooms.test.ts`, with five separate test accounts):
  - links expire, revoke and rotate;
  - email-bound and domain-limited invites refuse the wrong account;
  - accepting grants exactly one room, and non-members can't read other rooms;
  - the owner keeps their role.
- **Hosted:** the invitation migrations and the `livekit-token` function (active, with LiveKit secrets set)
  are deployed. One account has signed in, made a room, called and used the canvas.

**Not verified yet:**
- **Two independent accounts on two computers.** The first real run is the acceptance test below.
- **Clicking a `vowe://` link.** Not supported; paste it instead.

## Manual acceptance test (two computers)

1. **Owner:** in the existing room, Share → Member, 7 days → Create link → Copy link → send privately.
2. **Teammate:** follow ENGINEER_SETUP.md, sign in with their own Google account, and paste the link on Home.
3. **Teammate:** the invite shows the right room name and inviter → Join room → Open room.
4. **Both:** join the call. Each hears the other, and each sees the other in the call band.
5. **Owner:** move or add something on the canvas, or accept a Vowe proposal. **Teammate:** sees it land
   without reloading.
6. **Teammate:** pins a comment. **Owner:** sees it on the canvas and in the panel.
7. **Teammate:** quits and restarts the app. The room is still on Home and opens without a new invite.
8. **Owner:** Share → Turn off link. **Teammate (or a third account):** pasting the old link again is
   refused as turned off. The teammate stays a member.
9. **Teammate:** has no access to the owner's other rooms; they don't show on Home.
10. **Owner:** the access list still shows them as Owner.

## Remaining blockers for a smoother flow

- **Desktop link handler.** Register `vowe://` (`app.setAsDefaultProtocolClient` with a packaged app,
  `open-url` on macOS, `second-instance` on Windows) so a clicked link opens the invite.
- **Hosted landing page.** An `https://…/j/<token>` page that opens the app, or explains how to install it.
  The paste field already understands `/j/<token>` links.
- **Packaged app.** Teammates install from source today. A signed `.dmg` would remove the Node/pnpm setup.
- **Google OAuth publishing.** While the consent screen is in Testing, every teammate must be added as a test
  user.
- **The teammate's own Vowe voice** needs a deployed Vowe API. Today it runs only on the owner's machine
  (`pnpm api:start`).
