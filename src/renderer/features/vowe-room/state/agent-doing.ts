// What the agent is up to, in words, from the tool call it just started (AgentEvent 'tool.started'): the verb,
// what it's on (a file, the terms it searched, a part), and the canvas parts that touches. Between calls it's
// thinking; once it writes, it's writing. Inputs are the model's raw calls, so nothing here trusts their shape.

export interface Doing {
  verb: string;
  /** The thing it's on, short enough for a crumb. */
  what?: string;
  /** The whole of it, when `what` was shortened (a path). */
  tip?: string;
  /** Canvas parts it's looking at or drawing on. */
  parts?: string[];
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : []);
const base = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

const PLAIN: Record<string, string> = {
  describe_canvas: 'Looking at the canvas',
  get_room_context: 'Reading the room',
  report_reasoning: 'Thinking it through',
  list_coding_sessions: 'Looking at sessions',
  read_coding_session: 'Reading a session',
  get_repository_status: 'Checking the repository',
};

/** `name(id)`: a canvas part's name, for the parts its canvas tools name by id. */
export function doingOf(tool: string, input: unknown, name: (id: string) => string): Doing {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const part = (ids: string[], verb: string): Doing => (ids.length ? { verb, what: ids.map(name).join(', '), parts: ids } : { verb });
  switch (tool) {
    case 'read_code': {
      const path = str(i.path);
      return path ? { verb: 'Reading', what: base(path), tip: path } : { verb: 'Reading code' };
    }
    case 'search_code': {
      const terms = strs(i.terms);
      return terms.length ? { verb: 'Searching for', what: terms.slice(0, 3).join(', '), ...(str(i.path) ? { tip: `in ${str(i.path)}` } : {}) } : { verb: 'Searching code' };
    }
    case 'get_worktree_changes': {
      const paths = strs(i.diffPaths);
      return paths.length ? { verb: 'Checking changes to', what: base(paths[0]) + (paths.length > 1 ? ` +${paths.length - 1}` : ''), tip: paths.join('\n') } : { verb: 'Checking changes' };
    }
    case 'highlight_component': return part(strs(i.componentIds), 'Pointing at');
    case 'annotate_component': return part(strs([i.componentId]), 'Noting on');
    case 'connect_components': return part(strs([i.from, i.to]), 'Connecting');
    case 'propose_component': {
      const c = (i.component && typeof i.component === 'object' ? i.component : {}) as Record<string, unknown>;
      return str(c.name) ? { verb: 'Proposing', what: str(c.name) } : { verb: 'Proposing a part' };
    }
    case 'show_view': return part(strs([i.focus]), 'Showing a view of');
    default: return { verb: PLAIN[tool] ?? 'Working' };
  }
}
