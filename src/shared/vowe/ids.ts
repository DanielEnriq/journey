// How a decision version is named in a VoweRecord. Each version of a decision is its own Decision on the
// Desk (grouped by title into a family), so each needs its own id: version 1 is the decision's id, later
// versions are `<decision id>.v<n>`. Ids never contain ':' (the Desk splits `line:<decision>:<line>` on it).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decisionVersionId(decisionId: string, version: number): string {
  return version <= 1 ? decisionId : `${decisionId}.v${version}`;
}

/** The database decision and version a VoweRecord decision id names, or null if it isn't one. */
export function parseDecisionVersionId(id: string): { decisionId: string; version: number } | null {
  if (typeof id !== 'string') return null;
  const m = /^([^.]+)(?:\.v([1-9]\d{0,5}))?$/.exec(id);
  if (!m || !UUID.test(m[1])) return null;
  return { decisionId: m[1].toLowerCase(), version: m[2] ? Number(m[2]) : 1 };
}

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
