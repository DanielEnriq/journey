// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Brief and full-window: while main restores a stored session at launch, or while signing out.
 * From the Pass 2 package's AuthScreen.tsx. Journey keeps Pass 1's minimal centred sign-in, so the
 * split-layout AuthScreen itself isn't used; only this state is.
 */
import { h } from '../../../vendor/preact.js';
import { Avatar, Spinner, Wordmark } from '../../components.js';
import type { AccountView } from '../types.js';

export function SessionSplash({ label, account }: { label: string; account?: Pick<AccountView, 'initials' | 'tone'> }) {
  return (
    <div class="vh-splash v-root v-grain" role="status" aria-live="polite">
      <Wordmark size={26} />
      <span class="v-presence">{account ? <Avatar initials={account.initials} tone={account.tone} size={20} /> : <Spinner />}{label}</span>
    </div>
  );
}
