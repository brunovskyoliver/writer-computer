import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { LatexCompileResult } from "../src/lib/latex-document";

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  read: vi.fn(),
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
  readFile: mocks.read,
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
import { paneOfTab } from "../src/lib/editor-layout";
import {
  compileLatexSource,
  ensureLatexAutoCompile,
  toggleLatexPreview,
  useLatexCompileStore,
} from "../src/stores/latex-compile-store";

const source = "/w/chapter.tex";
function result(root = "/w/main.tex", status: "ok" | "failed" = "ok"): LatexCompileResult {
  return {
    status,
    root,
    pdf_path: status === "ok" ? root.replace(/\.tex$/, ".pdf") : null,
    diagnostics:
      status === "failed"
        ? [{ severity: "error", message: "bad document", file: null, line: null }]
        : [],
    duration_ms: 12,
    log: "",
  };
}
function pdfs() {
  return useEditorStore
    .getState()
    .tabs.flatMap((tab) => (tab.location.kind === "pdf" ? [tab.location.path] : []));
}
async function openPdf(path = "/w/main.pdf") {
  await useEditorStore.getState().openFile(path);
}
function closePdfs() {
  for (const tab of useEditorStore.getState().tabs) {
    if (tab.location.kind === "pdf") useEditorStore.getState().closeTab(tab.id);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  useEditorStore.getState().resetEditorState();
  vi.resetAllMocks();
  mocks.root.mockResolvedValue("/w/main.tex");
  mocks.compile.mockResolvedValue(result());
  mocks.save.mockResolvedValue(true);
  mocks.read.mockImplementation(async (path: string) => ({
    path,
    content: "\\documentclass{article}",
    modified_at: 1,
  }));
  mocks.exists.mockResolvedValue(true);
  ensureLatexAutoCompile();
});
afterEach(() => {
  useEditorStore.getState().resetEditorState();
  vi.useRealTimers();
});

test("preview saves the changed root before lookup and leaves the old PDF open", async () => {
  useLatexCompileStore.setState({ roots: { [source]: "/w/old.tex" } });
  await openPdf("/w/old.pdf");
  let saved = false;
  mocks.save.mockImplementation(async () => {
    saved = true;
    return true;
  });
  mocks.root.mockImplementation(async () => (saved ? "/w/new.tex" : "/w/old.tex"));
  mocks.compile.mockResolvedValue(result("/w/new.tex"));
  await toggleLatexPreview(source, "source");
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(pdfs()).toEqual(expect.arrayContaining(["/w/old.pdf", "/w/new.pdf"]));
  expect(useLatexCompileStore.getState().roots[source]).toBe("/w/new.tex");
});

test("preview toggle closes only the freshly resolved root's PDF", async () => {
  useLatexCompileStore.setState({ roots: { [source]: "/w/old.tex" } });
  await openPdf("/w/old.pdf");
  await openPdf("/w/new.pdf");
  mocks.root.mockResolvedValue("/w/new.tex");
  await toggleLatexPreview(source, "source");
  expect(pdfs()).toEqual(["/w/old.pdf"]);
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.compile).not.toHaveBeenCalled();
});

test("a native root migration opens the PDF returned by the build", async () => {
  mocks.compile.mockResolvedValue({ ...result("/w/other.tex"), pdf_path: "/w/build/output.pdf" });
  await toggleLatexPreview(source, "source");
  expect(pdfs()).toEqual(["/w/build/output.pdf"]);
  expect(usePdfRevisionStore.getState().revisions["/w/build/output.pdf"]).toBe(1);
  expect(usePdfRevisionStore.getState().revisions["/w/other.pdf"]).toBeUndefined();
  expect(mocks.exists).not.toHaveBeenCalled();
});

