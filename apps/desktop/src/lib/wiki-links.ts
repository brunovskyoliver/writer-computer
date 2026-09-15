import { getFileStem, getParentDir, normalizePath } from "./paths";
import type { SearchResult } from "@/types/fs";

export type WikiLinkTarget = { kind: "internal"; path: string } | { kind: "unresolved" };
export interface ParsedWikiLink {
  raw: string;
  target: string;
  path: string;
  fragment: string | null;
  alias: string | null;
  displayText: string;
}

function unescapeWikiText(text: string): string {
  return text.replace(/\\\|/g, "|").trim();
}

function splitAlias(raw: string): { target: string; alias: string | null } {
  const separator = raw.indexOf("|");
  if (separator === -1) {
    return { target: raw, alias: null };
  }

  const escapedSeparator = separator > 0 && raw[separator - 1] === "\\";
  const targetEnd = escapedSeparator ? separator - 1 : separator;

  return {
    target: raw.slice(0, targetEnd),
    alias: unescapeWikiText(raw.slice(separator + 1)),
  };
}

function splitFragment(target: string): { path: string; fragment: string | null } {
  const hashIndex = target.indexOf("#");
  if (hashIndex === -1) {
    return { path: target, fragment: null };
  }

  return {
    path: target.slice(0, hashIndex),
    fragment: target.slice(hashIndex + 1),
  };
}

export function parseWikiLink(raw: string): ParsedWikiLink {
  const { target, alias } = splitAlias(raw.trim());
  const normalizedTarget = unescapeWikiText(target);
  const { path, fragment } = splitFragment(normalizedTarget);
  const normalizedPath = normalizeWikiTarget(path);
  const fallbackDisplay = normalizedPath || (fragment ? `#${fragment}` : normalizedTarget);

  return {
    raw,
    target: normalizedTarget,
    path: normalizedPath,
    fragment,
    alias: alias || null,
    displayText: alias || fallbackDisplay,
  };
}

/**
 * Normalize a raw wiki-link target string for resolution:
 * trim whitespace, normalize backslashes, strip .md/.markdown extension.
 */
export function normalizeWikiTarget(raw: string): string {
  let target = raw.trim().replace(/\\/g, "/");
  target = target.replace(/^\/+/, "");
  const lower = target.toLowerCase();
  if (lower.endsWith(".md")) {
    target = target.slice(0, -3);
  } else if (lower.endsWith(".markdown")) {
    target = target.slice(0, -9);
  }
  return target;
}

/**
 * Resolve a wiki-link target to an internal file path or unresolved.
 *
 * - If the target contains `/`, treat it as a workspace-relative path (without extension).
 * - Otherwise, treat it as a stem lookup across the workspace.
 *   Resolves only when exactly one markdown file matches the stem.
 */
export async function resolveWikiLink(
  raw: string,
  workspaceRoot: string,
  fuzzySearch: (query: string, limit?: number) => Promise<SearchResult[]>,
  fileExists: (path: string) => Promise<boolean>,
  currentFilePath?: string | null,
): Promise<WikiLinkTarget> {
  const link = parseWikiLink(raw);
  const target = link.path;
  if (!target && link.fragment && currentFilePath) {
    return { kind: "internal", path: currentFilePath };
  }
  if (!target) return { kind: "unresolved" };

  if (target.includes("/")) {
    const basePath = normalizePath(`${workspaceRoot.replace(/\/$/, "")}/${target}`);
    const candidatePaths = [`${basePath}.md`, `${basePath}.markdown`];
    const existence = await Promise.all(candidatePaths.map((path) => fileExists(path)));
    const matchIndex = existence.findIndex(Boolean);
    if (matchIndex !== -1) {
      return { kind: "internal", path: candidatePaths[matchIndex] };
    }
    return { kind: "unresolved" };
  }

  // Stem lookup: find all files whose stem matches (case-insensitive)
  const results = await fuzzySearch(target, 50);
  const targetLower = target.toLowerCase();
  const exactMatches = results.filter((r) => getFileStem(r.filename).toLowerCase() === targetLower);

  if (exactMatches.length === 1) {
    return { kind: "internal", path: exactMatches[0].path };
  }

  return { kind: "unresolved" };
}

