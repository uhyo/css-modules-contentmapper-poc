# Notes

Where the task prompt / PR description and the actual code diverged, plus what a
production version would need. The authoritative wire structs live in
`internal/contentmapper/` (`hostimpl.go` in particular) and `internal/spanmap/spanmap.go`
at commit `d07c1fff6efd364533b7073dd87b39aaf03029c8`.

## Divergences: prompt/PR text vs. code (the code won)

1. **CLI flag**: not `--loadExternalPlugins` but **`--runExternalCode`**
   (`internal/tsoptions`, error TS100024). In the LSP it's
   `initializationOptions.runExternalCode: true`, intended to be gated on workspace trust.

2. **Manifest key**: not a top-level `tsContentMapper` field but
   **`"typescript": { "contentMapper": { ... } }`** in the mapper's `package.json`
   (`internal/tsoptions/contentmappers.go`). `exec` must be a non-empty string array;
   `compilerOptions` (names of compiler options forwarded to `transform`) and
   `dynamicConfig` are optional. The package.json **must** declare a `name`; `version` is
   folded into the mapper's identity (process sharing + cache keys). The mapper process's
   working directory is its package directory.

3. **TransformResult field names**: the virtual-syntax field is **`extension`**
   (`".ts"`, `".tsx"`, `".js"`, `".jsx"`, `".mts"`, `".cts"`, `".mjs"`, `".cjs"`, `".json"`),
   not `scriptKind`. Full result shape:
   `{ text, extension, mappings?, diagnosticDirectives?, diagnostics?, supplemental? }`.
   Absent/empty `mappings` is legal and means "fully synthesized output".

4. **No `SpanMapPurpose`**: the optional 6th tuple element is a bitwise **`Feature`
   mask** (Hover=1, SignatureHelp=2, Completion=4, Definition=8, … CodeLens=1<<19;
   omitted = All), not a Semantic/Navigation/All/None enum. Tuple layout
   `[virtualStart, virtualLength, originalStart, originalLength, kind, features?]` and
   kind values (Verbatim=0, Atom=1, Alias=2) match the description.

5. **Protocol details confirmed in code**: JSON-RPC 2.0 with LSP base-protocol framing
   (`Content-Length: N\r\n\r\n` + UTF-8 body) over stdio; parent-driven only (a request
   from the mapper is a protocol violation); methods `initialize`, `transform`, plus
   `openProject`/`closeProject` only if `dynamicConfig: true`. The initialize handshake
   has a **5-second timeout**. `diagnosticSource` must be non-empty and must not be
   `typescript`, `tsc`, or any native extension name (`ts`, `tsx`, `js`, …).

6. **Host-side validation is strict** (worth knowing before it bites):
   - Verbatim segments are checked character-for-character against both texts.
   - Segments must be ordered/disjoint in virtual space; original spans may be duplicated
     exactly but must not partially overlap.
   - Positions are validated against the negotiated encoding and must not split a Unicode
     code point (relevant for utf-16 surrogate pairs).
   - Failure accounting: 5 failed transforms in a project disable the mapper
     (TS100026 "failed {n} times and will not be used").

## The interesting lesson: quoted keys vs. the span map

The task suggested quoting every property key and mapping the text between the quotes as
`Verbatim`. That produces correct types and correct *diagnostic* positions, but
**go-to-definition degrades to (0,0)**: the definition target is the declaration's *name
node*, whose range includes the quotes. Language-service features require the whole name
span to sit inside a single segment (`Fidelity.IsSingleSegment`); `"button"` = gap +
verbatim + gap fails that test and the LSP falls back to a zero range.

This PoC therefore emits:
- **bare identifiers** (`readonly button: string;`) with an exact `Verbatim` segment when
  the class name is identifier-safe — strongest fidelity, edit/rename capable;
- **quoted keys** (`readonly "card-title": string;`) with an **`Atom`** segment covering
  the entire literal (quotes included) mapped onto the class name in the CSS — whole-span
  correspondence, which is precisely what `Atom` exists for.

Both variants demonstrably resolve go-to-definition into the correct selector (RESULTS.md §5).

## What a production version would need

- **camelCase aliases** (`cardTitle` for `.card-title`): emit the camelCase identifier and
  map it with **`Alias`** — atom geometry plus the assertion that virtual and original
  name the same entity, letting diagnostics display the original text. Both spellings
  could be emitted, with the kebab literal `Atom`-mapped as today.
- **`composes` support**: parse `composes: other;` / `composes: a from "./b.module.css"`
  (ICSS), emit imports in the virtual text so cross-file references type-check, and make
  the value type reflect the composition. Cross-file dependency means edits to the
  composed-from file must invalidate this file — likely needs `dynamicConfig`/watched
  files or acceptance of coarser invalidation.
- **`:global`/`:local` semantics**: this PoC types every class selector; CSS Modules
  semantics require skipping `:global(...)` scopes.
- **`@container` / `@scope`**: `walkRules` already covers rules nested in any at-rule, but
  `@scope (.a) to (.b)` holds selectors in the *at-rule prelude*, which is not a Rule —
  the prelude would need its own selector-parser pass over `atRule.params`.
- **Escaped class names** (`.foo\3a bar`): the unescaped name differs from the source
  text, so Verbatim is impossible and computing the raw span is fiddly; this PoC simply
  emits the property untyped-position (no mapping). Production: compute the raw span and
  `Atom`-map it.
- **Keyframes/animation names, custom properties, `@property`**: out of scope here but
  natural extensions of the same pattern.
- **utf-8 encoding option**: this mapper declares `utf-16` because PostCSS offsets are JS
  string indices; a Rust/Go rewrite would likely prefer `utf-8` and count bytes.
- **Supplemental outputs**: unused here; a `composes`-heavy design might emit shared
  declarations as a supplemental file instead of repeating them.

## Known trap: launcher-shimmed `node` hangs tsgo at exit

If `node` on `PATH` is a resident launcher shim (Volta being the known case),
`tsgo` completes the compile but hangs forever in mapper teardown and leaks an
orphaned `node dist/server.js` per run. `childProcess.Close`
(`cmd/tsgo/sys.go`) kills only its direct child — the shim — while the real
node, a reparented grandchild, keeps the inherited stderr-pipe write end open;
`cmd.Wait()` then blocks until that pipe EOFs, which is never. The shim doesn't
forward signals (not even SIGTERM), and tsgo never closes the child's stdin, so
the protocol's own exit-on-EOF path never fires either.

Workaround: prepend a directory with a symlink to the real binary
(`ln -s "$(volta which node)" dir/node; PATH="dir:$PATH" tsgo ...`). Exec-style
version managers (nvm, asdf) are unaffected. Full diagnosis and suggested
upstream fixes: `UPSTREAM-COMMENT.md` (posted to microsoft/typescript-go#4712,
2026-08-16).

## Misc observations

- Content-mapped files are indeed not emitted (`TestTscContentMapperEmit` baseline:
  "content-mapped files are not emitted") — correct for CSS, where a bundler owns the
  file at runtime.
- One mapper process is shared across projects keyed by `name@version` identity; the
  server must stay stateless per request (this one is a pure function of
  `(fileName, content)`).
- `tsgo --lsp` only supports `-stdio`.
- The demo uses `"module": "preserve"`; nothing mapper-specific about that choice beyond
  allowing extensionful relative imports comfortably.
