import type { JourneyApi } from '../shared/api.js';

// The preload's bridge to the main process (src/preload/index.cts).
declare global {
  interface Window {
    journey: JourneyApi;
  }
}
