import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { LatexCompileResult } from "../src/lib/latex-document";

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  root: vi.fn(),
  exists: vi.fn(),
  save: vi.fn(),
  notice: vi.fn(),
  saved: null as null | ((path: string) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));
vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("../src/lib/tauri")>()),
  compileLatex: mocks.compile,
  latexRoot: mocks.root,
  fileExists: mocks.exists,
}));
vi.mock("@/lib/save", async (original) => ({
  ...(await original<typeof import("../src/lib/save")>()),
  saveNow: mocks.save,
  onFileSaved: (listener: (path: string) => void) => {
    mocks.saved = listener;
    return () => {};
  },
}));
vi.mock("@/components/editor-area/editor-notice-store", () => ({ showEditorNotice: mocks.notice }));

import { useEditorStore } from "../src/stores/editor-store";
import { usePdfRevisionStore } from "../src/stores/pdf-revision-store";
import {
  compileLatexSource,
  compileLatexNow,
  ensureLatexAutoCompile,
  toggleLatexPreview,
  useLatexCompileStore,
} from "../src/stores/latex-compile-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const result = (status: "ok" | "failed" = "ok"): LatexCompileResult => ({
  status,
  root: "/w/main.tex",
  pdf_path: status === "ok" ? "/w/main.pdf" : null,
  diagnostics:
    status === "failed"
      ? [{ severity: "error", message: "old error", file: null, line: null }]
      : [],
  duration_ms: 12,
  log: "",
});
async function previewOpen() {
  await useEditorStore.getState().openFile("/w/main.pdf");
}

beforeEach(() => {
  useEditorStore.getState().resetEditorState();
  vi.resetAllMocks();
  mocks.compile.mockResolvedValue(result());
  mocks.root.mockResolvedValue("/w/main.tex");
  mocks.save.mockResolvedValue(true);
  mocks.exists.mockResolvedValue(true);
  ensureLatexAutoCompile();
});
afterEach(() => {
  useEditorStore.getState().resetEditorState();
  vi.useRealTimers();
});

test("editor reset clears builds, root mappings and PDF revision paths", async () => {
  await compileLatexSource("/w/chapter.tex");
  expect(useLatexCompileStore.getState().roots["/w/chapter.tex"]).toBe("/w/main.tex");
  expect(usePdfRevisionStore.getState().revisions["/w/main.pdf"]).toBe(1);
  useEditorStore.getState().resetEditorState();
  expect(useLatexCompileStore.getState().builds).toEqual({});
  expect(useLatexCompileStore.getState().roots).toEqual({});
  expect(usePdfRevisionStore.getState().revisions).toEqual({});
});

test.each(["ok", "failed"] as const)(
  "old %s compile and rerun cannot replace a new same-path build",
  async (status) => {
    const old = deferred<LatexCompileResult>();
    const current = deferred<LatexCompileResult>();
    mocks.compile.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = compileLatexSource("/w/main.tex");
    await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledTimes(1));
    void compileLatexSource("/w/main.tex");
    await vi.waitFor(() => expect(mocks.root).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    await Promise.resolve();
    useEditorStore.getState().resetEditorState();
    const next = compileLatexSource("/w/main.tex");
    await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledTimes(2));
    old.resolve(result(status));
    await first;
    expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("compiling");
    expect(usePdfRevisionStore.getState().revisions).toEqual({});
    expect(mocks.compile).toHaveBeenCalledTimes(2);
    const joined = compileLatexSource("/w/main.tex");
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.compile).toHaveBeenCalledTimes(2);
    current.resolve(result());
    await Promise.all([next, joined]);
    await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledTimes(3));
    expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("ok");
    expect(usePdfRevisionStore.getState().revisions["/w/main.pdf"]).toBe(2);
  },
);

test("reset cancels an already scheduled auto compile", async () => {
  vi.useFakeTimers();
  await previewOpen();
  mocks.saved!("/w/chapter.tex");
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  useEditorStore.getState().resetEditorState();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.compile).not.toHaveBeenCalled();
});

test("a root lookup finishing after reset cannot restore roots or schedule an auto compile", async () => {
  vi.useFakeTimers();
  await previewOpen();
  const root = deferred<string>();
  mocks.root.mockReturnValueOnce(root.promise);
  mocks.saved!("/w/chapter.tex");
  useEditorStore.getState().resetEditorState();
  await previewOpen();
  root.resolve("/w/main.tex");
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(useLatexCompileStore.getState().roots).toEqual({});
});

