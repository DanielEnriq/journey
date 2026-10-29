// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Home with no rooms yet. It keeps Journey's first-run structure: a question, a
 * composer that starts a room from a sentence, and starting points.
 *
 * It adds the two other honest ways in:
 * - someone else's room: invitations for you, or a pasted link;
 * - your code: add a repository, or find the ones in your usual folders.
 *
 * The drawing below is an example, labelled as one. Nothing on this page
 * implies a call, an agent or a teammate exists.
 */
import { h } from '../../../vendor/preact.js';
import { Button } from '../../components.js';
import { Icon } from '../../icons.js';

import { CanvasThumb } from '../common.js';
import type { IncomingInvitation, InviteKey } from '../../../../shared/api.js';
import { InvitationList, JoinByLink } from '../invites/JoinByLink.js';
import type { CanvasSketch } from '../types.js';
import { Composer, type ComposerProps } from './Composer.js';

/** Journey's starting points (WelcomeScreen TRIES). */
export const TRIES = ['Retries are double-charging customers', 'Redesign the checkout states', 'Walk me through this repo'];

const EXAMPLE: CanvasSketch = {
  nodes: [
    { id: 'api', label: 'Webhook API', kind: 'Service', x: 16, y: 34 },
    { id: 'q', label: 'jobs', kind: 'Queue', x: 50, y: 34 },
    { id: 's', label: 'Stripe', kind: 'External', x: 84, y: 34 },
    { id: 'k', label: 'Idempotency key', kind: 'Proposed', x: 50, y: 76, state: 'proposed' },
  ],
  edges: [{ from: 'api', to: 'q' }, { from: 'q', to: 's' }, { from: 'q', to: 'k', state: 'proposed' }],
};

export interface HomeFirstProps {
  firstName: string;
  composer: Omit<ComposerProps, 'tries'>;
  /** `invites.mine()`; empty hides the list. */
  invitations: IncomingInvitation[];
  /** Opens an invite from a pasted link. */
  onOpenInvite?: (key: InviteKey) => void;
  /** Repositories added on this machine. */
  repoCount: number;
  /** `repos.add()` and `repos.detect()`; absent in a browser preview. */
  onAddRepo?: () => void;
  onFindRepos?: () => void;
  /** Why rooms couldn't be read (`realStatus.failed`); shown instead of pretending there are none. */
  notice?: string | null;
}

export function HomeFirst(p: HomeFirstProps) {
  return (
    <div class="vh-page vh-first vh-stagger">
      <div class="vh-eyebrow"><span class="vh-orb" aria-hidden="true" />Welcome to Vowe</div>
      <h1 class="vh-greet">What are we building<em>, {p.firstName}?</em></h1>
      <p class="vh-lede">Start a room and say what you’re working on. Vowe sketches the system as the room talks. Bring your team in whenever you’re ready.</p>
      {p.notice ? <p class="vh-notice" role="alert"><Icon name="warn" size={14} />{p.notice}</p> : null}

      <Composer {...p.composer} tries={TRIES} />

      <div class="vh-ways">
        <section class="vh-way" aria-labelledby="vh-way-join">
          <h2 id="vh-way-join" class="v-label">Joining someone’s room?</h2>
          {p.invitations.length && p.onOpenInvite ? <InvitationList invitations={p.invitations} onOpen={p.onOpenInvite} /> : null}
          {p.onOpenInvite ? <JoinByLink onOpen={p.onOpenInvite} /> : null}
        </section>
        <section class="vh-way" aria-labelledby="vh-way-code">
          <h2 id="vh-way-code" class="v-label">Your code</h2>
          <p class="vh-way-p">{p.repoCount
            ? `${p.repoCount} ${p.repoCount === 1 ? 'repository' : 'repositories'} added on this machine. A room shares only its remote, never the path.`
            : 'Add a repository from this machine. A room shares only its remote, like github.com/acme/payments. Your path stays here.'}</p>
          {p.onAddRepo || p.onFindRepos ? (
            <div class="vh-way-acts">
              {p.onAddRepo ? <Button icon="project" onClick={p.onAddRepo}>Add a repository…</Button> : null}
              {p.onFindRepos ? <Button variant="quiet" icon="search" onClick={p.onFindRepos}>Find repositories</Button> : null}
            </div>
          ) : null}
        </section>
      </div>

      <figure class="vh-example">
        <div class="vh-example-cv">
          <CanvasThumb preview={{ status: 'ready', sketch: EXAMPLE }} large />
          <span class="v-badge vh-example-tag">Example</span>
        </div>
        <figcaption>Vowe draws while the room talks. <em>Dashed stays a proposal until the room agrees.</em></figcaption>
      </figure>

      <ul class="vh-ready" aria-label="What this build does">
        <li><Icon name="mic-off" size={14} />Voice calls in every room. Your mic stays off until you talk.</li>
        <li><Icon name="people" size={14} />Invite your team from a room’s Share.</li>
        <li class="is-later"><Icon name="lock" size={14} />Connect GitHub isn’t in this build yet. Rooms use repositories on this machine.</li>
      </ul>
    </div>
  );
}
