# Notes

Where the task prompt / PR description and the actual code diverged, plus what a
production version would need. The authoritative wire structs live in
`tsc/internal/contentmapper/` (`hostimpl.go` in particular) and
`tsc/internal/spanmap/spanmap.go` of `microsoft/TypeScript`.
Originally written against pre-merge commit `d07c1fff6efd364533b7073dd87b39aaf03029c8`
of `andrewbranch/typescript-go#content-mappers`; updated for the **merged** version
(microsoft/typescript-go `main`, merge commit `01b9e721f3d7f8037d700daff94f5808c1afb97e`,
verified at `16c25522`). Protocol version is still **1**. Post-merge changes are marked
"changed at merge" below.

**Repo migration (2026-08-20):** the whole Go implementation moved from the
`microsoft/typescript-go` staging repo into the main `microsoft/TypeScript` repo
(PR microsoft/TypeScript#63763), replayed with full history into the `tsc/`
subdirectory, which is now the Go module (`github.com/microsoft/TypeScript/tsc`).
Internal paths in this document gained the `tsc/` prefix; the CLI entry point was
renamed `cmd/tsgo` → `cmd/tsc` (`internal/tsoptions`, `internal/contentmapper`,
`internal/spanmap` are otherwise unchanged). No protocol or manifest change: this PoC
re-verified against `microsoft/TypeScript` commit `6d44e05` with zero mapper-side
changes (RESULTS.md). The only observable difference is the LSP `initialize` result:
`serverInfo.name` is now `"typescript"`, not `"typescript-go"`. The old staging repo
is slated to be permanently archived in September 2026, but PR/issue links into it
remain valid.

## Divergences: prompt/PR text vs. code (the code won)

1. **CLI flag**: not `--loadExternalPlugins` but **`--runExternalCode`**
   (`internal/tsoptions`, error TS100024). In the LSP it's
   `initializationOptions.runExternalCode: true`, intended to be gated on workspace trust.

2. **Manifest key**: not a top-level `tsContentMapper` field but
   **`"typescript": { "contentMapper": { ... } }`** in the mapper's `package.json`
   (`internal/tsoptions/contentmappers.go`). `exec` must be a non-empty string array;
   `compilerOptions` (names of compiler options whose values are folded into the
   transform-identity cache key — the option *values* now travel in `openProject`, not
   `transform`) and `dynamicConfig` are optional. The package.json **must** declare a
   `name`; `version` is folded into the mapper's identity (process sharing + cache keys).
   The mapper process's working directory is its package directory. A `contentMappers`
   entry in tsconfig may also carry a free-form `options` object, passed through to the
   mapper in `openProject` and folded into the identity.

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
   from the mapper is a protocol violation); methods `initialize`, `openProject`,
   `closeProject`, `transform`. The initialize handshake has a **5-second timeout**.
   `diagnosticSource` must be non-empty and must not be `typescript`, `tsc`, or any
   native extension name (`ts`, `tsx`, `js`, …).

   **Changed at merge — every mapper now gets `openProject`.** Pre-merge (`d07c1ff`),
   `openProject`/`closeProject` were sent only to `dynamicConfig` mappers. In the merged
   version the host opens a project entry before a mapper's first `transform` in that
   project, unconditionally: `openProject` carries `configFileName`, an opaque
   `projectHandle`, the entry's `options` from tsconfig, and the project's full effective
   `compilerOptions`; `transform` params gained a `projectHandle` field referencing it,
   and `closeProject` arrives when the project is released. A non-`dynamicConfig` mapper
   **must answer `openProject` with no `configIdentity` and no `watchedFiles`** (`{}` is
   the correct reply — a non-empty `configIdentity` from a static mapper is a project
   error), and answering "method not found" fails the transform. `initialize` params also
   gained an optional `locale` (BCP 47) for mapper-authored diagnostics. This PoC's
   server stays a pure function of `(fileName, content)` and just acknowledges
   `openProject`/`closeProject` without bookkeeping.

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

## Resolved upstream: launcher-shimmed `node` used to hang tsgo at exit

Pre-merge, if `node` on `PATH` was a resident launcher shim (Volta being the
known case), `tsgo` completed the compile but hung forever in mapper teardown
and leaked an orphaned `node dist/server.js` per run: `childProcess.Close`
(now `tsc/cmd/tsc/sys.go`) killed only its direct child — the shim — while the real
node, a reparented grandchild, kept the inherited stderr-pipe write end open,
and `cmd.Wait()` blocked until that pipe EOFed, which was never. Reported to
the PR on 2026-08-16 (`UPSTREAM-COMMENT.md`); **fixed in the merged version**:
`Close` now closes the child's stdin first (so a well-behaved mapper exits via
the protocol's exit-on-EOF path even when reparented) and sets
`cmd.WaitDelay = time.Second`, which bounds the reap and yields the tolerated
`exec.ErrWaitDelay` if a descendant still holds the pipes. Regression test:
`TestChildProcessCloseDoesNotWaitForLauncherDescendants` (now `tsc/cmd/tsc/sys_unix_test.go`).
No PATH workaround is needed anymore.

## Misc observations

- Content-mapped files are indeed not emitted (`TestTscContentMapperEmit` baseline:
  "content-mapped files are not emitted") — correct for CSS, where a bundler owns the
  file at runtime.
- One mapper process is shared across projects keyed by `name@version` identity; the
  server must stay stateless per request (this one is a pure function of
  `(fileName, content)`).
- `tsc --lsp` (native binary) only supports `-stdio`.
- The demo uses `"module": "preserve"`; nothing mapper-specific about that choice beyond
  allowing extensionful relative imports comfortably.