test.each(["ok", "failed"] as const)(
  "a preview command finishing with %s after reset does not reopen a PDF or show an old failure",
  async (status) => {
    const old = deferred<LatexCompileResult>();
    mocks.compile.mockReturnValueOnce(old.promise);
    const command = toggleLatexPreview("/w/main.tex", "source");
    await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledOnce());
    useEditorStore.getState().resetEditorState();
    old.resolve(result(status));
    await command;
    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(mocks.notice).not.toHaveBeenCalled();
  },
);

test("reset during an explicit command save prevents compilation", async () => {
  const saving = deferred<boolean>();
  mocks.save.mockReturnValueOnce(saving.promise);
  const command = compileLatexNow("/w/main.tex", "source");
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  useEditorStore.getState().resetEditorState();
  saving.resolve(true);
  await command;
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(mocks.notice).not.toHaveBeenCalled();
});

test("reset during a fallback PDF existence lookup prevents opening and stale notices", async () => {
  mocks.compile.mockResolvedValueOnce(result("failed"));
  const exists = deferred<boolean>();
  mocks.exists.mockReturnValueOnce(exists.promise);
  const command = toggleLatexPreview("/w/main.tex", "source");
  await vi.waitFor(() => expect(mocks.exists).toHaveBeenCalledOnce());
  useEditorStore.getState().resetEditorState();
  exists.resolve(true);
  await command;
  expect(useEditorStore.getState().tabs).toEqual([]);
  expect(mocks.notice).not.toHaveBeenCalled();
});

test("reset during the preview command save prevents compilation and opening", async () => {
  const saving = deferred<boolean>();
  mocks.save.mockReturnValueOnce(saving.promise);
  const command = toggleLatexPreview("/w/main.tex", "source");
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  useEditorStore.getState().resetEditorState();
  saving.resolve(true);
  await command;
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(useEditorStore.getState().tabs).toEqual([]);
});

test.each([
  ["compile", compileLatexNow],
  ["preview", toggleLatexPreview],
] as const)(
  "%s stops after a failed save without compiling or opening a PDF",
  async (_name, command) => {
    mocks.save.mockResolvedValueOnce(false);
    await command("/w/main.tex", "source");
    expect(mocks.save).toHaveBeenCalledWith("/w/main.tex");
    expect(mocks.compile).not.toHaveBeenCalled();
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(usePdfRevisionStore.getState().revisions).toEqual({});
  },
);

test("an automatic root lookup joins a pending preview request without canceling it", async () => {
  const lookup = deferred<string>();
  mocks.root.mockReturnValueOnce(lookup.promise);
  const preview = toggleLatexPreview("/w/chapter.tex", "source");
  expect(mocks.root).toHaveBeenCalledOnce();
  mocks.saved!("/w/chapter.tex");
  expect(mocks.root).toHaveBeenCalledOnce();
  lookup.resolve("/w/main.tex");
  await preview;
  expect(mocks.compile).toHaveBeenCalledOnce();
  expect(mocks.root).toHaveBeenCalledTimes(2);
  expect(
    useEditorStore
      .getState()
      .tabs.some((tab) => tab.location.kind === "pdf" && tab.location.path === "/w/main.pdf"),
  ).toBe(true);
});

test("a preview root lookup failure is reported without rejecting the command", async () => {
  mocks.root.mockRejectedValueOnce(new Error("lookup unavailable"));
  await expect(toggleLatexPreview("/w/chapter.tex", "source")).resolves.toBeUndefined();
  expect(mocks.notice).toHaveBeenCalledWith(
    expect.stringContaining("lookup unavailable"),
    "source",
  );
  expect(useLatexCompileStore.getState().builds["/w/chapter.tex"]?.state).toBe("failed");
});

test("an automatic root lookup failure publishes diagnostics without an unhandled rejection", async () => {
  mocks.root.mockRejectedValueOnce(new Error("auto lookup unavailable"));
  mocks.saved!("/w/chapter.tex");
  await vi.waitFor(() =>
    expect(useLatexCompileStore.getState().builds["/w/chapter.tex"]?.state).toBe("failed"),
  );
  expect(
    useLatexCompileStore.getState().builds["/w/chapter.tex"]?.diagnostics[0]?.message,
  ).toContain("auto lookup unavailable");
  expect(mocks.compile).not.toHaveBeenCalled();
});
