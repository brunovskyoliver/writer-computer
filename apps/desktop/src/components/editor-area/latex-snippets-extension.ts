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
import {
  expandSnippet,
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
    if (tr.isUserEvent("input.snippet")) lastExpansionAt = docChanges;

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

function setting(key: "latex.snippets-enabled" | "latex.tab-out" | "latex.auto-fraction"): boolean {
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

  const fraction =
    match === null && text === "/" && setting("latex.auto-fraction") && context.kind !== "prose"
      ? autoFraction(lineBefore)
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

  const replaceFrom = line.from + fraction!.operandFrom;
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
      key: "Backspace",
      run: (view: EditorView) => {
        if (vimBlocks(getTabId)) return false;
        const { lastExpansionAt, docChanges } = view.state.field(tabstopField);
        if (lastExpansionAt !== docChanges || undoDepth(view.state) === 0) return false;
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
