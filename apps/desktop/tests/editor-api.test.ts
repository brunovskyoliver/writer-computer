import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

// Mock the tauri API before importing stores
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import type { EditorView } from "@codemirror/view";
import { useEditorStore } from "../src/stores/editor-store";
import * as editorApi from "../src/hooks/editor-api";
import { clearTabViewState, resetEditorViews, rewriteEditorPaths } from "../src/lib/editor-views";
import { createLayout } from "../src/lib/editor-layout";

/** A view stub: `insertAtCursor` and the registry only read `state` and call
 *  `dispatch`, so nothing here needs a DOM. */
function fakeView(head: number, lineText: string) {
  return {
    state: {
      selection: { main: { head } },
      doc: { lineAt: () => ({ from: 0, text: lineText }) },
    },
    dispatch: vi.fn(),
  } as unknown as EditorView;
}

function makeFileTab(id: string, currentPath: string) {
  return {
    id,
    location: { kind: "file" as const, path: currentPath },
    back: [],
    forward: [],
  };
}

describe("editorApi", () => {
  beforeEach(() => {
    resetEditorViews();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });
  });

  test("getOpenFiles returns current open files map", () => {
    const files = new Map([
      [
        "/test.md",
        {
          path: "/test.md",
          frontmatter: "",
          content: "hello",
          title: "",
          titleSource: "none",
          diskContent: "hello",
          isDirty: false,
          isLoading: false,
          saveError: null,
          reloadVersion: 0,
          displayDate: null,
          stats: { words: 0, characters: 0, paragraphs: 0 },
        },
      ],
    ]);
    useEditorStore.setState({ openFiles: files });
    expect(editorApi.getOpenFiles()).toBe(files);
  });

  test("getActiveFilePath returns current active file", () => {
    expect(editorApi.getActiveFilePath()).toBeNull();
    useEditorStore.setState({ activeFilePath: "/test.md" });
    expect(editorApi.getActiveFilePath()).toBe("/test.md");
  });

  test("closeFile delegates to store", () => {
    const files = new Map([
      [
        "/a.md",
        {
          path: "/a.md",
          frontmatter: "",
          content: "",
          title: "",
          titleSource: "none",
          diskContent: "",
          isDirty: false,
          isLoading: false,
          saveError: null,
          reloadVersion: 0,
          displayDate: null,
          stats: { words: 0, characters: 0, paragraphs: 0 },
        },
      ],
    ]);
    useEditorStore.setState({
      openFiles: files,
      tabs: [makeFileTab("tab-a", "/a.md")],
      activeTabId: "tab-a",
      activeFilePath: "/a.md",
    });

    editorApi.closeFile("/a.md");

    expect(useEditorStore.getState().openFiles.has("/a.md")).toBe(false);
    expect(useEditorStore.getState().tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
  });

  test("markSaved delegates to store", () => {
    const files = new Map([
      [
        "/a.md",
        {
          path: "/a.md",
          frontmatter: null,
          content: "modified",
          title: "",
          titleSource: "none",
          diskContent: "original",
          isDirty: true,
          isLoading: false,
          saveError: null,
          reloadVersion: 0,
          displayDate: null,
          stats: { words: 0, characters: 0, paragraphs: 0 },
        },
      ],
    ]);
    useEditorStore.setState({ openFiles: files });
    editorApi.markSaved("/a.md", "modified");
    expect(useEditorStore.getState().openFiles.get("/a.md")?.isDirty).toBe(false);
  });

  test("insertAtCursor returns false if view not registered", () => {
    expect(editorApi.insertAtCursor("/missing.md", "hello")).toBe(false);
  });

  test("insertAtCursor inserts text and ensures heading starts on clean line", () => {
    const view = fakeView(18, "Some existing line");
    editorApi.registerEditorView("tab-doc", "/doc.md", view);
    useEditorStore.setState({
      tabs: [makeFileTab("tab-doc", "/doc.md")],
      layout: createLayout(["tab-doc"], "tab-doc"),
      activeTabId: "tab-doc",
      activeFilePath: "/doc.md",
    });

    const inserted = editorApi.insertAtCursor("/doc.md", "### Title\n![[drawing.excalidraw.svg]]");
    expect(inserted).toBe(true);
    expect(view.dispatch).toHaveBeenCalledWith({
      changes: {
        from: 18,
        insert: "\n\n### Title\n![[drawing.excalidraw.svg]]",
      },
      selection: {
        anchor: 18 + "\n\n### Title\n![[drawing.excalidraw.svg]]".length,
      },
    });
  });

  test("two tabs can hold live views of the same document", () => {
    const first = fakeView(0, "shared");
    const second = fakeView(0, "shared");
    editorApi.registerEditorView("tab-1", "/shared.md", first);
    editorApi.registerEditorView("tab-2", "/shared.md", second);
    useEditorStore.setState({
      tabs: [makeFileTab("tab-1", "/shared.md"), makeFileTab("tab-2", "/shared.md")],
      layout: createLayout(["tab-1", "tab-2"], "tab-1"),
      activeTabId: "tab-1",
      activeFilePath: "/shared.md",
    });

    expect(editorApi.getEditorView("tab-1")).toBe(first);
    expect(editorApi.getEditorView("tab-2")).toBe(second);
    expect(editorApi.getEditorViewsForPath("/shared.md")).toEqual([first, second]);
  });

  test("path membership is derived, so retargeting one tab does not disturb the other", () => {
    const first = fakeView(0, "a");
    const second = fakeView(0, "a");
    editorApi.registerEditorView("tab-1", "/a.md", first);
    editorApi.registerEditorView("tab-2", "/a.md", second);
    useEditorStore.setState({
      tabs: [makeFileTab("tab-1", "/a.md"), makeFileTab("tab-2", "/a.md")],
      layout: createLayout(["tab-1", "tab-2"], "tab-1"),
      activeTabId: "tab-1",
      activeFilePath: "/a.md",
    });

    editorApi.retargetEditorView("tab-2", "/b.md");

    expect(editorApi.getEditorViewsForPath("/a.md")).toEqual([first]);
    expect(editorApi.getEditorViewsForPath("/b.md")).toEqual([second]);
  });

  test("an unregister from a superseded mount leaves the live view alone", () => {
    const outgoing = fakeView(0, "x");
    const incoming = fakeView(0, "x");
    const staleGeneration = editorApi.registerEditorView("tab-1", "/a.md", outgoing);
    editorApi.registerEditorView("tab-1", "/a.md", incoming);

    editorApi.unregisterEditorView("tab-1", staleGeneration);
    expect(editorApi.getEditorView("tab-1")).toBe(incoming);
  });

  test("a tab that changes panes keeps its registration", () => {
    const view = fakeView(0, "x");
    editorApi.registerEditorView("tab-1", "/a.md", view);
    useEditorStore.setState({
      tabs: [makeFileTab("tab-1", "/a.md")],
      layout: createLayout(["tab-1"], "tab-1"),
      activeTabId: "tab-1",
      activeFilePath: "/a.md",
    });

    // A move rewrites the tree; nothing unregisters, so the view survives.
    const { layout } = useEditorStore.getState();
    useEditorStore.setState({ layout: createLayout(["tab-1"], "tab-1", layout.revision + 1) });

    expect(editorApi.getEditorView("tab-1")).toBe(view);
  });

  test("a rename reindexes registrations and per-tab view state immediately", () => {
    const view = fakeView(0, "x");
    editorApi.registerEditorView("tab-1", "/dir/a.md", view);
    editorApi.setTabCursor("tab-1", "/dir/a.md", 7);
    useEditorStore.setState({
      tabs: [makeFileTab("tab-1", "/dir/a.md")],
      layout: createLayout(["tab-1"], "tab-1"),
      activeTabId: "tab-1",
      activeFilePath: "/dir/a.md",
    });

    rewriteEditorPaths((path) => path.replace("/dir/", "/moved/"));

    expect(editorApi.getEditorViewsForPath("/moved/a.md")).toEqual([view]);
    expect(editorApi.getEditorViewsForPath("/dir/a.md")).toEqual([]);
    expect(editorApi.getTabViewState("tab-1", "/moved/a.md").cursor).toBe(7);
  });

  test("a deleted tab's view state does not outlive it", () => {
    editorApi.setTabCursor("tab-1", "/a.md", 12);
    clearTabViewState("tab-1");
    expect(editorApi.getTabViewState("tab-1", "/a.md").cursor).toBe(0);
  });
});
