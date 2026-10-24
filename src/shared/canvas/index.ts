// Vowe's semantic canvas: the document, the commands that change it, and the views drawn from it.
// Pure TypeScript shared by main, the renderer, the tests and the reasoning runtime. See INTEGRATION.md.

export * from './model.js';
export * from './errors.js';
export * from './commands.js';
export { applyCommand, failure, type Applied } from './engine.js';
export * from './store.js';
export * from './presence.js';
export { dangling, parseDocument } from './validate.js';
export { CANVAS_TOOLS, type ToolDefinition } from './tools.js';
export * from './views/index.js';
export { PAYMENT_SYSTEM, ORDERS_SYSTEM } from './fixtures/payment.js';
