import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript-api';
import type {
  CallFlow, ComparisonSite, FileStatus, IndexImport, IndexReference, IndexSymbol, LiteralSite, ReferenceKind, SourceRange, SymbolKind,
} from '../../shared/system/model.js';
import { hash16, oneLine, toPosix } from './util.js';

// The TypeScript/JavaScript pass, on the TypeScript 5.9 compiler API (`typescript-api`; the repo's own
// TypeScript 7 has no API). Each tsconfig in the repo becomes a program; .ts/.js files no tsconfig covers go
// in one more, loose program. Every file is read from exactly one program (the first that has it), so each
// fact appears once.
//
// Two walks per file: the first names every declaration we index (so a reference from any program can
// be resolved to a symbol id by position), the second records imports, references, literal call sites,
// string comparisons and call flows, keeping a stack of the enclosing indexed symbol.

export const TS_LIMITS = [
  'dynamic property access (`obj[key]`) and computed dispatch (e.g. `HANDLERS[cmd.name](…)`) are not resolved to a target',
  'calls through values typed `any` or untyped JavaScript are not resolved',
  'reads and type references are recorded once per (from, to, kind); calls, new, writes, JSX uses and heritage are recorded at every site',
  'call flows leave out calls to assert, console, JSON, Math, Object, Reflect, Number, String, Date, Symbol, require, array/string/collection/promise helpers and built-in constructors (`new Error`, `new Map`…) whose target is not an indexed symbol',
  'locally declared functions are indexed as `Outer.inner` (repeats get `~2`); anonymous callbacks are folded into the enclosing symbol, with ctx `callback` in its flow',
  'namespaces, `declare module` and `declare global` blocks are not indexed as symbols',
  'comparison branches are taken from the enclosing if/?:/&& only; a comparison mixed into `||` chains or negated with `!` may report no branch',
];

export const DIAGNOSTICS_CUT = 'time limit reached while counting type-checker diagnostics; counts are partial';

export interface TsFileResult { status: FileStatus; note?: string }

export interface TsPassOutput {
  symbols: IndexSymbol[];
  imports: IndexImport[];
  references: IndexReference[];
  literals: LiteralSite[];
  comparisons: ComparisonSite[];
  flows: CallFlow[];
  diagnostics: Record<string, number>;
  files: Map<string, TsFileResult>;
  limits: string[];
  incomplete: boolean;
}

export interface TsPassOptions {
  root: string;
  /** Repo-relative paths of every listed ts/tsx/js file (plus tsconfig.json files, found separately). */
  files: string[];
  tsconfigs: string[];
  deadline: number;
  diagnostics: boolean;
}

const FUNCTION_INIT = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression =>
  !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) && e.arguments.length === 1 && e.expression.getText() === 'Object.freeze') e = e.arguments[0];
    else return e;
  }
}

const isStringLit = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

function propName(n: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

/** `this.transport.execute`, `j.canvas.execute`, `supabase.from`: the callee as written, without `?.`, `!` or parens. */
export function normalizeCallee(e: ts.Expression): string {
  if (ts.isIdentifier(e) || ts.isPrivateIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (e.kind === ts.SyntaxKind.SuperKeyword) return 'super';
  if (e.kind === ts.SyntaxKind.ImportKeyword) return 'import';
  if (ts.isPropertyAccessExpression(e)) return `${normalizeCallee(e.expression)}.${e.name.text}`;
  if (ts.isElementAccessExpression(e)) {
    const a = e.argumentExpression;
    return isStringLit(a) ? `${normalizeCallee(e.expression)}.${a.text}` : `${normalizeCallee(e.expression)}[]`;
  }
  if (ts.isCallExpression(e)) return `${normalizeCallee(e.expression)}()`;
  if (ts.isNewExpression(e)) return `new ${normalizeCallee(e.expression)}()`;
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) return normalizeCallee(e.expression);
  if (ts.isStringLiteral(e)) return JSON.stringify(e.text);
  return oneLine(e.getText(), 60);
}

const lastName = (e: ts.Expression): string => {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && isStringLit(e.argumentExpression)) return e.argumentExpression.text;
  return '';
};

