// A scripted stand-in for a model, for running the eval with no credentials. It walks the turn the
// way a model would: search for the question's words, read the best file, ask for a failure view
// over the selection and its neighbours, report, answer. It doesn't reason; its answer is assembled
// from what the tools returned, and it is labelled as a mock everywhere it appears.

const STOP = new Set(['what', 'happens', 'this', 'that', 'after', 'before', 'with', 'from', 'when', 'does', 'would', 'should', 'there', 'their', 'about', 'which']);

const stem = (w) => w.replace(/(ing|es|ed|s)$/, '');
const keywords = (text) => [...new Set(text.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !STOP.has(w)).map(stem) ?? [])].slice(0, 5);

function lastUser(items) {
  return [...items].reverse().find((i) => i.type === 'user' && !i.text.startsWith('[Vowe runtime]'))?.text ?? '';
}
function resultOf(items, name) {
  const call = [...items].reverse().find((i) => i.type === 'tool_call' && i.name === name);
  const result = call && items.find((i) => i.type === 'tool_result' && i.callId === call.id);
  try {
    return result && !result.isError ? JSON.parse(result.content) : null;
  } catch {
    return null;
  }
}

export function mockProvider() {
  let n = 0;
  const call = (name, input) => ({ type: 'tool_call', id: `mock_${++n}`, name, input });
  const respond = (items) => ({ items, stopReason: items.some((i) => i.type === 'tool_call') ? 'tool_use' : 'end_turn', model: 'mock' });

  return {
    id: 'mock',
    name: 'Mock model',
    billing: 'none (mock)',
    model: 'mock',
    isConfigured: () => true,
    async complete({ items, onTextDelta }) {
      const question = lastUser(items).split('\n').at(-1);
      const search = resultOf(items, 'search_code');
      const canvas = resultOf(items, 'describe_canvas');
      const read = resultOf(items, 'read_code');
      const reported = items.some((i) => i.type === 'tool_call' && i.name === 'report_reasoning');

      if (!canvas) return respond([call('describe_canvas', {}), call('search_code', { terms: keywords(question) })]);
      if (!read && search?.matches?.length) {
        const counts = {};
        for (const m of search.matches) counts[m.at.split(':')[0]] = (counts[m.at.split(':')[0]] ?? 0) + 1;
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        return respond([call('read_code', { path: best })]);
      }
      if (!reported) {
        const focus = canvas.focus.components;
        const upstream = canvas.relationships.filter((r) => focus.includes(r.to)).map((r) => r.from);
        const downstream = canvas.relationships.filter((r) => focus.includes(r.from)).map((r) => r.to);
        const actors = [...new Set([...upstream.slice(0, 1), ...focus.slice(0, 1), ...downstream.slice(0, 1)])];
        const [up, me, down] = [upstream[0], focus[0], downstream[0]];
        const evidence = [read?.evidence, ...(search?.matches ?? []).map((m) => m.evidence)].filter(Boolean).slice(0, 6);
        const out = [];
        if (me && up && down)
          out.push(
            call('show_view', {
              view: 'failure',
              focus: [me],
              sequence: {
                actors,
                steps: [
                  { actor: up, title: 'Hands over work' },
                  { actor: me, title: 'Calls downstream', tone: 'normal' },
                  { actor: me, title: 'Stops before finishing', tone: 'crash' },
                  { actor: up, title: 'Hands it over again' },
                  { actor: down, title: 'Called a second time', tone: 'bad' },
                ],
              },
              reason: '[mock] The order of operations, as the tools returned it.',
              evidence,
            }),
          );
        out.push(
          call('report_reasoning', {
            claims: [{ text: `[mock] ${read ? `${read.path} was read` : 'No code was found'}.`, basis: read ? 'observed' : 'hypothetical', evidence: read ? [read.evidence] : [] }],
            gaps: ['This answer came from a mock model, not a real one.'],
          }),
        );
        return respond(out);
      }
      const text = `[mock] Not a real answer. The tools found ${search?.matches?.length ?? 0} matching lines${read ? ` and read ${read.path}` : ''}; a real model would reason over them here.`;
      onTextDelta?.(text);
      return respond([{ type: 'assistant', text }]);
    },
  };
}
