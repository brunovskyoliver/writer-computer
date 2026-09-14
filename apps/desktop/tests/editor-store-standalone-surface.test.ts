import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { locationForPath, useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { createLayout } from "../src/lib/editor-layout";

/**
 * The acceptance bar for the R4 refactor (SPECs/pdf-quote-links tasks T009):
 * every behavior a drawing had when the rule was four `isDrawingPath` checks
 * still holds now that it is one registry-derived predicate.
 *
 * The PDF half of this file is deliberately absent until T012 registers the
 * `pdf` page kind — a stubbed kind would test the stub, not the registry.
 */

const mockedInvoke = vi.mocked(invoke);
const DRAWING = "/ws/sketch.excalidraw.svg";

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
