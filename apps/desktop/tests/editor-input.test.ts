import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  freezeEditorInput,
  isEditorInputFrozen,
  runAsyncEditorInput,
  settleEditorInput,
} from "../src/lib/editor-input";

afterEach(() => vi.unstubAllGlobals());

test("nested gates preserve the original inert value and release idempotently", () => {
  const body = { inert: false };
  vi.stubGlobal("document", { body });
  const first = freezeEditorInput();
  const second = freezeEditorInput();
  first();
  first();
  expect(body.inert).toBe(true);
  expect(isEditorInputFrozen()).toBe(true);
  second();
  expect(body.inert).toBe(false);
  expect(isEditorInputFrozen()).toBe(false);
  body.inert = true;
  freezeEditorInput()();
  expect(body.inert).toBe(true);
});

test("a gate rejects new asynchronous edits while draining earlier ones", async () => {
  let finish!: () => void;
  const before = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const commit = vi.fn();
  const work = runAsyncEditorInput(async () => {
    await before;
    commit();
  });
  const release = freezeEditorInput();
  try {
    await expect(
      runAsyncEditorInput(async () => {
        commit();
      }),
    ).rejects.toThrow("paused");
    let drained = false;
    const draining = settleEditorInput().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const drainedBeforeCompletion = drained;
    expect(commit).not.toHaveBeenCalled();
    finish();
    await work;
    await draining;
    expect(drainedBeforeCompletion).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
});

test("failed asynchronous edits settle without retaining a pending job", async () => {
  const work = runAsyncEditorInput(async () => {
    throw new Error("clipboard failed");
  });
  await expect(work).rejects.toThrow("clipboard failed");
  await settleEditorInput();
  const commit = vi.fn();
  await runAsyncEditorInput(async () => {
    commit();
  });
  expect(commit).toHaveBeenCalledOnce();
});
