import {
  INDEX_SCHEMA,
  type CallFlow, type ComparisonSite, type IndexedFile, type IndexImport, type IndexReference, type IndexSymbol, type LiteralSite,
  type ReferenceKind, type RepoIndex, type SourceRange, type SymbolKind,
} from '../../shared/system/model.js';

// Small hand-made indexes for the registry's tests, in the indexer's shapes (ids `file#Qualified.name`,
// members with `container`, flows with ctx/guard). `boardIndex()` is a miniature app built like a real
// one — a drawing surface, a client over a transport, a preload bridge, IPC handlers, a hub, a store
// adapter, an engine with a dispatch table, SQL — so each rule can be checked without any real repository.

export const r = (file: string, line: number, endLine = line, col = 1, endCol = 80): SourceRange => ({ file, start: { line, col }, end: { line: endLine, col: endCol } });

export class IndexKit {
  files: IndexedFile[] = [];
  symbols: IndexSymbol[] = [];
  imports: IndexImport[] = [];
  references: IndexReference[] = [];
  literals: LiteralSite[] = [];
  comparisons: ComparisonSite[] = [];
  flows: CallFlow[] = [];

  file(path: string, extra: Partial<IndexedFile> = {}) {
    const lang = path.endsWith('.tsx') ? 'tsx' : path.endsWith('.sql') ? 'sql' : 'ts';
    this.files.push({ path, lang, hash: `h-${path.length}-${path.slice(-6)}`, size: 1000, lines: 100, status: 'indexed', ...(/\.test\./.test(path) ? { test: true } : {}), ...extra });
    return this;
  }
  sym(id: string, kind: SymbolKind, line: number, end = line, extra: Partial<IndexSymbol> = {}) {
    const [file, name] = id.split('#');
    const dot = name.lastIndexOf('.');
    this.symbols.push({
      id, name: dot >= 0 ? name.slice(dot + 1) : name, kind, file, range: r(file, line, end), exported: true, hash: `s-${id.length}-${name}`,
      ...(dot >= 0 ? { container: `${file}#${name.slice(0, dot)}` } : {}), ...extra,
    });
    return this;
  }
  ref(from: string, to: string, kind: ReferenceKind, line: number) {
    const file = from.split('#')[0];
    this.references.push({ from, to, kind, range: r(file, line, line, 5, 30) });
    return this;
  }
  lit(inSym: string, callee: string, literal: string, line: number, argIndex = 0, calleeSymbol?: string) {
    const file = inSym.split('#')[0];
    this.literals.push({ in: inSym, file, range: r(file, line, line, 10, 10 + literal.length), callee, method: callee.split('.').pop()!, literal, argIndex, ...(calleeSymbol ? { calleeSymbol } : {}) });
    return this;
  }
  cmp(inSym: string, subject: string, literal: string, line: number, branchEnd?: number) {
    const file = inSym.split('#')[0];
    this.comparisons.push({ in: inSym, file, range: r(file, line, line, 5, 25), subject, literal, ...(branchEnd ? { branch: r(file, line, branchEnd, 1, 120) } : {}) });
    return this;
  }
  flow(symbol: string, steps: { callee: string; calleeSymbol?: string; line: number; ctx?: CallFlow['steps'][number]['ctx']; guard?: string }[]) {
    const file = symbol.split('#')[0];
    this.flows.push({ symbol, steps: steps.map((s) => ({ callee: s.callee, ...(s.calleeSymbol ? { calleeSymbol: s.calleeSymbol } : {}), range: r(file, s.line, s.line, 3, 60), ctx: s.ctx ?? [], ...(s.guard ? { guard: s.guard } : {}) })) });
    return this;
  }
  imp(from: string, to: string, names: string[]) {
    this.imports.push({ from, to, specifier: `./${to}`, names, typeOnly: false, range: r(from, 1) });
    return this;
  }
  build(name = 'board-app'): RepoIndex {
    return {
      schema: INDEX_SCHEMA,
      revision: { repo: { id: name, name, root: `/tmp/${name}` }, head: 'abc123', branch: 'main', dirty: [], indexedAt: '2026-11-10T00:00:00.000Z', fingerprint: `fp-${name}` },
      tools: { typescript: 'test' }, files: this.files, symbols: this.symbols, imports: this.imports, references: this.references,
      literals: this.literals, comparisons: this.comparisons, flows: this.flows,
      coverage: { byLang: {}, limits: [], diagnostics: {} }, incomplete: false,
    };
  }
}

