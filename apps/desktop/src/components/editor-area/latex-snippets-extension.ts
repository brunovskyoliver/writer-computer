/**
 * The CodeMirror half of the snippet engine: it reads settings, asks the pure
 * modules in `src/lib/latex-snippets/` what should happen, and dispatches. All
 * decisions live in those modules — this file only adapts them to a view, so
 * it stays testable-by-inspection where the node-only test runner cannot go.
 *
 * Contract: SPECs/latex-suite/contracts/editor-extension.md
 */

import { isolateHistory, undo, undoDepth } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet } from "@codemirror/view";
import { autoFraction } from "@/lib/latex-snippets/auto-fraction";
import { matrixCellTarget } from "@/lib/latex-snippets/matrix-cell";
import { matrixRowBreak } from "@/lib/latex-snippets/matrix-row";
import { atFormulaEnd, copyStepInsert, emptyStepInsert } from "@/lib/math/steps";
import {
  expandSnippet,
  frameHolds,
  frameOf,
  nextGroup,
  selectionForGroup,
  type TabstopFrame,
} from "@/lib/latex-snippets/expand";
import { matchSnippet, type SnippetMatch } from "@/lib/latex-snippets/match";
import { mathContext, type MathContext } from "@/lib/latex-snippets/math-context";
import { tabOutTarget } from "@/lib/latex-snippets/tab-out";
import { useLatexSnippetStore } from "@/stores/latex-snippet-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useVimStore } from "./vim-store";
import "./latex-snippets.css";

/** How long the input handler may wait for the parser before deciding whether
 *  the caret is in math. Past this the tree stays stale and we fall back to
 *  whatever it already knows. */
const PARSE_BUDGET_MS = 20;

const TABSTOP_MARK = Decoration.mark({ class: "cm-latex-tabstop" });

type TabstopState = {
  /** Innermost frame last: a snippet expanded inside another's tabstop pushes. */
  frames: TabstopFrame[];
  /** Counts document changes so Backspace can tell "right after an expansion"
   *  from "one edit later" without comparing positions. */
  docChanges: number;
  lastExpansionAt: number | null;
};

/**
 * The single write path for the frame stack. The contract sketches three
 * effects (push / advance / clear); one effect carrying the new stack keeps
 * the pop-and-advance rule in one pure helper instead of two copies.
 */
export const setFrames = StateEffect.define<TabstopFrame[]>();

export const tabstopField = StateField.define<TabstopState>({
  create: () => ({ frames: [], docChanges: 0, lastExpansionAt: null }),

  update(value, tr) {
    let frames = value.frames;
    const docChanges = value.docChanges + (tr.docChanged ? 1 : 0);
    let lastExpansionAt = value.lastExpansionAt;

    if (tr.docChanged && frames.length > 0) {
      frames = frames
        .map((frame) => ({ ...frame, marks: frame.marks.map(tr.changes) }))
        .filter((frame) => frame.marks.size > 0);
    }
    // A tab swap or an external reload replaces the document wholesale; stops
    // from the previous document mean nothing.
    if (tr.isUserEvent("writer")) frames = [];

    for (const effect of tr.effects) {
      if (effect.is(setFrames)) frames = effect.value;
    }
    // A caret that moved out of a snippet, or reached its exit stop, is done
    // with it. Without this a frame from a subscript typed minutes ago keeps
    // its stops, and the next Tab jumps back to them instead of reaching the
    // matrix-cell or tab-out rules.
    if ((tr.selection || tr.docChanged) && frames.length > 0) {
      const head = tr.newSelection.main.head;
      let keep = frames.length;
      while (keep > 0 && !frameHolds(frames[keep - 1]!, head)) keep -= 1;
      if (keep < frames.length) frames = frames.slice(0, keep);
    }
    if (tr.isUserEvent("input.snippet")) lastExpansionAt = docChanges;
    // Moving the caret (Tab to a stop, arrows, a click) ends the window in
    // which Backspace means "undo that expansion".
    else if (tr.selection && !tr.docChanged) lastExpansionAt = null;

    return frames === value.frames && docChanges === value.docChanges
      ? { ...value, lastExpansionAt }
      : { frames, docChanges, lastExpansionAt };
  },
});

/** Only the innermost frame is highlighted, and only where it covers text —
 *  an empty stop has nothing to draw. */
function tabstopDecorations(value: TabstopState): DecorationSet {
  const top = value.frames[value.frames.length - 1];
  if (!top) return Decoration.none;

  const marks = [];
  const cursor = top.marks.iter();
  for (; cursor.value; cursor.next()) {
    if (cursor.to > cursor.from) marks.push(TABSTOP_MARK.range(cursor.from, cursor.to));
  }
  return RangeSet.of(marks);
}

export const latexTabstopState: Extension = [
  tabstopField,
  EditorView.decorations.from(tabstopField, tabstopDecorations),
];