const BUILTIN_CTORS = new Set(['Error', 'TypeError', 'RangeError', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Date', 'Promise', 'RegExp', 'URL', 'URLSearchParams', 'Array', 'Uint8Array', 'TextEncoder', 'TextDecoder', 'AbortController', 'Headers', 'Response', 'Request', 'Blob', 'FormData', 'Event', 'CustomEvent']);
const TRIVIAL_ROOTS = new Set(['assert', 'console', 'JSON', 'Math', 'Object', 'Reflect', 'Number', 'String', 'Boolean', 'Date', 'Symbol', 'Array', 'require', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent']);
const HELPER_METHODS = new Set([
  'map', 'filter', 'forEach', 'reduce', 'some', 'every', 'find', 'findIndex', 'findLast', 'includes', 'indexOf', 'lastIndexOf', 'push', 'pop',
  'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'sort', 'reverse', 'flat', 'flatMap', 'keys', 'values', 'entries', 'has', 'get',
  'set', 'add', 'delete', 'clear', 'toString', 'trim', 'trimStart', 'trimEnd', 'split', 'replace', 'replaceAll', 'startsWith', 'endsWith',
  'toLowerCase', 'toUpperCase', 'padStart', 'padEnd', 'then', 'catch', 'finally', 'at', 'fill', 'localeCompare', 'match', 'test', 'exec',
  'charAt', 'charCodeAt', 'codePointAt', 'repeat', 'substring', 'substr', 'toFixed', 'toISOString', 'getTime', 'valueOf', 'bind', 'call', 'apply',
]);

function returnsJsx(fn: ts.SignatureDeclaration): boolean {
  const jsxish = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    e = unwrap(e);
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return true;
    if (ts.isConditionalExpression(e)) return jsxish(e.whenTrue) || jsxish(e.whenFalse);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return jsxish(e.right) || jsxish(e.left);
    return false;
  };
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return false;
  if (!ts.isBlock(body)) return jsxish(body);
  let found = false;
  const walk = (n: ts.Node) => {
    if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n) && jsxish(n.expression)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}

const MODIFIERS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.AsyncKeyword]: 'async', [ts.SyntaxKind.StaticKeyword]: 'static', [ts.SyntaxKind.PrivateKeyword]: 'private',
  [ts.SyntaxKind.ProtectedKeyword]: 'protected', [ts.SyntaxKind.PublicKeyword]: 'public', [ts.SyntaxKind.ReadonlyKeyword]: 'readonly',
  [ts.SyntaxKind.AbstractKeyword]: 'abstract', [ts.SyntaxKind.DefaultKeyword]: 'default', [ts.SyntaxKind.DeclareKeyword]: 'declare',
  [ts.SyntaxKind.OverrideKeyword]: 'override',
};
function modifiersOf(n: ts.Node): string[] {
  const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : [];
  return mods.map((m) => MODIFIERS[m.kind]).filter((m): m is string => !!m);
}
const hasExport = (n: ts.Node) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** String-literal union members of a type: `'a' | 'b'` → ['a','b'] (null when it isn't one). */
function literalUnion(t: ts.TypeNode | undefined): string[] | null {
  if (!t) return null;
  while (ts.isParenthesizedTypeNode(t)) t = t.type;
  const parts = ts.isUnionTypeNode(t) ? t.types : [t];
  const out: string[] = [];
  for (const p of parts) {
    if (ts.isLiteralTypeNode(p) && ts.isStringLiteral(p.literal)) out.push(p.literal.text);
    else return null;
  }
  return ts.isUnionTypeNode(t) && out.length ? out : null;
}

function docOf(node: ts.Node, sf: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (!ranges?.length) return undefined;
  // Only the comments directly above (no blank line between them and the declaration).
  const keep: ts.CommentRange[] = [];
  let next = node.getStart(sf);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const between = sf.text.slice(ranges[i].end, next);
    if ((between.match(/\n/g)?.length ?? 0) > 1) break;
    keep.unshift(ranges[i]);
    next = ranges[i].pos;
  }
  if (!keep.length) return undefined;
  const text = keep.map((r) => sf.text.slice(r.pos, r.end)
    .replace(/^\/\*\*?|\*\/$/g, '')
    .split('\n').map((l) => l.replace(/^\s*(\/\/+|\*)?\s?/, '')).join(' ')).join(' ');
  const t = oneLine(text, 400);
  return t || undefined;
}

export interface Prog { program: ts.Program; checker: ts.TypeChecker; options: ts.CompilerOptions; host: ts.CompilerHost; owned: ts.SourceFile[]; cache: ts.ModuleResolutionCache }

/**
 * One program per tsconfig (shallowest first), then a loose program for listed files none of them covers.
 * `owned` holds the listed files each program is the reader of: the first program that has a file owns it.
 */
export function buildPrograms(rootIn: string, files: string[], tsconfigs: string[]): { progs: Prog[]; owner: Set<string>; limits: string[]; rel: (abs: string) => string } {
  const root = resolve(rootIn);
  const listed = new Set(files);
  const relCache = new Map<string, string>();
  const rel = (abs: string) => {
    let r = relCache.get(abs);
    if (r === undefined) relCache.set(abs, (r = toPosix(relative(root, abs))));
    return r;
  };
  const limits: string[] = [];
  const libCache = new Map<string, ts.SourceFile | undefined>();
  const makeHost = (options: ts.CompilerOptions) => {
    const host = ts.createCompilerHost(options, true);
    const get = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, langOpts, onError, shouldCreate) => {
      // Library and package declarations are the same for every program: parse them once.
      const inRepo = !rel(fileName).startsWith('..') && !fileName.includes('/node_modules/');
      if (inRepo) return get(fileName, langOpts, onError, shouldCreate);
      const lv = typeof langOpts === 'object' ? `${langOpts.languageVersion}:${langOpts.impliedNodeFormat ?? ''}` : String(langOpts);
      const key = `${fileName}|${lv}`;
      if (!libCache.has(key)) libCache.set(key, get(fileName, langOpts, onError, shouldCreate));
      return libCache.get(key);
    };
    return host;
  };

  const progs: Prog[] = [];
  const owner = new Set<string>();
  let baseOptions: ts.CompilerOptions | undefined;
  const addProgram = (names: string[], options: ts.CompilerOptions) => {
    const host = makeHost(options);
    const program = ts.createProgram({ rootNames: names, options, host });
    const owned: ts.SourceFile[] = [];
    for (const sf of program.getSourceFiles()) {
      const r = rel(sf.fileName);
      if (listed.has(r) && !owner.has(r)) { owner.add(r); owned.push(sf); }
    }
    const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), (s) => s, options);
    progs.push({ program, checker: program.getTypeChecker(), options, host, owned, cache });
  };

  const configs = [...tsconfigs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  for (const cfg of configs) {
    let err: string | undefined;
    const parsed = ts.getParsedCommandLineOfConfigFile(join(root, cfg), { noEmit: true }, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => { err = ts.flattenDiagnosticMessageText(d.messageText, ' '); },
    });
    if (!parsed) { limits.push(`${cfg} could not be read (${err ?? 'unknown error'}); its files were indexed loosely`); continue; }
    const names = parsed.fileNames.filter((f) => listed.has(rel(f)));
    if (!names.length) continue;
    baseOptions ??= parsed.options;
    addProgram(names, { ...parsed.options, noEmit: true });
  }
  const loose = files.filter((f) => !owner.has(f));
  if (loose.length) {
    // Files no tsconfig covers (scripts/*.mjs, configs): read with the root config's settings plus allowJs.
    const options: ts.CompilerOptions = {
      ...(baseOptions ?? { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve, strict: true, skipLibCheck: true }),
      allowJs: true, checkJs: false, noEmit: true, rootDir: undefined, outDir: undefined, composite: false, declaration: false,
    };
    addProgram(loose.map((f) => join(root, f)), options);
  }
  return { progs, owner, limits, rel };
}

/** Type-checker diagnostics per owned file (a full type check), stopping at `deadline`. */
export function countDiagnostics(progs: Prog[], rel: (abs: string) => string, deadline: number, skip?: Set<string>): { counts: Record<string, number>; complete: boolean } {
  const counts: Record<string, number> = {};
  for (const p of progs) for (const sf of p.owned) {
    const file = rel(sf.fileName);
    if (skip?.has(file)) continue;
    if (Date.now() > deadline) return { counts, complete: false };
    try {
      const n = p.program.getSyntacticDiagnostics(sf).length + p.program.getSemanticDiagnostics(sf).length;
      if (n) counts[file] = n;
    } catch { /* a checker crash only loses the count */ }
  }
  return { counts, complete: true };
}

