import type { Authorization, CanvasCommand, ReasoningEvent, Speaker, SpokenTurn, VoiceReasoning } from '../contract.js';

/**
 * A stand-in for Vowe's reasoning runtime with a scripted answer, for tests and the voice end-to-end
 * check. It streams like the real one: a tool call, the answer in small deltas, and a canvas command
 * part-way through. It never calls a model.
 */

export interface FixtureScript {
  /** The answer, spoken in order. A `canvas` step is sent between the text around it. */
  steps: ({ say: string } | { canvas: CanvasCommand } | { tool: string })[];
  /** Delay between deltas, to look like streaming. */
  deltaMs?: number;
}

export interface FixtureOptions {
  /** People this runtime may answer for; anyone else is refused, as a runtime without their model access must. */
  authorized: string[];
  script(turn: SpokenTurn): FixtureScript;
}

export class FixtureReasoning implements VoiceReasoning {
  readonly name = 'fixture';
  readonly turns: SpokenTurn[] = [];
  readonly aborted: string[] = [];

  constructor(private readonly options: FixtureOptions) {}

  async authorize(requester: Speaker): Promise<Authorization> {
    if (this.options.authorized.includes(requester.identity)) return { ok: true };
    return { ok: false, code: 'unauthorized', message: `${requester.name ?? 'Sorry'}, I can only answer with your own model access, and it isn’t connected here.` };
  }

  async *respond(turn: SpokenTurn, signal: AbortSignal): AsyncIterable<ReasoningEvent> {
    this.turns.push(turn);
    const { steps, deltaMs = 15 } = this.options.script(turn);
    const wait = () => sleep(deltaMs, signal);
    try {
      for (const step of steps) {
        if ('tool' in step) {
          const id = `${turn.turnId}:${step.tool}`;
          yield { type: 'tool', phase: 'started', id, name: step.tool };
          await wait();
          yield { type: 'tool', phase: 'finished', id, name: step.tool, error: null };
        } else if ('canvas' in step) {
          yield { type: 'canvas', command: step.canvas };
        } else {
          for (const word of step.say.match(/\S+\s*/g) ?? []) {
            if (signal.aborted) return;
            yield { type: 'text', delta: word };
            await wait();
          }
        }
        if (signal.aborted) return;
      }
      yield { type: 'done', stop: 'answered' };
    } finally {
      if (signal.aborted) this.aborted.push(turn.turnId);
    }
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}
