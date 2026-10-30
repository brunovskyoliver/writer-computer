import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));
vi.mock("../src/lib/preferences", () => ({
  getPreference: vi.fn(async (_key: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import { setPreference } from "../src/lib/preferences";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { useSettingsStore } from "../src/stores/settings-store";

const records = new Map<string, unknown>();
const openPaths = () =>
  useEditorStore
    .getState()
    .tabs.map((tab) => (tab.location as { path?: string }).path)
    .filter(Boolean);

beforeEach(async () => {
  records.clear();
  vi.clearAllMocks();
  vi.stubGlobal("document", { body: { inert: false } });
  useEditorStore.getState().resetEditorState();
  useWorkspaceStore.setState({
    root: "/vault",
    workspaceEpoch: 1,
    layouts: [],
    activeLayout: null,
  });
  // Layouts are explicit user data, so they work with session restore turned off.
  useSettingsStore.setState({ settings: { "workspace.restore-open-files": false } });
  vi.mocked(invoke).mockImplementation(async (command, payload) => {
    const args = payload as { workspaceRoot: string; session: unknown; path: string };
    if (command === "read_file") return { path: args.path, content: args.path, modified_at: 0 };
    if (command === "save_session") {
      if (args.session === null) records.delete(args.workspaceRoot);
      else records.set(args.workspaceRoot, args.session);
    }
    if (command === "load_session") {
      const session = records.get(args.workspaceRoot);
      return session ? { status: "ready", session } : { status: "missing" };
    }
    return null;
  });
  await useEditorStore.getState().openFile("/vault/a.md");
});

afterEach(() => {
  useEditorStore.getState().resetEditorState();
  useWorkspaceStore.setState({ root: null, layouts: [], activeLayout: null });
  vi.unstubAllGlobals();
});

test("switching keeps each layout's tabs, including changes made since saving", async () => {
  const store = useWorkspaceStore.getState();
  await store.saveLayoutAs(" Math ");
  expect(useWorkspaceStore.getState()).toMatchObject({ layouts: ["Math"], activeLayout: "Math" });
  expect(records.has("/vault#layout:Math")).toBe(true);

  await useEditorStore.getState().openFileInNewTab("/vault/b.md");
  await store.saveLayoutAs("Physics");
  await store.openLayout("Math");
  expect(openPaths()).toEqual(["/vault/a.md"]);
  expect(useWorkspaceStore.getState().activeLayout).toBe("Math");

  await useEditorStore.getState().openFileInNewTab("/vault/c.md");
  await store.openLayout("Physics");
  expect(openPaths()).toEqual(["/vault/a.md", "/vault/b.md"]);

  await store.openLayout("Math");
  expect(openPaths()).toEqual(["/vault/a.md", "/vault/c.md"]);
  expect(setPreference).toHaveBeenLastCalledWith("workspace:/vault:layouts", {
    names: ["Math", "Physics"],
    active: "Math",
  });
});

test("a layout whose files are gone leaves the window and active layout alone", async () => {
  const store = useWorkspaceStore.getState();
  await store.saveLayoutAs("Math");
  useWorkspaceStore.setState({ layouts: ["Math", "Gone"] });
  await store.openLayout("Gone");
  expect(openPaths()).toEqual(["/vault/a.md"]);
  expect(useWorkspaceStore.getState().activeLayout).toBe("Math");
});

test("delete removes the record and clears the active name", async () => {
  const store = useWorkspaceStore.getState();
  await store.saveLayoutAs("Math");
  await store.deleteLayout("Math");
  expect(records.has("/vault#layout:Math")).toBe(false);
  expect(useWorkspaceStore.getState()).toMatchObject({ layouts: [], activeLayout: null });
});

test("names that would corrupt the session key are rejected", async () => {
  const store = useWorkspaceStore.getState();
  await expect(store.saveLayoutAs("a/")).rejects.toThrow("contain /");
  await expect(store.saveLayoutAs("  ")).rejects.toThrow("empty");
  expect(records.size).toBe(0);
});
