/**
 * Source-level highlight decorations (FR-015/FR-016): a `Math`-node source
 * scan for `\textcolor` and an `HTMLTag` hide spec for the prose `<span>`
 * form — both conceal the wrapper and colour the inner glyphs. Inside an
 * unfolded formula the `\textcolor{#hex}{` and `}` markup conceals — as
 * `Decoration.replace` with an empty spec, not zero-size marks, so no
 * zero-width positions perturb `coordsAtPos` — and the inner glyphs take the
 * colour. The caret entering the wrapper or its inner text reveals the
 * markup for editing, the same caret rule hide/core.ts applies.
 *
 * The fold path (hide extension + unfurl) doesn't change: a folded math node
 * is a Decoration.replace over its whole range, which clips these inner
 * decorations automatically.
 *
 * This pass scans the formula source directly instead of walking syntax
 * nodes: the LaTeX grammar's tokenisation is flat — the `\textcolor` call
 * and its argument braces are sibling tokens, not a wrapper node a
 * `subNodeNameToHide`-style spec could name. Recorded in
 * SPECs/formula-highlight-colors/research.md.
 */

import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import {
  PROSE_SPAN_CLOSE,
  PROSE_SPAN_OPEN_RE,
  PROSE_SPAN_OPEN_SEARCH_RE,
  detectHighlights,
} from "@/lib/highlight/emit";
import {
  type HidableNodeSpec,
  hidableNodeFacet,
  mathFormulaSpan,
  unfurlFreezeFacet,
} from "@/lib/prosemark-core/main";
import { rangeTouchesRange, treeChanged } from "@/lib/prosemark-core/utils";

const buildDecorations = (state: EditorState) => {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Math") return;
      const span = mathFormulaSpan(node.node);
      if (!span) return false;
      const text = state.doc.sliceString(span.from, span.to);
      for (const hit of detectHighlights(text, span.from)) {
        if (hit.context !== "math") continue;
        const wrapper = { from: hit.wrapperFrom, to: hit.wrapperTo };
        if (state.selection.ranges.some((r) => rangeTouchesRange(r, wrapper))) continue;
        decorations.push(
          Decoration.replace({}).range(hit.wrapperFrom, hit.from),
          Decoration.mark({ attributes: { style: `color: ${hit.hex}` } }).range(hit.from, hit.to),
          Decoration.replace({}).range(hit.to, hit.wrapperTo),
        );
      }
      // The mounted LaTeX subtree under MathFormula holds nothing this pass
      // needs — the scan above already covered the source.
      return false;
    },
  });
  return Decoration.set(decorations, true);
};

const mathHighlightDecorations = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    // Skip the rebuild while the freeze facet holds a folded state — the
    // same guard hide/core.ts keeps.
    if (tr.state.facet(unfurlFreezeFacet)) {
      return tr.docChanged ? deco.map(tr.changes) : deco;
    }
    if (
      tr.docChanged ||
      tr.selection ||
      treeChanged({ state: tr.state, startState: tr.startState })
    ) {
      return buildDecorations(tr.state);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Block nodes that hold inline content — the boundary a span's partner scan
 * may never cross. A `</span>` in the next paragraph is a different `HTMLTag`
 * sibling pair and must not match (research R9). Anything unexpected falls
 * back to the tag's top-level ancestor, which is still a block boundary.
 */
const INLINE_BLOCK_NAMES = new Set([
  "Paragraph",
  "TableCell",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
]);

function enclosingInlineBlock(node: SyntaxNode): SyntaxNode {
  let block = node;
  while (block.parent?.parent && !INLINE_BLOCK_NAMES.has(block.name)) {
    block = block.parent;
  }
  return block;
}

interface ProseSpan {
  /** The inner text — the glyphs that take the colour. */
  from: number;
  to: number;
  /** The end of the close tag — the highlight's `to`. */
  closeTo: number;
  hex: string;
}

/**
 * When `node` is the opening tag of a Writer highlight whose `</span>`
 * partner sits in the same block, the span's geometry; otherwise null. The
 * first `</span>` after the open tag is the partner — Writer never nests
 * these wrappers, so a second opening tag inside the run means hand-written
 * markup, which is left literal rather than decorated twice.
 */
function proseSpanAt(state: EditorState, node: SyntaxNodeRef): ProseSpan | null {
  const open = PROSE_SPAN_OPEN_RE.exec(state.doc.sliceString(node.from, node.to));
  if (!open) return null;
  const block = enclosingInlineBlock(node.node);
  const rest = state.doc.sliceString(node.to, block.to);
  const close = rest.indexOf(PROSE_SPAN_CLOSE);
  if (close === -1) return null;
  if (PROSE_SPAN_OPEN_SEARCH_RE.test(rest.slice(0, close))) return null;
  return {
    from: node.to,
    to: node.to + close,
    closeTo: node.to + close + PROSE_SPAN_CLOSE.length,
    hex: open[1],
  };
}

/**
 * The prose spec (FR-015/FR-016): the parser emits the two tags as separate
 * sibling `HTMLTag` nodes inside the enclosing block (research R4), so the
 * spec matches the opening tag only — matching both would emit every
 * highlight's decorations twice — and `onHide` scans forward within the
 * block for the partner, returning three ranges that reach past the matched
 * node. That is allowed: hide/core.ts pushes `onHide` results into a flat
 * array and finishes with `Decoration.set(decorations, true)`, which sorts
 * them (research R9).
 */
const proseHighlightSpec: HidableNodeSpec = {
  nodeName: "HTMLTag",
  predicate: (state, node) => proseSpanAt(state, node) !== null,
  // The whole highlight — open tag through close tag — reveals as one unit
  // when the caret enters any part of it, and conceals again when it leaves.
  unhideZone: (state, node) => {
    const span = proseSpanAt(state, node);
    return span ? { from: node.from, to: span.closeTo } : node;
  },
  onHide: (state, node) => {
    const span = proseSpanAt(state, node);
    if (!span) return undefined;
    return [
      Decoration.replace({}).range(node.from, span.from),
      Decoration.mark({ attributes: { style: `color: ${span.hex}` } }).range(span.from, span.to),
      Decoration.replace({}).range(span.to, span.closeTo),
    ];
  },
};

export function highlightDecorations(): Extension {
  return [mathHighlightDecorations, hidableNodeFacet.of(proseHighlightSpec)];
}
