import { useEffect } from "react";
import * as editorApi from "@/hooks/editor-api";
import {
  useAiPanelActions,
  useAiPanelError,
  useAiPanelFor,
  useAiPanelLoading,
  useAiRelated,
  useAiSuggestions,
} from "@/hooks/use-ai";
import { getFileName } from "@/lib/paths";

/**
 * The AI suggestion card (SPECs/ai-note-graph): a floating panel over the
 * editor area that shows chat-suggested tags and the embedding "related"
 * list for one note. Nothing it shows is written anywhere until a tag chip
 * or "Add all" is clicked — closing (×, Escape) discards the suggestions.
 */
export function SuggestCard() {
  const panelFor = useAiPanelFor();
  const suggestions = useAiSuggestions();
  const related = useAiRelated();
  const loading = useAiPanelLoading();
  const error = useAiPanelError();
  const { acceptTag, acceptAll, closePanel } = useAiPanelActions();

  // Escape closes without writing. Capture-phase so it beats the editor's
  // own Escape handling but stays below a modal dialog.
  useEffect(() => {
    if (!panelFor) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [panelFor, closePanel]);

  if (!panelFor) return null;

  return (
    <div
      role="dialog"
      aria-label="AI suggestions"
      className="popover-outline fixed right-4 top-12 z-40 w-72 rounded-lg bg-[var(--surface-primary)] p-3 shadow-lg"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[12px] font-medium text-[var(--text-secondary)]">
          AI · {getFileName(panelFor)}
        </h2>
        <button
          type="button"
          onClick={closePanel}
          aria-label="Close suggestions"
          className="rounded px-1 text-[13px] leading-none text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          ×
        </button>
      </div>

      {loading && <p className="mt-3 text-[12px] text-[var(--text-muted)]">Thinking…</p>}

      {error && (
        <p role="alert" className="mt-3 text-[12px] leading-relaxed text-[var(--text-error)]">
          {error}
        </p>
      )}

      {!loading && !error && (
        <>
          {suggestions.length > 0 ? (
            <div className="mt-3">
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => void acceptTag(tag)}
                    title="Add this tag to the note"
                    className="rounded-full border border-[var(--line-subtle)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void acceptAll()}
                className="mt-2 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
              >
                Add all
              </button>
            </div>
          ) : (
            <p className="mt-3 text-[12px] text-[var(--text-muted)]">No tag suggestions.</p>
          )}

          {related.length > 0 && (
            <div className="mt-4 border-t border-[var(--line-subtle)] pt-3">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-icon-muted)]">
                Related
              </h3>
              <ul className="mt-1.5 grid gap-0.5">
                {related.map((note) => (
                  <li key={`${note.path}:${note.line ?? "sim"}`}>
                    <button
                      type="button"
                      title={
                        note.kind === "formula"
                          ? `Shared formula — open at line ${note.line}`
                          : "Similar note"
                      }
                      onClick={() => {
                        if (note.kind === "formula" && note.line !== null) {
                          editorApi.openFileAtLineTarget(note.path, {
                            line: note.line,
                            offset: 0,
                            length: 0,
                            needle: note.snippet ?? "",
                          });
                        } else {
                          void editorApi.openFile(note.path);
                        }
                        closePanel();
                      }}
                      className="w-full rounded px-1 py-0.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--item-hover-bg)]"
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate">{getFileName(note.path)}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-icon-muted)]">
                          {note.kind === "formula" ? `L${note.line}` : (note.score ?? 0).toFixed(2)}
                        </span>
                      </span>
                      {note.kind === "formula" && note.snippet && (
                        <span className="block truncate font-mono text-[11px] text-[var(--text-icon-muted)]">
                          {note.snippet}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
