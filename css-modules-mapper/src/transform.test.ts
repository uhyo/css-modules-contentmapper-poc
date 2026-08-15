import { test } from "node:test";
import assert from "node:assert/strict";
import { transform, lineColumnToOffset } from "./transform.js";

test("extracts class names: bare keys for identifiers, quoted for kebab-case", () => {
  const css = `.button { color: red; }\n.card-title { font-size: 2rem; }\n`;
  const result = transform("/proj/a.module.css", css);
  assert.equal(result.extension, ".ts");
  assert.match(result.text, /readonly button: string;/);
  assert.match(result.text, /readonly "card-title": string;/);
  assert.match(result.text, /export default styles;/);
  assert.equal(result.diagnostics, undefined);
});

test("identifier names map Verbatim; quoted names map Atom over the whole literal", () => {
  const css = `.button { color: red; }\n.card-title { font-size: 2rem; }\n`;
  const result = transform("/proj/a.module.css", css);
  assert.equal(result.mappings.length, 2);

  const [vStart, vLen, oStart, oLen, kind] = result.mappings[0]!;
  assert.equal(kind, 0); // Verbatim
  assert.equal(vLen, oLen);
  assert.equal(result.text.slice(vStart, vStart + vLen), "button");
  assert.equal(css.slice(oStart, oStart + oLen), "button");

  const [aStart, aLen, aoStart, aoLen, aKind] = result.mappings[1]!;
  assert.equal(aKind, 1); // Atom
  assert.equal(result.text.slice(aStart, aStart + aLen), '"card-title"');
  assert.equal(css.slice(aoStart, aoStart + aoLen), "card-title");
});

test("multibyte round-trip: class after a Japanese comment maps exactly (utf-16 offsets)", () => {
  const css = `/* ボタンの基本スタイル 🎨 */\n.button { color: red; }\n/* 見出し */\n.card-title { font-size: 2rem; }\n`;
  const result = transform("/proj/a.module.css", css);
  assert.equal(result.mappings.length, 2);
  const byName = new Map(
    result.mappings.map((m) => [css.slice(m[2], m[2] + m[3]), m]),
  );
  const button = byName.get("button")!;
  assert.equal(result.text.slice(button[0], button[0] + button[1]), "button");
  const cardTitle = byName.get("card-title")!;
  assert.equal(result.text.slice(cardTitle[0], cardTitle[0] + cardTitle[1]), '"card-title"');
});

test("deduplicates repeated class names; first occurrence wins", () => {
  const css = `.button { color: red; }\n.button:hover { color: blue; }\n@media (min-width: 600px) { .button { color: green; } }\n`;
  const result = transform("/proj/a.module.css", css);
  assert.equal(result.mappings.length, 1);
  const [, , oStart] = result.mappings[0]!;
  assert.equal(oStart, 1); // the very first ".button"
});

test("finds classes in nested rules and media queries", () => {
  const css = `@media screen { .in-media { top: 0; } }\n.outer { .nested { left: 0; } }\n`;
  const result = transform("/proj/a.module.css", css);
  assert.match(result.text, /"in-media"/);
  assert.match(result.text, /readonly outer: string;/);
  assert.match(result.text, /readonly nested: string;/);
});

test("compound and combinator selectors contribute every class once", () => {
  const css = `.a.b > .c ~ .d { color: red; }\n`;
  const result = transform("/proj/a.module.css", css);
  for (const name of ["a", "b", "c", "d"]) {
    assert.match(result.text, new RegExp(`readonly ${name}: string;`));
  }
  assert.equal(result.mappings.length, 4);
});

test("parse error returns a diagnostic at the offending position, not a crash", () => {
  const css = `.ok { color: red; }\n.broken { color: red;\n`; // unclosed block
  const result = transform("/proj/a.module.css", css);
  assert.ok(result.diagnostics && result.diagnostics.length === 1);
  const d = result.diagnostics[0]!;
  assert.ok(d.start >= 0 && d.start <= css.length);
  assert.ok(d.length >= 0 && d.start + d.length <= css.length);
  assert.match(result.text, /export default styles;/); // still valid TS
});

test("parse error after multibyte text keeps offsets within bounds", () => {
  const css = `/* 日本語のコメント */\n.a { color: red;\n`;
  const result = transform("/proj/a.module.css", css);
  assert.ok(result.diagnostics && result.diagnostics.length === 1);
  const d = result.diagnostics[0]!;
  assert.ok(d.start >= 0 && d.start + d.length <= css.length);
});

test("deterministic: same input, same output", () => {
  const css = `.x { color: red; }\n.y { color: blue; }\n`;
  const a = transform("/proj/a.module.css", css);
  const b = transform("/proj/a.module.css", css);
  assert.deepEqual(a, b);
});

test("empty css yields an empty typed module", () => {
  const result = transform("/proj/a.module.css", "");
  assert.match(result.text, /declare const styles: \{/);
  assert.equal(result.mappings.length, 0);
  assert.equal(result.diagnostics, undefined);
});

test("lineColumnToOffset counts utf-16 code units", () => {
  const content = "ab🎨cd\nxy";
  assert.equal(lineColumnToOffset(content, 1, 1), 0);
  assert.equal(lineColumnToOffset(content, 2, 1), 7); // "ab🎨cd" is 6 units + newline
  assert.equal(lineColumnToOffset(content, 2, 2), 8);
});
