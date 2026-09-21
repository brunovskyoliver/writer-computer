/**
 * Shared LaTeX source scanners: brace matching, environment spans, and the
 * top-level mask that tells `&`, `\\` and `=` belonging to a formula's own
 * row grammar from the same characters inside a nested `{…}` group or
 * environment. tidy, align and the evaluator all read through these so the
 * "what counts as nested" rule lives in one place.
 */

export const ENV_RE = /\\(begin|end)\{([^}]*)\}/g;

/** Index of the `}` matching the `{` at `openIndex`, or null. `\{` and
 *  other escapes are skipped. */
export function matchBrace(text: string, openIndex: number): number | null {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** Whole-env spans: `\begin{x}` through its matching `\end{x}`, innermost
 *  match wins on `end`. `\\begin` is a row break followed by the word
 *  "begin", not an opener. */
export function envSpans(text: string): Array<{ from: number; to: number }> {
  const stack: { name: string; from: number }[] = [];
  const spans: Array<{ from: number; to: number }> = [];
  for (const match of text.matchAll(ENV_RE)) {
    if (match.index > 0 && text[match.index - 1] === "\\") continue;
    const name = match[2]!;
    if (match[1] === "begin") {
      stack.push({ name, from: match.index });
      continue;
    }
    for (let at = stack.length - 1; at >= 0; at -= 1) {
      if (stack[at]!.name !== name) continue;
      const open = stack.splice(at, 1)[0]!;
      spans.push({ from: open.from, to: match.index + match[0].length });
      break;
    }
  }
  return spans;
}

/**
 * Per-character mask: true where a char is top-level — outside every
 * environment body and every `{…}` group. `&` and `\\` read at top level
 * are the row grammar; anything deeper belongs to a nested structure.
 */
export function topLevelMask(text: string): boolean[] {
  const mask = Array.from({ length: text.length }, () => true);
  for (const span of envSpans(text)) {
    for (let i = span.from; i < span.to; i += 1) mask[i] = false;
  }
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") {
      // Keep the escapee's mask bit equal to the backslash's own level.
      if (depth > 0 && i + 1 < text.length) mask[i + 1] = false;
      i += 1;
      continue;
    }
    if (text[i] === "{") {
      mask[i] = depth === 0 ? true : false;
      depth += 1;
      continue;
    }
    if (text[i] === "}") {
      depth = Math.max(0, depth - 1);
      mask[i] = false;
      continue;
    }
    if (depth > 0) mask[i] = false;
  }
  return mask;
}
