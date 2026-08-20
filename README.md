# css-modules-contentmapper-poc

Typed CSS Modules for TypeScript 7 (the native, Go-based compiler) via the experimental
**Content Mapper API** (PR [microsoft/typescript-go#4712](https://github.com/microsoft/typescript-go/pull/4712),
merged into `main` on 2026-08-19 as `01b9e72`). The Go implementation has since been
migrated from the `microsoft/typescript-go` staging repo into the main
[microsoft/TypeScript](https://github.com/microsoft/TypeScript) repo
(PR [microsoft/TypeScript#63763](https://github.com/microsoft/TypeScript/pull/63763),
2026-08-20), where it now lives in the `tsc/` subdirectory.
Importing a `*.module.css` file is type-checked: the imported object's keys are exactly
the class names in the CSS, unknown names are compile errors, and go-to-definition jumps
from `styles.button` into the `.button` selector.

- `css-modules-mapper/` — the content mapper: a JSON-RPC stdio server
  (`src/server.ts`) and the CSS → TS transform with span-map generation
  (`src/transform.ts`, PostCSS-based).
- `demo/` — consumer project registering the mapper via `contentMappers` in its
  tsconfig.
- `scripts/lsp-goto-def.mjs` — minimal LSP client used to demonstrate
  go-to-definition through the span map.
- `RESULTS.md` — acceptance evidence; `NOTES.md` — spec/code divergences and
  production considerations.

## Running it

Requires `tsc` built from `main` of `microsoft/TypeScript` (this PoC last verified
against `6d44e05`, see RESULTS.md). Since the repo migration the Go module lives in the
`tsc/` subdirectory and the entry point was renamed `cmd/tsgo` → `cmd/tsc`:

```bash
git clone --depth 1 https://github.com/microsoft/TypeScript
cd TypeScript/tsc && go build -o built/tsc ./cmd/tsc
```

Then:

```bash
npm install
npm run build -w css-modules-mapper
npm test -w css-modules-mapper                        # unit tests
path/to/built/tsc -p demo --runExternalCode           # type-check the demo
node scripts/lsp-goto-def.mjs path/to/built/tsc demo src/app.ts "button;"   # go-to-def
```
