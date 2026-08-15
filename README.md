# css-modules-contentmapper-poc

Typed CSS Modules for TypeScript 7 (typescript-go) via the experimental **Content Mapper
API** (PR [microsoft/typescript-go#4712](https://github.com/microsoft/typescript-go/pull/4712)).
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

Requires a `tsgo` built from the `content-mappers` branch of
`andrewbranch/typescript-go` (this PoC used commit `d07c1ff`, see RESULTS.md):

```bash
git clone -b content-mappers https://github.com/andrewbranch/typescript-go
cd typescript-go && go build -o built/tsgo ./cmd/tsgo
```

Then:

```bash
npm install
npm run build -w css-modules-mapper
npm test -w css-modules-mapper                        # unit tests
path/to/tsgo -p demo --runExternalCode                # type-check the demo
node scripts/lsp-goto-def.mjs path/to/tsgo demo src/app.ts "button;"   # go-to-def
```