// ---------- Shared helpers ----------

function setting(
  key:
    | "latex.snippets-enabled"
    | "latex.tab-out"
    | "latex.auto-fraction"
    | "latex.matrix-rows"
    | "latex.matrix-cells"
    | "latex.derivation-steps",
): boolean {
  const value: unknown = useSettingsStore.getState().getSetting(key);
  return value !== false;
}

/** Vim is on for this tab and the caret is not in an insert-like mode, so
 *  every key belongs to Vim. */
function vimBlocks(getTabId: () => string): boolean {
  const entry = useVimStore.getState().byTab.get(getTabId());
  return entry !== undefined && entry.mode !== "insert" && entry.mode !== "replace";
}

/** The math context at `pos`, with the current line parsed first. */
function contextAt(view: EditorView, pos: number): MathContext {
  ensureSyntaxTree(view.state, view.state.doc.lineAt(pos).to, PARSE_BUDGET_MS);
  return mathContext(view.state, pos);
}

function lineBeforeCaret(state: EditorState, pos: number): { from: number; text: string } {
  const line = state.doc.lineAt(pos);
  return { from: line.from, text: state.doc.sliceString(line.from, pos) };
}

/** Push a frame onto whatever the state currently holds. */
function push(state: EditorState, frame: TabstopFrame | null) {
  const frames = state.field(tabstopField).frames;
  return setFrames.of(frame ? [...frames, frame] : frames);
}

/** Dispatch an expansion: one undo step, isolated from the keystroke that
 *  triggered it, so ⌘Z brings the trigger text back. */
