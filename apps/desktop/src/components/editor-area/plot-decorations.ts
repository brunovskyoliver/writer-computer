/**
 * ` ```plot ` fences render as an inline SVG function plot. Same fold
 * contract as math: selection inside the fence shows the source with the
 * plot above it; outside, the fence is replaced by the plot. Clicking the
 * rendered plot range-selects the fence and unfolds it for editing.
 *
 * All rendering math is in `src/lib/math/plot.ts`; this file is the
 * CodeMirror glue. Rules: SPECs/math-workflow/spec.md (FR-8).
 */

import type { EditorState } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import {
  foldableSyntaxFacet,
  selectAllDecorationsOnSelectExtension,
} from "@/lib/prosemark-core/main";
import { renderPlotSvg } from "@/lib/math/plot";
import "./plot-widget.css";

class PlotWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly preview: boolean,
  ) {
    super();
  }

  eq(other: PlotWidget): boolean {
    return this.source === other.source && this.preview === other.preview;
  }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = this.preview ? "cm-plot-widget cm-plot-preview" : "cm-plot-widget";
    if (!this.preview) wrapper.setAttribute("aria-label", "Function plot");

    const result = renderPlotSvg(this.source);
    if (result.svg) {
      // The SVG is generated here — fixed shapes and numbers, no fence text
      // inside markup (series labels go through attribute sanitisation).
      const holder = document.createElement("div");
      holder.innerHTML = result.svg;
      const svg = holder.firstElementChild;
      if (svg) wrapper.appendChild(svg);
    }
    for (const error of result.errors) {
      const line = document.createElement("div");
      line.className = "cm-plot-error";
      line.textContent = error;
      wrapper.appendChild(line);
    }
    return wrapper;
  }

  // Preview hovers above source being edited — it must not eat the clicks
  // that belong to the editor. The folded widget lets them through so the
  // select-on-click handler can unfold.
  ignoreEvent() {
    return this.preview;
  }
}

/** FencedCode → info string + body, same shape as the mermaid reader. */
function parseFencedCode(
  state: EditorState,
  node: SyntaxNodeRef,
): { info: string; source: string } | undefined {
  let info = "";
  let source = "";
  let child = node.node.firstChild;
  while (child) {
    if (child.name === "CodeInfo") info = state.doc.sliceString(child.from, child.to);
    else if (child.name === "CodeText") source += state.doc.sliceString(child.from, child.to);
    child = child.nextSibling;
  }
  return info === "" ? undefined : { info, source };
}

export function plotDecorations() {
  return [
    foldableSyntaxFacet.of({
      nodePath: "FencedCode",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, editing) => {
        const parsed = parseFencedCode(state, node);
        if (!parsed) return;
        if (parsed.info.trim().toLowerCase() !== "plot") return;

        if (editing) {
          // Source stays visible; the plot previews above the fence — same
          // contract the math widget uses when its source is being edited.
          return Decoration.widget({
            widget: new PlotWidget(parsed.source, true),
            block: true,
            side: -1,
          }).range(state.doc.lineAt(node.from).from);
        }
        return Decoration.replace({
          widget: new PlotWidget(parsed.source, false),
          block: true,
        }).range(node.from, node.to);
      },
    }),
    selectAllDecorationsOnSelectExtension("cm-plot-widget"),
  ];
}
