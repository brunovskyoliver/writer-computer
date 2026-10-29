import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../src/stores/editor-store";

const mockedInvoke = vi.mocked(invoke);

beforeAll(async () => {
  vi.stubGlobal("window", {});
  await import("../src/lib/global-recents");
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  useEditorStore.getState().resetEditorState();
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
});

test("drawing focus updates recents even while activeFilePath remains null", async () => {
  const original = "/vault/Original.excalidraw.md";
  const copy = "/vault/Original.excalidraw.svg";
  await useEditorStore.getState().openFile(original);
  const originalTab = useEditorStore.getState().activeTabId!;
  await useEditorStore.getState().openFile(copy);
  useEditorStore.getState().setActiveTab(originalTab);
  useEditorStore.getState().setActiveTab(originalTab);

  expect(useEditorStore.getState().activeFilePath).toBeNull();
  expect(
    mockedInvoke.mock.calls
      .filter(([command]) => command === "record_recent_file")
      .map(([, args]) => args),
  ).toEqual([{ path: original }, { path: copy }, { path: original }]);
});
