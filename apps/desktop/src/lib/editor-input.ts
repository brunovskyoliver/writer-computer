/** Window input and asynchronous clipboard edits share one transition gate.
 * A close first pauses new input, drains edits already started, then saves. */
let freezeCount = 0;
let previousInert = false;
const pending = new Set<Promise<void>>();

export function isEditorInputFrozen(): boolean {
  return freezeCount > 0;
}

export function freezeEditorInput(): () => void {
  if (freezeCount++ === 0 && typeof document !== "undefined") {
    previousInert = document.body.inert;
    document.body.inert = true;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--freezeCount === 0 && typeof document !== "undefined") document.body.inert = previousInert;
  };
}

export function runAsyncEditorInput(operation: () => Promise<void>): Promise<void> {
  if (isEditorInputFrozen()) {
    return Promise.reject(new Error("Editor input is paused while Writer changes workspaces."));
  }
  const work = Promise.resolve().then(operation);
  const tracked = work.finally(() => pending.delete(tracked));
  pending.add(tracked);
  return tracked;
}

/** The caller holds the input gate, so no new clipboard work can start. */
export async function settleEditorInput(): Promise<void> {
  await Promise.allSettled(pending);
}
