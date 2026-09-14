/**
 * The non-schema half of the LaTeX Suite settings section: where the snippet
 * file lives, the two buttons that act on it, and what the last load produced.
 *
 * Contract: SPECs/latex-suite/contracts/settings.md ("Section rendering").
 * Every value is read from the snippet store — this component never touches
 * the file itself.
 */

import { ask } from "@tauri-apps/plugin-dialog";
import { useLatexSnippetStore } from "@/stores/latex-snippet-store";
import type { CompiledSnippetSet } from "@/lib/latex-snippets/compile";
import type { EntryError } from "@/lib/latex-snippets/options";

/** One snippet listed for several modes sits in several buckets as the same
 *  object, so count ids rather than bucket entries. */
function countSnippets(set: CompiledSnippetSet) {
  const ids = new Set<number>();
  for (const mode of Object.values(set.byMode)) {
    for (const snippet of [...mode.auto, ...mode.tab]) ids.add(snippet.id);
  }
  return ids.size;
}

function WarningRow({ error }: { error: EntryError }) {
  const parts = [
    `#${error.index}`,
    error.trigger ? `"${error.trigger}"` : null,
    error.line !== undefined ? `line ${error.line}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <li className="text-[12px] leading-relaxed text-[var(--text-muted)]">
      <span className="font-mono">{parts.join(" · ")}</span> — {error.message}
    </li>
  );
}

async function confirmReset() {
  const confirmed = await ask(
    "Replace your snippet file with the shipped defaults? This cannot be undone.",
    {
      title: "Reset snippets",
      kind: "warning",
    },
  );
  if (confirmed) await useLatexSnippetStore.getState().reset();
}

export function LatexSuiteExtras() {
  const filePath = useLatexSnippetStore((state) => state.filePath);
  const status = useLatexSnippetStore((state) => state.status);

  // Before the first load there is nothing true to say about the file.
  if (status.kind === "empty") return null;

  const count = countSnippets(status.set);
  const warnings = status.kind === "loaded" ? status.warnings : [];

  return (
    <div className="mt-3 px-4">
      {filePath && (
        <p className="mb-3 font-mono text-[12px] break-all text-[var(--text-muted)]">{filePath}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void useLatexSnippetStore.getState().openInEditor()}
          className="rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-subtle)]"
        >
          Edit snippets
        </button>
        <button
          type="button"
          onClick={() => void confirmReset()}
          className="rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-subtle)]"
        >
          Reset to defaults
        </button>
      </div>

      {status.kind === "failed" ? (
        <>
          <p role="alert" className="mt-3 text-[12px] text-[var(--text-error)]">
            Could not load: {status.error.message}
            {status.error.line !== undefined && ` (line ${status.error.line})`}
          </p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">
            Using the last valid set ({count} snippets)
          </p>
        </>
      ) : (
        <p className="mt-3 text-[12px] text-[var(--text-muted)]">
          {warnings.length === 0
            ? `${count} snippets loaded`
            : `${count} loaded, ${warnings.length} skipped`}
        </p>
      )}

      {warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {warnings.map((error, i) => (
            <WarningRow key={`${error.index}-${error.code}-${i}`} error={error} />
          ))}
        </ul>
      )}
    </div>
  );
}
