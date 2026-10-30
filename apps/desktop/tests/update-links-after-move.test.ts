import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { updateLinksAfterMove } from "../src/lib/update-links-after-move";
import { useEditorStore } from "../src/stores/editor-store";

const disk = new Map<string, string>();
const writes: { path: string; content: string; expected: unknown }[] = [];
const conflictOn = new Set<string>();

beforeEach(() => {
  disk.clear();
  writes.length = 0;
  conflictOn.clear();
  vi.mocked(invoke).mockImplementation(async (cmd: string, raw: unknown) => {
    const args = raw as { path: string; content: string; expected?: { content: string } };
    if (cmd === "list_workspace_notes") return [...disk.keys()];
    if (cmd === "read_file")
      return { path: args.path, content: disk.get(args.path), modified_at: 1 };
    if (cmd === "write_file") {
      if (conflictOn.has(args.path)) throw { kind: "file_conflict", diskContent: "changed" };
      writes.push({ path: args.path, content: args.content, expected: args.expected?.content });
      return { modified_at: 2 };
    }
    return null;
  });
});

describe("updateLinksAfterMove", () => {
  test("writes only notes whose links change, conditionally on what was read", async () => {
    disk.set("/v/a.md", "[[Foo]] [x](Foo.md)");
    disk.set("/v/plain.md", "no links");
    disk.set("/v/Bar.md", "self");

    const result = await updateLinksAfterMove("/v/Foo.md", "/v/Bar.md", false, "/v");

    expect(result).toEqual({ updated: 1, failed: [] });
    expect(writes).toEqual([
      { path: "/v/a.md", content: "[[Bar]] [x](Bar.md)", expected: "[[Foo]] [x](Foo.md)" },
    ]);
  });

  test("a note changed underneath is reported and the rest still update", async () => {
    disk.set("/v/a.md", "[[Foo]]");
    disk.set("/v/b.md", "[[Foo]]");
    disk.set("/v/Bar.md", "");
    conflictOn.add("/v/a.md");

    const result = await updateLinksAfterMove("/v/Foo.md", "/v/Bar.md", false, "/v");

    expect(result).toEqual({ updated: 1, failed: ["/v/a.md"] });
    expect(writes.map((write) => write.path)).toEqual(["/v/b.md"]);
  });

  test("an open note without a view updates its buffer and is not written around", async () => {
    disk.set("/v/a.md", "[[Foo]]");
    disk.set("/v/Bar.md", "");
    await useEditorStore.getState().openFile("/v/a.md");

    await updateLinksAfterMove("/v/Foo.md", "/v/Bar.md", false, "/v");

    expect(useEditorStore.getState().openFiles.get("/v/a.md")!.content).toBe("[[Bar]]");
    expect(writes.every((write) => write.content === "[[Bar]]")).toBe(true);
  });
});
