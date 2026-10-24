import { h } from '../../vendor/preact.js';
import { useRef, useState } from '../../vendor/preact-hooks.js';
import { ERROR_COPY, ROLE_HINT, ROLE_LABEL, isEmail, type MembershipError, type Result, type Role } from './model.js';
import { Icon, Menu, Spinner } from './primitives.js';

interface Props {
  /** Emails of current members: chips for these are flagged, not sent. */
  memberEmails: string[];
  /** Emails with a pending invite: sending again is a resend. */
  pendingEmails: string[];
  roles?: Role[];
  defaultRole?: Role;
  /** Resolves when the server has answered. Errors are shown inline. */
  onSend(emails: string[], role: Role): Promise<Result>;
  autoFocus?: boolean;
}

type ChipState = 'ok' | 'invalid' | 'member' | 'resend';
interface Chip { email: string; state: ChipState }

const CHIP_NOTE: Record<ChipState, string> = { ok: '', invalid: 'Not an email', member: 'Already in the room', resend: 'Will resend' };

/**
 * Invite people by email: type or paste addresses, pick the role they join with, send. Addresses turn
 * into chips on Enter, comma, space or paste; each chip says what will happen to it before anything is
 * sent. No email goes out from this build: the invitation waits in Vowe for whoever signs in with that address.
 */
export function InviteByEmail({ memberEmails, pendingEmails, roles = ['member', 'viewer', 'owner'], defaultRole = 'member', onSend, autoFocus }: Props) {
  const [chips, setChips] = useState<Chip[]>([]);
  const [text, setText] = useState('');
  const [role, setRole] = useState<Role>(defaultRole);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ code: MembershipError; detail?: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const classify = (email: string): ChipState => {
    if (!isEmail(email)) return 'invalid';
    if (memberEmails.includes(email)) return 'member';
    if (pendingEmails.includes(email)) return 'resend';
    return 'ok';
  };

  /** Turns what was typed into chips; returns the chips as they now are. */
  const commit = (raw: string): Chip[] => {
    const found = raw.split(/[\s,;]+/).map((s) => s.trim().replace(/^<|>$/g, '').toLowerCase()).filter(Boolean);
    const next = [...chips];
    const have = new Set(next.map((c) => c.email));
    for (const email of found) if (!have.has(email)) { next.push({ email, state: classify(email) }); have.add(email); }
    setChips(next);
    setText('');
    setError(null);
    return next;
  };

  const sendableOf = (all: Chip[]) => all.filter((c) => c.state === 'ok' || c.state === 'resend');
  const sendable = sendableOf(chips);
  const blocked = chips.some((c) => c.state === 'invalid');

  const send = async () => {
    const all = text.trim() ? commit(text) : chips;
    const ready = sendableOf(all);
    if (!ready.length || all.some((c) => c.state === 'invalid') || sending) return;
    setSending(true);
    const res = await onSend(ready.map((c) => c.email), role);
    setSending(false);
    if (res.ok) { setChips([]); setError(null); } else setError({ code: res.error, detail: res.detail });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) commit(text); else void send(); }
    else if (e.key === ',' || e.key === ' ' || e.key === ';') { if (text.trim()) { e.preventDefault(); commit(text); } }
    else if (e.key === 'Backspace' && !text && chips.length) setChips(chips.slice(0, -1));
  };

  const onPaste = (e: ClipboardEvent) => {
    const t = e.clipboardData?.getData('text') ?? '';
    if (/[\s,;]/.test(t.trim())) { e.preventDefault(); commit(t); }
  };

  return (
    <div class="vm-invite">
      <div class={`vm-field vm-chipfield${error ? ' vm-field-error' : ''}`} onClick={() => input.current?.focus()}>
        <Icon.mail />
        {chips.map((c) => (
          <span key={c.email} class={`vm-chip vm-chip-${c.state}`} title={CHIP_NOTE[c.state] || undefined}>
            {c.email}
            {c.state !== 'ok' && <em>{CHIP_NOTE[c.state]}</em>}
            <button type="button" class="vm-chip-x" aria-label={`Remove ${c.email}`}
              onClick={(e) => { e.stopPropagation(); setChips(chips.filter((x) => x.email !== c.email)); }}>
              <Icon.close />
            </button>
          </span>
        ))}
        <label class="vm-sr" for="vm-invite-input">Email addresses</label>
        <input id="vm-invite-input" ref={input} autoFocus={autoFocus} type="email" multiple autoComplete="off" spellcheck={false}
          placeholder={chips.length ? '' : 'Add people by email'} value={text}
          onInput={(e) => { setText((e.currentTarget as HTMLInputElement).value); setError(null); }}
          onKeyDown={onKey} onPaste={onPaste} onBlur={() => { if (text.trim()) commit(text); }} />
      </div>

      <div class="vm-invite-row">
        <Menu ariaLabel="Role for new people" buttonClass="vm-select" align="start" label={<span>Join as <b>{ROLE_LABEL[role]}</b></span>}
          items={roles.map((r) => ({ key: r, label: ROLE_LABEL[r], hint: ROLE_HINT[r], checked: r === role, onSelect: () => setRole(r) }))} />
        <span class="vm-invite-note">
          {blocked
            ? 'Remove the address that isn’t an email.'
            : sendable.length
              ? `${sendable.length} ${sendable.length === 1 ? 'person' : 'people'} · invite lasts 7 days`
              : 'They’ll find it in Vowe when they sign in with that Google account.'}
        </span>
        <button type="button" class="vm-btn vm-btn-primary" disabled={sending || blocked || (!sendable.length && !text.trim())} onClick={() => void send()}>
          {sending && <Spinner />}
          {sending ? 'Sending' : sendable.length && sendable.every((c) => c.state === 'resend') ? 'Resend' : 'Invite'}
        </button>
      </div>

      {error && (
        <div class="vm-inline-error" role="alert">
          <b>{ERROR_COPY[error.code].title}.</b> {error.detail ?? ERROR_COPY[error.code].body}
        </div>
      )}
    </div>
  );
}
