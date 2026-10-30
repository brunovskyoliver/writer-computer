import { useState } from "react";
import {
  type GitConfirm,
  gitActions,
  useGitConfirm,
  useGitExcluded,
  useGitMessage,
  useGitPanelOpen,
  useGitResult,
  useGitRunning,
  useGitStatus,
} from "@/hooks/use-git";
import { useOpenFile } from "@/hooks/use-tabs";
import { useWorkspace } from "@/hooks/use-workspace";
import { defaultCommitMessage } from "@/lib/git";
import type { GitFile, GitStatus } from "@/lib/tauri";
import { useGitStatusUpdates } from "./use-git-status-updates";

const FILES_SHOWN = 200;
const STATUS_TITLES: Record<string, string> = {
  "?": "New",
  A: "Added",
  M: "Modified",
  D: "Deleted",
  T: "Type changed",
  U: "Conflict",
};
const BUTTON =
  "rounded-md bg-[var(--surface-subtle)] px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--fg-base)] disabled:opacity-50";
const NOTE = "whitespace-pre-wrap break-words text-[12px] leading-[1.35]";

function Counts({ status }: { status: GitStatus }) {
  const label = status.branch ?? "detached HEAD";
  return (
    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
      {label}
      {status.upstream !== null && (
        <span
          className="ml-1.5 tabular-nums"
          aria-label={`${status.ahead} ahead, ${status.behind} behind`}
        >
          ↑{status.ahead} ↓{status.behind}
        </span>
      )}
      {status.files.length > 0 && (
        <span className="ml-1.5 tabular-nums">· {status.files.length} changed</span>
      )}
    </span>
  );
}

