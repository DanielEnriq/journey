import type { PersonId, Reply } from '../contracts/model.js';

// A thread's replies as the tree people wrote: each reply under the one it answers, in the order they came.
// The thread's first message is the thread itself, so it isn't a node; replies to it are the top level.
// A reply whose parent isn't in the thread (or would loop) answers the thread. Pure: no Preact.

export interface ReplyNode { r: Reply; kids: ReplyNode[] }

export function replyTree(replies: Reply[]): ReplyNode[] {
  const rest = replies.slice(1);
  const nodes = new Map(rest.map((r) => [r.id, { r, kids: [] as ReplyNode[] }]));
  const top: ReplyNode[] = [];
  const under = new Map<ReplyNode, ReplyNode>();
  for (const n of nodes.values()) {
    const parent = n.r.parent ? nodes.get(n.r.parent) : undefined;
    if (parent && !loops(n, parent, under)) { parent.kids.push(n); under.set(n, parent); } else top.push(n);
  }
  return top;
}

/** Whether `parent` already hangs under `node`, so attaching it there would make a loop. */
function loops(node: ReplyNode, parent: ReplyNode, under: Map<ReplyNode, ReplyNode>): boolean {
  for (let at: ReplyNode | undefined = parent; at; at = under.get(at)) if (at === node) return true;
  return false;
}

/** How many replies sit beneath a node, at any depth. */
export const countUnder = (n: ReplyNode): number => n.kids.reduce((s, k) => s + 1 + countUnder(k), 0);

/** Who replied beneath a node, in the order they first did. */
export function facesUnder(n: ReplyNode, out: PersonId[] = []): PersonId[] {
  for (const k of n.kids) { if (!out.includes(k.r.by)) out.push(k.r.by); facesUnder(k, out); }
  return out;
}
