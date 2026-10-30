import { GFM, parser as baseParser } from "@lezer/markdown";
import {
  decodeLinkPath,
  formatMarkdownDestination,
  getFileExtension,
  getFileName,
  getFileStem,
  getParentDir,
  normalizeMarkdownDestination,
  normalizePath,
} from "./paths";
import { prosemarkMarkdownSyntaxExtensions } from "./prosemark-core/markdown";

const parser = baseParser.configure([GFM, prosemarkMarkdownSyntaxExtensions]);
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode"]);
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface PathMove {
  oldPath: string;
  newPath: string;
  root: string;
  isDir: boolean;
  /** A bare `[[name]]` follows the rename only if the old name was unique. */
  oldNameIsFree: boolean;
  /** The bare form still resolves to the moved file at its new name. */
  newNameIsFree: boolean;
}

/** Where a path lands after the move: itself, unless it is or sits under the moved entry. */
export function movedPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  return path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
}

export function relativePath(fromDir: string, to: string): string {
  const from = normalizePath(fromDir).split("/").filter(Boolean);
  const target = normalizePath(to).split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) {
    shared++;
  }
  return [...from.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");
}

function isMarkdownName(path: string): boolean {
  const extension = getFileExtension(path).toLowerCase();
  return extension === "md" || extension === "markdown";
}

function rewriteDestination(raw: string, noteOldDir: string, noteNewDir: string, move: PathMove) {
  const destination = normalizeMarkdownDestination(raw);
  if (!destination || destination.startsWith("#") || destination.startsWith("/")) return null;
  if (URL_SCHEME.test(destination)) return null;
  const suffixAt = destination.search(/[?#]/);
  const path = suffixAt === -1 ? destination : destination.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : destination.slice(suffixAt);
  if (!path) return null;
  // ponytail: extensionless site-style links (`./foo` for foo.md) are left as
  // written; add a `.md` probe here if a docs vault needs them followed.
  const decoded = decodeLinkPath(path);
  const oldTarget = normalizePath(`${noteOldDir}/${decoded}`);
  const newTarget = movedPath(oldTarget, move.oldPath, move.newPath);
  if (noteOldDir === noteNewDir && newTarget === oldTarget) return null;
  const next = relativePath(noteNewDir, newTarget);
  if (next === normalizePath(decoded).replace(/^\.\//, "")) return null;
  // Re-encode what would otherwise read as a suffix or an escape on the next parse.
  const encoded = next.replace(/[?#%]/g, encodeURIComponent);
  const formatted = formatMarkdownDestination(encoded + suffix);
  return /[()]/.test(formatted) && !formatted.startsWith("<") ? `<${formatted}>` : formatted;
}

function rewriteWikiPath(path: string, move: PathMove): string | null {
  const target = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!target) return null;
  const root = move.root.replace(/\/$/, "");
  const oldMarkdown = isMarkdownName(move.oldPath);

  if (target.includes("/")) {
    // Notes are written without their extension; attachments keep theirs.
    const written = normalizePath(`${root}/${target}`);
    const hasExtension = isMarkdownName(target);
    const candidates = hasExtension ? [written] : [written, `${written}.md`, `${written}.markdown`];
    for (const candidate of candidates) {
      const next = movedPath(candidate, move.oldPath, move.newPath);
      if (next === candidate) continue;
      const relative = relativePath(root, next);
      return candidate === written ? relative : relative.replace(/\.(md|markdown)$/i, "");
    }
    return null;
  }

  // A bare link names a file, so a folder's rename never touches one.
  const oldName = getFileName(move.oldPath);
  if (move.isDir || oldName === getFileName(move.newPath) || !move.oldNameIsFree) return null;
  const lower = target.toLowerCase();
  const explicit = lower === oldName.toLowerCase();
  if (!explicit && !(oldMarkdown && lower === getFileStem(oldName).toLowerCase())) return null;
  const newName = getFileName(move.newPath);
  if (!move.newNameIsFree) {
    const relative = relativePath(root, move.newPath);
    return explicit ? relative : relative.replace(/\.(md|markdown)$/i, "");
  }
  return explicit ? newName : getFileStem(newName);
}

/**
 * Every edit that keeps `text`'s links pointing at the same files after `move`.
 * `notePath` is the note's location after the move. Covers Markdown links and
 * images (relative to the note, so a moved note's own links change too) and
 * wiki links and embeds (workspace-relative or bare). Code is left alone.
 */
export function linkEditsForMove(text: string, notePath: string, move: PathMove): TextEdit[] {
  const edits: TextEdit[] = [];
  const noteNewDir = getParentDir(notePath);
  const noteOldPath = movedPath(notePath, move.newPath, move.oldPath);
  const noteOldDir = getParentDir(noteOldPath);
  const skipped: [number, number][] = [];

  parser.parse(text).iterate({
    enter(node) {
      if (CODE_NODES.has(node.name)) {
        skipped.push([node.from, node.to]);
        return false;
      }
      if (node.name !== "URL") return;
      const parent = node.node.parent?.name;
      if (parent !== "Link" && parent !== "Image" && parent !== "LinkReference") return;
      // A `[[` inside a destination is that destination's text, not a wiki link.
      skipped.push([node.from, node.to]);
      const insert = rewriteDestination(
        text.slice(node.from, node.to),
        noteOldDir,
        noteNewDir,
        move,
      );
      if (insert !== null) edits.push({ from: node.from, to: node.to, insert });
    },
  });

  for (const match of text.matchAll(WIKI_LINK)) {
    const at = match.index;
    if (skipped.some(([from, to]) => at >= from && at < to)) continue;
    const inner = match[1]!;
    const pathEnd = inner.search(/\\?\||#/);
    const path = pathEnd === -1 ? inner : inner.slice(0, pathEnd);
    const next = rewriteWikiPath(path, move);
    if (next !== null) edits.push({ from: at + 2, to: at + 2 + path.length, insert: next });
  }
  return edits.sort((a, b) => a.from - b.from);
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  let result = "";
  let at = 0;
  for (const edit of edits) {
    result += text.slice(at, edit.from) + edit.insert;
    at = edit.to;
  }
  return result + text.slice(at);
}
