/**
 * Split a replacement string into the pieces the expander inserts: literal
 * text, tabstops, regex captures and the visual selection.
 *
 * `${NAME}` variables are *not* handled here — `compile.ts` substitutes them
 * textually before this runs, so by now every `${…}` is either a placeholder
 * tabstop or `${VISUAL}`.
 *
 * Syntax table: SPECs/latex-suite/contracts/snippet-file-format.md
 */

export type ReplacementSegment =
  | { kind: "literal"; text: string }
  | { kind: "tabstop"; index: number; placeholder?: string }
  | { kind: "capture"; group: number }
  | { kind: "visual" };

/** `$0`, `${0:placeholder}` or `${VISUAL}` starting at `text[at]` (a `$`). */
function readDollar(
  text: string,
  at: number,
): { segment: ReplacementSegment; length: number } | null {
  const next = text[at + 1];
  if (next === undefined) return null;

  if (next >= "0" && next <= "9") {
    return { segment: { kind: "tabstop", index: Number(next) }, length: 2 };
  }
  if (next !== "{") return null;

  const close = text.indexOf("}", at + 2);
  if (close === -1) return null;
  const inner = text.slice(at + 2, close);

  if (inner === "VISUAL") return { segment: { kind: "visual" }, length: close + 1 - at };
  // `${N:placeholder}`; the placeholder may not contain `}`, which the
  // `indexOf` above already guarantees.
  const match = /^(\d):([\s\S]*)$/.exec(inner);
  if (!match) return null;
  return {
    segment: { kind: "tabstop", index: Number(match[1]), placeholder: match[2] },
    length: close + 1 - at,
  };
}

/** `[[n]]` starting at `text[at]`. */
function readCapture(
  text: string,
  at: number,
): { segment: ReplacementSegment; length: number } | null {
  const match = /^\[\[(\d+)\]\]/.exec(text.slice(at));
  if (!match) return null;
  return { segment: { kind: "capture", group: Number(match[1]) }, length: match[0].length };
}

/**
 * Parse a replacement into segments. Anything that is not one of the four
 * recognised forms stays literal — `"$$0$"` is a literal `$`, tabstop 0 and a
 * literal `$`, which is what makes `mk` produce `$|$`.
 */
export function parseReplacement(text: string): ReplacementSegment[] {
  const segments: ReplacementSegment[] = [];
  let literal = "";

  const flushLiteral = () => {
    if (literal.length > 0) {
      segments.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  for (let pos = 0; pos < text.length; ) {
    const char = text[pos]!;
    const read =
      char === "$" ? readDollar(text, pos) : char === "[" ? readCapture(text, pos) : null;
    if (read) {
      flushLiteral();
      segments.push(read.segment);
      pos += read.length;
    } else {
      literal += char;
      pos += 1;
    }
  }

  flushLiteral();
  return segments;
}

/** Highest `[[n]]` in the template, or `null` when it uses no captures. */
export function maxCaptureIndex(segments: ReplacementSegment[]): number | null {
  let max: number | null = null;
  for (const segment of segments) {
    if (segment.kind === "capture" && (max === null || segment.group > max)) max = segment.group;
  }
  return max;
}

/** A template with `${VISUAL}` only fires on a non-empty selection (FR-010). */
export function hasVisual(segments: ReplacementSegment[]): boolean {
  return segments.some((segment) => segment.kind === "visual");
}
