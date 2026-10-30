import { useCallback, useEffect } from "react";
import { useMoveEntry } from "@/components/sidebar/use-move-entry";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { planLessonMoves, type LessonMove } from "@/lib/calendar";
import { getFileName } from "@/lib/paths";
import { getPreference, setPreference } from "@/lib/preferences";
import * as tauri from "@/lib/tauri";
import { useCalendarStore } from "@/stores/calendar-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const autoKey = (root: string) => `workspace:${root}:organize-lessons`;
const PREVIEW_LINES = 8;
let running = false;

async function planMoves(root: string): Promise<LessonMove[]> {
  const notes = await tauri.findCalendarNotes();
  const files = await Promise.all(
    notes.map(async (note) => ({
      path: note.path,
      course: note.course,
      content: (await tauri.readFile(note.path)).content,
    })),
  );
  const entries = await tauri.readDirectory(root);
  const folders = entries.filter((entry) => entry.is_dir).map((entry) => entry.name);
  const existing = new Set(await tauri.listWorkspaceNotes());
  return planLessonMoves(files, root, folders, existing);
}

/** Sort calendar notes into course folders: on request first, then after every calendar sync. */
export function useOrganizeLessons() {
  const { applyPathChange } = useMoveEntry();
  const root = useWorkspaceStore((s) => s.root);
  const fetchedAt = useCalendarStore((s) => s.fetchedAt);

  const apply = useCallback(
    async (workspace: string, moves: LessonMove[]) => {
      const failed: string[] = [];
      for (const { from, to } of moves) {
        try {
          const folder = to.slice(0, to.lastIndexOf("/"));
          if (!(await tauri.fileExists(folder))) await tauri.createDirectory(folder);
          const [note] = await tauri.readFileEntries([from]);
          await applyPathChange(note, to);
          // A note's pasted images follow it under its new name.
          const assets = `${from.slice(0, -3)}-assets`;
          if (await tauri.fileExists(assets)) {
            // The sidebar listing hides asset folders, so describe this one directly.
            const entry = { ...note, name: getFileName(assets), path: assets, is_dir: true };
            await applyPathChange(entry, `${to.slice(0, -3)}-assets`);
          }
        } catch (error) {
          console.error("[calendar] Failed to organize a lesson note", error);
          failed.push(getFileName(from));
        }
      }
      if (useWorkspaceStore.getState().root !== workspace) return;
      showEditorNotice(
        failed.length > 0
          ? `Organized ${moves.length - failed.length} lesson notes. Couldn't move: ${failed.join(", ")}`
          : `Organized ${moves.length} lesson note${moves.length === 1 ? "" : "s"}.`,
      );
    },
    [applyPathChange],
  );

  useEffect(() => {
    if (root) useCalendarStore.getState().refreshIfStale();
  }, [root]);

  useEffect(() => {
    if (!root || !fetchedAt || running) return;
    running = true;
    void (async () => {
      if (!(await getPreference(autoKey(root), false))) return;
      const moves = await planMoves(root);
      if (moves.length > 0) await apply(root, moves);
    })()
      .catch((error: unknown) => {
        showEditorNotice(`Couldn't organize lesson notes: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, [apply, fetchedAt, root]);

  return useCallback(async () => {
    if (!root) return;
    const moves = await planMoves(root);
    if (moves.length === 0) {
      showEditorNotice("Lesson notes are already organized.");
    } else {
      const preview = moves
        .slice(0, PREVIEW_LINES)
        .map(({ to }) => to.slice(root.length + 1))
        .join("\n");
      const more =
        moves.length > PREVIEW_LINES ? `\n…and ${moves.length - PREVIEW_LINES} more` : "";
      const confirmed = window.confirm(
        `Move and rename ${moves.length} lesson notes? Links are updated. New notes will then be sorted after each calendar sync.\n\n${preview}${more}`,
      );
      if (!confirmed) return;
      await apply(root, moves);
    }
    await setPreference(autoKey(root), true);
  }, [apply, root]);
}
