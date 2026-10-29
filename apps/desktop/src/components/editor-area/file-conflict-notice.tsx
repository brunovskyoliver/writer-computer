import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  useFileConflict,
  useConflictResolving,
  keepLocalFileChanges,
  loadCurrentDiskVersion,
} from "@/hooks/use-file-conflict";
import { useFileSaveError } from "@/hooks/use-tabs";
import { FILE_CONFLICT_MESSAGE } from "@/lib/file-conflict";

function ConflictReviewDialog({
  title,
  children,
  onClose,
  trigger,
  focusEditor,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
  focusEditor: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      const ownedFocus = dialog.contains(document.activeElement);
      dialog.close();
      // Parent pane attributes change later in this commit. Wait until they
      // hide the compact trigger before deciding where focus should return.
      // Navigation must not steal focus; focusEditor checks live pane focus.
      if (ownedFocus)
        queueMicrotask(() => {
          const active = document.activeElement;
          if (
            !trigger.current?.getClientRects().length &&
            (active === document.body || active === trigger.current)
          )
            focusEditor();
        });
    };
  }, [trigger, focusEditor]);
  return createPortal(
    <dialog
      ref={ref}
      className="file-conflict-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id={titleId} className="text-[15px] font-medium">
          {title}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[13px] hover:bg-[var(--surface-subtle)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          Close
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}

export function FileConflictNotice({
  path,
  focusEditor,
  compact,
  isVisible,
}: {
  path: string;
  focusEditor: () => void;
  compact: boolean;
  isVisible: boolean;
}) {
  const conflict = useFileConflict(path);
  const resolving = useConflictResolving(path);
  const error = useFileSaveError(path);
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setReviewPath(null);
  }, [path, compact, isVisible]);
  useEffect(() => {
    if (!conflict) setReviewPath(null);
  }, [conflict]);
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
  const content = (
    <div className="text-[12px] text-[var(--text-secondary)]">
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
  return (
    <>
      <div
        data-file-conflict
        className="file-conflict-inline mt-24 max-h-[calc(100%-6rem)] shrink-0 overflow-y-auto px-5 py-3"
      >
        {!compact && content}
      </div>
      <div data-file-conflict-compact className="file-conflict-compact">
        <span
          role="status"
          className="min-w-0 truncate"
          title="Autosave is paused until you choose a version."
        >
          {missing ? "File deleted" : "File changed"}
        </span>
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          onClick={() => setReviewPath(path)}
          className="shrink-0 rounded-md px-2 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          Review changes
        </button>
      </div>
      {compact && isVisible && reviewPath === path && (
        <ConflictReviewDialog
          title={`Review ${path.split(/[\\/]/).pop()}`}
          onClose={() => setReviewPath(null)}
          trigger={trigger}
          focusEditor={focusEditor}
        >
          {content}
        </ConflictReviewDialog>
      )}
    </>
  );
}