test.each([false, true])(
  "a migrated preview keeps its source active with other tabs=%s",
  async (otherTabs) => {
    const tab = await useEditorStore.getState().openFile(source);
    expect(tab).not.toBeNull();
    if (otherTabs) {
      await openPdf("/w/old.pdf");
      useEditorStore.getState().setActiveTab(tab!.id);
    }
    const origin = paneOfTab(useEditorStore.getState().layout, tab!.id)!;
    mocks.compile.mockResolvedValue(result("/w/other.tex"));
    await toggleLatexPreview(source, tab!.id);
    const state = useEditorStore.getState();
    const pdf = state.tabs.find(
      (item) => item.location.kind === "pdf" && item.location.path === "/w/other.pdf",
    );
    expect(pdf?.location).toMatchObject({ kind: "pdf", path: "/w/other.pdf" });
    expect(paneOfTab(state.layout, pdf!.id)?.id).not.toBe(origin.id);
    expect(state.layout.focusedPaneId).toBe(origin.id);
    expect(paneOfTab(state.layout, tab!.id)?.activeTabId).toBe(tab!.id);
  },
);

test.each([true, false])(
  "a failed migrated build checks only its own PDF (exists=%s)",
  async (exists) => {
    mocks.compile.mockResolvedValue(result("/w/other.tex", "failed"));
    mocks.exists.mockImplementation(async (path: string) =>
      path === "/w/other.pdf" ? exists : true,
    );
    await toggleLatexPreview(source, "source");
    expect(mocks.exists).toHaveBeenCalledExactlyOnceWith("/w/other.pdf");
    expect(pdfs()).toEqual(exists ? ["/w/other.pdf"] : []);
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining("bad document"), "source");
  },
);

test("a missing actual root cannot fall back to the previous PDF", async () => {
  mocks.compile.mockResolvedValue({
    ...result("/w/main.tex", "failed"),
    status: "no-root",
    root: null,
  });
  await toggleLatexPreview(source, "source");
  expect(mocks.exists).not.toHaveBeenCalled();
  expect(pdfs()).toEqual([]);
  expect(mocks.notice).toHaveBeenCalled();
});

test.each(["PDF path", "document root"])(
  "a success without a %s fails explicitly",
  async (missing) => {
    mocks.compile.mockResolvedValue({
      ...result(),
      ...(missing === "PDF path" ? { pdf_path: null } : { root: null }),
    });
    await toggleLatexPreview(source, "source");
    expect(pdfs()).toEqual([]);
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining(missing), "source");
    expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("failed");
  },
);

test("a failed preview save preserves open PDFs and prevents any root lookup", async () => {
  await openPdf();
  mocks.save.mockResolvedValue(false);
  await toggleLatexPreview(source, "source");
  expect(pdfs()).toEqual(["/w/main.pdf"]);
  expect(mocks.root).not.toHaveBeenCalled();
  expect(mocks.compile).not.toHaveBeenCalled();
});

test("a joined chapter does not open another chapter's migrated PDF", async () => {
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource("/w/a.tex");
  await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledOnce());
  const preview = toggleLatexPreview(source, "source");
  await vi.waitFor(() => expect(mocks.root).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  await Promise.resolve();
  engine.resolve(result("/w/other.tex"));
  await Promise.all([first, preview]);
  expect(pdfs()).not.toContain("/w/other.pdf");
  expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining("root changed"), "source");
});

test("autosave resolves an edited root before deciding whether a preview is open", async () => {
  vi.useFakeTimers();
  await openPdf("/w/main.pdf");
  useLatexCompileStore.setState({ roots: { [source]: "/w/main.tex" } });
  mocks.root.mockResolvedValue("/w/other.tex");
  mocks.saved!(source);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.compile).not.toHaveBeenCalled();
  expect(useLatexCompileStore.getState().roots[source]).toBe("/w/other.tex");
});

test.each(["closed", "changed"])(
  "autosave rechecks a %s preview after the debounce",
  async (change) => {
    vi.useFakeTimers();
    await openPdf();
    mocks.saved!(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    if (change === "closed") closePdfs();
    else mocks.root.mockResolvedValue("/w/other.tex");
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.compile).not.toHaveBeenCalled();
  },
);

test("an auto-only rerun stops when its preview closes", async () => {
  vi.useFakeTimers();
  await openPdf();
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile).toHaveBeenCalledOnce();
  mocks.saved!(source);
  await vi.advanceTimersByTimeAsync(500);
  closePdfs();
  engine.resolve(result());
  await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile).toHaveBeenCalledOnce();
});

