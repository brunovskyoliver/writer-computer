import { discardDrawingSessions, withDrawingSaveBoundary } from "@/lib/drawing-sessions";
import { useCallback } from "react";
import {
  useRefreshDirectory,
  useRewriteExpandedDir,
  useRewritePinnedPath,
} from "@/hooks/use-file-tree";
import { renameOpenFile, rewritePathPrefix, withDrawingSourceRename } from "@/hooks/editor-api";
import * as tauri from "@/lib/tauri";
import { getFileName, getParentDir } from "@/lib/paths";
import { queueLinkUpdate } from "@/lib/update-links-after-move";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import type { DirEntry } from "@/types/fs";
import { canMoveInto, computeMovePath } from "./tree-move";

export type MoveOutcome =
  | { status: "moved"; entry: DirEntry; newPath: string }
  | { status: "skipped"; entry: DirEntry }
  | { status: "exists"; entry: DirEntry; newPath: string }
  | { status: "error"; entry: DirEntry; error: unknown };

/** The move already succeeded, so a link failure is reported, not thrown. */
async function updateLinks(
  root: string,
  oldPath: string,
  newPath: string,
  isDir: boolean,
): Promise<void> {
  // The note list comes from the window's current workspace, not the moved file's.
  if (getWorkspaceRoot() !== root) {
    showEditorNotice(
      `Moved ${getFileName(newPath)}, but the workspace changed before its links were updated.`,
    );
    return;
  }
  try {
    const { updated, failed } = await queueLinkUpdate(oldPath, newPath, isDir, root);
    if (failed.length > 0) {
      showEditorNotice(
        `Moved, but couldn't update links in ${failed.length} note(s): ${failed.map(getFileName).join(", ")}`,
      );
    } else if (updated > 0) {
      showEditorNotice(`Updated links in ${updated} note${updated === 1 ? "" : "s"}.`);
    }
  } catch (error) {
    showEditorNotice(`Moved, but couldn't update links: ${String(error)}`);
  }
}

/**
 * The single write path for relocating a file or folder. Both inline rename and
 * drag-to-move funnel through here so on-disk renames and the corresponding
 * editor/workspace state rewrites stay in lockstep.
 */
export function useMoveEntry() {
  const refreshDirectory = useRefreshDirectory();
  const rewriteExpandedDir = useRewriteExpandedDir();
  const rewritePinnedPath = useRewritePinnedPath();

  // Rename `entry` on disk to `newPath`, then rewrite editor/workspace state and
  // refresh the affected directories. `newPath` may differ from `entry.path` in
  // its name (rename) or its parent (move) — the handling is identical.
  const applyPathChange = useCallback(
    async (entry: DirEntry, newPath: string): Promise<void> => {
      const root = getWorkspaceRoot();
      await withDrawingSourceRename(entry.path, newPath, async () => {
        await withDrawingSaveBoundary(async () => {
          await tauri.renameEntry(entry.path, newPath);
          discardDrawingSessions(entry.path);
        }, entry.path);
        if (entry.is_dir) {
          rewritePathPrefix(entry.path, newPath);
          rewriteExpandedDir(entry.path, newPath);
          rewritePinnedPath(entry.path, newPath);
        } else {
          renameOpenFile(entry.path, newPath);
          rewritePathPrefix(entry.path, newPath);
          rewritePinnedPath(entry.path, newPath);
        }
      });
      const fromParent = getParentDir(entry.path);
      const toParent = getParentDir(newPath);
      await refreshDirectory(fromParent);
      if (toParent !== fromParent) await refreshDirectory(toParent);
      if (!root) return;
      // Layouts drop tabs whose files are gone, so they follow the move too.
      await tauri.rewriteLayoutPaths(root, entry.path, newPath).catch((error: unknown) => {
        showEditorNotice(`Moved, but couldn't update saved layouts: ${String(error)}`);
      });
      await updateLinks(root, entry.path, newPath, entry.is_dir);
    },
    [refreshDirectory, rewriteExpandedDir, rewritePinnedPath],
  );

  // Move `entry` into `destDir`, preserving its name. Returns an outcome instead
  // of alerting so callers can batch many moves and surface a single summary.
  const moveEntry = useCallback(
    async (entry: DirEntry, destDir: string): Promise<MoveOutcome> => {
      if (!canMoveInto(entry.path, entry.is_dir, destDir)) {
        return { status: "skipped", entry };
      }
      const newPath = computeMovePath(entry, destDir);
      if (await tauri.fileExists(newPath)) {
        return { status: "exists", entry, newPath };
      }
      try {
        await applyPathChange(entry, newPath);
        return { status: "moved", entry, newPath };
      } catch (error) {
        return { status: "error", entry, error };
      }
    },
    [applyPathChange],
  );

  return { applyPathChange, moveEntry };
}
