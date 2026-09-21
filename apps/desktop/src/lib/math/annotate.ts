/**
 * The muted `≈ value` / `✓` / `✗` badge appended to rendered math widgets
 * (FR-6). A formula that parses closed — no free variables — shows its
 * value; a single top-level equality between two closed sides shows ✓ when
 * they agree and ✗ with both values in the tooltip. Everything else returns
 * null and renders unannotated.
 *
 * Results memoize per formula string (bounded — a note's formula count is
 * small, and the map is cleared when it grows past it).
 */

import { equalitySides, evaluateSource, formatComplex, sameValue } from "./evaluate";

export interface MathAnnotation {
  /** Short badge text: `≈ 1.543`, `✓`, `✗`. */
  text: string;
  /** Tooltip for detail — the two sides' values on a ✗. */
  title?: string;
}

const CACHE_LIMIT = 500;
const cache = new Map<string, MathAnnotation | null>();

function computeAnnotation(formula: string): MathAnnotation | null {
  const sides = equalitySides(formula);
  if (!sides) {
    const out = evaluateSource(formula);
    return out.kind === "value" ? { text: `≈ ${formatComplex(out.value)}` } : null;
  }
  if (sides.length !== 2) return null; // a chain a = b = c — skip, ambiguous badge

  const left = evaluateSource(sides[0]!);
  const right = evaluateSource(sides[1]!);
  if (left.kind !== "value" || right.kind !== "value") return null;

  const agree = sameValue(left.value, right.value);
  return agree
    ? { text: "✓" }
    : {
        text: "✗",
        title: `left ≈ ${formatComplex(left.value)} · right ≈ ${formatComplex(right.value)}`,
      };
}

export function mathAnnotation(formula: string): MathAnnotation | null {
  const key = formula.trim();
  if (key === "") return null;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const annotation = computeAnnotation(key);
  cache.set(key, annotation);
  return annotation;
}

/** Exported for tests. */
export function __clearAnnotationCache() {
  cache.clear();
}
