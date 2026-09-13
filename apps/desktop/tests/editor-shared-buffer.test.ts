import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// The save engine is the thing we are counting, so stub it wholesale. The
// editor store wires itself to the real module at import time; `registerSaveStore`
// is a no-op here because nothing in this file performs a write.
vi.mock("../src/lib/save", () => ({
  scheduleSave: vi.fn(),
  cancelSave: vi.fn(),
  isSaveInFlight: () => false,
  registerSaveStore: vi.fn(),
}));

import {
  EditorSelection,
  EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { publishEditorUpdate } from "../src/components/editor-area/editor-extensions";
import * as editorViews from "../src/lib/editor-views";
import * as editorApi from "../src/hooks/editor-api";
import { scheduleSave } from "../src/lib/save";
import { createLayout } from "../src/lib/editor-layout";
import { useEditorStore } from "../src/stores/editor-store";

const scheduledSaves = vi.mocked(scheduleSave);

/**
 * A stand-in for a mounted editor: it holds a real `EditorState` and *applies*
 * every transaction, so selection mapping, undo history, and change
 * composition are the genuine CodeMirror behavior. Only the DOM is missing,
 * and none of the shared-buffer logic touches it.
 */
interface TestView {
  state: EditorState;
  dispatch: (spec: TransactionSpec) => void;
  pending: Transaction[];
}

function mountView(doc: string): TestView {
  const view: TestView = {
    state: EditorState.create({ doc, extensions: [history()] }),
    pending: [],
    dispatch(spec) {
      const transaction = view.state.update(spec);
      view.state = transaction.state;
      view.pending.push(transaction);
    },
  };
  return view;
}

/** Feed a view's queued transactions through the same code the CodeMirror
 *  update listener runs, one update per transaction. */
function drain(view: TestView, path: string, tabId: string) {
  const transactions = view.pending.splice(0, view.pending.length);
  for (const transaction of transactions) {
    publishEditorUpdate(
      {
        docChanged: !transaction.changes.empty,
        selectionSet: transaction.selection !== undefined,
        transactions: [transaction],
        changes: transaction.changes,
        state: transaction.state,
        view: view as unknown as EditorView,
      },
      path,
      tabId,
    );
  }
}

function openDocument(path: string, content: string) {
  useEditorStore.setState({
    openFiles: new Map([
      [
        path,
        {
          path,
          frontmatter: null,
          content,
          title: "",
          titleSource: "none" as const,
          diskContent: content,
          isDirty: false,
          isLoading: false,
          saveError: null,
          reloadVersion: 0,
          displayDate: null,
          stats: { words: 0, characters: 0, paragraphs: 0 },
        },
      ],
    ]),
  });
}

/** Two tabs in two panes showing the same file, each with its own view. */
function openTwoViews(path: string, content: string) {
  const tabs = [
    { id: "tab-a", location: { kind: "file" as const, path }, back: [], forward: [] },
    { id: "tab-b", location: { kind: "file" as const, path }, back: [], forward: [] },
  ];
  openDocument(path, content);
  useEditorStore.setState({
    tabs,
    layout: createLayout(["tab-a", "tab-b"], "tab-a"),
    activeTabId: "tab-a",
    activeFilePath: path,
  });

  const a = mountView(content);
  const b = mountView(content);
  editorViews.registerEditorView("tab-a", path, a as unknown as EditorView);
  editorViews.registerEditorView("tab-b", path, b as unknown as EditorView);
  return { a, b };
}

const PATH = "/notes/shared.md";

describe("shared markdown buffer across duplicate views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorViews.resetEditorViews();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });
  });

  test("an edit in one view reaches its sibling synchronously", () => {
    const { a, b } = openTwoViews(PATH, "hello world");

    a.dispatch({ changes: { from: 5, insert: " there" } });
    drain(a, PATH, "tab-a");

    expect(b.state.doc.toString()).toBe("hello there world");
    expect(useEditorStore.getState().openFiles.get(PATH)?.content).toBe("hello there world");
  });

  test("the sibling's caret is mapped through the change, not copied", () => {
    const { a, b } = openTwoViews(PATH, "hello world");
    // B's caret sits after the insertion point, so it must shift right by the
    // inserted length rather than jumping to where A's caret is.
    b.dispatch({ selection: EditorSelection.cursor(11) });
    b.pending.length = 0;
    a.dispatch({ changes: { from: 0, insert: "XY" }, selection: EditorSelection.cursor(2) });
    drain(a, PATH, "tab-a");

    expect(b.state.selection.main.head).toBe(13);
    expect(a.state.selection.main.head).toBe(2);
  });

  test("one keystroke publishes one document update and one save, whatever the pane count", () => {
    const { a, b } = openTwoViews(PATH, "hello");
    const c = mountView("hello");
    editorViews.registerEditorView("tab-c", PATH, c as unknown as EditorView);

    a.dispatch({ changes: { from: 5, insert: "!" } });
    drain(a, PATH, "tab-a");
    // Whatever the siblings received must not republish — this is the loop the
    // sync annotation exists to break.
    drain(b, PATH, "tab-b");
    drain(c, PATH, "tab-c");

    expect(scheduledSaves).toHaveBeenCalledTimes(1);
    expect(scheduledSaves).toHaveBeenCalledWith(PATH);
    expect(b.state.doc.toString()).toBe("hello!");
    expect(c.state.doc.toString()).toBe("hello!");
  });

  test("undo stays local to the view that made the edit, mapped through the sibling's", () => {
    const { a, b } = openTwoViews(PATH, "");

    a.dispatch({ changes: { from: 0, insert: "A" }, selection: EditorSelection.cursor(1) });
    drain(a, PATH, "tab-a");
    b.dispatch({ changes: { from: 1, insert: "B" }, selection: EditorSelection.cursor(2) });
    drain(b, PATH, "tab-b");
    expect(a.state.doc.toString()).toBe("AB");

    undo(a as unknown as EditorView);
    drain(a, PATH, "tab-a");

    // A's undo removed A's own insert and left B's alone.
    expect(a.state.doc.toString()).toBe("B");
    expect(b.state.doc.toString()).toBe("B");

    redo(a as unknown as EditorView);
    drain(a, PATH, "tab-a");
    expect(b.state.doc.toString()).toBe("AB");
  });

  test("a synchronized transaction is recognizable as one", () => {
    const { a, b } = openTwoViews(PATH, "x");
    a.dispatch({ changes: { from: 1, insert: "y" } });
    drain(a, PATH, "tab-a");

    const received = b.pending.at(-1)!;
    expect(received.annotation(editorViews.syncTransaction)).toBe(true);
  });

  test("scroll and cursor are kept per tab, not per document", () => {
    openTwoViews(PATH, "hello world");

    editorApi.setTabCursor("tab-a", PATH, 3);
    editorApi.setTabScroll("tab-a", PATH, 120);
    editorApi.setTabCursor("tab-b", PATH, 9);

    expect(editorApi.getTabViewState("tab-a", PATH)).toMatchObject({ cursor: 3, scroll: 120 });
    expect(editorApi.getTabViewState("tab-b", PATH)).toMatchObject({ cursor: 9, scroll: 0 });
    // Nothing about the caret reaches the document.
    expect(useEditorStore.getState().openFiles.get(PATH)).not.toHaveProperty("cursorPos");
  });

  test("view state is dropped when its tab navigates elsewhere", () => {
    openTwoViews(PATH, "hello");
    editorApi.setTabCursor("tab-a", PATH, 4);

    expect(editorApi.getTabViewState("tab-a", "/other.md").cursor).toBe(0);
    expect(editorApi.getTabViewState("tab-a", PATH).cursor).toBe(4);
  });

  test("frontmatter edits stay on the document and dirty it once", () => {
    openTwoViews(PATH, "body");
    useEditorStore.getState().updateFrontmatter(PATH, "title: Shared");

    const file = useEditorStore.getState().openFiles.get(PATH)!;
    expect(file.frontmatter).toBe("title: Shared");
    expect(file.isDirty).toBe(true);
    expect(scheduledSaves).toHaveBeenCalledTimes(1);
  });

  test("insertAtCursor goes through the focused view and reaches the siblings", () => {
    const { a, b } = openTwoViews(PATH, "note");
    a.dispatch({ selection: EditorSelection.cursor(4) });
    a.pending.length = 0;

    expect(editorApi.insertAtCursor(PATH, " more")).toBe(true);
    drain(a, PATH, "tab-a");

    expect(a.state.doc.toString()).toBe("note more");
    expect(b.state.doc.toString()).toBe("note more");
    expect(useEditorStore.getState().openFiles.get(PATH)?.content).toBe("note more");
  });

  test("an external reload applies once to the document all views share", () => {
    openTwoViews(PATH, "old");
    const before = useEditorStore.getState().openFiles.get(PATH)!.reloadVersion;

    useEditorStore.getState().reloadFromDisk(PATH, "new from disk");

    const file = useEditorStore.getState().openFiles.get(PATH)!;
    expect(file.content).toBe("new from disk");
    expect(file.isDirty).toBe(false);
    expect(file.reloadVersion).toBe(before + 1);
  });

  test("closing one view leaves the other registered and editable", () => {
    const { a, b } = openTwoViews(PATH, "hello");
    const generation = editorViews.registerEditorView("tab-b", PATH, b as unknown as EditorView);

    editorViews.unregisterEditorView("tab-b", generation);

    expect(editorViews.getEditorView("tab-b")).toBeNull();
    expect(editorViews.getEditorView("tab-a")).not.toBeNull();

    a.dispatch({ changes: { from: 5, insert: "!" } });
    drain(a, PATH, "tab-a");
    expect(useEditorStore.getState().openFiles.get(PATH)?.content).toBe("hello!");
  });

  test("a stale unregister cannot drop the view that replaced it", () => {
    const view = mountView("hello");
    const stale = editorViews.registerEditorView("tab-x", PATH, view as unknown as EditorView);
    editorViews.registerEditorView("tab-x", PATH, view as unknown as EditorView);

    editorViews.unregisterEditorView("tab-x", stale);

    expect(editorViews.getEditorView("tab-x")).not.toBeNull();
  });
});
