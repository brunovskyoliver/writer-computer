import { useEffect, useState } from "react";
import * as tauri from "@/lib/tauri";
import { useCalendarStore } from "@/stores/calendar-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** The link is write-only here: Rust keeps it outside the vault and never returns it. */
export function CalendarSection() {
  const root = useWorkspaceStore((s) => s.root);
  const [configured, setConfigured] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!root) return;
    tauri.calendarFeedConfigured().then(setConfigured, (e: unknown) => setError(String(e)));
  }, [root]);

  if (!root) return null;

  async function store(next: string | null) {
    setError(null);
    try {
      await tauri.setCalendarFeed(next);
      setConfigured(next !== null);
      setUrl("");
      await useCalendarStore.getState().refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mt-3 px-4">
      <p className="text-[12px] text-[var(--text-muted)]">
        {configured
          ? "Calendar link saved outside your notes. Lesson notes are created when a lesson starts and sorted into course folders automatically."
          : "Add a private calendar link (webcal or https) to list today's lessons, create a note when a lesson starts, and sort lesson notes into course folders automatically."}
      </p>
      <form
        className="mt-2 flex items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) void store(url);
        }}
      >
        <input
          type="password"
          aria-label="Calendar link"
          autoComplete="off"
          placeholder="webcal://…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-[var(--line-subtler)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-secondary)]"
        />
        <button
          type="submit"
          className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          Save
        </button>
        {configured && (
          <button
            type="button"
            onClick={() => void store(null)}
            className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          >
            Remove
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-[var(--text-muted)]">
          {error}
        </p>
      )}
    </div>
  );
}
