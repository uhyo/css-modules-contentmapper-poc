# Acceptance results

PoC of typed CSS Modules via the typescript-go Content Mapper API (PR microsoft/typescript-go#4712).

## Environment

- **typescript-go**: branch `content-mappers` of `andrewbranch/typescript-go`, commit **`d07c1fff6efd364533b7073dd87b39aaf03029c8`**, reporting `Version 7.1.0-dev`
- Built with `go build -o built/tsgo ./cmd/tsgo` (Go 1.24.7 toolchain, module toolchain go1.26.0), Node.js v22.22.2
- Content mapper protocol version: **1**
- `$TSGO` below = the `tsgo` binary built from that commit

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
initialize ok (server: {"name":"typescript-go","version":"7.1.0-dev"})
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
