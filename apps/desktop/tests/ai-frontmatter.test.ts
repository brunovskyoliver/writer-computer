import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import { mergeTagsIntoFrontmatter } from "../src/lib/ai";

describe("mergeTagsIntoFrontmatter", () => {
  test("creates a tags list when frontmatter is absent", () => {
    const merged = mergeTagsIntoFrontmatter(null, ["Math", "Set Theory"]);
    expect(parse(merged)).toEqual({ tags: ["math", "set-theory"] });
  });

  test("creates a tags list when frontmatter is empty", () => {
    const merged = mergeTagsIntoFrontmatter("", ["a"]);
    expect(parse(merged)).toEqual({ tags: ["a"] });
  });

  test("appends to an existing list, preserving other keys", () => {
    const merged = mergeTagsIntoFrontmatter("title: Note\ntags:\n  - existing\n", ["new-tag"]);
    expect(parse(merged)).toEqual({ title: "Note", tags: ["existing", "new-tag"] });
  });

  test("supports a scalar tags value", () => {
    const merged = mergeTagsIntoFrontmatter("tags: solo\n", ["added"]);
    expect(parse(merged)).toEqual({ tags: ["solo", "added"] });
  });

  test("supports a comma-separated scalar", () => {
    const merged = mergeTagsIntoFrontmatter("tags: one, two\n", ["three"]);
    expect(parse(merged)).toEqual({ tags: ["one", "two", "three"] });
  });

  test("dedupes case-insensitively and normalizes incoming tags", () => {
    const merged = mergeTagsIntoFrontmatter("tags:\n  - math\n", ["Math", "  spaced  tag "]);
    expect(parse(merged)).toEqual({ tags: ["math", "spaced-tag"] });
  });

  test("appends a tags block to unparseable frontmatter instead of overwriting it", () => {
    // `: bad` is not valid YAML — merging must not drop it.
    const merged = mergeTagsIntoFrontmatter(": bad\nkeep-me", ["tag"]);
    expect(merged).toContain(": bad");
    expect(merged).toContain("keep-me");
    expect(merged).toContain("tags:");
    expect(merged).toContain("- tag");
  });
});
