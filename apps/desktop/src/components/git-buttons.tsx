import { gitActions, useGitRunning } from "@/hooks/use-git";

const BUTTON =
  "pointer-events-auto rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--fg-base)] disabled:opacity-50";

export function GitButtons() {
  const running = useGitRunning();
  return (
    <div
      className="pointer-events-none absolute right-0 top-0 z-50 flex items-center gap-1.5"
      style={{
        height: "calc(var(--chrome-control-height) + var(--chrome-control-padding) * 2)",
        padding: "var(--chrome-control-padding) 12px",
      }}
    >
      <button
        type="button"
        className={BUTTON}
        disabled={running !== null}
        title="Get the latest changes, only if all of them apply cleanly"
        onClick={() => void gitActions().pull()}
      >
        {running === "pull" ? "Pulling…" : "Pull"}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={running !== null}
        title="Commit the files edited in Writer and push them"
        onClick={() => void gitActions().push()}
      >
        {running === "push" ? "Pushing…" : "Push"}
      </button>
    </div>
  );
}
