import type { JourneyApi } from '../shared/api.js';
import type { SystemClient } from './features/system-canvas/api-client.js';

// The preload's bridge to the main process (src/preload/index.cts).
declare global {
  interface Window {
    /** `system` is the system canvas's bridge; absent when the page is served by the dev server instead. */
    journey: JourneyApi & { system?: SystemClient };
  }
}
