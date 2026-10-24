/**
 * AI voice agents, independent of who provides them. Calls between people run on LiveKit
 * (src/renderer/calls/service.ts); a voice agent is a separate conversation that will later be bridged
 * into a call as one more participant. Nothing starts a session yet.
 *
 * A provider runs in main and keeps its credentials there. Audio crosses this interface as raw
 * PCM so a bridge can move it between the agent and a LiveKit track without knowing the vendor.
 */

/** 16-bit signed little-endian mono PCM at `sampleRate` Hz. */
export interface AudioFormat {
  encoding: 'pcm_s16le';
  sampleRate: number;
}

export type VoiceAgentEvent =
  /** What the agent heard from the call. */
  | { type: 'user_transcript'; text: string }
  /** What the agent is about to say. */
  | { type: 'agent_response'; text: string }
  /** A chunk of the agent's speech, in the session's `output` format. */
  | { type: 'agent_audio'; pcm: Uint8Array }
  /** Someone spoke over the agent: drop any of its audio not yet played. */
  | { type: 'interruption' }
  /** The session ended, by close() or from the provider's side. Nothing follows it. */
  | { type: 'closed'; reason: string | null };

export interface VoiceAgentSession {
  readonly conversationId: string;
  /** What sendUserAudio expects. */
  readonly input: AudioFormat;
  /** What agent_audio carries. */
  readonly output: AudioFormat;
  /** Call audio for the agent to hear, in the `input` format. */
  sendUserAudio(pcm: Uint8Array): void;
  /** Background the agent should know about (say, what a worker agent is doing), without interrupting it. */
  sendContext(text: string): void;
  close(): void;
}

export interface VoiceAgentProvider {
  /** For logs and errors, e.g. "ElevenLabs". */
  readonly name: string;
  /** Whether its credentials are set; says nothing about whether they work. */
  isConfigured(): boolean;
  /** Checks the credentials and agent against the provider, without starting a conversation. */
  verify(): Promise<void>;
  /** Opens a conversation; resolves once the agent is ready for audio. */
  startSession(onEvent: (event: VoiceAgentEvent) => void): Promise<VoiceAgentSession>;
}