/** File paths of the miniature app; `rename` moves one (ids and ranges follow). */
export function boardIndex(opts: { rename?: Record<string, string>; status?: Record<string, IndexedFile['status']> } = {}): RepoIndex {
  const P = (p: string) => opts.rename?.[p] ?? p;
  const A = P('src/renderer/features/board/BoardView.tsx'), B = P('src/renderer/features/board/client.ts'), PRE = P('src/preload/index.ts');
  const I = P('src/main/ipc.ts'), M = P('src/main/board.ts'), S = P('src/integrations/db/board.ts'), G = P('src/shared/board/engine.ts');
  const T = P('src/shared/board/store.ts'), Q = P('db/schema.sql'), X = P('src/shared/board/engine.test.ts');
  const k = new IndexKit();
  for (const f of [A, B, PRE, I, M, S, G, T, Q, X]) k.file(f, opts.status?.[f] ? { status: opts.status[f] } : {});

  // The surface: a Mode union with a declared list, pointer handlers, branches that run commands.
  k.sym(`${A}#Mode`, 'type', 3, 3, { signature: "type Mode = 'pick' | 'sketch' | 'wipe'", attrs: { members: ['pick', 'sketch', 'wipe'] } })
    .sym(`${A}#MODES`, 'variable', 4, 8, { exported: false, attrs: { items: ['{"id":"pick","label":"Pick","title":"Pick · V"}', '{"id":"sketch","label":"Sketch","title":"Sketch · P"}', '{"id":"wipe","label":"Wipe","title":"Wipe · E"}'] } })
    .sym(`${A}#KEYS`, 'variable', 9, 9, { exported: false, attrs: { keys: ['v', 'p', 'e'], values: ['pick', 'sketch', 'wipe'] } })
    .sym(`${A}#BoardView`, 'ui-component', 10, 60, { attrs: { events: ['onPointerDown', 'onPointerUp', 'onKeyDown'], elements: ['svg', 'path', 'button'] } })
    .cmp(`${A}#BoardView`, 'mode', 'sketch', 20, 24).cmp(`${A}#BoardView`, 'mode', 'pick', 30, 31).cmp(`${A}#BoardView`, 'mode', 'wipe', 35, 37)
    .lit(`${A}#BoardView`, 'run', 'sketch_line', 22).lit(`${A}#BoardView`, 'run', 'erase_line', 36)
    .ref(`${A}#BoardView`, `${B}#BoardClient.run`, 'call', 22).ref(`${A}#BoardView`, `${B}#BoardClient.run`, 'call', 36)
    .imp(A, B, ['BoardClient']);

  // The client and its transport; an adapter implementing the transport through a window API.
  k.sym(`${B}#BoardTransport`, 'interface', 3, 8, { doc: 'Where a board is kept, and how this window hears about saves.' })
    .sym(`${B}#BoardTransport.send`, 'method', 4, 4, { signature: 'send(id: string, op: Op): Promise<Saved>' })
    .sym(`${B}#BoardTransport.load`, 'method', 5, 5, { signature: 'load(id: string): Promise<Saved>' })
    .sym(`${B}#BoardTransport.onSaved`, 'method', 6, 6, { signature: 'onSaved(id: string, fn: (s: Saved) => void): () => void' })
    .sym(`${B}#BoardClient`, 'class', 10, 40)
    .sym(`${B}#BoardClient.transport`, 'property', 12, 12, { signature: 'readonly transport: BoardTransport' })
    .sym(`${B}#BoardClient.pending`, 'property', 13, 13, { signature: 'private pending: Op[]' })
    .sym(`${B}#BoardClient.store`, 'property', 11, 11, { signature: 'readonly store: Store<BoardState>' })
    .sym(`${B}#BoardClient.constructor`, 'method', 14, 16)
    .sym(`${B}#BoardClient.run`, 'method', 18, 24, { signature: 'run(name: OpName, args: unknown): Promise<Result>', doc: 'Runs an op as you.' })
    .sym(`${B}#BoardClient.applySaved`, 'method', 26, 30)
    .ref(`${B}#BoardClient.transport`, `${B}#BoardTransport`, 'type', 12)
    .ref(`${B}#BoardClient.constructor`, `${B}#BoardTransport.onSaved`, 'call', 15).ref(`${B}#BoardClient.constructor`, `${B}#BoardClient.applySaved`, 'call', 15)
    .ref(`${B}#BoardClient.run`, `${B}#BoardClient.pending`, 'read', 19).ref(`${B}#BoardClient.run`, `${B}#BoardTransport.send`, 'call', 20)
    .ref(`${B}#BoardClient.run`, `${B}#BoardClient.applySaved`, 'call', 21)
    .flow(`${B}#BoardClient.run`, [{ callee: 'this.pending.push', line: 19 }, { callee: 'this.transport.send', calleeSymbol: `${B}#BoardTransport.send`, line: 20, ctx: ['try', 'await'] }, { callee: 'this.applySaved', calleeSymbol: `${B}#BoardClient.applySaved`, line: 21, ctx: ['try'] }])
    .sym(`${B}#bridgeTransport`, 'function', 45, 60, { signature: 'bridgeTransport(): BoardTransport' })
    .sym(`${B}#bridgeTransport.send`, 'method', 47, 49, { exported: false })
    .flow(`${B}#bridgeTransport.send`, [{ callee: 'w.board.send', line: 48, ctx: ['await'] }]);

  // The preload bridge, IPC handlers, the main-process service and the hub.
  k.sym(`${PRE}#api`, 'variable', 3, 10, { exported: false })
    .lit(`${PRE}#api`, 'ipcRenderer.invoke', 'board:send', 5).lit(`${PRE}#api`, 'ipcRenderer.invoke', 'board:load', 6)
    .sym(`${I}#register`, 'function', 1, 20)
    .lit(`${I}#register`, 'handle', 'board:send', 5).lit(`${I}#register`, 'handle', 'board:load', 6)
    .lit(`${I}#register`, 'hub.events.on', 'saved', 10)
    .ref(`${I}#register`, `${M}#sendAsUser`, 'call', 5).ref(`${I}#register`, `${M}#loadBoard`, 'call', 6)
    .imp(I, M, ['sendAsUser', 'loadBoard'])
    .sym(`${M}#sendAsUser`, 'function', 3, 6, { doc: 'A person\'s op from a window.' }).sym(`${M}#loadBoard`, 'function', 8, 9)
    .ref(`${M}#sendAsUser`, `${S}#createBoardHub.send`, 'call', 4)
    .flow(`${M}#sendAsUser`, [{ callee: 'hub.send', calleeSymbol: `${S}#createBoardHub.send`, line: 4, ctx: ['await'] }])
    .imp(M, S, ['createBoardHub', 'createBoardStore']);

  k.sym(`${S}#createBoardStore`, 'function', 3, 12, { signature: 'createBoardStore(db: Db): BoardStore' })
    .sym(`${S}#createBoardStore.load`, 'method', 4, 6, { exported: false })
    .sym(`${S}#createBoardStore.save`, 'method', 7, 10, { exported: false, signature: 'save(id, base, doc): Promise<number | null>' })
    .lit(`${S}#createBoardStore.load`, 'db.from', 'boards', 5).lit(`${S}#createBoardStore.save`, 'db.rpc', 'save_board', 8)
    .flow(`${S}#createBoardStore.save`, [{ callee: 'db.rpc', line: 8, ctx: ['await'] }])
    .sym(`${S}#createBoardHub`, 'function', 14, 30)
    .sym(`${S}#createBoardHub.send`, 'method', 16, 20, { exported: false })
    .ref(`${S}#createBoardHub.send`, `${T}#runOp`, 'call', 17)
    .flow(`${S}#createBoardHub.send`, [{ callee: 'runOp', calleeSymbol: `${T}#runOp`, line: 17, ctx: ['await'] }, { callee: 'events.emit', line: 19 }])
    .lit(`${S}#createBoardHub.send`, 'events.emit', 'saved', 19)
    .imp(S, T, ['runOp', 'BoardStore']);

  // The engine: a dispatch table keyed by OpArgs, a validator raising a typed error, the save loop.
  k.sym(`${G}#OpArgs`, 'interface', 3, 8, { attrs: { keys: ['sketch_line', 'erase_line', 'move'] } })
    .sym(`${G}#OpArgs.sketch_line`, 'property', 4, 4, { signature: 'sketch_line: { d: string }', doc: 'A stroke on the board.' })
    .sym(`${G}#OpArgs.erase_line`, 'property', 5, 5).sym(`${G}#OpArgs.move`, 'property', 6, 6)
    .sym(`${G}#OpName`, 'type', 9, 9, { signature: 'type OpName = keyof OpArgs' })
    .sym(`${G}#BoardError`, 'class', 10, 12)
    .sym(`${G}#HANDLERS`, 'variable', 20, 40, { exported: false, signature: 'HANDLERS: { [K in OpName]: Handler<K> }', attrs: { keys: ['sketch_line', 'erase_line', 'move'] } })
    .sym(`${G}#HANDLERS.sketch_line`, 'function', 21, 25, { exported: false })
    .sym(`${G}#HANDLERS.erase_line`, 'function', 26, 30, { exported: false })
    .sym(`${G}#HANDLERS.move`, 'function', 31, 35, { exported: false })
    .sym(`${G}#applyOp`, 'function', 42, 50, { signature: 'applyOp(doc: Doc, op: Op): Doc' })
    .ref(`${G}#applyOp`, `${G}#HANDLERS`, 'read', 44)
    .sym(`${G}#parseOp`, 'function', 52, 60, { signature: 'parseOp(raw: unknown): Op' })
    .ref(`${G}#parseOp`, `${G}#BoardError`, 'new', 55)
    .sym(`${T}#BoardStore`, 'interface', 3, 6)
    .sym(`${T}#BoardStore.load`, 'method', 4, 4, { signature: 'load(id: string): Promise<Saved>' })
    .sym(`${T}#BoardStore.save`, 'method', 5, 5, { signature: 'save(id: string, base: number, doc: Doc): Promise<number | null>' })
    .sym(`${T}#MAX_TRIES`, 'variable', 8, 8, { signature: 'MAX_TRIES = 3', attrs: { value: 3 } })
    .sym(`${T}#runOp`, 'function', 10, 30, { signature: 'runOp(store: BoardStore, id: string, raw: unknown): Promise<Saved>' })
    .ref(`${T}#runOp`, `${G}#parseOp`, 'call', 11).ref(`${T}#runOp`, `${T}#BoardStore.load`, 'call', 13).ref(`${T}#runOp`, `${G}#applyOp`, 'call', 15)
    .ref(`${T}#runOp`, `${T}#BoardStore.save`, 'call', 16).ref(`${T}#runOp`, `${T}#BoardStore.load`, 'call', 19).ref(`${T}#runOp`, `${G}#BoardError`, 'new', 21)
    .flow(`${T}#runOp`, [
      { callee: 'parseOp', calleeSymbol: `${G}#parseOp`, line: 11, ctx: ['try'] },
      { callee: 'store.load', calleeSymbol: `${T}#BoardStore.load`, line: 13, ctx: ['await'] },
      { callee: 'applyOp', calleeSymbol: `${G}#applyOp`, line: 15, ctx: ['loop', 'try'] },
      { callee: 'store.save', calleeSymbol: `${T}#BoardStore.save`, line: 16, ctx: ['loop', 'await'], guard: 'for (let i = 0; i < MAX_TRIES; i++)' },
      { callee: 'store.load', calleeSymbol: `${T}#BoardStore.load`, line: 19, ctx: ['loop', 'await'], guard: 'for (let i = 0; i < MAX_TRIES; i++)' },
      { callee: 'new BoardError', calleeSymbol: `${G}#BoardError`, line: 21 },
    ])
    .imp(T, G, ['applyOp', 'parseOp']);

  // SQL: a table with a key column, and a function that writes it.
  k.sym(`${Q}#public.boards`, 'sql-table', 1, 5, { attrs: { primaryKey: ['id'] } })
    .sym(`${Q}#public.boards.id`, 'sql-column', 2, 2, { attrs: { type: 'uuid', primaryKey: true } })
    .sym(`${Q}#public.boards.doc`, 'sql-column', 3, 3, { attrs: { type: 'jsonb' } })
    .sym(`${Q}#public.save_board`, 'sql-function', 10, 20, { signature: 'save_board(id uuid, base bigint, doc jsonb) returns bigint' })
    .ref(`${Q}#public.save_board`, `${Q}#public.boards`, 'sql-write', 14);
  // SQL names are bare, as the indexer writes them; columns sit in their table.
  for (const s of k.symbols) if (s.file === Q) { s.name = s.id.split('.').pop()!; if (s.kind !== 'sql-column') delete s.container; }

  // A test that exercises the engine.
  k.sym(`${X}#test:engine > applies a stroke`, 'test-case', 5, 9, { exported: false })
    .ref(`${X}#test:engine > applies a stroke`, `${G}#applyOp`, 'call', 6).ref(`${X}#test:engine > applies a stroke`, `${G}#parseOp`, 'call', 7)
    .lit(`${X}#test:engine > applies a stroke`, 'op', 'sketch_line', 6);
  return k.build();
}
