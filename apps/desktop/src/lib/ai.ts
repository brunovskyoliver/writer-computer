import { invoke } from "@tauri-apps/api/core";
import { parse, stringify } from "yaml";
import * as editorApi from "@/hooks/editor-api";
import { parseFrontmatter, serializeFile } from "@/lib/frontmatter";
import { readFile, writeFile } from "@/lib/tauri";

// IPC payload mirrors for `commands/ai.rs` — SPECs/ai-note-graph/data-model.md.

export interface AiStatus {
  enabled: boolean;
  chat_ok: boolean;
  embed_ok: boolean;
  indexed: number;
  pending: number;
}

export interface AiGraphNode {
  path: string;
  name: string;
  suggested_tags: string[];
}

export interface AiGraphEdge {
  source: string;
  target: string;
  kind: "link" | "similar";
  score: number | null;
}

export interface AiGraph {
  nodes: AiGraphNode[];
  edges: AiGraphEdge[];
}

export interface RelatedNote {
  path: string;
  score: number;
}

export function aiStatus(): Promise<AiStatus> {
  return invoke("ai_status");
}

export function aiGraph(): Promise<AiGraph> {
  return invoke("ai_graph");
}

/** `content` comes from the caller's buffer — an open file may be ahead of
 *  disk. */
export function aiSuggestTags(path: string, content: string): Promise<string[]> {
  return invoke("ai_suggest_tags", { path, content });
}

export function aiRelated(path: string): Promise<RelatedNote[]> {
  return invoke("ai_related", { path });
}

export function aiRescan(): Promise<void> {
  return invoke("ai_rescan");
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-");
}

function existingTagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return [];
}

/**
 * Merge `tags` into the frontmatter `tags` key, preserving every other key.
 * Existing `tags` may be a YAML list or a scalar (string/comma-separated) —
 * both normalize to a list; new tags append, deduped case-insensitively.
 * Returns the serialized frontmatter body (no `---` fences).
 */
export function mergeTagsIntoFrontmatter(fm: string | null, tags: string[]): string {
  const incoming = tags.map(normalizeTag).filter((tag) => tag !== "");
  if (fm !== null && fm.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = parse(fm);
    } catch {
      parsed = undefined;
    }
    if (
      parsed === undefined ||
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      // Unparseable (or non-map) frontmatter: append a tags block rather than
      // overwriting keys we couldn't read — least destructive merge.
      const existing = fm.replace(/\n$/, "");
      const block = ["tags:", ...incoming.map((tag) => `  - ${tag}`)].join("\n");
      return `${existing}\n${block}`;
    }

    const obj = parsed as Record<string, unknown>;
    const merged = existingTagList(obj.tags);
    const seen = new Set(merged.map((tag) => tag.toLowerCase()));
    for (const tag of incoming) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      merged.push(tag);
    }
    obj.tags = merged;
    return stringify(obj, { lineWidth: 0 }).trim();
  }

  const obj: Record<string, unknown> = { tags: incoming };
  return stringify(obj, { lineWidth: 0 }).trim();
}

/**
 * The single write path for accepted suggestions. Open file →
 * `updateFrontmatter` (dirty → autosave, the normal save path); closed file →
 * `readFile` + merge + `writeFile` (self-write suppression included).
 */
export async function applyTags(path: string, tags: string[]): Promise<void> {
  const open = editorApi.getOpenFile(path);
  if (open) {
    editorApi.updateFrontmatter(path, mergeTagsIntoFrontmatter(open.frontmatter, tags));
    return;
  }
  const file = await readFile(path);
  const parsed = parseFrontmatter(file.content);
  const merged = mergeTagsIntoFrontmatter(parsed.frontmatter, tags);
  await writeFile(path, serializeFile(merged, parsed.body));
}
