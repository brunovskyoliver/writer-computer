import { Compartment, type EditorState } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import {
  foldableSyntaxFacet,
  mathFormulaSpan,
  selectAllDecorationsOnSelectExtension,
} from "@/lib/prosemark-core/main";
import { mathAnnotation, type MathAnnotation } from "@/lib/math/annotate";
import { useSettingsStore } from "@/stores/settings-store";
import { renderMath } from "./math-renderer";
import "katex/dist/katex.min.css";
import "./math-widget.css";

class MathWidget extends WidgetType {
  constructor(
    public formula: string,
    public display: boolean,
    public preview = false,
    public annotation: MathAnnotation | null = null,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.formula === other.formula &&
      this.display === other.display &&
      this.preview === other.preview &&
      this.annotation?.text === other.annotation?.text
    );
  }

  toDOM() {
    const span = document.createElement(this.preview ? "div" : "span");
    span.className = this.preview
      ? "cm-math-preview cm-math-display"
      : this.display
        ? "cm-math-widget cm-math-display"
        : "cm-math-widget";

    if (this.preview) {
      span.setAttribute("aria-label", "Math preview");
    }

    const result = renderMath(this.formula, this.display);
    if (result.error !== undefined) {
      // Fail visibly: show the raw source styled as an error with the KaTeX
      // message on hover, never an empty gap.
      span.classList.add("cm-math-error");
      span.textContent = this.display ? `$$${this.formula}$$` : `$${this.formula}$`;
      span.title = result.error;
      return span;
    }

    // KaTeX markup rendered with `trust: false` from renderMath — the formula
    // text cannot inject markup of its own.
    span.innerHTML = result.html;
    if (this.annotation) {
      const badge = document.createElement("span");
      badge.className = "cm-math-annotation";
      badge.textContent = ` ${this.annotation.text}`;
      if (this.annotation.title) badge.title = this.annotation.title;
      span.appendChild(badge);
    }
    return span;
  }

  // Let mousedown reach the editor so the click-to-edit selection handler runs.
  ignoreEvent(_event: Event) {
    return this.preview;
  }
}

function mathFormulaRange(node: SyntaxNodeRef): { from: number; to: number } | null {
  return mathFormulaSpan(node.node);
}

function annotationsOn(): boolean {
  return useSettingsStore.getState().settings["latex.eval-annotations"] !== false;
}

/** The math fold facet, parameterized so the eval-annotations toggle can
 *  rebuild it through the compartment. */
function mathFacet(withAnnotations: boolean) {
  return foldableSyntaxFacet.of({
    nodePath: "Math",
    keepDecorationOnUnfold: true,
    buildDecorations: (state: EditorState, node: SyntaxNodeRef, editing: boolean) => {
      const range = mathFormulaRange(node);
      if (!range) return;

      const formula = state.doc.sliceString(range.from, range.to);
      if (formula.trim() === "") return; // nothing to render — keep the source visible

      const annotation = withAnnotations ? mathAnnotation(formula) : null;
      const display = state.doc.sliceString(node.from, node.from + 2) === "$$";
      if (editing) {
        return Decoration.widget({
          widget: new MathWidget(formula, true, true, annotation),
          block: true,
          side: -1,
        }).range(state.doc.lineAt(node.from).from);
      }
      return Decoration.replace({
        widget: new MathWidget(formula, display, false, annotation),
      }).range(node.from, node.to);
    },
  });
}

export function mathDecorations() {
  const compartment = new Compartment();
  return [
    compartment.of(mathFacet(annotationsOn())),
    // Toggling `latex.eval-annotations` rebuilds the facet — a reconfigure
    // produces fresh widgets with (or without) the badge.
    ViewPlugin.define((view) => {
      let current = annotationsOn();
      const unsubscribe = useSettingsStore.subscribe((state) => {
        const next = state.settings["latex.eval-annotations"] !== false;
        if (next === current) return;
        current = next;
        view.dispatch({ effects: compartment.reconfigure(mathFacet(next)) });
      });
      return { destroy: unsubscribe };
    }),
    // Clicking a rendered formula range-selects the math node, which unfolds
    // it into editable source (same interaction as images).
    selectAllDecorationsOnSelectExtension("cm-math-widget"),
  ];
}

export const __testMathDecorations = { MathWidget };
