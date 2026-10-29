import {
  useFileConflict,
  useConflictResolving,
  keepLocalFileChanges,
  loadCurrentDiskVersion,
} from "@/hooks/use-file-conflict";
import { useFileSaveError } from "@/hooks/use-tabs";
import { FILE_CONFLICT_MESSAGE } from "@/lib/file-conflict";

export function FileConflictNotice({
  path,
  focusEditor,
}: {
  path: string;
  focusEditor: () => void;
}) {
  const conflict = useFileConflict(path);
  const resolving = useConflictResolving(path);
  const error = useFileSaveError(path);
  if (!conflict) return null;
  const missing = conflict.diskContent === null;

  const resolve = async (button: HTMLButtonElement, action: () => Promise<boolean>) => {
    const restoreFocus = document.activeElement === button;
    if (!(await action()) || !restoreFocus) return;
    requestAnimationFrame(() => {
      if (document.activeElement === button || document.activeElement === document.body)
        focusEditor();
    });
  };
  const buttonClass =
    "rounded-md border border-[var(--border-color)] bg-[var(--surface-subtle)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--surface-selected)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";

  return (
    <div
      data-file-conflict
      className="mt-24 max-h-[calc(100%-6rem)] shrink-0 overflow-y-auto px-5 py-3 text-[12px] text-[var(--text-secondary)]"
    >
      <p role="status" className="leading-relaxed">
        {missing
          ? "This file was deleted outside Writer. Your text is kept here; autosave is paused."
          : "This file changed outside Writer. Your edits are kept here; autosave is paused."}
      </p>
      <p className="mt-1 text-[var(--text-muted)]">
        {missing
          ? "Recreate it to save your text."
          : "Keep your changes to replace the disk version, or use disk to discard your local edits."}
      </p>
      {error && error !== FILE_CONFLICT_MESSAGE && (
        <p role="status" className="mt-2">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={resolving}
          className={buttonClass}
          onClick={(event) => void resolve(event.currentTarget, () => keepLocalFileChanges(path))}
        >
          {missing ? "Recreate file" : "Keep my changes"}
        </button>
        {!missing && (
          <button
            type="button"
            disabled={resolving}
            className={buttonClass}
            onClick={(event) =>
              void resolve(event.currentTarget, () => loadCurrentDiskVersion(path))
            }
          >
            {resolving ? "Loading disk version…" : "Use disk version"}
          </button>
        )}
      </div>
    </div>
  );
}
