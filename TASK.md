# Task: PoC — Typed CSS Modules via TypeScript's experimental Content Mapper API

## Mission

Build a proof-of-concept **content mapper** that makes CSS Modules (`*.module.css`) first-class citizens in TypeScript 7 (typescript-go). Importing a `.module.css` file should be type-checked: the imported object's keys are exactly the class names defined in the CSS file, unknown class names are compile errors, and editor features (hover, go-to-definition) map back into the original CSS file.

This uses the **Content Mapper API**, an experimental feature currently under review in PR microsoft/typescript-go#4712 (targeted for TypeScript 7.1). It is NOT in any published npm package yet, so you must build the compiler from the PR branch.

## Step 0 — Learn the API before writing any code

Read these, in order. Do not skip this step; the protocol is small but the span-mapping semantics are subtle.

1. **The PR description** (this is the spec): https://github.com/microsoft/typescript-go/pull/4712
   Pay attention to:
   - The `tsconfig.json` `contentMappers` field and the `--loadExternalPlugins` flag (mandatory; mappers are ignored without it).
   - The `tsContentMapper` manifest field in the mapper package's `package.json` (`exec`, `compilerOptions`).
   - The JSON-RPC protocol over STDIO: TypeScript is the only side that sends requests; a mapper must handle exactly two methods, `initialize` and `transform`.
   - `TransformResult`: `text` (valid TS/TSX/JS/JSON), `scriptKind`, `mappings` (span map tuples), `diagnostics` (parse errors in the original content).
   - Span map tuples: `[generatedStart, generatedLength, originalStart, originalLength, kind, purpose?]`, with `SpanMapKind` (`Verbatim` / `Atom` / `Alias`) and `SpanMapPurpose` (`Semantic` / `Navigation` / `All` / `None`). Positions use the encoding you declare in `initialize` (declare `utf-8` and count bytes, or `utf-16` and count code units — be consistent).
   - Gaps in the span map = synthesized content; diagnostics there are reported specially, not dropped.
   - Failure handling: after 5 mapper failures in a project, TypeScript disables the mapper.
2. **A working reference implementation**: https://github.com/mikearnaldi/ets-go — a community experiment (a custom `.ets` DSL) built directly against this PR. Use it to see how a real mapper process is wired up (stdio framing, initialize handshake, package manifest).
3. Skim the design-context issue linked from the PR (microsoft/typescript-go#2824) only if you need rationale; the PR text is sufficient to implement.

## Step 1 — Build the compiler from the PR branch

```bash
git clone -b content-mappers https://github.com/andrewbranch/typescript-go
cd typescript-go
npm ci
npx hereby build        # or: go build ./cmd/tsgo
```

Requirements: Go ≥ 1.24, Node.js ≥ 20. The resulting `tsgo` binary is your `tsc`. Verify with `tsgo --version` and a trivial plain-TS project before touching mappers. Note the branch may have moved since this prompt was written — if the protocol described in the PR body differs from the code, **the code wins**; check `internal/contentmapper/` for the authoritative wire structs.

## Step 2 — Repository layout

Create a monorepo (npm workspaces) with:

```
css-modules-mapper/          # the content mapper package
  package.json               # contains "tsContentMapper" manifest
  src/server.ts              # JSON-RPC stdio server
  src/transform.ts           # CSS → TS transform + span map generation
demo/                        # consumer project proving it works
  tsconfig.json              # contentMappers registration
  src/button.module.css
  src/app.ts                 # imports and uses the CSS module
```

Mapper `package.json` essentials:

```json
{
  "name": "css-modules-mapper",
  "version": "0.1.0",
  "tsContentMapper": {
    "exec": ["node", "dist/server.js"],
    "compilerOptions": []
  }
}
```

Demo `tsconfig.json`:

```json
{
  "compilerOptions": { "strict": true, "noEmit": true },
  "contentMappers": [
    { "package": "css-modules-mapper", "extensions": [".css"] }
  ],
  "include": ["src"]
}
```

Run the demo with: `tsgo -p demo --loadExternalPlugins`

## Step 3 — The transform

For an input like:

```css
.button { color: red; }
.card-title { font-size: 2rem; }
```

emit TypeScript along these lines:

```ts
declare const styles: {
  readonly "button": string;
  readonly "card-title": string;
};
export default styles;
```

Requirements:

- **CSS parsing**: use a real CSS parser (e.g. `postcss` + `postcss-selector-parser`) to extract class selectors, including from nested rules and media queries. Deduplicate class names. Handle kebab-case by quoting property keys (do not invent camelCase aliases in v1 — keep the mapping 1:1 so spans can be `Verbatim`).
- **Span maps**: map each generated property-name span (the identifier text between the quotes) back to the class name in the original CSS (the text after the `.` in the selector). Since the generated and original text are identical, use `SpanMapKind.Verbatim` with default purpose (`All`). Everything else (the `declare const` scaffolding) is intentionally unmapped/synthesized.
- **Diagnostics**: if the CSS fails to parse, return a `MapperDiagnostic` at the offending position instead of crashing. Never let an exception escape the `transform` handler — remember the 5-strike disable rule.
- **Determinism/idempotency**: the same input must produce the same output. One mapper process may serve multiple projects and receives files in any order; keep the server stateless per-request.

## Step 4 — Acceptance criteria

Prove each of these and record the evidence (command + output) in a `RESULTS.md`:

1. `tsgo -p demo --loadExternalPlugins` type-checks cleanly when `app.ts` uses `styles.button` (or `styles["card-title"]`).
2. Accessing a non-existent class (`styles.buton`) produces a TS error **positioned meaningfully** (in `app.ts`; this one doesn't involve the span map).
3. Introduce a syntax error into the CSS → the mapper diagnostic appears with the mapper's `diagnosticSource` (set something like `"css-modules"` in `initialize`; it must not be `"ts"` or similar reserved values) at the correct position in the `.css` file.
4. Omitting `--loadExternalPlugins` produces the expected "mappers ignored/error" behavior — document what actually happens.
5. **Stretch (attempt, but don't block on it)**: launch the built LSP (`tsgo --lsp` via the PR's `_extension/` in VS Code, trusted workspace) and demonstrate go-to-definition from `styles.button` in `app.ts` into the `.button` selector in the CSS file. This is the payoff of the span map.

## Constraints and known sharp edges

- Protocol version is `1` and the whole feature is pre-stabilization; pin your clone to a commit and note the SHA in RESULTS.md.
- Content-mapped files are **not emitted to JS** — that's correct for this use case (a bundler owns the CSS at runtime); don't fight it. `--declaration` emit would produce `foo.d.module.css.ts`-style files; out of scope.
- Position encoding bugs are the most likely failure mode. Write a unit test that round-trips a multibyte-containing CSS file (e.g. a class name after a comment with Japanese text) through your offset math.
- If `transform` requests seem to never arrive, check that (a) the extension list matches, (b) the package resolves from the demo project's `node_modules`, (c) your stdio framing matches what the ets-go example does — do not write logs to stdout; use stderr.

## Deliverables

1. Working monorepo as described.
2. `RESULTS.md` with acceptance evidence and the typescript-go commit SHA used.
3. A short `NOTES.md`: anything where the PR description and actual code diverged, and your assessment of what a production version (camelCase aliases via `SpanMapKind.Atom`/`Alias`, `composes` support, `@container`/`@scope` handling) would need.
