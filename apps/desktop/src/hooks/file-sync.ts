import { useEditorStore, waitForFileLoad } from "@/stores/editor-store";
import { editorGeneration } from "@/lib/editor-reset";
import { isSaveInFlight, waitForSave } from "@/lib/save";
import { readFile } from "@/lib/tauri";

async function readDisk(path: string): Promise<string | null> {
  try {
    return (await readFile(path)).content;
  } catch (error) {
    if (String(error).startsWith("Not found:")) return null;
    throw error;
  }
}

/** One watcher lifetime owns its reads. Only the latest request may publish. */
export function createExternalFileSync() {
  const requests = new Map<string, symbol>();
  let disposed = false;

  return {
    async refresh(path: string, isCurrent: () => boolean) {
      const initial = useEditorStore.getState().openFiles.get(path);
      if (!initial || disposed) return;
      const generation = editorGeneration();
      const request = Symbol();
      requests.set(path, request);
      const ownsRead = () =>
        !disposed &&
        requests.get(path) === request &&
        generation === editorGeneration() &&
        useEditorStore.getState().openFiles.get(path)?.instanceId === initial.instanceId &&
        isCurrent();

      try {
        await waitForFileLoad(path);
        while (ownsRead()) {
          await waitForSave(path);
          if (!ownsRead()) return;
          const before = useEditorStore.getState().openFiles.get(path)!;
          const content = await readDisk(path);
          if (!ownsRead()) return;
          const latest = useEditorStore.getState().openFiles.get(path)!;
          // A newer save/reload may have overtaken the snapshot. Re-read so
          // rejecting stale bytes does not consume the only external event.
          if (
            isSaveInFlight(path) ||
            latest.diskContent !== before.diskContent ||
            latest.reloadVersion !== before.reloadVersion
          )
            continue;
          useEditorStore.getState().receiveDiskContent(path, content);
          return;
        }
      } catch (error) {
        if (ownsRead()) {
          useEditorStore
            .getState()
            .setSaveError(path, `Could not check the external change: ${String(error)}`);
        }
      } finally {
        if (requests.get(path) === request) requests.delete(path);
      }
    },
    dispose() {
      disposed = true;
      requests.clear();
    },
  };
}

/** An explicit discard applies only to the buffer the user chose, before further typing. */
export async function loadCurrentDiskVersion(path: string): Promise<boolean> {
  const store = useEditorStore.getState();
  const file = store.openFiles.get(path);
  if (!file?.conflict || file.conflictResolving) return false;
  store.flushPendingEdit(path);
  const snapshot = useEditorStore.getState().openFiles.get(path)!;
  const pending = store.getPendingEdit(path);
  const generation = editorGeneration();
  const ownsResolution = () =>
    generation === editorGeneration() &&
    useEditorStore.getState().openFiles.get(path)?.instanceId === snapshot.instanceId;
  store.setConflictResolving(path, true);
  try {
    while (ownsResolution()) {
      await waitForSave(path);
      if (!ownsResolution()) return false;
      const before = useEditorStore.getState().openFiles.get(path)!;
      const content = await readDisk(path);
      if (!ownsResolution()) return false;
      const latest = useEditorStore.getState().openFiles.get(path)!;
      if (
        latest.conflict !== before.conflict ||
        latest.diskContent !== before.diskContent ||
        latest.reloadVersion !== before.reloadVersion
      )
        continue;
      if (latest.editSeq !== snapshot.editSeq || store.getPendingEdit(path) !== pending) {
        store.recordDiskConflict(path, content);
        store.setSaveError(
          path,
          "You edited this note while it was loading. Your changes are preserved; choose a version again.",
        );
        return false;
      }
      if (content === null) {
        store.recordDiskConflict(path, null);
        store.setSaveError(path, "The file no longer exists on disk. Your text is preserved here.");
        return false;
      }
      store.reloadFromDisk(path, content);
      return true;
    }
    return false;
  } catch (error) {
    if (ownsResolution())
      store.setSaveError(path, `Could not load the disk version: ${String(error)}`);
    return false;
  } finally {
    if (ownsResolution()) store.setConflictResolving(path, false);
  }
}
