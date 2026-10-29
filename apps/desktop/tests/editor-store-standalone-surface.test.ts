import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { activeDocumentPath, locationForPath, useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { withDrawingSourceRename } from "../src/hooks/editor-api";
import { createLayout } from "../src/lib/editor-layout";

/**
 * The acceptance bar for the R4 refactor (SPECs/pdf-quote-links tasks T009):
 * every behavior a drawing had when the rule was four `isDrawingPath` checks
 * still holds now that it is one registry-derived predicate.
 *
 * The PDF half (T012) rides along: the same predicate has to place two
 * different standalone kinds side by side, which is the case a boolean-matched
 * reuse branch gets wrong.
 */

const mockedInvoke = vi.mocked(invoke);
const DRAWING = "/ws/sketch.excalidraw.svg";
const PDF = "/ws/paper.pdf";

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    layout: createLayout(),
    activeTabId: null,
    activeFilePath: null,
  });
  useWorkspaceStore.setState({ chromeMode: "workspace" });
});

describe("locationForPath is the only extension dispatch", () => {
  test("a drawing path builds a drawing location, everything else a file", () => {
    expect(locationForPath(DRAWING)).toEqual({ kind: "drawing", path: DRAWING });
    expect(locationForPath("/ws/note.md")).toEqual({ kind: "file", path: "/ws/note.md" });
    // A plain SVG is an image, not a surface.
    expect(locationForPath("/ws/logo.svg")).toEqual({ kind: "file", path: "/ws/logo.svg" });
  });

  test("a pdf path builds a pdf location starting at page 1", () => {
    expect(locationForPath(PDF)).toEqual({ kind: "pdf", path: PDF, page: 1 });
    expect(locationForPath("/ws/PAPER.PDF")).toEqual({
      kind: "pdf",
      path: "/ws/PAPER.PDF",
      page: 1,
    });
    // No stem, no document.
    expect(locationForPath("/ws/.pdf")).toEqual({ kind: "file", path: "/ws/.pdf" });
  });
});

describe("standalone surfaces open in a tab of their own", () => {
  test("a drawing opened from a note leaves the note's tab in place", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/ws/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/ws/a.md");
    await useEditorStore.getState().navigateToFile(DRAWING);

    const state = useEditorStore.getState();
    expect(state.tabs.map((tab) => tab.location)).toEqual([
      { kind: "file", path: "/ws/a.md" },
      { kind: "drawing", path: DRAWING },
    ]);
    expect(state.activeTabId).toBe(state.tabs[1]!.id);
  });

  test("a drawing never enters openFiles or becomes activeFilePath", async () => {
    await useEditorStore.getState().openFile(DRAWING);
    const state = useEditorStore.getState();
    expect(state.openFiles.has(DRAWING)).toBe(false);
    expect(state.activeFilePath).toBeNull();
    // `ensureFileLoaded` must not have read it as markdown.
    expect(mockedInvoke).not.toHaveBeenCalledWith("read_file", expect.anything());
  });

  test("an already-open surface is focused, not opened a second time", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/ws/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/ws/a.md");
    await useEditorStore.getState().navigateToFile(DRAWING);

    const surfaceTabId = useEditorStore.getState().tabs[1]!.id;
    useEditorStore.getState().setActiveTab(useEditorStore.getState().tabs[0]!.id);
    await useEditorStore.getState().openFile(DRAWING);

    const state = useEditorStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(surfaceTabId);
  });

  test("two different surfaces each get their own tab", async () => {
    const other = "/ws/other.excalidraw.svg";
    await useEditorStore.getState().openFile(DRAWING);
    await useEditorStore.getState().openFile(other);

    // The reuse match is on kind *and* path. A predicate that matched on "is a
    // standalone surface" alone would find the first tab and refuse the second.
    expect(useEditorStore.getState().tabs.map((tab) => tab.location)).toEqual([
      { kind: "drawing", path: DRAWING },
      { kind: "drawing", path: other },
    ]);
  });

  test("a pdf never enters openFiles or becomes activeFilePath", async () => {
    await useEditorStore.getState().openFile(PDF);
    const state = useEditorStore.getState();
    expect(state.openFiles.has(PDF)).toBe(false);
    expect(state.activeFilePath).toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalledWith("read_file", expect.anything());
  });

  test("a pdf and a drawing coexist, and neither opens twice", async () => {
    await useEditorStore.getState().openFile(DRAWING);
    await useEditorStore.getState().openFile(PDF);
    const pdfTabId = useEditorStore.getState().tabs[1]!.id;

    // Reuse matches on kind *and* path. A boolean match would find the drawing
    // tab first and either refuse the PDF or focus the wrong surface.
    useEditorStore.getState().setActiveTab(useEditorStore.getState().tabs[0]!.id);
    await useEditorStore.getState().navigateToFile(PDF);

    const state = useEditorStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(pdfTabId);
  });

  test("a surface opened into an empty window lands in one tab, not a bounce", async () => {
    await useEditorStore.getState().navigateToFile(DRAWING);
    expect(useEditorStore.getState().tabs.map((tab) => tab.location)).toEqual([
      { kind: "drawing", path: DRAWING },
    ]);
  });

  test("navigating between notes still replaces the tab and records history", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/ws/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/ws/b.md", content: "b", modified_at: 2 });
    await useEditorStore.getState().openFile("/ws/a.md");
    await useEditorStore.getState().navigateToFile("/ws/b.md");

    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      location: { kind: "file", path: "/ws/b.md" },
      back: [{ kind: "file", path: "/ws/a.md" }],
    });
  });
});

