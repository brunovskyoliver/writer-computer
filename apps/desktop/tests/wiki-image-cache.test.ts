import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { notifyEditorReset } from "../src/lib/editor-reset";
import { resolveWikiImageEmbed } from "../src/lib/wiki-links";

describe("wiki image resolution caching", () => {
  beforeEach(() => notifyEditorReset());

  function resolver(
    fileExists = vi.fn(async (_path: string) => true),
    findFileByName = vi.fn(async (_root: string, _name: string): Promise<string | null> => null),
  ) {
    return (target = "pic.png", root: string | null = "/vault", note = "/vault/note.md") =>
      resolveWikiImageEmbed(target, root, note, fileExists, findFileByName);
  }

  test("reuses a successful resolution", async () => {
    const fileExists = vi.fn(async () => true);
    const resolve = resolver(fileExists);
    expect(await resolve()).toBe("/vault/pic.png");
    expect(await resolve()).toBe("/vault/pic.png");
    expect(fileExists).toHaveBeenCalledTimes(1);
  });

  test("keeps workspace, note and target contexts independent, including compact windows", async () => {
    const fileExists = vi.fn(async () => true);
    const resolve = resolver(fileExists);
    const contexts = [
      ["pic.png", "/vault", "/vault/a/note.md", "/vault/a/pic.png"],
      ["pic.png", "/other", "/other/a/note.md", "/other/a/pic.png"],
      ["pic.png", "/vault", "/vault/b/note.md", "/vault/b/pic.png"],
      ["other.png", "/vault", "/vault/a/note.md", "/vault/a/other.png"],
      ["pic.png", null, "/solo/note.md", "/solo/pic.png"],
    ] as const;
    for (const [target, root, note, expected] of contexts) {
      expect(await resolve(target, root, note)).toBe(expected);
    }
    expect(fileExists).toHaveBeenCalledTimes(contexts.length);
    fileExists.mockClear();
    for (const [target, root, note, expected] of contexts) {
      expect(await resolve(target, root, note)).toBe(expected);
    }
    expect(fileExists).not.toHaveBeenCalled();
  });

  test("evicts the least recently used resolution after 256 entries", async () => {
    const fileExists = vi.fn(async () => true);
    const resolve = resolver(fileExists);
    for (let index = 0; index < 256; index++) await resolve(`image-${index}.png`);
    await resolve("image-0.png");
    await resolve("image-256.png");
    fileExists.mockClear();
    await resolve("image-0.png");
    expect(fileExists).not.toHaveBeenCalled();
    expect(await resolve("image-1.png")).toBe("/vault/image-1.png");
    expect(fileExists).toHaveBeenCalledTimes(1);
  });

  test("reprobes a successful lookup after editor reset", async () => {
    const fileExists = vi.fn(async () => true);
    const resolve = resolver(fileExists);
    await resolve("reset.png");
    notifyEditorReset();
    await resolve("reset.png");
    expect(fileExists).toHaveBeenCalledTimes(2);
  });

  test("an old completion cannot overwrite a newer same-key result after reset", async () => {
    let release!: (path: string | null) => void;
    const findFileByName = vi.fn(() => new Promise<string | null>((done) => (release = done)));
    const fileExists = vi.fn(async () => false);
    const resolve = resolver(fileExists, findFileByName);
    const pending = resolve("race.png");
    await vi.waitFor(() => expect(findFileByName).toHaveBeenCalledTimes(1));
    notifyEditorReset();
    findFileByName.mockResolvedValue("/vault/new/race.png");
    expect(await resolve("race.png")).toBe("/vault/new/race.png");
    release("/vault/old/race.png");
    expect(await pending).toBe("/vault/old/race.png");
    fileExists.mockClear();
    expect(await resolve("race.png")).toBe("/vault/new/race.png");
    expect(fileExists).not.toHaveBeenCalled();
  });

  test("an old completion cannot refill an empty cache after reset", async () => {
    let release!: (exists: boolean) => void;
    const fileExists = vi.fn(() => new Promise<boolean>((done) => (release = done)));
    const resolve = resolver(fileExists);
    const pending = resolve("empty.png");
    notifyEditorReset();
    release(true);
    expect(await pending).toBe("/vault/empty.png");
    fileExists.mockResolvedValue(false);
    expect(await resolve("empty.png")).toBeNull();
    expect(fileExists).toHaveBeenCalledTimes(2);
  });

  test("misses are not cached, so a newly created image resolves", async () => {
    const fileExists = vi.fn(async () => false);
    const resolve = resolver(fileExists);
    expect(await resolve("missing.png")).toBeNull();
    expect(await resolve("missing.png")).toBeNull();
    expect(fileExists).toHaveBeenCalledTimes(2);
    fileExists.mockResolvedValue(true);
    expect(await resolve("missing.png")).toBe("/vault/missing.png");
  });

  test("failed lookups propagate their error and can be retried", async () => {
    const error = new Error("filesystem unavailable");
    const fileExists = vi.fn(async () => true).mockRejectedValueOnce(error);
    const resolve = resolver(fileExists);
    await expect(resolve("retry.png")).rejects.toBe(error);
    expect(await resolve("retry.png")).toBe("/vault/retry.png");
    expect(fileExists).toHaveBeenCalledTimes(2);
  });

  test("does not retain an oversized key even when its normalized path exists", async () => {
    const target = `${"folder/../".repeat(1000)}pic.png`;
    const fileExists = vi.fn(async (path: string) => path === "/vault/pic.png");
    const resolve = resolver(fileExists);
    expect(await resolve(target)).toBe("/vault/pic.png");
    expect(await resolve(target)).toBe("/vault/pic.png");
    expect(fileExists).toHaveBeenCalledTimes(2);
  });

  test.each([8192, 8193])("caps combined key and resolved path at %i characters", async (size) => {
    const target = `long-${size}.png`;
    const root = "/vault";
    const note = "/vault/note.md";
    const keyLength = JSON.stringify([root, note, target]).length;
    const prefix = "/vault/";
    const path = prefix + "x".repeat(size - keyLength - prefix.length);
    const fileExists = vi.fn(async () => false);
    const findFileByName = vi.fn(async () => path);
    const resolve = resolver(fileExists, findFileByName);
    expect(await resolve(target, root, note)).toBe(path);
    expect(await resolve(target, root, note)).toBe(path);
    expect(findFileByName).toHaveBeenCalledTimes(size === 8192 ? 1 : 2);
  });
});
