import { useCallback, useEffect } from "react";
import { useMoveEntry } from "@/components/sidebar/use-move-entry";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { planLessonMoves, type LessonMove } from "@/lib/calendar";
import { getFileName } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import { useCalendarStore } from "@/stores/calendar-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const PREVIEW_LINES = 8;
const LESSON_CHECK_MS = 60_000;
let running = false;
let rerun = false;

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

/**
 * Keep a workspace with a calendar link organized: each sync sorts its notes,
 * and a lesson that starts gets a note. Adding the link is the opt-in; without
 * one, sorting happens only through the palette command.
 */
export function useOrganizeLessons() {
  const { applyPathChange } = useMoveEntry();
  const root = useWorkspaceStore((s) => s.root);
  const syncedAt = useCalendarStore((s) => s.syncedAt);

  const apply = useCallback(
    async (workspace: string, moves: LessonMove[]) => {
      const failed: string[] = [];
      let moved = 0;
      for (const { from, to } of moves) {
        if (useWorkspaceStore.getState().root !== workspace) return;
        // ponytail: skips only unsaved notes; a keystroke landing during the rename can still conflict.
        // The next sync retries it.
        if (useEditorStore.getState().openFiles.get(from)?.isDirty) continue;
        try {
          const assets = `${from.slice(0, -3)}-assets`;
          const assetsTo = `${to.slice(0, -3)}-assets`;
          // Check first: moving the note and then failing here would separate them for good.
          if ((await tauri.fileExists(assets)) && (await tauri.fileExists(assetsTo))) {
            throw new Error(`${getFileName(assetsTo)} already exists`);
          }
          const folder = to.slice(0, to.lastIndexOf("/"));
          if (!(await tauri.fileExists(folder))) await tauri.createDirectory(folder);
          const [note] = await tauri.readFileEntries([from]);
          await applyPathChange(note, to);
          moved += 1;
          // A note's pasted images follow it under its new name.
          if (await tauri.fileExists(assets)) {
            // The sidebar listing hides asset folders, so describe this one directly.
            const entry = { ...note, name: getFileName(assets), path: assets, is_dir: true };
            await applyPathChange(entry, assetsTo);
          }
        } catch (error) {
          console.error("[calendar] Failed to organize a lesson note", error);
          failed.push(getFileName(from));
        }
      }
      if (useWorkspaceStore.getState().root !== workspace) return;
      if (failed.length > 0) {
        showEditorNotice(`Organized ${moved} lesson notes. Couldn't move: ${failed.join(", ")}`);
      } else if (moved > 0) {
        showEditorNotice(`Organized ${moved} lesson note${moved === 1 ? "" : "s"}.`);
      }
    },
    [applyPathChange],
  );

  useEffect(() => {
    if (!root) return;
    const report = (error: unknown) => showEditorNotice(`Calendar: ${String(error)}`);
    useCalendarStore.getState().refreshIfStale();
    const timer = setInterval(() => {
      useCalendarStore.getState().refreshIfStale();
      void useCalendarStore.getState().createCurrentLessons().catch(report);
    }, LESSON_CHECK_MS);
    return () => clearInterval(timer);
  }, [root]);

  useEffect(() => {
    // Read the store, not the render: a workspace switch resets it in the effect above,
    // and the previous workspace's sync must not sort this one.
    if (!root || !syncedAt || !useCalendarStore.getState().syncedAt) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        rerun = false;
        const current = useWorkspaceStore.getState().root;
        if (!current || !useCalendarStore.getState().syncedAt) return;
        const moves = await planMoves(current);
        if (useWorkspaceStore.getState().root !== current) continue;
        if (moves.length > 0) await apply(current, moves);
        await useCalendarStore.getState().createCurrentLessons();
      } while (rerun);
    })()
      .catch((error: unknown) => {
        showEditorNotice(`Couldn't organize lesson notes: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, [apply, syncedAt, root]);

  return useCallback(async () => {
    if (!root) return;
    if (running) {
      showEditorNotice("Lesson notes are being organized. Try again in a moment.");
      return;
    }
    const moves = await planMoves(root);
    if (moves.length === 0) {
      showEditorNotice("Lesson notes are already organized.");
      return;
    }
    const preview = moves
      .slice(0, PREVIEW_LINES)
      .map(({ to }) => to.slice(root.length + 1))
      .join("\n");
    const more = moves.length > PREVIEW_LINES ? `\n…and ${moves.length - PREVIEW_LINES} more` : "";
    const confirmed = window.confirm(
      `Move and rename ${moves.length} lesson notes? Links are updated.\n\n${preview}${more}`,
    );
    if (!confirmed || running) return;
    running = true;
    try {
      await apply(root, moves);
    } finally {
      running = false;
    }
  }, [apply, root]);
}
