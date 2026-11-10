import { writeFileSync } from 'node:fs';
import { indexRepository, stableStringify } from './index.js';

// `node dist/system/indexer/cli.js <root> [--out index.json] [--max-files N] [--timeout MS] [--no-diagnostics]`
// Indexes a repository and prints what it found; `--out` writes the RepoIndex as JSON.

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const out = flag('--out');
const maxFiles = flag('--max-files');
const timeout = flag('--timeout');
const noDiag = args.includes('--no-diagnostics');
const root = args.filter((a) => !a.startsWith('--'))[0] ?? process.cwd();

const t0 = Date.now();
const index = await indexRepository(root, {
  ...(maxFiles ? { maxFiles: Number(maxFiles) } : {}),
  ...(timeout ? { timeoutMs: Number(timeout) } : {}),
  diagnostics: !noDiag,
});
const ms = Date.now() - t0;
if (out) writeFileSync(out, stableStringify(index) + '\n');

const r = index.revision;
const kinds: Record<string, number> = {};
for (const s of index.symbols) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
const refKinds: Record<string, number> = {};
for (const x of index.references) refKinds[x.kind] = (refKinds[x.kind] ?? 0) + 1;
const fmt = (o: Record<string, number>) => Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`${r.repo.name} (${r.repo.id}) at ${r.head?.slice(0, 10) ?? 'no git'}${r.branch ? ` on ${r.branch}` : ''}, ${r.dirty.length} dirty, fingerprint ${r.fingerprint}`);
console.log(`indexed in ${ms}ms${index.incomplete ? ' — INCOMPLETE' : ''}`);
console.log(`files       ${index.files.length}: ${Object.entries(index.coverage.byLang).sort().map(([l, c]) => `${l} ${c!.files}${c!.indexed !== c!.files ? ` (${c!.indexed} indexed, ${c!.partial} partial, ${c!.unsupported} unsupported, ${c!.skipped} skipped, ${c!.error} error)` : ''}`).join(', ')}`);
console.log(`symbols     ${index.symbols.length}: ${fmt(kinds)}`);
console.log(`imports     ${index.imports.length}`);
console.log(`references  ${index.references.length}: ${fmt(refKinds)}`);
console.log(`literals    ${index.literals.length}`);
console.log(`comparisons ${index.comparisons.length}`);
console.log(`flows       ${index.flows.length} (${index.flows.reduce((n, f) => n + f.steps.length, 0)} steps)`);
console.log(`diagnostics ${Object.values(index.coverage.diagnostics).reduce((a, b) => a + b, 0)} in ${Object.keys(index.coverage.diagnostics).length} files`);
console.log('limits:');
for (const l of index.coverage.limits) console.log(`  - ${l}`);
if (out) console.log(`wrote ${out}`);
