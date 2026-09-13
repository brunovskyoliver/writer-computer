import * as editorApi from "@/hooks/editor-api";
import {
  createDrawing,
  extractDrawingTitle,
  nextAvailableDrawingPath,
  sanitizeDrawingStem,
} from "@/lib/drawings";
import { getFileName } from "@/lib/paths";
import * as tauri from "@/lib/tauri";

/**
 * The palette's two open routes that do disk work before they open anything.
 * Both capture the pane (and, for a drawing, the note's tab) the user was in
 * *before* their first await, so a slow create cannot land the new tab in
 * whichever pane the user focused meanwhile. The palette hands the captured
 * origin in; nothing here reads focus after an await.
 */
export interface PaletteOpenOrigin {
  paneId: string;
  /** The focused tab at capture time, for the drawing embed insertion. */
  tabId: string | null;
}

/** Create a new note on disk, then open it in the captured pane. */
export async function createAndOpenFile(path: string, origin: PaletteOpenOrigin): Promise<void> {
  await tauri.createFile(path);
  await editorApi.openFile(path, { paneId: origin.paneId });
}

/**
 * Create a drawing, insert its embed into `notePath` (the note the user was
 * in), and open the drawing beside it.
 *
 * Load-bearing order: write the file, insert the embed while the note still
 * has the cursor, then open the tab — opening it moves focus off the note.
 * With no note in front `notePath` is null, the drawing lands in the
 * workspace root and nothing is inserted.
 */
export async function createAndOpenDrawing(
  baseDir: string,
  notePath: string | null,
  rawName: string | undefined,
  origin: PaletteOpenOrigin,
): Promise<void> {
  const title = extractDrawingTitle(rawName);
  const stem = sanitizeDrawingStem(rawName);
  const path = await nextAvailableDrawingPath(baseDir, tauri.fileExists, stem);
  await createDrawing(path);
  if (notePath) {
    const embed = `![[${getFileName(path)}]]`;
    const insertText = title ? `### ${title}\n${embed}` : embed;
    editorApi.insertAtCursor(notePath, insertText, origin.tabId);
  }
  await editorApi.openFile(path, { paneId: origin.paneId });
}
