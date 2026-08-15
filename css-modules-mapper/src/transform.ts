/**
 * CSS Modules → TypeScript transform for the typescript-go Content Mapper API.
 *
 * Position encoding: this mapper declares "utf-16" in its initialize response, so
 * every offset below is a JavaScript string index (UTF-16 code unit count). PostCSS
 * source offsets are JS string indices too, which is why utf-16 is the natural choice.
 */
import postcss, { type Rule, CssSyntaxError } from "postcss";
import selectorParser from "postcss-selector-parser";

/** SpanMapKind values from internal/spanmap (Verbatim = 0, Atom = 1, Alias = 2). */
export const KIND_VERBATIM = 0;
export const KIND_ATOM = 1;

/** [virtualStart, virtualLength, originalStart, originalLength, kind] — features omitted = All. */
export type SpanTuple = [number, number, number, number, number];

export interface MapperDiagnostic {
  messageText: string;
  start: number;
  length: number;
  code?: number;
}

/** Matches the wire shape of the host's TransformResult (MappedOutput + diagnostics). */
export interface TransformOutput {
  text: string;
  extension: ".ts";
  mappings: SpanTuple[];
  diagnostics?: MapperDiagnostic[];
}

interface ClassOccurrence {
  /** Offset of the first character of the class name in the original CSS (after the "."). */
  start: number | undefined;
}

/**
 * Transforms CSS Module source text into a virtual TypeScript module declaring the
 * exported class-name map, with Verbatim span mappings from each generated property
 * name back to the class name in the original CSS. Pure and deterministic: same
 * content in, same result out. Never throws on malformed CSS — parse failures come
 * back as mapper diagnostics positioned in the original file.
 */
export function transform(fileName: string, content: string): TransformOutput {
  let root: postcss.Root;
  try {
    root = postcss.parse(content, { from: fileName });
  } catch (error) {
    if (error instanceof CssSyntaxError) {
      return emptyModule([cssSyntaxErrorToDiagnostic(error, content)]);
    }
    throw error;
  }

  // Collect class selectors in document order, deduplicated; the first occurrence
  // provides the span-map target.
  const classes = new Map<string, ClassOccurrence>();
  const processor = selectorParser();
  root.walkRules((rule: Rule) => {
    let selectorRoot: selectorParser.Root;
    try {
      // Passing the Rule node lets the parser read raws, keeping sourceIndex
      // aligned with the original selector text.
      selectorRoot = processor.astSync(rule);
    } catch {
      // Selector the parser cannot handle (rare, e.g. inside @keyframes with exotic
      // syntax); classes in it are simply not typed. Not a fatal error.
      return;
    }
    const ruleStart = rule.source?.start?.offset;
    selectorRoot.walkClasses((classNode) => {
      const name = classNode.value;
      if (classes.has(name)) {
        return;
      }
      // sourceIndex points at the "." within the selector text, which begins at the
      // rule's source start; +1 skips the dot.
      let start: number | undefined;
      if (ruleStart !== undefined && classNode.sourceIndex >= 0) {
        const candidate = ruleStart + classNode.sourceIndex + 1;
        // A Verbatim segment requires the original slice to equal the generated text
        // exactly. Escaped selectors (`.foo\:bar`) or raws drift fail this check and
        // are emitted without a mapping rather than with a wrong one.
        if (content.slice(candidate, candidate + name.length) === name) {
          start = candidate;
        }
      }
      classes.set(name, { start });
    });
  });

  return buildModule(classes);
}

/** Class names that can be emitted as bare property names. Conservative on purpose:
 * anything else takes the quoted-key path. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function buildModule(classes: Map<string, ClassOccurrence>): TransformOutput {
  const mappings: SpanTuple[] = [];
  let text = "declare const styles: {\n";
  for (const [name, occurrence] of classes) {
    text += "  readonly ";
    if (IDENTIFIER.test(name)) {
      // Bare identifier: generated and original text are equal, so the name node's
      // span is exactly one Verbatim segment — the strongest mapping (exact
      // positions, edit write-back capable).
      if (occurrence.start !== undefined) {
        mappings.push([text.length, name.length, occurrence.start, name.length, KIND_VERBATIM]);
      }
      text += `${name}: string;\n`;
    } else {
      // Kebab-case and friends need a quoted key. The declaration's *name node*
      // includes the quotes, and language-service features require the whole name
      // span to fall inside one segment — so map the full literal as an Atom onto
      // the class name in the CSS (whole-span correspondence, lengths may differ).
      const keyLiteral = JSON.stringify(name);
      if (occurrence.start !== undefined) {
        mappings.push([text.length, keyLiteral.length, occurrence.start, name.length, KIND_ATOM]);
      }
      text += `${keyLiteral}: string;\n`;
    }
  }
  text += "};\nexport default styles;\n";
  return { text, extension: ".ts", mappings };
}

function emptyModule(diagnostics: MapperDiagnostic[]): TransformOutput {
  return {
    text: "declare const styles: {};\nexport default styles;\n",
    extension: ".ts",
    mappings: [],
    diagnostics,
  };
}

/** Fallback result for unexpected internal failures, so an exception never escapes
 * the transform handler (five failures disable the mapper). */
export function internalErrorResult(error: unknown): TransformOutput {
  const message = error instanceof Error ? error.message : String(error);
  return emptyModule([
    { messageText: `css-modules-mapper internal error: ${message}`, start: 0, length: 0, code: 1000 },
  ]);
}

function cssSyntaxErrorToDiagnostic(error: CssSyntaxError, content: string): MapperDiagnostic {
  const start = clampToContent(
    error.line !== undefined && error.column !== undefined
      ? lineColumnToOffset(content, error.line, error.column)
      : 0,
    content,
  );
  let end: number;
  if (error.endLine !== undefined && error.endColumn !== undefined) {
    end = clampToContent(lineColumnToOffset(content, error.endLine, error.endColumn), content);
  } else {
    end = start < content.length ? start + 1 : start;
  }
  if (end < start) {
    end = start;
  }
  // Never split a surrogate pair: the host rejects positions inside a code point.
  if (end > start && end < content.length && isLowSurrogate(content.charCodeAt(end))) {
    end++;
  }
  return { messageText: error.reason, start, length: end - start, code: 1001 };
}

/** Converts PostCSS 1-based line/column to a UTF-16 string offset. */
export function lineColumnToOffset(content: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = content.indexOf("\n", offset);
    if (next === -1) {
      return content.length;
    }
    offset = next + 1;
  }
  return offset + (column - 1);
}

function clampToContent(offset: number, content: string): number {
  const clamped = Math.max(0, Math.min(offset, content.length));
  // Nudge off a low surrogate so the position does not split a code point.
  if (clamped > 0 && clamped < content.length && isLowSurrogate(content.charCodeAt(clamped))) {
    return clamped - 1;
  }
  return clamped;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
