import { elevenlabs } from '../elevenlabs/index.js';
import type { VoiceAgentProvider } from './provider.js';

export type * from './provider.js';

/** The configured voice agent provider, if any. Add or swap providers here; callers only see the interface. */
export function getVoiceAgentProvider(): VoiceAgentProvider | undefined {
  return elevenlabs.isConfigured() ? elevenlabs : undefined;
}