function dispatchExpansion(
  view: EditorView,
  match: SnippetMatch,
  replaceFrom: number,
  replaceTo: number,
): void {
  const { changes, selection, frame } = expandSnippet(match, view.state, replaceFrom, replaceTo);
  view.dispatch({
    changes,
    selection,
    effects: [push(view.state, frame)],
    userEvent: "input.snippet",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
}

// ---------- Typing ----------

function handleInput(view: EditorView, from: number, to: number, text: string): boolean {
  const snippetsOn = setting("latex.snippets-enabled");
  const store = useLatexSnippetStore.getState();

  if (snippetsOn && from !== to) {
    // A selection only ever triggers a `${VISUAL}` snippet, and it must be
    // decided before the keystroke replaces the selected text.
    const match = matchSnippet({
      lineBefore: lineBeforeCaret(view.state, from).text + text,
      context: contextAt(view, from),
      set: store.getActiveSet(),
      kind: "auto",
      selectionText: view.state.doc.sliceString(from, to),
      typedText: text,
      onDisable: store.markDisabled,
    });
    if (!match) return false;
    dispatchExpansion(view, match, from, to);
    return true;
  }
  if (from !== to) return false;
  if (overtypeCloser(view, from, text)) return true;

  // Decide *before* touching the document. Returning `true` from an
  // `inputHandler` suppresses every lower-precedence one — `closeBrackets()`
  // among them — so on a miss nothing may have been dispatched and the answer
  // must be `false`.
  const line = view.state.doc.lineAt(from);
  const lineBefore = view.state.doc.sliceString(line.from, from) + text;
  const context = contextAt(view, from);
  if (context.kind === "code" || context.kind === "text") return false;

  const match = snippetsOn
    ? matchSnippet({
        lineBefore,
        context,
        set: store.getActiveSet(),
        kind: "auto",
        selectionText: "",
        typedText: text,
        onDisable: store.markDisabled,
      })
    : null;

  // The first math line may also contain prose and opening delimiters.
  // Neither belongs to the operand consumed by auto-fraction.
  const fractionFrom =
    context.kind === "prose" ? line.from : Math.max(line.from, context.node.formulaFrom);
  const fraction =
    match === null && text === "/" && setting("latex.auto-fraction") && context.kind !== "prose"
      ? autoFraction(lineBefore.slice(fractionFrom - line.from))
      : null;

  if (!match && !fraction) return false;

  // Let the keystroke land as its own transaction: it stays a separate undo
  // step, so ⌘Z after an expansion brings the trigger text back.
  view.dispatch(view.state.replaceSelection(text), { userEvent: "input.type" });
  const caret = view.state.selection.main.head;

  if (match) {
    dispatchExpansion(view, match, line.from + match.from, caret);
    return true;
  }

  const replaceFrom = fractionFrom + fraction!.operandFrom;
  view.dispatch({
    changes: { from: replaceFrom, to: caret, insert: fraction!.text },
    selection: EditorSelection.cursor(
      replaceFrom + fraction!.stops.find((stop) => stop.group === 0)!.offset,
    ),
    effects: [
      push(
        view.state,
        frameOf(
          fraction!.stops.map((stop) => ({
            from: replaceFrom + stop.offset,
            to: replaceFrom + stop.offset,
            group: stop.group,
          })),
        ),
      ),
    ],
    userEvent: "input.snippet",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });

  return true;
}

/**
 * Typing the `}` / `)` / `]` a snippet already inserted steps over it instead
 * of doubling it: `^{T` + `}` reads `^{T}`, not `^{T}}`. Only when the closer
 * ends right before a stop of the innermost frame — i.e. it is the snippet's
 * own closer — and the caret then continues at that stop.
 */
function overtypeCloser(view: EditorView, pos: number, text: string): boolean {
  if (text !== "}" && text !== ")" && text !== "]") return false;
  if (view.state.doc.sliceString(pos, pos + 1) !== text) return false;
  const frames = view.state.field(tabstopField).frames;
  const top = frames[frames.length - 1];
  if (!top) return false;

  let group: number | null = null;
  const cursor = top.marks.iter();
  for (; cursor.value; cursor.next()) {
    if (cursor.from === pos + 1 && cursor.value.group !== top.currentGroup) {
      group = cursor.value.group;
      break;
    }
  }
  if (group === null) return false;

  view.dispatch({
    selection: EditorSelection.cursor(pos + 1),
    effects: [setFrames.of([...frames.slice(0, -1), { ...top, currentGroup: group }])],
    userEvent: "select",
  });
  return true;
}

// ---------- Tab / Shift-Tab / Escape / Backspace ----------

/** Move to the next group, popping frames that have none left. `null` when the
 *  whole stack is exhausted. */
function advance(view: EditorView, dir: 1 | -1): boolean {
  const frames = [...view.state.field(tabstopField).frames];

  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const group = nextGroup(frame, dir);
    const selection =
      group === null ? null : selectionForGroup(frame, group, view.state.doc.length);
    if (group !== null && selection) {
      frames[frames.length - 1] = { ...frame, currentGroup: group };
      view.dispatch({ selection, effects: [setFrames.of(frames)], userEvent: "select" });
      return true;
    }
    // Exhausted in this direction: fall back into the enclosing snippet.
    if (dir === -1) return false;
    frames.pop();
  }

  if (view.state.field(tabstopField).frames.length > 0) {
    view.dispatch({ effects: [setFrames.of([])] });
  }
  return false;
}

function tabCommand(getTabId: () => string) {
  return (view: EditorView): boolean => {
    if (vimBlocks(getTabId)) return false;
    if (advance(view, 1)) return true;

    const caret = view.state.selection.main;
    if (!caret.empty || view.state.selection.ranges.length > 1) return false;

    const context = contextAt(view, caret.head);
    const line = lineBeforeCaret(view.state, caret.head);

    if (setting("latex.snippets-enabled")) {
      const store = useLatexSnippetStore.getState();
      const match = matchSnippet({
        lineBefore: line.text,
        context,
        set: store.getActiveSet(),
        kind: "tab",
        selectionText: "",
        onDisable: store.markDisabled,
      });
      if (match) {
        dispatchExpansion(view, match, line.from + match.from, caret.head);
        return true;
      }
    }

    if (
      setting("latex.matrix-cells") &&
      (context.kind === "inline" || context.kind === "display")
    ) {
      const formula = view.state.doc.sliceString(context.node.formulaFrom, context.node.formulaTo);
      const cell = matrixCellTarget(formula, caret.head - context.node.formulaFrom);
      if (cell) {
        if (cell.kind === "move") {
          view.dispatch({
            selection: EditorSelection.cursor(context.node.formulaFrom + cell.to),
            userEvent: "select",
          });
        } else {
          view.dispatch({
            changes: { from: context.node.formulaFrom + cell.at, insert: cell.text },
            selection: EditorSelection.cursor(context.node.formulaFrom + cell.caret),
            userEvent: "input.type",
          });
        }
        return true;
      }
    }

    if (setting("latex.tab-out")) {
      const docLine = view.state.doc.lineAt(caret.head);
      const target = tabOut(view.state, caret.head, context, docLine.to);
      if (target !== null) {
        view.dispatch({ selection: EditorSelection.cursor(target), userEvent: "select" });
        return true;
      }
    }

    return false;
  };
}

function tabOut(state: EditorState, caret: number, context: MathContext, lineTo: number) {
  return tabOutTarget(state.doc.sliceString(caret, lineTo), caret, context, lineTo);
}

function latexKeymap(getTabId: () => string) {
  return [
    { key: "Tab", run: tabCommand(getTabId) },
    {
      key: "Shift-Tab",
      run: (view: EditorView) => !vimBlocks(getTabId) && advance(view, -1),
    },
    {
      key: "Escape",
      run: (view: EditorView) => {
        if (view.state.field(tabstopField).frames.length > 0) {
          view.dispatch({ effects: [setFrames.of([])] });
        }
        // Escape belongs to everyone else too (Vim, search, dialogs).
        return false;
      },
    },
    {
      // Inside a matrix-like environment in display math, Enter ends the row
      // (`\\` + newline) instead of inserting a plain newline. At the very
      // end of a display formula it closes the block and opens the next
      // step's `$$` below. Every other position falls through to the usual
      // Enter handling.
      key: "Enter",
      run: (view: EditorView) => {
        if (vimBlocks(getTabId)) return false;
        const caret = view.state.selection.main;
        if (!caret.empty || view.state.selection.ranges.length > 1) return false;

        const context = contextAt(view, caret.head);
        if (context.kind !== "display") return false;

        const formula = view.state.doc.sliceString(
          context.node.formulaFrom,
          context.node.formulaTo,
        );
        const offset = caret.head - context.node.formulaFrom;

        if (setting("latex.matrix-rows") && matrixRowBreak(formula, offset)) {
          view.dispatch(view.state.replaceSelection("\\\\\n"), { userEvent: "input.type" });
          return true;
        }

        // Step continuation only applies to block-level display math: the
        // opener line must be a bare `$$`, which excludes a one-line
        // `$$x$$` inside a paragraph.
        if (view.state.doc.lineAt(context.node.from).text.trim() !== "$$") return false;
        if (!setting("latex.derivation-steps") || !atFormulaEnd(formula, offset)) {
          return false;
        }
        const step = emptyStepInsert();
        view.dispatch({
          changes: { from: caret.head, insert: step.insert },
          selection: EditorSelection.cursor(caret.head + step.caretOffset),
          userEvent: "input.type",
        });
        return true;
      },
    },
    {
      // Mod-Enter inside a display block copies the whole formula into a new
      // `$$` block below — the "next step" of a derivation. Outside a
      // block-level `$$` it falls through to CodeMirror's own binding.
      key: "Mod-Enter",
      run: (view: EditorView) => {
        if (vimBlocks(getTabId)) return false;
        if (!setting("latex.derivation-steps")) return false;
        const caret = view.state.selection.main;
        if (view.state.selection.ranges.length > 1) return false;

        const context = contextAt(view, caret.head);
        if (context.kind !== "display") return false;
        // Only block-level display math: the opener line must be a bare `$$`,
        // which excludes a one-line `$$x$$` inside a paragraph.
        if (view.state.doc.lineAt(context.node.from).text.trim() !== "$$") return false;

        const formula = view.state.doc.sliceString(
          context.node.formulaFrom,
          context.node.formulaTo,
        );
        if (formula.trim() === "") return false;

        const step = copyStepInsert(formula);
        const at = context.node.formulaFrom + formula.trimEnd().length;
        view.dispatch({
          changes: { from: at, insert: step.insert },
          selection: EditorSelection.cursor(at + step.caretOffset),
          userEvent: "input.type",
          scrollIntoView: true,
        });
        return true;
      },
    },
    {
      key: "Backspace",
      run: (view: EditorView) => {
        if (vimBlocks(getTabId)) return false;
        const { lastExpansionAt, docChanges } = view.state.field(tabstopField);
        if (lastExpansionAt !== docChanges || undoDepth(view.state) === 0) return false;
        // A selected placeholder (`{cc}`) is being cleared, not regretted.
        if (!view.state.selection.main.empty) return false;
        // Backspace immediately after an expansion undoes it, the way ⌘Z would.
        return undo(view);
      },
    },
  ];
}

/** Leaving insert mode abandons the snippet: Vim's own motions take over. */
function vimWatcher(getTabId: () => string) {
  return ViewPlugin.define((view) => {
    const unsubscribe = useVimStore.subscribe((state) => {
      const entry = state.byTab.get(getTabId());
      if (!entry || entry.mode === "insert" || entry.mode === "replace") return;
      if (view.state.field(tabstopField).frames.length === 0) return;
      view.dispatch({ effects: [setFrames.of([])] });
    });
    return { destroy: unsubscribe };
  });
}

export function latexSnippetsExtension(getTabId: () => string): Extension {
  return [
    // A repeated tabstop (`$1 … $1`) selects every copy at once; the facet
    // that allows it lives in `codeMirrorBaseSetup` (prosemark-core), next to
    // the `Mod-d` binding that also needs it.
    latexTabstopState,
    Prec.high(
      EditorView.inputHandler.of((view, from, to, text) => {
        if (view.composing || view.state.selection.ranges.length > 1) return false;
        if (vimBlocks(getTabId)) return false;
        if (!setting("latex.snippets-enabled") && !setting("latex.auto-fraction")) return false;
        return handleInput(view, from, to, text);
      }),
    ),
    Prec.highest(keymap.of(latexKeymap(getTabId))),
    vimWatcher(getTabId),
  ];
}
