/**
 * Where the math is in a LaTeX source file. Notes find math through the
 * Markdown syntax tree; a `.tex` file has no such tree, so this scans the text
 * for `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and the display-math environments,
 * skipping `%` comments and escaped `\$`. Pure, so the scanner is tested on
 * strings alone.
 *
 * Rules: SPECs/latex-documents/spec.md (US6, FR-5).
 */

export type SourceRegion = {
  kind: "inline" | "display" | "comment";
  /** The region including its delimiters. */
  from: number;
  to: number;
  /** The formula between the delimiters (for comments, the comment text). */
  formulaFrom: number;
  formulaTo: number;
};

/** Environments whose body is math. Starred forms count too. */
const MATH_ENV =
  /^(?:equation|align|gather|multline|eqnarray|math|displaymath|flalign|alignat|dmath)\*?$/;

const BEGIN = /^\\begin\{([^}]*)\}/;

type Open = {
  kind: "inline" | "display";
  from: number;
  formulaFrom: number;
  /** What closes it: a literal delimiter, or `\end{name}`. */
  close: string;
};

/**
 * Every math region and comment in `text`, in order. An unclosed region runs
 * to the end of the text, the way an unfinished formula does while it is
 * being typed.
 */
export function scanLatexSource(text: string): SourceRegion[] {
  const regions: SourceRegion[] = [];
  let open: Open | null = null;
  let at = 0;

  while (at < text.length) {
    const char = text[at]!;

    if (char === "%") {
      const end = text.indexOf("\n", at);
      const to = end === -1 ? text.length : end;
      // A comment inside math is still a comment; the region keeps going.
      regions.push({ kind: "comment", from: at, to, formulaFrom: at + 1, formulaTo: to });
      at = to;
      continue;
    }

    if (open) {
      if (text.startsWith(open.close, at) && (open.close !== "$" || text[at + 1] !== "$")) {
        regions.push({
          kind: open.kind,
          from: open.from,
          to: at + open.close.length,
          formulaFrom: open.formulaFrom,
          formulaTo: at,
        });
        at += open.close.length;
        open = null;
        continue;
      }
      // Skip escapes so `\$` and `\\` never close anything.
      at += char === "\\" ? 2 : 1;
      continue;
    }

    if (char === "\\") {
      const next = text[at + 1];
      if (next === "(" || next === "[") {
        open = {
          kind: next === "(" ? "inline" : "display",
          from: at,
          formulaFrom: at + 2,
          close: next === "(" ? "\\)" : "\\]",
        };
        at += 2;
        continue;
      }
      const begin = BEGIN.exec(text.slice(at, at + 40));
      if (begin && MATH_ENV.test(begin[1]!)) {
        open = {
          kind: "display",
          from: at,
          formulaFrom: at + begin[0].length,
          close: `\\end{${begin[1]}}`,
        };
        at += begin[0].length;
        continue;
      }
      at += 2;
      continue;
    }

    if (char === "$") {
      const display = text[at + 1] === "$";
      const width = display ? 2 : 1;
      open = {
        kind: display ? "display" : "inline",
        from: at,
        formulaFrom: at + width,
        close: display ? "$$" : "$",
      };
      at += width;
      continue;
    }

    at += 1;
  }

  if (open) {
    regions.push({
      kind: open.kind,
      from: open.from,
      to: text.length,
      formulaFrom: open.formulaFrom,
      formulaTo: text.length,
    });
  }
  // A comment inside math was pushed before the math region that encloses it
  // (that one is only pushed when it closes); `regionAt` needs `from` order.
  return regions.sort((a, b) => a.from - b.from);
}

/**
 * The region the caret at `pos` is in, with the same boundary rule as the
 * Markdown math context: on the opening delimiter the caret is outside, just
 * past the closing one it is still inside (so tab-out can leave). Comments are
 * half-open — the caret at the end of a comment line is in the comment.
 */
export function regionAt(regions: readonly SourceRegion[], pos: number): SourceRegion | null {
  // Regions are sorted by `from`; binary-search the last one starting before pos.
  let low = 0;
  let high = regions.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (regions[mid]!.from < pos) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // A comment inside an open math region sits after it in the list; check a
  // few back so the enclosing math region is still found.
  for (let at = found; at >= 0 && at >= found - 64; at -= 1) {
    const region = regions[at]!;
    if (pos > region.from && pos <= region.to) return region;
  }
  return null;
}
