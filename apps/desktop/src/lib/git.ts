import type { GitFile } from "./tauri";

const NAMES_SHOWN = 3;

function baseName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A readable default, so Sync never has to stop and ask for a message. */
export function defaultCommitMessage(files: GitFile[], merging = false): string {
  if (merging) return "Merge remote changes";
  if (files.length === 0) return "Update notes";
  const verb = files.every((file) => file.status === "D")
    ? "Delete"
    : files.every((file) => file.status === "?" || file.status === "A")
      ? "Add"
      : "Update";
  const names = files.slice(0, NAMES_SHOWN).map((file) => baseName(file.path));
  const more = files.length - names.length;
  return `${verb} ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
