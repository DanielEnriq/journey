import { diffIndexes, indexRepository, INDEXER_TOOL, refreshIndex, scanFreshness } from '../indexer/index.js';
import { buildRegistry, RULES_VERSION } from '../registry/index.js';
import { diffRegistries, markStatus } from '../../shared/system/registry-utils.js';
import type { SystemEngine } from '../service.js';

// The host's glue to the indexer and the registry: the only file that knows their exact shapes.

export async function defaultEngine(): Promise<SystemEngine> {
  return {
    // A cache written by another indexer or rule set is rebuilt rather than trusted.
    version: `${INDEXER_TOOL}+${RULES_VERSION}`,
    index: (root) => indexRepository(root),
    async scan(root, index) {
      const f = scanFreshness(root, index);
      return { fingerprint: f.current, changed: [...new Set([...f.changed, ...f.added, ...f.removed])].sort(), headMoved: f.headMoved };
    },
    async refresh(root, prev) { return (await refreshIndex(root, prev)).index; },
    diffIndexes,
    build: (index, interpretations) => buildRegistry(index, interpretations),
    diffRegistries,
    mark: (next, diff, previous) => markStatus(next, { diff, previous }),
    fixtures: () => [],
    fixture: () => null,
  };
}
