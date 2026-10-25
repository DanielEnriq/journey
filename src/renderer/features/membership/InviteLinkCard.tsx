import { Fragment, h } from '../../vendor/preact.js';
import { useEffect, useState } from '../../vendor/preact-hooks.js';
import { ERROR_COPY, ROLE_HINT, ROLE_LABEL, until, type InviteLink, type LinkExpiry, type LinkSettings, type Result, type Role } from './model.js';
import { Icon, Menu, Spinner } from './primitives.js';

interface Props {
  link: InviteLink | null;
  now: number;
  /** Domain offered for restriction: the owner's own. */
  suggestedDomain: string | null;
  canManage: boolean;
  /** Makes the room's link; changing role, expiry or domain makes a new one and the old one stops working. */
  onCreate(settings: LinkSettings): Promise<Result>;
  onRevoke(): Promise<Result>;
  /** Called after the URL was put on the clipboard (or failed to be). */
  onCopied?(ok: boolean): void;
}

const EXPIRY_LABEL: Record<LinkExpiry, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

/**
 * The room's link. Opening it still takes Google sign-in; it can be limited to one company's domain,
 * always expires, and turning it off (or changing its settings) stops every copy already shared.
 * Its token is only shown to the owner who just made it: anyone else sees the link's settings, and
 * copying it means making a new one.
 */
export function InviteLinkCard({ link, now, suggestedDomain, canManage, onCreate, onRevoke, onCopied }: Props) {
  const [draft, setDraft] = useState<LinkSettings>({ role: 'member', expiry: '7d', domain: null });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [failure, setFailure] = useState<Result & { ok: false } | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const live = link && link.status === 'active' ? link : null;
  const settings: LinkSettings = live ? { role: live.role, expiry: live.expiry, domain: live.domain } : draft;

  const run = async (p: () => Promise<Result>) => {
    setBusy(true);
    const r = await p();
    setBusy(false);
    setFailure(r.ok ? null : r);
    return r;
  };

  const change = (next: LinkSettings) => { if (!live) setDraft(next); else void run(() => onCreate(next)); };

  const copy = async (url: string) => {
    let ok = true;
    try { await navigator.clipboard.writeText(url); } catch { ok = false; }
    setCopied(ok);
    onCopied?.(ok);
  };

  const settingsRow = (
    <div class="vm-link-settings">
      <Menu buttonClass="vm-pillsel" align="start" ariaLabel="Role for people who use the link" label={<span>{ROLE_LABEL[settings.role]}</span>}
        items={(['member', 'viewer'] as Role[]).map((r) => ({ key: r, label: ROLE_LABEL[r], hint: ROLE_HINT[r], checked: settings.role === r, onSelect: () => change({ ...settings, role: r }) }))} />
      <Menu buttonClass="vm-pillsel" align="start" ariaLabel="Who can use the link" label={<span>{settings.domain ? `Only @${settings.domain}` : 'Anyone signed in'}</span>}
        items={[
          ...(suggestedDomain
            ? [{ key: 'dom', label: `Only @${suggestedDomain}`, hint: 'Their sign-in email must be on this domain', checked: settings.domain === suggestedDomain, onSelect: () => change({ ...settings, domain: suggestedDomain }) }]
            : []),
          { key: 'any', label: 'Anyone signed in to Vowe', hint: 'Anyone who has the link', checked: !settings.domain, onSelect: () => change({ ...settings, domain: null }) },
        ]} />
      <Menu buttonClass="vm-pillsel" align="start" ariaLabel="Link expiry" label={<span>{live ? `Expires ${until(live.expiresAt, now)}` : `For ${EXPIRY_LABEL[settings.expiry]}`}</span>}
        items={(['24h', '7d', '30d'] as LinkExpiry[]).map((x) => ({ key: x, label: EXPIRY_LABEL[x], checked: settings.expiry === x, onSelect: () => change({ ...settings, expiry: x }) }))} />
      {busy && <Spinner />}
    </div>
  );

  const error = failure && (
    <div class="vm-inline-error" role="alert"><b>{ERROR_COPY[failure.error].title}.</b> {failure.detail ?? ERROR_COPY[failure.error].body}</div>
  );

  if (!live) {
    const was = link?.status;
    return (
      <div class="vm-linkcard">
        <div class="vm-link-top">
          <span class="vm-link-ico"><Icon.link /></span>
          <span class="vm-link-copy">
            <b>{was === 'revoked' ? 'Link turned off' : was === 'expired' ? 'Link expired' : 'Invite link'}</b>
            <span>{was ? 'Anyone who uses the old link is told it no longer works.' : 'Share in Slack or a DM. People paste it into Vowe and sign in with Google to get in.'}</span>
          </span>
        </div>
        {canManage ? (
          <>
            {settingsRow}
            <button type="button" class="vm-btn" disabled={busy} onClick={() => void run(() => onCreate(draft))}>
              {busy ? <Spinner /> : <Icon.link />}
              {was ? 'Create a new link' : 'Create link'}
            </button>
          </>
        ) : (
          <span class="vm-quiet">Only owners can create links.</span>
        )}
        {error}
      </div>
    );
  }

  return (
    <div class="vm-linkcard vm-linkcard-live">
      <div class="vm-link-url">
        <span class="vm-link-ico"><Icon.link /></span>
        {live.url ? (
          <>
            <span class="vm-mono" title="Copy to share">{live.url}</span>
            <button type="button" class={`vm-btn vm-btn-copy${copied ? ' vm-copied' : ''}`} onClick={() => void copy(live.url!)} aria-live="polite">
              {copied && <Icon.check />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </>
        ) : (
          <>
            <span class="vm-mono vm-mono-muted" title="Each link is shown once, to the owner who made it">Link is on · shown once when made</span>
            {canManage && <button type="button" class="vm-btn vm-btn-copy" disabled={busy} onClick={() => void run(() => onCreate(settings))}>New link to copy</button>}
          </>
        )}
      </div>
      {canManage && settingsRow}
      <div class="vm-link-foot">
        <span class="vm-quiet">{live.uses ? `Used ${live.uses} ${live.uses === 1 ? 'time' : 'times'}` : 'Not used yet'} · changing a setting makes a new link</span>
        {canManage && (confirmOff ? (
          <span class="vm-confirm-inline">
            Turn off for everyone?
            <button type="button" class="vm-link-btn" onClick={() => setConfirmOff(false)}>Keep</button>
            <button type="button" class="vm-link-btn vm-destructive" onClick={() => { setConfirmOff(false); void run(onRevoke); }}>Turn off</button>
          </span>
        ) : (
          <button type="button" class="vm-link-btn" onClick={() => setConfirmOff(true)}>Turn off link</button>
        ))}
      </div>
      {error}
    </div>
  );
}
