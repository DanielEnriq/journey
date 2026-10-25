import type { ModelProvider } from './provider.js';

/**
 * Which provider answers a turn. With `auto`, the person's ChatGPT plan when it's signed in with plan
 * usage granted; otherwise the first configured API-key fallback, in order. A pinned choice is used even
 * when it isn't configured, so the person sees why it can't answer instead of being billed elsewhere.
 *
 * This runs once per turn, before any request: a plan error mid-turn stops the turn, it doesn't
 * re-select (OpenAI: "Don't silently switch to another billing path").
 */
export function selectProvider(choice: 'auto' | string, plan: ModelProvider, fallbacks: ModelProvider[]): ModelProvider {
  const all = [plan, ...fallbacks];
  if (choice !== 'auto') return all.find((p) => p.id === choice) ?? plan;
  return all.find((p) => p.isConfigured()) ?? plan;
}
