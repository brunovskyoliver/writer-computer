import { isDrawingPath } from "./drawings";
import { getFileExtension, getFileName, getFileStem } from "./paths";
import { applyTextEdits, linkEditsForMove, type PathMove } from "./rewrite-links";
import * as tauri from "./tauri";
import * as editorApi from "@/hooks/editor-api";

const READ_CONCURRENCY = 8;

function isMarkdown(path: string): boolean {
  return /^(md|markdown)$/i.test(getFileExtension(path));
}

export interface LinkUpdateResult {
  updated: number;
  failed: string[];
}

async function buildMove(
  oldPath: string,
  newPath: string,
  isDir: boolean,
  root: string,
  notes: string[],
): Promise<PathMove> {
  const isFree = async (path: string) => {
    if (isMarkdown(path)) {
      const stem = getFileStem(path).toLowerCase();
      return !notes.some((note) => note !== newPath && getFileStem(note).toLowerCase() === stem);
    }
    // Notes are all `notes` lists; an attachment's name is looked up on disk.
    const found = await tauri.findFileByName(root, getFileName(path));
    return found === null || found === newPath;
  };
  return {
    oldPath,
    newPath,
    root,
    isDir,
    oldNameIsFree: await isFree(oldPath),
    newNameIsFree: await isFree(newPath),
  };
}

async function updateNote(note: string, move: PathMove): Promise<boolean> {
  const open = editorApi.getOpenFile(note);
  if (open) {
    editorApi.flushPendingEdit(note);
    const current = editorApi.getOpenFile(note)!;
    if (current.isLoading || current.conflict) throw new Error("note is not ready to edit");
    const view = editorApi.getEditorViewsForPath(note)[0];
    const text = view ? view.state.doc.toString() : current.content;
    const edits = linkEditsForMove(text, note, move);
    // The buffer holds only the body; frontmatter lives beside it.
    const frontmatter = current.frontmatter ?? "";
    const frontmatterEdits = linkEditsForMove(frontmatter, note, move);
    if (frontmatterEdits.length > 0) {
      editorApi.updateFrontmatter(note, applyTextEdits(frontmatter, frontmatterEdits));
    }
    if (edits.length === 0) return frontmatterEdits.length > 0;
    // Through the view, so the edit is undoable and syncs like typing.
    if (view) view.dispatch({ changes: edits });
    else editorApi.updateContent(note, applyTextEdits(text, edits));
    return true;
  }
  const { content } = await tauri.readFile(note);
  const edits = linkEditsForMove(content, note, move);
  if (edits.length === 0) return false;
  // Conditional: a note changed since the read is reported, never overwritten.
  await tauri.writeFile(note, applyTextEdits(content, edits), content);
  return true;
}

/**
 * Keep every note's links correct after `oldPath` moved to `newPath`, which has
 * already happened on disk. A failed note doesn't undo the move or stop the
 * rest: it is reported so the user can fix that link by hand.
 */
export async function updateLinksAfterMove(
  oldPath: string,
  newPath: string,
  isDir: boolean,
  root: string,
): Promise<LinkUpdateResult> {
  const notes = await tauri.listWorkspaceNotes();
  const result: LinkUpdateResult = { updated: 0, failed: [] };
  const queue = notes.filter((note) => !isDrawingPath(note));

  const move = await buildMove(oldPath, newPath, isDir, root, notes);
  // ponytail: reads every note, once per move; fine at vault scale. Prefilter
  // in Rust by the moved names if a very large workspace makes this felt.
  const worker = async () => {
    for (let note = queue.shift(); note !== undefined; note = queue.shift()) {
      try {
        if (await updateNote(note, move)) result.updated++;
      } catch {
        result.failed.push(note);
      }
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  return result;
}

let chain: Promise<unknown> = Promise.resolve();

/** Serialized so a batch drag's rewrites can't race each other's conditional writes. */
export function queueLinkUpdate(
  oldPath: string,
  newPath: string,
  isDir: boolean,
  root: string,
): Promise<LinkUpdateResult> {
  const run = chain.then(() => updateLinksAfterMove(oldPath, newPath, isDir, root));
  chain = run.catch(() => undefined);
  return run;
}