export function runTypeScriptPass(opts: TsPassOptions): TsPassOutput {
  const root = resolve(opts.root);
  const listed = new Set(opts.files);
  const timing = process.env.VOWE_INDEX_TIMING ? (label: string) => console.error(`[indexer] ${label} ${Date.now() - tStart}ms`) : () => {};
  const tStart = Date.now();
  const out: TsPassOutput = { symbols: [], imports: [], references: [], literals: [], comparisons: [], flows: [], diagnostics: {}, files: new Map(), limits: [...TS_LIMITS], incomplete: false };

  const { progs, owner, limits, rel } = buildPrograms(root, opts.files, opts.tsconfigs);
  out.limits.push(...limits);
  for (const f of opts.files) if (!owner.has(f)) out.files.set(f, { status: 'error', note: 'no program could read this file' });
  timing(`programs (${progs.length})`);

  /* ---------- Pass 1: declarations ---------- */
  const declIds = new Map<string, string>(); // `${file}:${pos}:${end}` → symbol id
  const symbols = new Map<string, IndexSymbol>();
  const keyOf = (n: ts.Node) => `${rel(n.getSourceFile().fileName)}:${n.pos}:${n.end}`;
  const idOfDecl = (n: ts.Node | undefined) => (n ? declIds.get(keyOf(n)) : undefined);

  const rangeOf = (n: ts.Node, sf: ts.SourceFile = n.getSourceFile()): SourceRange => {
    const s = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    const e = sf.getLineAndCharacterOfPosition(Math.max(n.getStart(sf), n.end - 1));
    return { file: rel(sf.fileName), start: { line: s.line + 1, col: s.character + 1 }, end: { line: e.line + 1, col: e.character + 1 } };
  };

  let deadlineHit = false;
  const overTime = () => {
    if (!deadlineHit && Date.now() > opts.deadline) deadlineHit = true;
    return deadlineHit;
  };
  const skipped = new Set<string>();

  for (const p of progs) {
    const checker = p.checker;
    const typeText = (n: ts.Node) => {
      try { return oneLine(checker.typeToString(checker.getTypeAtLocation(n), undefined, ts.TypeFormatFlags.NoTruncation), 160); } catch { return ''; }
    };
    const returnText = (fn: ts.SignatureDeclaration) => {
      if (fn.type) return oneLine(fn.type.getText(), 160);
      try {
        const sig = checker.getSignatureFromDeclaration(fn);
        return sig ? oneLine(checker.typeToString(checker.getReturnTypeOfSignature(sig), undefined, ts.TypeFormatFlags.NoTruncation), 160) : '';
      } catch { return ''; }
    };
    const fnSig = (name: string, fn: ts.SignatureDeclaration) => {
      const tp = fn.typeParameters?.length ? `<${fn.typeParameters.map((t) => t.getText()).join(', ')}>` : '';
      const ret = returnText(fn);
      return oneLine(`${name}${tp}(${fn.parameters.map((x) => x.getText()).join(', ')})${ret ? `: ${ret}` : ''}`);
    };

    for (const sf of p.owned) {
      const file = rel(sf.fileName);
      if (overTime()) { skipped.add(file); continue; }
      const used = new Map<string, number>();
      const exportedNames = new Set<string>();
      for (const st of sf.statements) {
        if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) exportedNames.add((el.propertyName ?? el.name).text);
        } else if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) exportedNames.add(st.expression.text);
      }

      const add = (keyNode: ts.Node, rangeNode: ts.Node, qname: string, kind: SymbolKind, extra: Partial<IndexSymbol> & { merge?: boolean }): string => {
        let id = `${file}#${qname}`;
        const existing = symbols.get(id);
        if (existing && extra.merge) {
          // Overloads and merged declarations share one symbol; the one with a body describes it.
          declIds.set(keyOf(keyNode), id);
          if ((keyNode as ts.FunctionLikeDeclaration).body && !(existing.attrs?.hasBody)) {
            Object.assign(existing, { range: rangeOf(rangeNode, sf), hash: hash16(rangeNode.getText(sf)), signature: extra.signature ?? existing.signature, doc: extra.doc ?? existing.doc });
            existing.attrs = { ...existing.attrs, ...extra.attrs, hasBody: true };
          }
          return id;
        }
        if (existing) {
          const n = (used.get(id) ?? 1) + 1;
          used.set(id, n);
          id = `${id}~${n}`;
        }
        const name = qname.slice(qname.lastIndexOf('.') + 1);
        const attrs = { ...extra.attrs };
        if ((keyNode as ts.FunctionLikeDeclaration).body) attrs.hasBody = true;
        const sym: IndexSymbol = {
          id, name: kind === 'test-case' ? qname : name, kind, file, range: rangeOf(rangeNode, sf), exported: extra.exported ?? false,
          ...(extra.container ? { container: extra.container } : {}),
          ...(extra.signature ? { signature: extra.signature } : {}),
          ...(docOf(rangeNode, sf) ? { doc: docOf(rangeNode, sf) } : {}),
          hash: hash16(rangeNode.getText(sf)),
          ...(Object.keys(attrs).length ? { attrs } : {}),
        };
        symbols.set(id, sym);
        declIds.set(keyOf(keyNode), id);
        return id;
      };

      const fnKind = (fn: ts.SignatureDeclaration, base: SymbolKind): SymbolKind => (base === 'function' && returnsJsx(fn) ? 'ui-component' : base);
      const fnAttrs = (fn: ts.SignatureDeclaration, keyNode: ts.Node) => {
        const a: Record<string, string | number | boolean | string[]> = {};
        const mods = [...new Set([...modifiersOf(keyNode), ...modifiersOf(fn)])];
        if (mods.length) a.modifiers = mods;
        const params = fn.parameters.map((x) => propName(x.name) ?? x.name.getText());
        if (params.length) a.params = params;
        return a;
      };

      /** Indexes a function's locals and returned object-literal methods, recursively. */
      const scanBody = (fn: ts.Node, q: string, container: string) => {
        const body = (fn as ts.FunctionLikeDeclaration).body;
        if (!body) return;
        const visit = (n: ts.Node) => {
          if (ts.isFunctionDeclaration(n) && n.name && n.body) {
            const id = add(n, n, `${q}.${n.name.text}`, fnKind(n, 'function'), { container, signature: fnSig(n.name.text, n), attrs: fnAttrs(n, n) });
            scanBody(n, symbols.get(id)!.id.split('#')[1], id);
            return;
          }
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && FUNCTION_INIT(unwrap(n.initializer))) {
            const f = unwrap(n.initializer) as ts.ArrowFunction;
            const id = add(n, ts.isVariableDeclarationList(n.parent) && n.parent.declarations.length === 1 ? n.parent.parent : n, `${q}.${n.name.text}`, fnKind(f, 'function'), { container, signature: fnSig(n.name.text, f), attrs: fnAttrs(f, n) });
            scanBody(f, id.split('#')[1], id);
            return;
          }
          if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(unwrap(n.expression))) {
            objectMembers(unwrap(n.expression) as ts.ObjectLiteralExpression, q, container, false);
            return;
          }
          if (ts.isClassLike(n)) return;
          ts.forEachChild(n, visit);
        };
        if (!ts.isBlock(body)) {
          const e = unwrap(body);
          if (ts.isObjectLiteralExpression(e)) { objectMembers(e, q, container, false); return; }
        }
        ts.forEachChild(body, visit);
      };

      /** Function-valued members of an object literal: `HANDLERS.load_system`, `createCanvasHub.execute`. */
      const objectMembers = (obj: ts.ObjectLiteralExpression, q: string, container: string, exported: boolean, depth = 0) => {
        for (const m of obj.properties) {
          // Nested namespaces of functions (`api.canvas.execute`) keep their path; no symbol for the namespace itself.
          if (ts.isPropertyAssignment(m) && ts.isObjectLiteralExpression(unwrap(m.initializer)) && depth < 3) {
            const name = propName(m.name);
            if (name) objectMembers(unwrap(m.initializer) as ts.ObjectLiteralExpression, `${q}.${name}`, container, exported, depth + 1);
            continue;
          }
          const name = propName(m.name);
          if (!name) continue;
          if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
            const id = add(m, m, `${q}.${name}`, 'method', { container, exported, signature: fnSig(name, m), attrs: fnAttrs(m, m), merge: !ts.isMethodDeclaration(m) });
            scanBody(m, id.split('#')[1], id);
          } else if (ts.isPropertyAssignment(m) && FUNCTION_INIT(unwrap(m.initializer))) {
            const f = unwrap(m.initializer) as ts.ArrowFunction;
            const id = add(m, m, `${q}.${name}`, 'method', { container, exported, signature: fnSig(name, f), attrs: fnAttrs(f, m) });
            scanBody(f, id.split('#')[1], id);
          }
        }
      };

      const initAttrs = (init: ts.Expression | undefined): Record<string, string | number | boolean | string[]> => {
        const a: Record<string, string | number | boolean | string[]> = {};
        if (!init) return a;
        const e = unwrap(init);
        if (isStringLit(e)) a.value = e.text;
        else if (ts.isNumericLiteral(e)) a.value = Number(e.text);
        else if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) a.value = -Number(e.operand.text);
        else if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) a.value = e.kind === ts.SyntaxKind.TrueKeyword;
        else if (ts.isObjectLiteralExpression(e)) {
          const keys: string[] = [], values: string[] = [];
          for (const m of e.properties) {
            const k = ts.isShorthandPropertyAssignment(m) ? m.name.text : propName(m.name);
            if (!k) continue;
            keys.push(k);
            values.push(ts.isPropertyAssignment(m) && isStringLit(unwrap(m.initializer)) ? (unwrap(m.initializer) as ts.StringLiteral).text : '');
          }
          if (keys.length) a.keys = keys;
          if (values.some(Boolean)) a.values = values;
        } else if (ts.isArrayLiteralExpression(e)) {
          const els = e.elements.map(unwrap);
          if (els.length && els.every(isStringLit)) a.values = els.map((x) => (x as ts.StringLiteral).text);
          else if (els.length && els.every(ts.isObjectLiteralExpression)) {
            const items: string[] = [], ids: string[] = [];
            for (const o of els as ts.ObjectLiteralExpression[]) {
              const item: Record<string, string | number> = {};
              for (const m of o.properties) {
                if (!ts.isPropertyAssignment(m)) continue;
                const k = propName(m.name), v = unwrap(m.initializer);
                if (!k) continue;
                if (isStringLit(v)) item[k] = v.text;
                else if (ts.isNumericLiteral(v)) item[k] = Number(v.text);
              }
              items.push(JSON.stringify(item));
              if (typeof item.id === 'string') ids.push(item.id);
            }
            a.items = items;
            if (ids.length) a.ids = ids;
          }
        }
        return a;
      };

      const memberSig = (m: ts.TypeElement | ts.ClassElement | ts.ParameterDeclaration, name: string) => {
        const mods = modifiersOf(m).filter((x) => x !== 'public');
        const opt = (m as ts.PropertySignature).questionToken ? '?' : '';
        const type = (m as ts.PropertySignature).type;
        let t = type ? oneLine(type.getText(), 160) : '';
        const init = (m as ts.PropertyDeclaration).initializer;
        if (!t) t = typeText(m.name ?? m);
        void init;
        return oneLine(`${mods.length ? mods.join(' ') + ' ' : ''}${name}${opt}${t ? `: ${t}` : ''}`);
      };

      const typeMembers = (members: ts.NodeArray<ts.TypeElement>, q: string, container: string, exported: boolean) => {
        for (const m of members) {
          const name = propName(m.name);
          if (!name) continue;
          if (ts.isMethodSignature(m)) {
            add(m, m, `${q}.${name}`, 'method', { container, exported, signature: fnSig(name, m), attrs: { ...fnAttrs(m, m), ...(m.questionToken ? { optional: true } : {}) }, merge: true });
          } else if (ts.isPropertySignature(m)) {
            const members = literalUnion(m.type);
            add(m, m, `${q}.${name}`, 'property', { container, exported, signature: memberSig(m, name), attrs: { ...(members ? { members } : {}), ...(m.questionToken ? { optional: true } : {}), ...(modifiersOf(m).length ? { modifiers: modifiersOf(m) } : {}) }, merge: true });
          }
        }
      };

      const classDecl = (c: ts.ClassDeclaration, name: string, exported: boolean) => {
        const heritage = (k: ts.SyntaxKind) => c.heritageClauses?.filter((h) => h.token === k).flatMap((h) => h.types.map((t) => oneLine(t.getText(), 120))) ?? [];
        const ext = heritage(ts.SyntaxKind.ExtendsKeyword), impl = heritage(ts.SyntaxKind.ImplementsKeyword);
        const tp = c.typeParameters?.length ? `<${c.typeParameters.map((t) => t.getText()).join(', ')}>` : '';
        const id = add(c, c, name, 'class', {
          exported, signature: oneLine(`class ${name}${tp}${ext.length ? ` extends ${ext.join(', ')}` : ''}${impl.length ? ` implements ${impl.join(', ')}` : ''}`),
          attrs: { ...(ext.length ? { extends: ext } : {}), ...(impl.length ? { implements: impl } : {}), ...(modifiersOf(c).length ? { modifiers: modifiersOf(c) } : {}), keys: c.members.map((m) => propName(m.name)).filter((x): x is string => !!x) },
        });
        for (const m of c.members) {
          if (ts.isConstructorDeclaration(m)) {
            const cid = add(m, m, `${name}.constructor`, 'method', { container: id, exported, signature: fnSig('constructor', m), attrs: fnAttrs(m, m), merge: true });
            for (const prm of m.parameters) {
              // Parameter properties (`readonly transport: CanvasTransport`) are fields of the class.
              if (!ts.isIdentifier(prm.name) || !modifiersOf(prm).some((x) => ['private', 'protected', 'public', 'readonly'].includes(x))) continue;
              add(prm, prm, `${name}.${prm.name.text}`, 'property', { container: id, exported, signature: memberSig(prm, prm.name.text), attrs: { modifiers: modifiersOf(prm), parameterProperty: true } });
            }
            scanBody(m, cid.split('#')[1], cid);
            continue;
          }
          const mname = m.name && (ts.isPrivateIdentifier(m.name) ? `#${m.name.text}` : propName(m.name));
          if (!mname) continue;
          if (ts.isMethodDeclaration(m)) {
            const mid = add(m, m, `${name}.${mname}`, 'method', { container: id, exported, signature: fnSig(mname, m), attrs: fnAttrs(m, m), merge: true });
            scanBody(m, mid.split('#')[1], mid);
          } else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
            const mid = add(m, m, `${name}.${mname}`, 'property', { container: id, exported, signature: memberSig(m as unknown as ts.PropertyDeclaration, mname), attrs: { modifiers: [...modifiersOf(m), ts.isGetAccessorDeclaration(m) ? 'get' : 'set'] }, merge: true });
            scanBody(m, mid.split('#')[1], mid);
          } else if (ts.isPropertyDeclaration(m)) {
            const f = m.initializer && FUNCTION_INIT(unwrap(m.initializer)) ? (unwrap(m.initializer) as ts.ArrowFunction) : undefined;
            if (f) {
              const mid = add(m, m, `${name}.${mname}`, 'method', { container: id, exported, signature: fnSig(mname, f), attrs: { ...fnAttrs(f, m), field: true } });
              scanBody(f, mid.split('#')[1], mid);
            } else {
              const members = literalUnion(m.type);
              add(m, m, `${name}.${mname}`, 'property', { container: id, exported, signature: memberSig(m, mname), attrs: { ...initAttrs(m.initializer), ...(members ? { members } : {}), ...(modifiersOf(m).length ? { modifiers: modifiersOf(m) } : {}) } });
            }
          }
        }
      };

      for (const st of sf.statements) {
        const exported = hasExport(st);
        if (ts.isFunctionDeclaration(st)) {
          const name = st.name?.text ?? 'default';
          const id = add(st, st, name, fnKind(st, 'function'), { exported: exported || exportedNames.has(name), signature: fnSig(name, st), attrs: fnAttrs(st, st), merge: true });
          scanBody(st, name, id);
        } else if (ts.isClassDeclaration(st)) {
          const name = st.name?.text ?? 'default';
          classDecl(st, name, exported || exportedNames.has(name));
        } else if (ts.isInterfaceDeclaration(st)) {
          const name = st.name.text;
          const ex = exported || exportedNames.has(name);
          const ext = st.heritageClauses?.flatMap((h) => h.types.map((t) => oneLine(t.getText(), 120))) ?? [];
          const tp = st.typeParameters?.length ? `<${st.typeParameters.map((t) => t.getText()).join(', ')}>` : '';
          const keys = st.members.map((m) => propName(m.name)).filter((x): x is string => !!x);
          const id = add(st, st, name, 'interface', { exported: ex, signature: oneLine(`interface ${name}${tp}${ext.length ? ` extends ${ext.join(', ')}` : ''}`), attrs: { ...(keys.length ? { keys } : {}), ...(ext.length ? { extends: ext } : {}) }, merge: true });
          if (symbols.get(id) && keys.length) {
            const prev = (symbols.get(id)!.attrs?.keys as string[] | undefined) ?? [];
            symbols.get(id)!.attrs = { ...symbols.get(id)!.attrs, keys: [...new Set([...prev, ...keys])] };
          }
          typeMembers(st.members, name, id, ex);
        } else if (ts.isTypeAliasDeclaration(st)) {
          const name = st.name.text;
          const ex = exported || exportedNames.has(name);
          const members = literalUnion(st.type);
          const lit = ts.isTypeLiteralNode(st.type) ? st.type : undefined;
          const keys = lit ? lit.members.map((m) => propName(m.name)).filter((x): x is string => !!x) : [];
          const tp = st.typeParameters?.length ? `<${st.typeParameters.map((t) => t.getText()).join(', ')}>` : '';
          const id = add(st, st, name, 'type', { exported: ex, signature: oneLine(`type ${name}${tp} = ${st.type.getText()}`), attrs: { ...(members ? { members } : {}), ...(keys.length ? { keys } : {}) } });
          if (lit) typeMembers(lit.members, name, id, ex);
        } else if (ts.isEnumDeclaration(st)) {
          const name = st.name.text;
          add(st, st, name, 'enum', { exported: exported || exportedNames.has(name), signature: `enum ${name}`, attrs: { members: st.members.map((m) => propName(m.name) ?? m.name.getText()) }, merge: true });
        } else if (ts.isVariableStatement(st)) {
          const declKind = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : st.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
          for (const d of st.declarationList.declarations) {
            if (!ts.isIdentifier(d.name)) continue;
            const name = d.name.text;
            const ex = exported || exportedNames.has(name);
            const rangeNode = st.declarationList.declarations.length === 1 ? st : d;
            const init = d.initializer && unwrap(d.initializer);
            if (init && FUNCTION_INIT(init)) {
              const id = add(d, rangeNode, name, fnKind(init, 'function'), { exported: ex, signature: fnSig(name, init), attrs: { ...fnAttrs(init, st), declKind } });
              scanBody(init, name, id);
            } else {
              const t = d.type ? oneLine(d.type.getText(), 160) : (init && (isStringLit(init) || ts.isNumericLiteral(init)) ? '' : typeText(d.name));
              const sig = d.type || t ? `${name}: ${t}` : `${name} = ${oneLine(d.initializer!.getText(), 120)}`;
              const id = add(d, rangeNode, name, 'variable', { exported: ex, signature: oneLine(sig), attrs: { declKind, ...initAttrs(d.initializer) } });
              if (init && ts.isObjectLiteralExpression(init)) objectMembers(init, name, id, ex);
            }
          }
        }
      }
    }
  }

  timing('declarations');
  /* ---------- Pass 2: uses ---------- */
  const seenRef = new Set<string>();
  const testNames = new Map<string, number>();

  for (const p of progs) {
    const checker = p.checker;
    const resolveSym = (s: ts.Symbol | undefined): string | undefined => {
      if (!s) return undefined;
      if (s.flags & ts.SymbolFlags.Alias) {
        try { s = checker.getAliasedSymbol(s); } catch { return undefined; }
      }
      for (const d of s.declarations ?? []) {
        const id = idOfDecl(d);
        if (id) return id;
      }
      return undefined;
    };
    const symAt = (n: ts.Node) => { try { return checker.getSymbolAtLocation(n); } catch { return undefined; } };
    const calleeSymbol = (e: ts.Expression): string | undefined => {
      e = unwrap(e);
      if (ts.isPropertyAccessExpression(e)) return resolveSym(symAt(e.name));
      if (ts.isElementAccessExpression(e)) return isStringLit(e.argumentExpression) ? resolveSym(symAt(e.argumentExpression)) : undefined;
      if (ts.isIdentifier(e)) return resolveSym(symAt(e));
      return undefined;
    };

    for (const sf of p.owned) {
      const file = rel(sf.fileName);
      if (skipped.has(file) || overTime()) { skipped.add(file); continue; }
      const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes('__tests__/');
      const fileId = `${file}#`;
      const containers: string[] = [];
      interface Ctx { kind: CallFlow['steps'][number]['ctx'][number]; guard?: string }
      interface Frame { id: string; ctx: Ctx[]; steps: CallFlow['steps'] }
      const frames: Frame[] = [{ id: '', ctx: [], steps: [] }];
      const ownedFns = new Set<ts.Node>();
      const describe: string[] = [];
      const from = () => containers[containers.length - 1] ?? fileId;
      const frame = () => frames[frames.length - 1];
      const txt = (n: ts.Node, max = 120) => oneLine(n.getText(sf), max);
      const withCtx = (kind: Ctx['kind'], guard: string | undefined, f: () => void) => { frame().ctx.push({ kind, guard }); f(); frame().ctx.pop(); };
      const uiAttr = (key: 'events' | 'elements', v: string) => {
        for (let i = containers.length - 1; i >= 0; i--) {
          const s = symbols.get(containers[i]);
          if (s?.kind === 'ui-component') {
            const cur = (s.attrs?.[key] as string[] | undefined) ?? [];
            if (!cur.includes(v)) s.attrs = { ...s.attrs, [key]: [...cur, v].sort() };
            return;
          }
        }
      };

      const addRef = (fromId: string, to: string, kind: ReferenceKind, n: ts.Node) => {
        if (kind === 'read' || kind === 'type') {
          if (to === fromId) return;
          const k = `${fromId}|${to}|${kind}`;
          if (seenRef.has(k)) return;
          seenRef.add(k);
        }
        out.references.push({ from: fromId, to, kind, range: rangeOf(n, sf) });
      };

      const refKind = (id: ts.Identifier | ts.PrivateIdentifier): { kind: ReferenceKind; node: ts.Node } | null => {
        let n: ts.Node = id;
        while (n.parent && ((ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) || ts.isQualifiedName(n.parent))) n = n.parent;
        const par = n.parent;
        if (!par) return { kind: 'read', node: id };
        if (ts.isExpressionWithTypeArguments(par) && ts.isHeritageClause(par.parent)) {
          return { kind: par.parent.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends', node: par };
        }
        if (ts.isTypeReferenceNode(par) || ts.isTypeQueryNode(par) || ts.isImportTypeNode(par) || ts.isExpressionWithTypeArguments(par)) return { kind: 'type', node: id };
        if ((ts.isJsxOpeningElement(par) || ts.isJsxSelfClosingElement(par)) && par.tagName === n) return { kind: 'jsx', node: id };
        if (ts.isJsxClosingElement(par)) return null;
        if ((ts.isCallExpression(par) || ts.isDecorator(par)) && par.expression === n) return { kind: 'call', node: id };
        if (ts.isTaggedTemplateExpression(par) && par.tag === n) return { kind: 'call', node: id };
        if (ts.isNewExpression(par) && par.expression === n) return { kind: 'new', node: id };
        if (ts.isBinaryExpression(par) && par.left === n && par.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && par.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return { kind: 'write', node: id };
        if ((ts.isPrefixUnaryExpression(par) || ts.isPostfixUnaryExpression(par)) && (par.operator === ts.SyntaxKind.PlusPlusToken || par.operator === ts.SyntaxKind.MinusMinusToken)) return { kind: 'write', node: id };
        if (ts.isDeleteExpression(par)) return { kind: 'write', node: id };
        return { kind: 'read', node: id };
      };

      const isDeclName = (id: ts.Node) => {
        const par = id.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
        if (!par) return false;
        if (ts.isPropertyAccessExpression(par) || ts.isMetaProperty(par) || ts.isShorthandPropertyAssignment(par)) return false;
        if (ts.isJsxAttribute(par)) return true;
        if (ts.isBindingElement(par) && par.propertyName === id) return true;
        if (ts.isLabeledStatement(par) || ts.isBreakOrContinueStatement(par)) return true;
        return par.name === id;
      };

      const recordImport = (spec: ts.Expression, names: string[], typeOnly: boolean, node: ts.Node) => {
        if (!isStringLit(spec)) return;
        let to: string | null = null;
        try {
          const mode = ts.getModeForUsageLocation(sf, spec as ts.StringLiteralLike, p.options);
          const r = ts.resolveModuleName(spec.text, sf.fileName, p.options, p.host, p.cache, undefined, mode).resolvedModule;
          if (r && !r.isExternalLibraryImport) {
            const rr = rel(r.resolvedFileName);
            if (listed.has(rr)) to = rr;
          }
        } catch { /* unresolved */ }
        if (to === null && spec.text.startsWith('.')) {
          // Imports of files the TS pass doesn't own (e.g. `./styles.css`), resolved by path.
          const guess = toPosix(relative(root, resolve(dirname(sf.fileName), spec.text)));
          if (existsSync(join(root, guess)) && !guess.startsWith('..')) to = guess;
        }
        out.imports.push({ from: file, to, specifier: spec.text, names: [...names].sort(), typeOnly, range: rangeOf(node, sf) });
      };

      const comparisonBranch = (cmp: ts.BinaryExpression, negate: boolean): SourceRange | undefined => {
        let cur: ts.Node = cmp;
        let andRight: ts.Node | undefined;
        for (;;) {
          const par: ts.Node = cur.parent;
          if (ts.isParenthesizedExpression(par)) { cur = par; continue; }
          if (ts.isBinaryExpression(par) && (par.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || par.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
            if (par.operatorToken.kind === ts.SyntaxKind.BarBarToken && negate) return undefined;
            if (!andRight && par.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && par.left === cur) andRight = par.right;
            cur = par;
            continue;
          }
          if (ts.isIfStatement(par) && par.expression === cur) {
            const b = negate ? par.elseStatement : par.thenStatement;
            return b ? rangeOf(b, sf) : undefined;
          }
          if (ts.isConditionalExpression(par) && par.condition === cur) return rangeOf(negate ? par.whenFalse : par.whenTrue, sf);
          if ((ts.isWhileStatement(par) || ts.isDoStatement(par)) && par.expression === cur && !negate) return rangeOf(par.statement, sf);
          return andRight && !negate ? rangeOf(andRight, sf) : undefined;
        }
      };

      const skipStep = (callee: string, sym: string | undefined) => {
        if (sym) return false;
        const rootName = callee.split(/[.(]/)[0];
        if (TRIVIAL_ROOTS.has(rootName)) return true;
        if (callee.startsWith('new ') && BUILTIN_CTORS.has(callee.slice(4))) return true;
        const last = callee.slice(callee.lastIndexOf('.') + 1);
        return callee.includes('.') && HELPER_METHODS.has(last) || callee === 'Promise.resolve' || callee === 'Promise.reject';
      };

      const step = (call: ts.CallExpression | ts.NewExpression, callee: string, sym: string | undefined) => {
        const f = frame();
        if (!f.id || skipStep(callee, sym)) return;
        const ctx = f.ctx.map((c) => c.kind);
        let par = call.parent;
        while (ts.isParenthesizedExpression(par)) par = par.parent;
        if (ts.isAwaitExpression(par)) ctx.push('await');
        let guard: string | undefined;
        for (let i = f.ctx.length - 1; i >= 0; i--) {
          const c = f.ctx[i];
          if (c.kind === 'branch' || c.kind === 'loop') { guard = c.guard; break; }
          if (c.kind !== 'await') break;
        }
        f.steps.push({ callee, ...(sym ? { calleeSymbol: sym } : {}), range: rangeOf(call, sf), ctx, ...(guard ? { guard } : {}) });
      };

      const enter = (id: string, fn: ts.Node | undefined, f: () => void) => {
        containers.push(id);
        if (fn) { ownedFns.add(fn); frames.push({ id, ctx: [], steps: [] }); }
        f();
        if (fn) {
          const fr = frames.pop()!;
          if (fr.steps.length) {
            const existing = out.flows.find((x) => x.symbol === id);
            if (existing) existing.steps.push(...fr.steps);
            else out.flows.push({ symbol: id, steps: fr.steps });
          }
        }
        containers.pop();
      };

      const visitCall = (n: ts.CallExpression | ts.NewExpression) => {
        const calleeExpr = n.expression;
        const args = n.arguments ?? ts.factory.createNodeArray<ts.Expression>();
        // Test cases: `test('name', () => …)`, nested in `describe`.
        if (isTest && ts.isCallExpression(n) && args.length >= 2 && isStringLit(args[0]) && /^(test|it|describe|suite)$/.test(lastName(calleeExpr))) {
          const fnArg = args.find((a) => FUNCTION_INIT(a));
          if (fnArg) {
            visit(calleeExpr);
            const isDescribe = /^(describe|suite)$/.test(lastName(calleeExpr));
            const label = [...describe, args[0].text].join(' > ');
            let id = `${file}#test:${label}`;
            const k = (testNames.get(id) ?? 0) + 1;
            testNames.set(id, k);
            if (k > 1) id = `${id}~${k}`;
            if (!isDescribe) {
              symbols.set(id, { id, name: label, kind: 'test-case', file, range: rangeOf(n, sf), exported: false, ...(containers.length ? { container: from() } : {}), hash: hash16(n.getText(sf)) });
              enter(id, fnArg, () => ts.forEachChild(fnArg, visit));
            } else {
              describe.push(args[0].text);
              ownedFns.add(fnArg);
              ts.forEachChild(fnArg, visit);
              describe.pop();
            }
            for (const a of args) if (a !== fnArg) visit(a);
            return;
          }
        }
        // Dynamic import and require are imports.
        if (ts.isCallExpression(n) && args.length && isStringLit(args[0]) && (calleeExpr.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(calleeExpr) && calleeExpr.text === 'require'))) {
          recordImport(args[0], [], false, n);
        }
        visit(calleeExpr);
        const callee = ts.isNewExpression(n) ? `new ${normalizeCallee(calleeExpr)}` : normalizeCallee(calleeExpr);
        const sym = calleeSymbol(calleeExpr);
        const method = lastName(calleeExpr);
        const fnArgs: ts.Expression[] = [];
        args.forEach((a, i) => {
          if (isStringLit(a) && !callee.startsWith('console.')) {
            out.literals.push({ in: from(), file, range: rangeOf(a, sf), callee, method, ...(sym ? { calleeSymbol: sym } : {}), literal: a.text, argIndex: i });
          }
          if (FUNCTION_INIT(unwrap(a))) fnArgs.push(a); else visit(a);
        });
        step(n, callee, sym);
        for (const a of fnArgs) visit(a);
      };

      const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n)) {
          const c = n.importClause;
          const names: string[] = [];
          let allType = !!c?.isTypeOnly;
          if (c?.name) names.push('default');
          if (c?.namedBindings) {
            if (ts.isNamespaceImport(c.namedBindings)) names.push(`* as ${c.namedBindings.name.text}`);
            else {
              const els = c.namedBindings.elements;
              for (const el of els) names.push((el.propertyName ?? el.name).text);
              if (!c.isTypeOnly) allType = els.length > 0 && !c.name && els.every((el) => el.isTypeOnly);
            }
          }
          recordImport(n.moduleSpecifier, names, allType, n);
          return;
        }
        if (ts.isExportDeclaration(n)) {
          if (n.moduleSpecifier) {
            const names = n.exportClause ? (ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : [`* as ${n.exportClause.name.getText(sf)}`]) : ['*'];
            recordImport(n.moduleSpecifier, names, n.isTypeOnly, n);
          } else if (n.exportClause && ts.isNamedExports(n.exportClause)) {
            for (const el of n.exportClause.elements) {
              const to = resolveSym(checker.getExportSpecifierLocalTargetSymbol(el));
              if (to) addRef(fileId, to, 'read', el);
            }
          }
          return;
        }
        if (ts.isImportEqualsDeclaration(n)) {
          if (ts.isExternalModuleReference(n.moduleReference)) recordImport(n.moduleReference.expression, [n.name.text], n.isTypeOnly, n);
          return;
        }

        const myId = declIds.get(`${file}:${n.pos}:${n.end}`);
        if (myId && !ts.isParameter(n)) {
          const fn = ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body ? n
            : (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.initializer && FUNCTION_INIT(unwrap(n.initializer)) ? unwrap(n.initializer) : undefined;
          enter(myId, fn, () => ts.forEachChild(n, visit));
          return;
        }

        if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
          if (isDeclName(n)) {
            if (ts.isJsxAttribute(n.parent) && /^on[A-Z]/.test(n.text)) uiAttr('events', n.text);
            return;
          }
          const s = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : symAt(n);
          const to = resolveSym(s);
          if (!to) return;
          const k = refKind(n);
          if (k) addRef(from(), to, k.kind, k.node);
          return;
        }
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && /^[a-z]/.test(n.tagName.text)) uiAttr('elements', n.tagName.text);

        if (ts.isCallExpression(n) || ts.isNewExpression(n)) { visitCall(n); return; }

        if (ts.isFunctionLike(n) && !ownedFns.has(n) && (n as ts.FunctionLikeDeclaration).body) {
          withCtx('callback', undefined, () => ts.forEachChild(n, visit));
          return;
        }

        if (ts.isBinaryExpression(n)) {
          const op = n.operatorToken.kind;
          if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
            const [lit, subj] = isStringLit(n.right) ? [n.right, n.left] : isStringLit(n.left) ? [n.left, n.right] : [null, null];
            if (lit && subj) {
              const negate = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
              const branch = comparisonBranch(n, negate);
              out.comparisons.push({ in: from(), file, range: rangeOf(n, sf), subject: normalizeCallee(subj), literal: lit.text, ...(branch ? { branch } : {}) });
            }
          }
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
            visit(n.left);
            const g = txt(n.left);
            withCtx('branch', op === ts.SyntaxKind.AmpersandAmpersandToken ? g : op === ts.SyntaxKind.BarBarToken ? `!(${g})` : `${g} == null`, () => visit(n.right));
            return;
          }
        }
        if (ts.isIfStatement(n)) {
          visit(n.expression);
          const g = txt(n.expression);
          withCtx('branch', g, () => visit(n.thenStatement));
          if (n.elseStatement) withCtx('branch', `!(${g})`, () => visit(n.elseStatement!));
          return;
        }
        if (ts.isConditionalExpression(n)) {
          visit(n.condition);
          const g = txt(n.condition);
          withCtx('branch', g, () => visit(n.whenTrue));
          withCtx('branch', `!(${g})`, () => visit(n.whenFalse));
          return;
        }
        if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
          visit(n.initializer); visit(n.expression);
          withCtx('loop', `for (${txt(n.initializer, 60)} ${ts.isForOfStatement(n) ? 'of' : 'in'} ${txt(n.expression, 60)})`, () => visit(n.statement));
          return;
        }
        if (ts.isForStatement(n)) {
          if (n.initializer) visit(n.initializer);
          withCtx('loop', `for (${n.initializer ? txt(n.initializer, 40) : ''}; ${n.condition ? txt(n.condition, 40) : ''}; ${n.incrementor ? txt(n.incrementor, 40) : ''})`, () => {
            if (n.condition) visit(n.condition);
            visit(n.statement);
            if (n.incrementor) visit(n.incrementor);
          });
          return;
        }
        if (ts.isWhileStatement(n) || ts.isDoStatement(n)) {
          withCtx('loop', ts.isWhileStatement(n) ? `while (${txt(n.expression)})` : `do … while (${txt(n.expression)})`, () => { visit(n.expression); visit(n.statement); });
          return;
        }
        if (ts.isSwitchStatement(n)) {
          visit(n.expression);
          const subject = normalizeCallee(n.expression);
          for (const clause of n.caseBlock.clauses) {
            let guard = 'default';
            if (ts.isCaseClause(clause)) {
              visit(clause.expression);
              guard = `${txt(n.expression, 60)} === ${txt(clause.expression, 60)}`;
              if (isStringLit(clause.expression)) {
                const sts = clause.statements;
                const branch = sts.length ? { ...rangeOf(sts[0], sf), end: rangeOf(sts[sts.length - 1], sf).end } : rangeOf(clause, sf);
                out.comparisons.push({ in: from(), file, range: rangeOf(clause.expression, sf), subject, literal: clause.expression.text, branch });
              }
            }
            withCtx('branch', guard, () => clause.statements.forEach(visit));
          }
          return;
        }
        if (ts.isTryStatement(n)) {
          withCtx('try', undefined, () => visit(n.tryBlock));
          if (n.catchClause) withCtx('catch', undefined, () => visit(n.catchClause!));
          if (n.finallyBlock) visit(n.finallyBlock);
          return;
        }
        ts.forEachChild(n, visit);
      };

      ts.forEachChild(sf, visit);
    }
  }
  timing('uses');

  if (opts.diagnostics) {
    const d = countDiagnostics(progs, rel, opts.deadline, skipped);
    out.diagnostics = d.counts;
    if (!d.complete) { out.limits.push(DIAGNOSTICS_CUT); out.incomplete = true; }
    timing('diagnostics');
  }

  for (const f of owner) {
    if (out.files.has(f)) continue;
    out.files.set(f, skipped.has(f) ? { status: 'skipped', note: 'time limit reached before this file was read' } : { status: 'indexed' });
  }
  if (skipped.size) { out.incomplete = true; out.limits.push(`time limit reached: ${skipped.size} TypeScript/JavaScript files were not (fully) read`); }
  // Facts from a file the second walk skipped would be half-read: drop them.
  out.symbols = [...symbols.values()].filter((s) => !skipped.has(s.file));
  for (const s of out.symbols) if (s.attrs && 'hasBody' in s.attrs) {
    const { hasBody: _h, ...rest } = s.attrs;
    s.attrs = Object.keys(rest).length ? rest : undefined;
    if (!s.attrs) delete s.attrs;
  }
  return out;
}
