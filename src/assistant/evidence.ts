/**
 * Where Vowe's conclusions come from. Tools register each source they return (a file range, a Git
 * fact, a transcript message, a decision) in the turn's ledger, which hands back a short id ("E3") for
 * the model to cite. The model reports its claims with a basis and the ids behind them, and the runtime
 * checks the report against the ledger rather than taking it on trust:
 *
 *   observed      seen in code, Git, a transcript or tool output: needs at least one such source.
 *   inferred      reasoned from what was observed; may cite sources.
 *   hypothetical  a scenario (what would happen if…), not a finding.
 *   decided       agreed by people: needs a room decision signed on its current version.
 *
 * A claim whose sources don't hold up is downgraded to `inferred` and says why. Canvas components
 * are a drawing, so they never make a claim `observed`.
 */

export type EvidenceKind = 'code' | 'git' | 'session' | 'activity' | 'decision' | 'thread' | 'goal' | 'canvas';
export type ClaimBasis = 'observed' | 'inferred' | 'hypothetical' | 'decided';

export interface EvidenceSource {
  id: string;
  kind: EvidenceKind;
  /** What it points at: `src/worker.ts:40-58`, `session 1a2b3c4d #42`, `git status`, `decision 3f2a… v2`. */
  ref: string;
  /** A short excerpt or summary, as the tool returned it. */
  excerpt?: string;
  /**
   * `local`: from this machine (code, Git, transcripts), sent to the model only with the person's
   * approval, and not shown to the room. `room`: from the room's record or canvas, which members see.
   */
  visibility: 'local' | 'room';
  /** Decisions only: signed by its signers on its current version. */
  approved?: boolean;
  /** The tool call that produced it. */
  toolCallId: string;
}

export interface Claim {
  text: string;
  basis: ClaimBasis;
  evidence: string[];
}

export interface CheckedClaim extends Claim {
  /** What the runtime changed or doubts about it; absent when it held up. */
  issues?: string[];
}

export interface Grounding {
  /** `grounded`: every claim held up; `partial`: some were downgraded; `unreported`: the model gave no report. */
  status: 'grounded' | 'partial' | 'unreported';
  claims: CheckedClaim[];
  /** What Vowe couldn't check, in its words. */
  gaps: string[];
  /** The sources the claims cite. */
  sources: EvidenceSource[];
}

const OBSERVABLE: ReadonlySet<EvidenceKind> = new Set(['code', 'git', 'session', 'activity']);

export class EvidenceLedger {
  private sources = new Map<string, EvidenceSource>();
  private byRef = new Map<string, string>();

  /** Registers a source and returns its id; the same source registered twice keeps its first id. */
  add(source: Omit<EvidenceSource, 'id'>): string {
    const key = `${source.kind}|${source.ref}`;
    const known = this.byRef.get(key);
    if (known) return known;
    const id = `E${this.sources.size + 1}`;
    this.sources.set(id, { ...source, id });
    this.byRef.set(key, id);
    return id;
  }

  get(id: string) {
    return this.sources.get(id);
  }

  all(): EvidenceSource[] {
    return [...this.sources.values()];
  }

  /** Ids that name a registered source, for validating command evidence. */
  known(ids: string[]) {
    return ids.filter((id) => this.sources.has(id));
  }

  /**
   * The transcript source that `text` quotes, if any: room-visible output (canvas requests) may name a
   * session's work but not repeat what was said in it. Matches runs of 32 characters, ignoring case and spacing.
   */
  quotesTranscript(text: string): EvidenceSource | null {
    const flat = (t: string) => t.toLowerCase().replace(/\s+/g, ' ');
    const haystack = flat(text);
    for (const source of this.sources.values()) {
      if (source.kind !== 'session' || !source.excerpt) continue;
      const excerpt = flat(source.excerpt).replace(/…$/, '');
      for (let i = 0; i + 32 <= excerpt.length; i += 8) if (haystack.includes(excerpt.slice(i, i + 32))) return source;
    }
    return null;
  }

  /** Checks a reasoning report against what the tools actually returned. */
  check(report: { claims: Claim[]; gaps: string[] } | null): Grounding {
    if (!report) return { status: 'unreported', claims: [], gaps: [], sources: [] };
    const cited = new Set<string>();
    const claims = report.claims.map((claim): CheckedClaim => {
      const issues: string[] = [];
      const unknown = claim.evidence.filter((id) => !this.sources.has(id));
      if (unknown.length) issues.push(`cites ${unknown.join(', ')}, which no tool returned`);
      const evidence = claim.evidence.filter((id) => this.sources.has(id));
      evidence.forEach((id) => cited.add(id));
      const kinds = evidence.map((id) => this.sources.get(id)!);
      let basis = claim.basis;
      if (basis === 'observed' && !kinds.some((s) => OBSERVABLE.has(s.kind))) {
        issues.push('no code, Git or transcript evidence: shown as inferred');
        basis = 'inferred';
      }
      if (basis === 'decided' && !kinds.some((s) => s.kind === 'decision' && s.approved)) {
        issues.push('no decision signed on its current version: shown as inferred');
        basis = 'inferred';
      }
      return { text: claim.text, basis, evidence, ...(issues.length ? { issues } : {}) };
    });
    return {
      status: claims.some((c) => c.issues) ? 'partial' : 'grounded',
      claims,
      gaps: report.gaps,
      sources: [...cited].map((id) => this.sources.get(id)!),
    };
  }
}

/**
 * Grounding as the room may see it: local sources keep their kind but lose excerpts, and transcript
 * sources lose their session ids. Code paths and Git refs stay, since the room shares the repository.
 * Whatever a person explicitly shares is theirs to share; this is the default.
 */
export function groundingForRoom(grounding: Grounding): Grounding {
  return {
    ...grounding,
    sources: grounding.sources.map((s) =>
      s.visibility === 'room'
        ? s
        : { ...s, excerpt: undefined, ref: s.kind === 'session' || s.kind === 'activity' ? 'a local Claude Code session (not shared)' : s.ref },
    ),
  };
}
