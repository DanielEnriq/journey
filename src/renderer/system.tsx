import { h, render } from './vendor/preact.js';
import { App } from './features/system-canvas/App.js';

// The system canvas page (system.html): served by the dev server (scripts/system-canvas/serve.mjs) or
// opened by Electron main from the Developer menu. Everything it knows comes through SystemApi.

render(<App />, document.getElementById('app')!);
