// The Markdown a message may carry, parsed into plain data the Desk draws itself (never as HTML): paragraphs,
// lists, fenced code with an optional file and line range, and inline `code`, **bold** and *italic*. Anything
// else stays the words it is. Pure: no Preact, no Journey globals.

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; code: string; lang: string | null; path: string | null; from: number | null };

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'b' | 'i'; children: Inline[] };

const FENCE = /^\s*(```|~~~)(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

/** "ts src/main/index.ts:40-48", "src/a.ts", "python": the language, the file, the first line's number. */
export function fenceInfo(info: string): { lang: string | null; path: string | null; from: number | null } {
  let lang: string | null = null, path: string | null = null, from: number | null = null;
  for (const word of info.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(.*?)(?::(\d+)(?:[–-]\d+)?)?$/.exec(word)!;
    if (!path && /[/.]/.test(m[1])) { path = m[1]; from = m[2] ? Number(m[2]) : null; }
    else if (!lang && !path) lang = word.toLowerCase();
  }
  if (!lang && path) lang = /\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? null;
  return { lang, path, from };
}

/** A message's blocks. A fence left open runs to the end, as an unfinished answer would. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ kind: 'p', text: para.join('\n') }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i]);
      out.push({ kind: 'code', code: body.join('\n'), ...fenceInfo(fence[2]) });
      continue;
    }
    const bullet = BULLET.exec(line), num = NUMBER.exec(line);
    if (bullet || num) {
      flush();
      const ordered = !bullet;
      const items: string[] = [];
      const start = num ? Number(num[1]) : 1;
      for (; i < lines.length; i++) {
        const b = BULLET.exec(lines[i]), n = NUMBER.exec(lines[i]);
        const item = ordered ? n : b;
        if (item) { items.push(ordered ? n![2] : b![1]); continue; }
        // An indented line continues the item above it; anything else ends the list.
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += '\n' + lines[i].trim(); continue; }
        break;
      }
      i--;
      out.push({ kind: 'list', ordered, start, items });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = HEADING.exec(line);
    para.push(heading ? `**${heading[1]}**` : line);
  }
  flush();
  return out;
}

// `code` first, so nothing inside it is read as emphasis; then **bold**, then *italic* or _italic_ that
// hugs its words (so "2 * 3 * 4" and snake_case_names stay as written).
const INLINE = /`([^`\n]+)`|\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*|(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\w*])|(?<![\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w])/g;

/** A run of text as code, emphasis and plain words. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'b', children: parseInline(m[2]) });
    else out.push({ kind: 'i', children: parseInline(m[3] ?? m[4]) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Whether a message has anything beyond plain words, so a one-liner can stay a line. */
export const isPlain = (text: string) => !/[`*_\n]|^\s*[-•]\s|^\s*\d+[.)]\s/m.test(text);

export type CodeToken = { kind: 'k' | 'f' | 's' | 'c' | 'n' | 'p'; text: string };

const CLIKE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'javascript', 'json', 'swift', 'go', 'rs', 'rust', 'java', 'kotlin', 'kt', 'c', 'cpp', 'cs', 'css', 'sql', 'py', 'python', 'sh', 'bash', 'zsh']);
const KEYWORDS = new Set(('async await break case catch class const continue default do else export extends false finally for from function if import in interface let new null of return static super switch this throw true try type typeof undefined var void while yield def elif except lambda None True False pass raise with fn pub impl struct enum match mut use func package select insert update delete where join')
  .split(' '));

/** A light, safe colouring for common languages: keywords, calls, strings, numbers and comments. */
export function highlight(code: string, lang: string | null): CodeToken[] {
  if (!lang || !CLIKE.has(lang)) return [{ kind: 'p', text: code }];
  const hash = lang === 'py' || lang === 'python' || lang === 'sh' || lang === 'bash' || lang === 'zsh';
  const re = hash
    ? /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
  const out: CodeToken[] = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (m.index! > last) out.push({ kind: 'p', text: code.slice(last, m.index) });
    const kind: CodeToken['kind'] = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? (KEYWORDS.has(m[4]) ? 'k' : 'f') : KEYWORDS.has(m[5]) ? 'k' : 'p';
    out.push({ kind, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < code.length) out.push({ kind: 'p', text: code.slice(last) });
  return out;
}