test("a later save during an explicit build queues one preview rerun", async () => {
  vi.useFakeTimers();
  await openPdf();
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(0);
  mocks.saved!(source);
  await vi.advanceTimersByTimeAsync(500);
  engine.resolve(result());
  await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
});

test("an auto request cannot downgrade an explicit rerun after the preview closes", async () => {
  vi.useFakeTimers();
  await openPdf();
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(0);
  const explicit = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(0);
  mocks.saved!(source);
  await vi.advanceTimersByTimeAsync(500);
  closePdfs();
  engine.resolve(result());
  await Promise.all([first, explicit]);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
});

test("a save following an older pending lookup reads its changed root before scheduling", async () => {
  vi.useFakeTimers();
  await openPdf("/w/other.pdf");
  const lookup = deferred<string>();
  mocks.root.mockReturnValueOnce(lookup.promise).mockResolvedValue("/w/other.tex");
  mocks.compile.mockImplementation(async (path: string) =>
    result(useLatexCompileStore.getState().roots[path]!),
  );
  const earlier = compileLatexSource(source);
  mocks.saved!(source);
  lookup.resolve("/w/main.tex");
  await earlier;
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
  expect(mocks.root).toHaveBeenCalledTimes(3);
  expect(useLatexCompileStore.getState().roots[source]).toBe("/w/other.tex");
});

test("a saved-root refresh also waits for intervening foreground lookup ownership", async () => {
  vi.useFakeTimers();
  await openPdf("/w/other.pdf");
  const old = deferred<string>();
  const current = deferred<string>();
  mocks.root
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise)
    .mockResolvedValue("/w/other.tex");
  mocks.compile.mockImplementation(async (path: string) =>
    result(useLatexCompileStore.getState().roots[path]!),
  );
  const first = compileLatexSource(source);
  mocks.saved!(source);
  const foreground = compileLatexSource(source);
  old.resolve("/w/main.tex");
  expect(await first).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.root).toHaveBeenCalledTimes(2);
  expect(mocks.compile).not.toHaveBeenCalled();
  current.resolve("/w/other.tex");
  expect((await foreground)?.status).toBe("ok");
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.root).toHaveBeenCalledTimes(4);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
});

test("an explicit queued chapter retains its authority when a later auto chapter migrates", async () => {
  vi.useFakeTimers();
  await openPdf();
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource("/w/initial.tex");
  await vi.advanceTimersByTimeAsync(0);
  const explicit = compileLatexSource("/w/explicit.tex");
  await vi.advanceTimersByTimeAsync(0);
  mocks.saved!("/w/auto.tex");
  await vi.advanceTimersByTimeAsync(500);
  mocks.root.mockImplementation(async (path: string) =>
    path === "/w/auto.tex" ? "/w/other.tex" : "/w/main.tex",
  );
  closePdfs();
  engine.resolve(result());
  await Promise.all([first, explicit]);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
  expect(mocks.compile).toHaveBeenNthCalledWith(2, "/w/explicit.tex");
});

test.each([
  ["build", "/w/other.tex"],
  ["exists", "/w/other.tex"],
  ["build", null],
  ["exists", null],
] as const)(
  "a newer source association during %s to %s prevents opening an older PDF",
  async (stage, currentRoot) => {
    const engine = deferred<LatexCompileResult>();
    const exists = deferred<boolean>();
    mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result("/w/other.tex"));
    if (stage === "exists") mocks.exists.mockReturnValueOnce(exists.promise);
    const preview = toggleLatexPreview(source, "source");
    await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledOnce());
    if (stage === "exists") {
      engine.resolve(result("/w/main.tex", "failed"));
      await vi.waitFor(() => expect(mocks.exists).toHaveBeenCalledOnce());
    }
    mocks.root.mockResolvedValue(currentRoot);
    await compileLatexSource(source);
    if (stage === "build") engine.resolve(result());
    else exists.resolve(true);
    await preview;
    expect(pdfs()).toEqual([]);
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining("root changed"), "source");
  },
);

