# Acceptance results

PoC of typed CSS Modules via the TypeScript Content Mapper API (PR microsoft/typescript-go#4712,
**merged** into typescript-go `main` on 2026-08-19 as `01b9e721f3d7f8037d700daff94f5808c1afb97e`;
the Go implementation then **migrated into the main `microsoft/TypeScript` repo** on
2026-08-20 via PR microsoft/TypeScript#63763, as the `tsc/` subdirectory).

## Environment

- **TypeScript**: `main` of `microsoft/TypeScript` (post repo-migration), commit
  **`6d44e0584a857f3a03794241197fd9c7ff457499`**, reporting `Version 7.1.0-dev`
- Built with `cd tsc && go build -o built/tsgo ./cmd/tsc` (Go 1.26.0 toolchain), Node.js v22.22.2
- Content mapper protocol version: **1**
- `$TSGO` below = the native compiler binary built from that commit (upstream's entry
  point is now `cmd/tsc`; built as `tsgo` here to keep it distinct from the JS `tsc`)

All results below were re-run on 2026-08-20 against the post-migration
`microsoft/TypeScript` repo, with **no changes to the mapper or the demo**, and are
byte-identical to the previous run against `microsoft/typescript-go` commit `16c2552` —
except that the LSP server now identifies itself as `"typescript"` instead of
`"typescript-go"` (§5). The `16c2552` run was in turn identical to the original run
against pre-merge commit `d07c1ff` of `andrewbranch/typescript-go#content-mappers`, after
one mapper-side change: the merged host sends `openProject`/`closeProject` to every
mapper (not just `dynamicConfig` ones), so `server.ts` now acknowledges both (see
NOTES.md §5).

Setup:

```bash
npm install
npm run build -w css-modules-mapper
```

> Note: the actual CLI flag is **`--runExternalCode`**, not `--loadExternalPlugins` as
> earlier drafts of the PR description suggested — see NOTES.md. All commands below use
> the flag the code actually implements.

## 1. Clean type-check with class-name access

`app.ts` uses `styles.button`, `styles["card-title"]`, and `styles["wide-only"]` (the
latter defined inside a `@media` block).

```
$ $TSGO -p demo --runExternalCode
exit=0
```

## 2. Non-existent class is a compile error, positioned in app.ts

With `styles.button` changed to `styles.buton`:

```
$ $TSGO -p demo --runExternalCode
demo/src/app.ts(4,30): error TS2551: Property 'buton' does not exist on type '{ readonly button: string; readonly "card-title": string; readonly "wide-only": string; }'. Did you mean 'button'?
exit=2
```

The error is in `app.ts` at the access site, and TypeScript's spelling suggestion works
across the mapper boundary.

## 3. CSS syntax error surfaces as a mapper diagnostic in the .css file

With line 3 of `button.module.css` changed from `color: red;` to `color red;`:

```
$ $TSGO -p demo --runExternalCode
demo/src/button.module.css(3,3): error css-modules1001: Unknown word color
exit=2
```

- Source is `css-modules` (declared as `diagnosticSource` in the `initialize` response),
  rendered as the code prefix `css-modules1001` (1001 is this mapper's parse-error code).
- Position (3,3) is exactly where `color` starts, **after a multibyte Japanese comment on
  line 1** — the utf-16 offset math holds (the mapper declares `positionEncoding: "utf-16"`).

## 4. Omitting --runExternalCode

```
$ $TSGO -p demo
demo/src/app.ts(1,20): error TS2307: Cannot find module './button.module.css' or its corresponding type declarations.
demo/tsconfig.json(7,3): error TS100024: Content mappers require the '--runExternalCode' command line flag to be enabled.
exit=2
```

Observed behavior: without the flag, mappers are dropped entirely (their extensions are
not registered, so `.css` imports fail as unknown modules) and one explicit error
(TS100024) is reported at the `contentMappers` key in `demo/tsconfig.json`. The mapper
process is never spawned.

## 5. Stretch: go-to-definition through the span map (LSP)

VS Code itself isn't runnable in this container, so `scripts/lsp-goto-def.mjs` drives
`tsgo --lsp -stdio` directly, passing `initializationOptions: { runExternalCode: true }`
(the LSP equivalent of the CLI flag, normally gated on workspace trust by the editor).

Definition on `button` in `styles.button` (a **Verbatim**-mapped bare identifier):

```
$ node scripts/lsp-goto-def.mjs $TSGO demo src/app.ts "button;"
initialize ok (server: {"name":"typescript","version":"7.1.0-dev"})
definition request at src/app.ts:4:30 (on "button;")
[
  {
    "uri": "file:///.../demo/src/button.module.css",
    "range": { "start": { "line": 1, "character": 1 }, "end": { "line": 1, "character": 7 } }
  }
]
```

That range (0-based) is exactly `button` in the `.button` selector on line 2 of the CSS.

Definition on `styles["card-title"]` (a quoted key, **Atom**-mapped over the whole literal):

```
$ node scripts/lsp-goto-def.mjs $TSGO demo src/app.ts 'card-title"]'
[
  {
    "uri": "file:///.../demo/src/button.module.css",
    "range": { "start": { "line": 5, "character": 1 }, "end": { "line": 5, "character": 11 } }
  }
]
```

Exactly `card-title` in the `.card-title` selector on line 6. See NOTES.md for why the
quoted-key case requires `Atom` rather than `Verbatim`.

## Unit tests (including multibyte round-trip)

```
$ npm test -w css-modules-mapper
# tests 11
# pass 11
# fail 0
```

Covers: class extraction (nested rules, media queries, compound/combinator selectors),
deduplication, Verbatim/Atom span slices matching on both sides, a class name after a
Japanese comment (with an astral emoji) round-tripping through the offset math, parse-error
diagnostics staying in bounds after multibyte text, determinism, and empty input.