describe("the pdf page write-back", () => {
  test("updates the location in place and never touches nav history", async () => {
    await useEditorStore.getState().openFile(PDF);
    const tabId = useEditorStore.getState().tabs[0]!.id;

    useEditorStore.getState().setPdfPage(tabId, 7);

    const tab = useEditorStore.getState().tabs[0]!;
    expect(tab.location).toEqual({ kind: "pdf", path: PDF, page: 7 });
    // Scrolling is not navigating: filling `back` here would break Back.
    expect(tab.back).toEqual([]);
    expect(tab.forward).toEqual([]);
  });

  test("an unchanged page is a no-op, so a repeated settle costs nothing", async () => {
    await useEditorStore.getState().openFile(PDF);
    const tabId = useEditorStore.getState().tabs[0]!.id;
    useEditorStore.getState().setPdfPage(tabId, 3);

    const before = useEditorStore.getState().tabs;
    useEditorStore.getState().setPdfPage(tabId, 3);
    expect(useEditorStore.getState().tabs).toBe(before);
  });

  test("a non-pdf tab is left alone", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/ws/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/ws/a.md");
    const tabId = useEditorStore.getState().tabs[0]!.id;

    useEditorStore.getState().setPdfPage(tabId, 4);
    expect(useEditorStore.getState().tabs[0]!.location).toEqual({
      kind: "file",
      path: "/ws/a.md",
    });
  });
});

