import { h } from '../../../vendor/preact.js';
import { useState } from '../../../vendor/preact-hooks.js';

/**
 * Writing a decision down, or its next version: what the room decided and the checks that prove it.
 * Shown in place of the panel; saving makes a new version that everyone signs again.
 */
export function ProposeDecision({ initial, onSubmit, onCancel }: {
  initial?: { title: string; verify: string };
  onSubmit(d: { title: string; verify: string }): Promise<void>;
  onCancel(): void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [verify, setVerify] = useState(initial?.verify ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = title.trim() && verify.trim() && !busy;
  const submit = (e: Event) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    onSubmit({ title: title.trim(), verify: verify.trim() }).catch((err: Error) => { setBusy(false); setError(err.message); });
  };
  return (
    <form class="rp-panel" aria-label={initial ? 'Propose a change' : 'Propose a decision'} onSubmit={submit}>
      <div class="rp-rhead"><span class="rp-eyebrow">{initial ? 'Propose a change' : 'Propose a decision'}</span></div>
      <section class="rp-sec rp-first">
        <span class="rp-rk">Decision</span>
        <label class="rp-cm-reply"><span class="rp-sr">What the room decided</span>
          <input type="text" placeholder="Use idempotent processing for retries." value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <span class="rp-rk">Verify<span>checks, separated by ;</span></span>
        <label class="rp-cm-reply"><span class="rp-sr">Checks</span>
          <input type="text" placeholder="Concurrent pickup; worker crash after charge" value={verify} onInput={(e) => setVerify(e.currentTarget.value)} />
        </label>
        {error ? <span class="rp-setaside" role="alert">{error}</span> : null}
        <span class="rp-stream-acts">
          <button class="rp-mini" type="submit" disabled={!ok}>{busy ? 'Saving…' : initial ? 'Save as a new version' : 'Propose'}</button>
          <button class="rp-mini rp-ghost" type="button" onClick={onCancel}>Cancel</button>
        </span>
        <span class="rp-setaside">{initial ? 'Everyone signs the new version again.' : 'Everyone in the room signs it before it counts.'}</span>
      </section>
    </form>
  );
}
