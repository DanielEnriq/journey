import { h } from '../../vendor/preact.js';
import { useState } from '../../vendor/preact-hooks.js';
import { joinNames } from './model.js';
import { Icon } from './primitives.js';

/**
 * Before the call: choose how to arrive. The default is muted, which never touches the microphone.
 * Choosing to talk is what asks the OS for the microphone, never the act of joining a room. A viewer
 * only listens, so for them there is nothing to choose.
 */
export function PreJoinSheet({ talking, canTalk, micDenied, onJoin, onCancel, onOpenSystemSettings }: {
  /** Names of who is on the call now. */
  talking: string[];
  canTalk: boolean;
  /** The OS refused the microphone the last time it was asked. */
  micDenied: boolean;
  /** `talk` false joins muted and does not touch the microphone. */
  onJoin(opts: { talk: boolean }): void;
  onCancel(): void;
  onOpenSystemSettings(): void;
}) {
  const [talk, setTalk] = useState(false);
  const denied = micDenied && talk;
  return (
    <div class="vm-prejoin" role="dialog" aria-label="Join the call" onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); }}>
      <div class="vm-prejoin-head">
        <span>Join the call</span>
        <button type="button" class="vm-icon-btn" aria-label="Close" onClick={onCancel}><Icon.close /></button>
      </div>
      {talking.length > 0 && <p class="vm-prejoin-who">{joinNames(talking)} {talking.length === 1 ? 'is' : 'are'} on the call.</p>}

      {canTalk ? (
        <div class="vm-seg vm-seg-full" role="radiogroup" aria-label="How to join">
          <button type="button" role="radio" aria-checked={!talk} class={!talk ? 'vm-on' : ''} onClick={() => setTalk(false)}><Icon.micOff />Join muted</button>
          <button type="button" role="radio" aria-checked={talk} class={talk ? 'vm-on' : ''} onClick={() => setTalk(true)}><Icon.mic />Join and talk</button>
        </div>
      ) : (
        <p class="vm-prejoin-who">You’re a viewer here: you’ll hear the call, and your mic stays off.</p>
      )}

      {denied ? (
        <div class="vm-micdenied" role="alert">
          <b>Vowe can’t use your microphone</b>
          <span>Turn it on in System Settings › Privacy &amp; Security › Microphone, then come back. You can join muted meanwhile.</span>
          <button type="button" class="vm-link-btn" onClick={onOpenSystemSettings}>Open System Settings</button>
        </div>
      ) : (
        <div class="vm-devices">
          <span><Icon.mic />{talk ? 'Your system will ask for the microphone if it hasn’t yet' : 'Mic stays off'}</span>
          <span><Icon.speaker />System speakers</span>
        </div>
      )}

      <button type="button" class="vm-btn vm-btn-primary vm-btn-block" onClick={() => onJoin({ talk: talk && !denied })}>
        {talk && !denied ? 'Join and talk' : canTalk ? 'Join muted' : 'Join and listen'}
      </button>
    </div>
  );
}