describe("Obsidian drawing routing", () => {
  const original = "/ws/Sketch.excalidraw.md";

  test.each(["openFile", "openFileInNewTab", "openCompactFile", "replaceTabWithFile"] as const)(
    "%s never publishes a Markdown buffer for a drawing",
    async (route) => {
      useEditorStore.getState().ensureLauncherTab();
      const launcherId = useEditorStore.getState().activeTabId!;
      const buffers: string[][] = [];
      const unsubscribe = useEditorStore.subscribe((state) => {
        buffers.push([...state.openFiles.keys()]);
      });
      try {
        if (route === "replaceTabWithFile") {
          await useEditorStore.getState().replaceTabWithFile(launcherId, original);
        } else if (route === "openCompactFile") {
          await useEditorStore.getState().openCompactFile(original, {
            path: original,
            content: "# Original scene wrapper",
            modified_at: 1,
          });
        } else {
          await useEditorStore.getState()[route](original);
        }
        const state = useEditorStore.getState();
        expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.location).toEqual({
          kind: "drawing",
          path: original,
        });
        expect(state.activeFilePath).toBeNull();
        expect(activeDocumentPath(state)).toBe(original);
        expect(buffers.flat()).not.toContain(original);
        expect(mockedInvoke).not.toHaveBeenCalledWith("read_file", expect.anything());
      } finally {
        unsubscribe();
      }
    },
  );

  test("runtime restore normalizes current and history drawings before publishing or prefetching", async () => {
    const back = "/ws/Back.excalidraw.md";
    const forward = "/ws/Forward.excalidraw.svg";
    const buffers: string[][] = [];
    const unsubscribe = useEditorStore.subscribe((state) =>
      buffers.push([...state.openFiles.keys()]),
    );
    try {
      await useEditorStore.getState().restoreSession(
        {
          tabs: [
            {
              id: "legacy",
              location: { kind: "file", path: original },
              back: [
                { kind: "pdf", path: PDF, page: 9 },
                { kind: "file", path: back },
              ],
              forward: [{ kind: "file", path: forward }],
            },
          ],
          layout: createLayout(["legacy"], "legacy"),
        },
        { path: original, content: "# Original scene wrapper", modified_at: 1 },
      );
      expect(buffers.flat()).toEqual([]);
      expect(useEditorStore.getState().tabs[0]).toMatchObject({
        location: { kind: "drawing", path: original },
        back: [
          { kind: "pdf", path: PDF, page: 9 },
          { kind: "drawing", path: back },
        ],
        forward: [{ kind: "drawing", path: forward }],
      });
      await useEditorStore.getState().navigateBack();
      expect(activeDocumentPath(useEditorStore.getState())).toBe(back);
      expect(useEditorStore.getState().activeFilePath).toBeNull();
      await useEditorStore.getState().navigateBack();
      expect(useEditorStore.getState().tabs[0]?.location).toEqual({
        kind: "pdf",
        path: PDF,
        page: 9,
      });
      await useEditorStore.getState().navigateForward();
      expect(activeDocumentPath(useEditorStore.getState())).toBe(back);
      expect(mockedInvoke).not.toHaveBeenCalledWith("read_file", expect.anything());
    } finally {
      unsubscribe();
    }
  });
});

test("renaming a note to an Obsidian source flushes edits before removing its text buffer", async () => {
  const oldPath = "/ws/sketch.md",
    newPath = "/ws/sketch.excalidraw.md";
  mockedInvoke.mockImplementation(async (command, args) => {
    if (command === "read_file") return { path: oldPath, content: "old", modified_at: 1 };
    if (command === "write_file") return { path: (args as { path: string }).path, modified_at: 2 };
    return undefined;
  });
  await useEditorStore.getState().openFile(oldPath);
  useEditorStore.getState().updateContent(oldPath, "latest draft");
  expect(() => useEditorStore.getState().renameOpenFile(oldPath, newPath)).toThrow(
    "Save this note",
  );
  expect(useEditorStore.getState().openFiles.get(oldPath)?.content).toBe("latest draft");
  await withDrawingSourceRename(oldPath, newPath, async () => {
    expect(useEditorStore.getState().openFiles.get(oldPath)?.isDirty).toBe(false);
    useEditorStore.getState().renameOpenFile(oldPath, newPath);
  });
  expect(useEditorStore.getState().openFiles.size).toBe(0);
  expect(useEditorStore.getState().tabs[0]!.location).toEqual({ kind: "drawing", path: newPath });
  const writes = mockedInvoke.mock.calls.filter(([command]) => command === "write_file");
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every(([, args]) => (args as { path: string }).path === oldPath)).toBe(true);
});

test("a failed save prevents a source-format rename from touching disk", async () => {
  const path = "/ws/sketch.md";
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "read_file") return { path, content: "old", modified_at: 1 };
    if (command === "write_file") throw "disk full";
    return undefined;
  });
  await useEditorStore.getState().openFile(path);
  useEditorStore.getState().updateContent(path, "keep me");
  const rename = vi.fn();
  await expect(withDrawingSourceRename(path, "/ws/sketch.excalidraw.md", rename)).rejects.toThrow(
    "Save this note",
  );
  expect(rename).not.toHaveBeenCalled();
  expect(useEditorStore.getState().openFiles.get(path)?.content).toBe("keep me");
});