test.each(["PDF path", "document root"])(
  "direct compilation rejects a success missing its %s",
  async (missing) => {
    mocks.compile.mockResolvedValue({
      ...result(),
      ...(missing === "PDF path" ? { pdf_path: null } : { root: null }),
    });
    const build = await compileLatexSource(source);
    expect(build?.status).toBe("failed");
    expect(build?.diagnostics[0]?.message).toContain(missing);
    expect(usePdfRevisionStore.getState().revisions).toEqual({});
  },
);

test("the latest of multiple explicit requests owns the queued source", async () => {
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource("/w/initial.tex");
  await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledOnce());
  const second = compileLatexSource("/w/second.tex");
  await vi.waitFor(() => expect(mocks.root).toHaveBeenCalledTimes(2));
  const third = compileLatexSource("/w/third.tex");
  await vi.waitFor(() => expect(mocks.root).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  await Promise.resolve();
  engine.resolve(result());
  await Promise.all([first, second, third]);
  await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledTimes(2));
  expect(mocks.compile).toHaveBeenNthCalledWith(2, "/w/third.tex");
});

test("a debounced auto request waits for a pending explicit lookup without canceling it", async () => {
  vi.useFakeTimers();
  await openPdf();
  mocks.saved!(source);
  await vi.advanceTimersByTimeAsync(0);
  const lookup = deferred<string>();
  mocks.root.mockReturnValueOnce(lookup.promise);
  const foreground = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(500);
  const readsBeforeForegroundSettled = mocks.root.mock.calls.length;
  lookup.resolve("/w/main.tex");
  const outcome = await foreground;
  await vi.advanceTimersByTimeAsync(0);
  expect(readsBeforeForegroundSettled).toBe(2);
  expect(outcome?.status).toBe("ok");
  expect(mocks.compile).toHaveBeenCalled();
});

test("a later-completing older explicit lookup cannot replace the newer queued source", async () => {
  const engine = deferred<LatexCompileResult>();
  const lookup = deferred<string>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource("/w/initial.tex");
  await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledOnce());
  mocks.root.mockReturnValueOnce(lookup.promise);
  const older = compileLatexSource("/w/older.tex");
  const newer = compileLatexSource("/w/newer.tex");
  await vi.waitFor(() => expect(mocks.root).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  await Promise.resolve();
  lookup.resolve("/w/main.tex");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  engine.resolve(result());
  await Promise.all([first, older, newer]);
  await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalledTimes(2));
  expect(mocks.compile).toHaveBeenNthCalledWith(2, "/w/newer.tex");
});

test("an older explicit rerun waits for a newer pending preview lookup", async () => {
  vi.useFakeTimers();
  const engine = deferred<LatexCompileResult>();
  const lookup = deferred<string>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  const first = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(0);
  const queued = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(0);
  mocks.root.mockReturnValueOnce(lookup.promise);
  const preview = toggleLatexPreview(source, "source");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.root).toHaveBeenCalledTimes(3);
  engine.resolve(result());
  await Promise.all([first, queued]);
  await vi.advanceTimersByTimeAsync(0);
  const readsBeforePreviewSettled = mocks.root.mock.calls.length;
  lookup.resolve("/w/main.tex");
  await preview;
  expect(readsBeforePreviewSettled).toBe(3);
  expect(pdfs()).toEqual(["/w/main.pdf"]);
});

test("a newer same-path refresh retains its association against an older native migration", async () => {
  vi.useFakeTimers();
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise);
  const preview = toggleLatexPreview(source, "source");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile).toHaveBeenCalledOnce();
  mocks.saved!(source);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.root).toHaveBeenCalledTimes(3);
  expect(useLatexCompileStore.getState().roots[source]).toBe("/w/main.tex");
  engine.resolve(result("/w/other.tex"));
  await preview;
  expect(useLatexCompileStore.getState().roots[source]).toBe("/w/main.tex");
  expect(pdfs()).toEqual([]);
  expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining("root changed"), "source");
});

