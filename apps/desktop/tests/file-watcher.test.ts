import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { isWorkspaceEventCurrent } from "../src/lib/workspace-events";
import identityContract from "../shared/workspace-identity.contract.json";

describe("workspace watcher event routing", () => {
  test("shares the serialized workspace identity contract", () => {
    expect(identityContract).toEqual({ root: "/workspace", epoch: 7 });
  });

  test("rejects stale workspace events after switches and close", () => {
    const first = { root: "/workspace-a", epoch: 1 };
    expect(isWorkspaceEventCurrent(first, first)).toBe(true);
    expect(isWorkspaceEventCurrent(first, { root: "/workspace-b", epoch: 2 })).toBe(false);
    expect(isWorkspaceEventCurrent(first, null)).toBe(false);
    expect(isWorkspaceEventCurrent(first, { root: "/workspace-a", epoch: 3 })).toBe(false);
  });

  test("keeps unscoped standalone-file events", () => {
    expect(isWorkspaceEventCurrent(null, null)).toBe(true);
  });

  test("keeps unscoped global events while a workspace is open", () => {
    // The global config watcher emits `workspace: null` for the LaTeX snippet
    // file to every window, including ones showing a workspace; those windows
    // must still reload the open tab (SPECs/latex-suite, US2).
    expect(isWorkspaceEventCurrent(null, { root: "/workspace-a", epoch: 1 })).toBe(true);
  });
});

vi.mock("react", () => ({ useEffect: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/stores/workspace-store", () => ({
  useWorkspaceStore: { getState: () => ({ root: "/workspace", workspaceEpoch: 7 }) },
}));
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ loadSettings }) },
}));
vi.mock("@/stores/latex-snippet-store", () => ({ startLatexSnippetSubscriptions: () => () => {} }));
vi.mock("@/hooks/editor-api", () => ({}));
vi.mock("@/lib/tauri", () => ({}));
vi.mock("@/lib/save", () => ({}));

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useFileWatcher } from "../src/hooks/use-file-watcher";

const { loadSettings } = vi.hoisted(() => ({ loadSettings: vi.fn(async () => {}) }));

afterEach(() => vi.clearAllMocks());

test("global settings events reload settings in a workspace window and clean up the listener", async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  useFileWatcher();
  const cleanup = vi.mocked(useEffect).mock.calls[0]![0]();
  const handler = vi.mocked(listen).mock.calls.find(([name]) => name === "settings:changed")![1];
  try {
    handler({ event: "settings:changed", id: 1, payload: null });
    expect(loadSettings).toHaveBeenCalledTimes(1);
    handler({ event: "settings:changed", id: 2, payload: { root: "/old", epoch: 6 } });
    expect(loadSettings).toHaveBeenCalledTimes(1);
    handler({ event: "settings:changed", id: 3, payload: { root: "/workspace", epoch: 7 } });
    expect(loadSettings).toHaveBeenCalledTimes(2);
  } finally {
    if (cleanup) cleanup();
    await Promise.resolve();
  }
  expect(unlisten).toHaveBeenCalledTimes(5);
});
