import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

// Mock the tauri API before importing stores
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import type { EditorView } from "@codemirror/view";
import { useEditorStore } from "../src/stores/editor-store";
import * as editorApi from "../src/hooks/editor-api";

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
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
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
          scrollPos: 0,
          cursorPos: 0,
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
          scrollPos: 0,
          cursorPos: 0,
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
          scrollPos: 0,
          cursorPos: 0,
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
    const fakeState = {
      selection: { main: { head: 18 } },
      doc: {
        lineAt: () => ({ from: 0, text: "Some existing line" }),
      },
    };
    const fakeView = {
      state: fakeState,
      dispatch: vi.fn(),
    } as unknown as EditorView;
    editorApi.setEditorView("/doc.md", fakeView);

    const inserted = editorApi.insertAtCursor("/doc.md", "### Title\n![[drawing.excalidraw.svg]]");
    expect(inserted).toBe(true);
    expect(fakeView.dispatch).toHaveBeenCalledWith({
      changes: {
        from: 18,
        insert: "\n\n### Title\n![[drawing.excalidraw.svg]]",
      },
      selection: {
        anchor: 18 + "\n\n### Title\n![[drawing.excalidraw.svg]]".length,
      },
    });

    editorApi.clearEditorView(fakeView);
  });
});
