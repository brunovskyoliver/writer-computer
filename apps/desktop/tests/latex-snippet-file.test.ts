import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { parseSnippetFile } from "../src/lib/latex-snippets/parse-snippet-file";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

async function parse(source: string) {
  const result = await parseSnippetFile(source);
  if ("failure" in result) throw new Error(`unexpected failure: ${result.failure.message}`);
  return result;
}

describe("the user's Obsidian Latex Suite file", () => {
  test("loads with exactly its four function replacements skipped", async () => {
    const { entries, errors } = await parse(read("../../../SPECs/obsidian-latex-suite"));

    expect(errors.map((error) => error.code)).toEqual([
      "function-replacement",
      "function-replacement",
      "function-replacement",
      "function-replacement",
    ]);
    // Every other element became an entry, and each carries its line number.
    expect(entries.length).toBeGreaterThan(180);
    expect(entries.every((entry) => entry.line > 0)).toBe(true);
  });
});

describe("the shipped default set", () => {
  test("parses without a single error", async () => {
    const { entries, errors } = await parse(read("../shared/latex-snippets.default.js"));

    expect(errors).toEqual([]);
    expect(entries.length).toBeGreaterThan(180);
  });
});

describe("accepted file shapes", () => {
  test("a bare array and an export default array both load", async () => {
    const entry = '{trigger: "mk", replacement: "$$0$", options: "tA"}';
    expect((await parse(`[${entry}]`)).entries).toHaveLength(1);
    expect((await parse(`export default [${entry}]`)).entries).toHaveLength(1);
  });

  test("anything else is a whole-file failure", async () => {
    const result = await parseSnippetFile("const snippets = [];\nexport default snippets;");
    expect("failure" in result && result.failure.message).toContain("array of snippets");
  });

  test("a syntax error reports its line", async () => {
    const result = await parseSnippetFile('[\n  {trigger: "x"\n]');
    expect("failure" in result && result.failure.line).toBe(3);
  });
});

describe("per-entry errors", () => {
  test("a template literal with an expression is an unsupported value", async () => {
    const { errors } = await parse('[{trigger: "x", replacement: `a${1}b`, options: "tA"}]');
    expect(errors).toEqual([
      expect.objectContaining({ code: "unsupported-value", index: 0, trigger: "x" }),
    ]);
  });

  test("an expression-free template literal is taken as a string", async () => {
    const { entries } = await parse("[{trigger: `x`, replacement: `a`, options: `tA`}]");
    expect(entries[0]).toMatchObject({ trigger: { kind: "string", value: "x" }, replacement: "a" });
  });

  test("a non-object element is reported", async () => {
    const { errors } = await parse('["mk"]');
    expect(errors).toEqual([expect.objectContaining({ code: "not-an-object", index: 0 })]);
  });

  test("a missing field is reported with the string trigger attached", async () => {
    const { errors } = await parse('[{trigger: "mk", replacement: "$$0$"}]');
    expect(errors).toEqual([
      expect.objectContaining({ code: "missing-field", index: 0, trigger: "mk" }),
    ]);
    expect(errors[0]?.message).toContain("options");
  });

  test("a negative priority parses", async () => {
    const { entries } = await parse(
      '[{trigger: "x", replacement: "y", options: "tA", priority: -1}]',
    );
    expect(entries[0]?.priority).toBe(-1);
  });

  test("a regex trigger keeps its source and flags, unknown keys are ignored", async () => {
    const { entries, errors } = await parse(
      '[{trigger: /(\\S\\s*)dm/i, replacement: "y", options: "rtA", excludedMacros: ["x"]}]',
    );
    expect(errors).toEqual([]);
    expect(entries[0]?.trigger).toEqual({ kind: "regex", source: "(\\S\\s*)dm", flags: "i" });
  });
});