function FileRow({
  file,
  root,
  conflict,
  chosen,
}: {
  file: GitFile;
  root: string;
  conflict: boolean;
  chosen: boolean;
}) {
  const openFile = useOpenFile();
  const deleted = file.status === "D";
  return (
    <li className="flex min-w-0 items-center gap-1.5 py-0.5 text-[12px]">
      <input
        type="checkbox"
        checked={chosen}
        onChange={() => gitActions().toggleFile(file.path)}
        aria-label={`Include ${file.path} in the commit`}
      />
      <span
        className="w-3 shrink-0 text-center text-[var(--text-muted)]"
        title={STATUS_TITLES[file.status] ?? file.status}
      >
        {file.status}
      </span>
      <button
        type="button"
        disabled={deleted}
        onClick={() => void openFile(`${root}/${file.path}`)}
        title={file.path}
        className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left ${
          conflict ? "font-semibold text-[var(--fg-base)]" : "text-[var(--text-secondary)]"
        } hover:text-[var(--fg-base)]`}
      >
        {file.path}
      </button>
    </li>
  );
}

function CommitWarning({ confirm }: { confirm: GitConfirm }) {
  const oneSided = confirm.kind === "oneSided";
  return (
    <div role="alert" className="rounded-md bg-[var(--surface-subtle)] p-2">
      <p className={`${NOTE} text-[var(--fg-base)]`}>
        {oneSided
          ? "Git couldn't combine these. Only the version on disk would be committed; the other side is dropped from this commit:"
          : "These look like credentials and would be committed:"}
      </p>
      <ul className={`${NOTE} my-1 text-[var(--text-secondary)]`}>
        {confirm.suspects.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p className={`${NOTE} mb-2 text-[var(--text-muted)]`}>
        {oneSided
          ? "To keep the other version, replace the file on disk first, or abort the merge."
          : "If they shouldn't be in the repo, add them to .gitignore and sync again."}
      </p>
      <div className="flex gap-1.5">
        <button type="button" className={BUTTON} onClick={() => gitActions().dismissConfirm()}>
          Cancel
        </button>
        <button type="button" className={BUTTON} onClick={() => void gitActions().commitSuspects()}>
          {oneSided ? "Commit the version on disk" : "Commit anyway"}
        </button>
      </div>
    </div>
  );
}

function AbortMerge({ busy }: { busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={BUTTON} disabled={busy} onClick={() => setConfirming(true)}>
        Abort merge…
      </button>
    );
  }
  return (
    <div role="alert" className="rounded-md bg-[var(--surface-subtle)] p-2">
      <p className={`${NOTE} mb-2 text-[var(--fg-base)]`}>
        This undoes the pull and puts your files back as they were at your last commit. Anything
        staged or fixed since leaves your files, and Writer keeps a copy in a local commit it names
        afterwards.
      </p>
      <div className="flex gap-1.5">
        <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
          Keep merging
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            void gitActions().abortMerge();
          }}
        >
          Abort merge
        </button>
      </div>
    </div>
  );
}

function Details({ status, busy }: { status: GitStatus; busy: boolean }) {
  const excluded = useGitExcluded();
  const message = useGitMessage();
  const repoRoot = status.repoRoot ?? "";
  const chosen = status.files.filter((file) => !excluded.includes(file.path));
  const merging = status.inProgress === "merge";
  const conflicts = new Set(status.conflicts);
  const canCommit = !busy && (chosen.length > 0 || merging);
  const noUpstream = status.hasRemote && status.upstream === null && status.branch !== null;
  return (
    <div className="flex flex-col gap-1.5 pb-1.5 pl-[10px] pr-1">
      {status.inProgress !== null && (
        <p className={`${NOTE} text-[var(--fg-base)]`} role="status">
          {merging && conflicts.size > 0
            ? `Merge stopped. Conflicts in ${[...conflicts].join(", ")}.`
            : `A ${status.inProgress} is in progress.`}
        </p>
      )}
      {status.files.length > 0 && (
        <ul className="max-h-40 overflow-y-auto">
          {status.files.slice(0, FILES_SHOWN).map((file) => (
            <FileRow
              key={file.path}
              file={file}
              root={repoRoot}
              conflict={conflicts.has(file.path)}
              chosen={!excluded.includes(file.path)}
            />
          ))}
        </ul>
      )}
      {status.files.length > FILES_SHOWN && (
        <p className={`${NOTE} text-[var(--text-muted)]`}>
          and {status.files.length - FILES_SHOWN} more, which a commit includes.
        </p>
      )}
      {status.outsideChanges > 0 && (
        <p className={`${NOTE} text-[var(--text-muted)]`}>
          {status.outsideChanges} changed outside this folder, left out of Sync.
        </p>
      )}
      <input
        type="text"
        value={message}
        onChange={(event) => gitActions().setMessage(event.target.value)}
        placeholder={defaultCommitMessage(chosen, merging)}
        aria-label="Commit message"
        className="w-full rounded-md bg-[var(--surface-input)] px-2 py-1 text-[12px] text-[var(--fg-base)] outline-none placeholder:text-[var(--text-muted)]"
      />
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={BUTTON}
          disabled={!canCommit}
          onClick={() => void gitActions().commit()}
        >
          {merging ? "Commit merge" : `Commit ${chosen.length}`}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => void gitActions().pull()}
        >
          Pull
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => void gitActions().push()}
        >
          Push
        </button>
        {noUpstream && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void gitActions().publish()}
          >
            Publish branch
          </button>
        )}
      </div>
      {merging && <AbortMerge busy={busy} />}
    </div>
  );
}

export function GitPanel() {
  useGitStatusUpdates();
  const { root } = useWorkspace();
  const status = useGitStatus();
  const running = useGitRunning();
  const result = useGitResult(root);
  const open = useGitPanelOpen();
  const confirm = useGitConfirm();
  if (!root || !status) return null;

  if (status.kind === "noRepo") {
    return (
      <section aria-label="Git" className="flex items-center gap-1.5 pb-1 pl-[10px] text-[12px]">
        <span className="min-w-0 flex-1 text-[var(--text-muted)]">Not a git repository</span>
        <button
          type="button"
          className={BUTTON}
          disabled={running !== null}
          onClick={() => void gitActions().init()}
        >
          Initialize
        </button>
      </section>
    );
  }
  if (status.kind !== "ok") {
    return (
      <section aria-label="Git" className="pb-1 pl-[10px]">
        <p className={`${NOTE} text-[var(--text-secondary)]`} role="status">
          {status.message}
        </p>
      </section>
    );
  }

  const busy = running !== null;
  return (
    <section aria-label="Git" className="mb-1 max-h-[50vh] overflow-y-auto">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => gitActions().setPanelOpen(!open)}
          aria-expanded={open}
          aria-label="Git changes"
          title={status.upstream ?? "No upstream"}
          className="flex h-[28px] min-w-0 flex-1 items-center overflow-hidden rounded-lg pl-[10px] pr-1 text-left text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--fg-base)]"
        >
          <Counts status={status} />
        </button>
        <button
          type="button"
          className={`${BUTTON} shrink-0`}
          disabled={busy}
          aria-busy={busy}
          title="Commit everything, pull, push (Cmd+Shift+S)"
          onClick={() => void gitActions().sync()}
        >
          {running === null ? "Sync" : `${runningLabel(running)}…`}
        </button>
      </div>
      {result && !confirm && (
        <p
          role="status"
          title={new Date(result.at).toLocaleString()}
          className={`${NOTE} max-h-24 overflow-y-auto pb-1.5 pl-[10px] pr-1 ${
            result.ok ? "text-[var(--text-muted)]" : "text-[var(--danger,#cf222e)]"
          }`}
        >
          {result.message}
        </p>
      )}
      {confirm && <CommitWarning confirm={confirm} />}
      {open && <Details status={status} busy={busy} />}
    </section>
  );
}

function runningLabel(action: string) {
  return (
    { sync: "Syncing", pull: "Pulling", push: "Pushing", commit: "Committing" }[action] ?? "Working"
  );
}
