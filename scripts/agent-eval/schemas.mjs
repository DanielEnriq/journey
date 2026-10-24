// pnpm contracts:write: writes the JSON Schemas of Vowe's runtime contracts to src/assistant/contracts,
// from the zod schemas the runtime enforces. contracts.test.ts fails when they drift; rerun this then.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { canvasCommandSchema, canvasSnapshotSchema } from '../../dist/assistant/canvas.js';
import { roomTurnSchema } from '../../dist/assistant/index.js';

export const CONTRACTS = {
  'room-agent-turn': roomTurnSchema,
  'canvas-snapshot': canvasSnapshotSchema,
  'canvas-command': canvasCommandSchema,
};

export const render = (schema) => `${JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, schema] of Object.entries(CONTRACTS)) {
    writeFileSync(`src/assistant/contracts/${name}.schema.json`, render(schema));
    console.log(`wrote src/assistant/contracts/${name}.schema.json`);
  }
}
