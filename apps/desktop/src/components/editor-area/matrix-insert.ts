/**
 * Insert a filled matrix: the command opens a one-line prompt at the caret,
 * the user types a size and a letter (`3x3 a`), and Enter writes a `bmatrix`
 * of `a_{11}` … `a_{33}`. Inside display math the environment lands at the
 * caret, inside inline math it stays on one line, and in prose it arrives in
 * its own `$$` block. The caret ends just past `\end{bmatrix}` so `=` or the
 * next operand can follow.
 *
 * `matrixTemplate`/`parseMatrixSpec` are the pure half; this file resolves
 * context, owns the prompt, and dispatches one undo step.
 */

import { ensureSyntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, showTooltip, type TooltipView } from "@codemirror/view";
import { mathContext } from "@/lib/latex-snippets/math-context";
import {
  matrixTemplate,
  parseMatrixSpec,
  type MatrixSpec,
} from "@/lib/latex-snippets/matrix-template";
import { showEditorNotice } from "./editor-notice-store";
import { enterVimInsertMode } from "./vim-mode";

const PARSE_BUDGET_MS = 50;
const HINT = "rows × columns, letter";

/** Where the open prompt will insert, or null when no prompt is open. */
const setPrompt = StateEffect.define<number | null>();

const promptField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPrompt)) return effect.value;
    }
    if (value === null) return value;
    // Clicking or typing back in the editor dismisses the prompt.
    if (tr.isUserEvent("select.pointer") || tr.isUserEvent("input")) return null;
    return tr.docChanged ? tr.changes.mapPos(value) : value;
  },
  provide: (field) =>
    showTooltip.compute([field], (state) => {
      const pos = state.field(field);
      return pos === null ? null : { pos, above: false, create: createPrompt };
    }),
});

/** Why a matrix can't go at `pos`, or null when it can. */
function refusal(state: EditorState, pos: number): string | null {
  ensureSyntaxTree(state, state.doc.lineAt(pos).to, PARSE_BUDGET_MS);
  const context = mathContext(state, pos);
  if (context.kind === "code") return "A matrix can't go inside code.";
  if (context.kind === "text") return "Leave the \\text{…} group before inserting a matrix.";
  return null;
}

/** The one transaction that writes the matrix at `pos`. */
function insertion(state: EditorState, pos: number, spec: MatrixSpec): TransactionSpec {
  const context = mathContext(state, pos);
  if (context.kind === "display" || context.kind === "inline") {
    const insert = matrixTemplate(spec, { inline: context.kind === "inline" });
    return {
      changes: { from: pos, insert },
      selection: EditorSelection.cursor(pos + insert.length),
    };
  }

  // Prose: a `$$` block on lines of its own, caret still inside it.
  const line = state.doc.lineAt(pos);
  const before = state.doc.sliceString(line.from, pos).trim() === "" ? "" : "\n";
  const after = state.doc.sliceString(pos, line.to).trim() === "" ? "" : "\n";
  const body = `$$\n${matrixTemplate(spec)}`;
  const insert = `${before}${body}\n$$${after}`;
  return {
    changes: { from: pos, insert },
    selection: EditorSelection.cursor(pos + before.length + body.length),
  };
}

function createPrompt(view: EditorView): TooltipView {
  const form = document.createElement("form");
  form.className = "cm-matrix-prompt cm-matrix-prompt-form";
  const label = document.createElement("label");
  label.textContent = "Matrix";
  const input = document.createElement("input");
  input.placeholder = "3x3 a";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", `Matrix size: ${HINT}`);
  const hint = document.createElement("span");
  hint.className = "cm-matrix-prompt-hint";
  hint.textContent = HINT;
  label.append(input);
  form.append(label, hint);

  let closed = false;
  const close = (effects: StateEffect<unknown>[] = [], spec?: TransactionSpec) => {
    if (closed) return;
    closed = true;
    view.dispatch({ ...spec, effects: [setPrompt.of(null), ...effects] });
    view.focus();
  };

  const submit = () => {
    const spec = parseMatrixSpec(input.value);
    if (!spec) {
      input.setAttribute("aria-invalid", "true");
      hint.textContent = `Try “3x3 a” (${HINT})`;
      return;
    }
    const pos = view.state.field(promptField);
    if (pos === null) return;
    close([], {
      ...insertion(view.state, pos, spec),
      userEvent: "input.matrix",
      scrollIntoView: true,
    });
    enterVimInsertMode(view);
  };
  // Enter is handled on keydown rather than through the form's implicit
  // submission, which WKWebView does not fire reliably for a lone input.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    hint.textContent = HINT;
  });
  input.addEventListener("keydown", (event) => {
    // The prompt lives in `document.body`, so window-level shortcut handlers
    // would otherwise see these keys too.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  });

  return {
    dom: form,
    mount: () => {
      input.focus();
      // Opened from the command palette, the palette hands focus back to the
      // editor as it unmounts — after this mount. Take it back once.
      requestAnimationFrame(() => {
        if (!closed && view.hasFocus) input.focus();
      });
    },
    destroy: () => {
      closed = true;
    },
  };
}

export const insertMatrix: StateCommand = (target) => {
  if (!(target instanceof EditorView)) return false;
  const { state } = target;
  if (state.selection.ranges.length > 1) return false;
  const pos = state.selection.main.head;
  const reason = refusal(state, pos);
  if (reason) {
    showEditorNotice(reason);
    return true;
  }
  target.dispatch({ effects: setPrompt.of(pos) });
  return true;
};

const promptTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-matrix-prompt": {
    padding: "6px 10px",
  },
  ".cm-matrix-prompt-form": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    fontFamily: "var(--ui-font)",
    fontSize: "13px",
    color: "var(--text-primary)",
  },
  ".cm-matrix-prompt-form label": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  ".cm-matrix-prompt-form input": {
    width: "8ch",
    padding: "2px 6px",
    font: "inherit",
    color: "inherit",
    background: "transparent",
    border: "1px solid var(--line-subtler)",
    borderRadius: "6px",
    outline: "none",
  },
  ".cm-matrix-prompt-form input[aria-invalid]": {
    borderColor: "var(--danger, #cf222e)",
  },
  ".cm-matrix-prompt-hint": {
    color: "var(--text-muted)",
  },
});

export const matrixPrompt: Extension = [promptField, promptTheme];
