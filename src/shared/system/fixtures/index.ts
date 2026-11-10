import type { SystemRegistry } from '../model.js';
import { PAYMENTS_FIXTURE } from './payments.js';

// Hand-made registries, clearly labelled, for tests and the second-system demonstration (SystemApi.fixtures).

export const FIXTURES: { id: string; label: string; registry: SystemRegistry }[] = [
  { id: 'payments', label: PAYMENTS_FIXTURE.fixture!.label, registry: PAYMENTS_FIXTURE },
];

export const fixtureById = (id: string): SystemRegistry | undefined => FIXTURES.find((f) => f.id === id)?.registry;

export { PAYMENTS_FIXTURE };
