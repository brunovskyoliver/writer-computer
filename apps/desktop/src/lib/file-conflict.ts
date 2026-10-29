export interface FileConflict {
  diskContent: string | null;
}

export const FILE_CONFLICT_MESSAGE =
  "This file changed outside Writer. Autosave is paused until you choose a version.";

/** Native conditional writes return data only for this error; other IPC errors remain strings. */
export class FileConflictError extends Error {
  constructor(readonly diskContent: string | null) {
    super(FILE_CONFLICT_MESSAGE);
    this.name = "FileConflictError";
  }
}

export function decodeFileConflict(error: unknown): FileConflictError | null {
  if (typeof error !== "object" || error === null) return null;
  const value = error as Record<string, unknown>;
  return value.kind === "file_conflict" &&
    (value.diskContent === null || typeof value.diskContent === "string")
    ? new FileConflictError(value.diskContent)
    : null;
}
