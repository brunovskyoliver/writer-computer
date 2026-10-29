import { useEditorStore } from "@/stores/editor-store";
import { saveNow } from "@/lib/save";
export { loadCurrentDiskVersion } from "./file-sync";

export function useFileConflict(path: string) {
  return useEditorStore((state) => state.openFiles.get(path)?.conflict ?? null);
}

export function useConflictResolving(path: string) {
  return useEditorStore((state) => Boolean(state.openFiles.get(path)?.conflictResolving));
}

export async function keepLocalFileChanges(path: string): Promise<boolean> {
  const file = useEditorStore.getState().openFiles.get(path);
  if (!file?.conflict || file.conflictResolving) return false;
  useEditorStore.getState().keepLocalChanges(path);
  return saveNow(path);
}
