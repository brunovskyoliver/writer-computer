import { afterEach, expect, test, vi } from "vite-plus/test";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useLatexCompileStore, ensureLatexAutoCompile } from "../src/stores/latex-compile-store";
import { saveNow, cancelSave, onFileSaved } from "../src/lib/save";

const path = "/w/main.tex";
afterEach(() => {
  cancelSave(path);
  useEditorStore.getState().resetEditorState();
  vi.useRealTimers();
});

test.each([false, true])(
  "a pre-reset save cannot publish into a reopened same-path buffer (failure=%s)",
  async (failure) => {
    vi.useFakeTimers();
    useEditorStore.getState().resetEditorState();
    useSettingsStore.setState({ settings: { "files.insert-final-newline": false } });
    let disk = "old disk";
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const written = vi.fn();
    const unsubscribe = onFileSaved(written);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_file") return { path, content: disk, modified_at: 1 };
      if (command === "write_file") {
        await gate;
        if (failure) throw new Error("old write failed");
        return { path, modified_at: 2 };
      }
      if (command === "latex_root") return path;
      return null;
    });
    ensureLatexAutoCompile();
    await useEditorStore.getState().openFile(path);
    useEditorStore.getState().updateContent(path, "old edited bytes");
    const save = saveNow(path);
    useEditorStore.getState().resetEditorState();
    disk = "new disk";
    await useEditorStore.getState().openFile(path);
    await useEditorStore.getState().openFile("/w/main.pdf");
    finish();
    await save;
    const file = useEditorStore.getState().openFiles.get(path)!;
    expect(file.diskContent).toBe("new disk");
    expect(file.saveError).toBeNull();
    expect(written).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(useLatexCompileStore.getState().roots).toEqual({});
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "compile_latex")).toBe(
      false,
    );
    unsubscribe();
  },
);