// Image formats supported by Obsidian-style embeds (`![[image.png]]`),
// per SPECs/obsidian-image-embed-spec.md.
const WIKI_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/**
 * Parse the inner text of a `![[...]]` embed. Returns the normalized image
 * path (slashes normalized, leading `/` stripped) when the target is an
 * image, or null for non-image embeds (note transclusions, PDFs, …).
 * Anything after an unescaped `|` (alias / size modifiers) is ignored —
 * v1 non-goals per the spec.
 */
export function parseWikiImageEmbedTarget(raw: string): string | null {
  const { target } = splitAlias(raw.trim());
  const path = unescapeWikiText(target).replace(/\\/g, "/").replace(/^\/+/, "");
  const dot = path.lastIndexOf(".");
  if (dot <= 0 || dot === path.length - 1) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return WIKI_IMAGE_EXTENSIONS.has(ext) ? path : null;
}

/**
 * Resolve a wiki image embed target to an absolute file path, or null.
 *
 * - Targets with `/` resolve workspace-relative first (Obsidian vault-path
 *   semantics), then relative to the current note's directory.
 * - Bare basenames probe next to the note and at the workspace root, then
 *   fall back to a case-insensitive basename search across the workspace
 *   (`findFileByName`) — Obsidian's default "shortest path" links reference
 *   attachments by bare filename wherever they live.
 * - Without a workspace (compact windows), only note-relative probing
 *   applies.
 */
export async function resolveWikiImage(
  target: string,
  workspaceRoot: string | null,
  currentFilePath: string | null,
  fileExists: (path: string) => Promise<boolean>,
  findFileByName: (root: string, fileName: string) => Promise<string | null>,
): Promise<string | null> {
  const noteDir = currentFilePath ? getParentDir(currentFilePath) : null;
  const root = workspaceRoot ? workspaceRoot.replace(/\/$/, "") : null;

  const candidates: string[] = [];
  const pushCandidate = (base: string | null) => {
    if (!base) return;
    const path = normalizePath(`${base}/${target}`);
    if (!candidates.includes(path)) candidates.push(path);
  };
  if (target.includes("/")) {
    pushCandidate(root);
    pushCandidate(noteDir);
  } else {
    pushCandidate(noteDir);
    pushCandidate(root);
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  if (root && !target.includes("/")) {
    return findFileByName(root, target);
  }
  return null;
}

/**
 * Resolve a `.pdf` wiki-link target to an absolute path, or null.
 *
 * Separate from `resolveWikiLink` on purpose: that function's contract is
 * Markdown notes, and it gets there by stripping the extension
 * (`normalizeWikiTarget`) and then probing `.md`/`.markdown` or falling back to
 * a fuzzy-index stem lookup. None of that can find a PDF — the fuzzy index is
 * Markdown-only (research.md R3) — so a `.pdf` target has to keep its
 * extension and resolve by direct probing instead.
 *
 * The probing rule (workspace-relative first for a path, note-dir then root
 * then a basename search for a bare filename) is identical to an image embed's
 * and lives in `resolveWikiImage`; this delegates rather than restating it.
 * Pass the target with its extension intact — `parseWikiLink().path` already
 * leaves `.pdf` alone.
 */
export async function resolveWikiPdf(
  target: string,
  workspaceRoot: string | null,
  currentFilePath: string | null,
  fileExists: (path: string) => Promise<boolean>,
  findFileByName: (root: string, fileName: string) => Promise<string | null>,
): Promise<string | null> {
  const normalized = target.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return null;
  return resolveWikiImage(normalized, workspaceRoot, currentFilePath, fileExists, findFileByName);
}

/**
 * Compute the canonical insertion text for a selected file.
 * Uses the shortest unambiguous form: bare stem when unique,
 * workspace-relative path (without extension) when duplicate stems exist.
 */
export function canonicalWikiTarget(file: SearchResult, allFiles: SearchResult[]): string {
  const stem = getFileStem(file.filename);
  const stemLower = stem.toLowerCase();

  const hasDuplicate = allFiles.some(
    (f) => f.path !== file.path && getFileStem(f.filename).toLowerCase() === stemLower,
  );

  if (!hasDuplicate) return stem;

  return stripMdExtension(file.relative_path);
}

function stripMdExtension(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return path.slice(0, -3);
  if (lower.endsWith(".markdown")) return path.slice(0, -9);
  return path;
}
