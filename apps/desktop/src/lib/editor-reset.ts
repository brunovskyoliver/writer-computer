/** Workspace-owned caches register here without importing the editor store
 * back into their owners. Async work captures the generation before awaiting. */
let generation = 0;
const listeners = new Set<() => void>();

export function editorGeneration(): number {
  return generation;
}

export function onEditorReset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Invalidate async work before clearing owner state or publishing new tabs. */
export function notifyEditorReset(): void {
  generation += 1;
  for (const listener of listeners) listener();
}
