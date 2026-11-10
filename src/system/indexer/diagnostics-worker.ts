import { parentPort, workerData } from 'node:worker_threads';
import { buildPrograms, countDiagnostics } from './typescript.js';

// Counting type-checker diagnostics is a full type check of every file: the slowest part of indexing, and
// independent of everything else. indexRepository runs it here, on its own copy of the programs, while the
// main thread reads symbols and references.

const { root, files, tsconfigs, deadline } = workerData as { root: string; files: string[]; tsconfigs: string[]; deadline: number };
try {
  const { progs, rel } = buildPrograms(root, files, tsconfigs);
  parentPort!.postMessage({ ok: true, ...countDiagnostics(progs, rel, deadline) });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: (err as Error).message });
}
