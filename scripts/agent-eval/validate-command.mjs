// pnpm canvas:validate <command.json> [snapshot.json]: checks a canvas command against the contract
// (src/assistant/canvas.ts) and a canvas snapshot, as the runtime does before emitting one. Without a
// snapshot, the eval's Payment Reliability canvas is used. `-` reads the command from stdin.
// Exits 0 when valid, 1 with the errors when not.
import { readFileSync } from 'node:fs';
import { canvasSnapshotSchema, validateCanvasCommand } from '../../dist/assistant/canvas.js';
import { canvas } from './fixture.mjs';

const [commandPath, snapshotPath] = process.argv.slice(2);
if (!commandPath) {
  console.error('Usage: pnpm canvas:validate <command.json | -> [snapshot.json]');
  process.exit(2);
}
const read = (path) => JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
const snapshot = canvasSnapshotSchema.safeParse(snapshotPath ? read(snapshotPath) : canvas);
if (!snapshot.success) {
  console.error('The snapshot is not a valid canvas snapshot:');
  for (const issue of snapshot.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
const commands = [read(commandPath)].flat();
const proposed = new Set();
let failed = 0;
for (const [i, command] of commands.entries()) {
  const result = validateCanvasCommand(command, snapshot.data, proposed);
  if (result.ok) {
    if (result.command.type === 'propose_component') proposed.add(result.command.payload.component.id);
    console.log(`✔ ${i}: ${result.command.type}`);
  } else {
    failed++;
    console.log(`✖ ${i}: ${command?.type ?? 'command'}`);
    for (const e of result.errors) console.log(`    ${e}`);
  }
}
process.exitCode = failed ? 1 : 0;