test.each(["no-root", "error"])("a %s rerun lookup releases the root lane", async (outcome) => {
  vi.useFakeTimers();
  const engine = deferred<LatexCompileResult>();
  mocks.compile.mockReturnValueOnce(engine.promise).mockResolvedValue(result());
  mocks.root.mockResolvedValueOnce("/w/main.tex").mockResolvedValueOnce("/w/main.tex");
  if (outcome === "no-root") mocks.root.mockResolvedValueOnce(null);
  else mocks.root.mockRejectedValueOnce(new Error("root read failed"));
  const first = compileLatexSource("/w/initial.tex");
  await vi.advanceTimersByTimeAsync(0);
  const queued = compileLatexSource(source);
  await vi.advanceTimersByTimeAsync(0);
  engine.resolve(result());
  await Promise.all([first, queued]);
  await vi.advanceTimersByTimeAsync(0);
  expect(useLatexCompileStore.getState().builds[source]?.state).toBe(
    outcome === "no-root" ? "no-root" : "failed",
  );
  await compileLatexSource("/w/initial.tex");
  expect(mocks.compile).toHaveBeenCalledTimes(2);
});

test("an older explicit lookup stays superseded after a newer explicit build hands off to auto", async () => {
  vi.useFakeTimers();
  await openPdf();
  const oldLookup = deferred<string>();
  const explicitEngine = deferred<LatexCompileResult>();
  const autoEngine = deferred<LatexCompileResult>();
  mocks.root.mockImplementation(async (path: string) =>
    path === "/w/older.tex" ? oldLookup.promise : "/w/main.tex",
  );
  mocks.compile
    .mockReturnValueOnce(explicitEngine.promise)
    .mockReturnValueOnce(autoEngine.promise)
    .mockResolvedValue(result());
  const older = compileLatexSource("/w/older.tex");
  const newer = compileLatexSource("/w/newer.tex");
  await vi.advanceTimersByTimeAsync(0);
  mocks.saved!("/w/auto.tex");
  await vi.advanceTimersByTimeAsync(500);
  explicitEngine.resolve(result());
  await newer;
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile).toHaveBeenCalledTimes(2);
  oldLookup.resolve("/w/main.tex");
  await vi.advanceTimersByTimeAsync(0);
  autoEngine.resolve(result());
  await older;
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.compile.mock.calls.map((call) => call[0])).toEqual(["/w/newer.tex", "/w/auto.tex"]);
});

test.each(["lookup", "engine"])(
  "a late older lookup cannot take over a newer rerun during %s",
  async (stage) => {
    vi.useFakeTimers();
    const firstEngine = deferred<LatexCompileResult>();
    const nextEngine = deferred<LatexCompileResult>();
    const oldLookup = deferred<string>();
    const nextLookup = deferred<string>();
    let newerReads = 0;
    mocks.root.mockImplementation(async (path: string) => {
      if (path === "/w/older.tex") return oldLookup.promise;
      if (path === "/w/newer.tex" && ++newerReads === 2 && stage === "lookup")
        return nextLookup.promise;
      return "/w/main.tex";
    });
    mocks.compile
      .mockReturnValueOnce(firstEngine.promise)
      .mockReturnValueOnce(nextEngine.promise)
      .mockResolvedValue(result());
    const initial = compileLatexSource("/w/initial.tex");
    await vi.advanceTimersByTimeAsync(0);
    const older = compileLatexSource("/w/older.tex");
    const newer = compileLatexSource("/w/newer.tex");
    await vi.advanceTimersByTimeAsync(0);
    firstEngine.resolve(result());
    await Promise.all([initial, newer]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.compile).toHaveBeenCalledTimes(stage === "lookup" ? 1 : 2);
    oldLookup.resolve("/w/main.tex");
    await vi.advanceTimersByTimeAsync(0);
    if (stage === "lookup") nextLookup.resolve("/w/main.tex");
    await vi.advanceTimersByTimeAsync(0);
    nextEngine.resolve(result());
    await older;
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.compile.mock.calls.map((call) => call[0])).toEqual([
      "/w/initial.tex",
      "/w/newer.tex",
    ]);
  },
);
