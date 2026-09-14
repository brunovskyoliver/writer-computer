import { describe, expect, test } from "vite-plus/test";
import { compileSnippetSet, parseVariables } from "../src/lib/latex-snippets/compile";
import type { SnippetEntry } from "../src/lib/latex-snippets/parse-snippet-file";

let nextIndex = 0;

/** One entry with the boring fields filled in. */
function entry(partial: Partial<SnippetEntry> & { options: string }): SnippetEntry {
  const index = partial.index ?? nextIndex++;
  return {
    index,
    line: index + 1,
    trigger: { kind: "string", value: "x" },
    replacement: "y",
    ...partial,
  } as SnippetEntry;
}

function compile(entries: SnippetEntry[], variables: Record<string, string> = {}) {
  return compileSnippetSet(entries, new Map(Object.entries(variables)));
}

describe("option letters", () => {
  test("an unknown letter, no mode letter and two mode letters are all rejected", () => {
    const { set, errors } = compile([
      entry({ options: "tAZ" }),
      entry({ options: "A" }),
      entry({ options: "tmA" }),
    ]);

    expect(errors.map((error) => error.code)).toEqual([
      "invalid-options",
      "invalid-options",
      "invalid-options",
    ]);
    expect(set.count).toBe(0);
  });

  test("a redundant `r` on a regex trigger is accepted", () => {
    const { set, errors } = compile([
      entry({
        trigger: { kind: "regex", source: "a(b)", flags: "" },
        replacement: "[[0]]",
        options: "rmA",
      }),
    ]);

    expect(errors).toEqual([]);
    expect(set.count).toBe(1);
  });
});

describe("snippet variables", () => {
  test("are substituted into the trigger source", () => {
    const { set } = compile(
      [
        entry({
          trigger: { kind: "string", value: "\\\\(${GREEK})" },
          replacement: "y",
          options: "rmA",
        }),
      ],
      { GREEK: "alpha|beta" },
    );

    const snippet = set.byMode.inline.auto[0]!;
    expect(snippet.pattern.test("\\alpha")).toBe(true);
    expect(snippet.pattern.test("\\gamma")).toBe(false);
  });

  test("an unresolved name skips the entry", () => {
    const { errors } = compile([entry({ index: 7, replacement: "${NOPE}", options: "mA" })]);
    expect(errors[0]).toMatchObject({ code: "unknown-variable", index: 7, line: 8 });
  });

  test("`${VISUAL}` and placeholder tabstops are not variables", () => {
    const { set, errors } = compile([entry({ replacement: "${0:f}(${VISUAL})", options: "mA" })]);
    expect(errors).toEqual([]);
    expect(set.byMode.inline.auto[0]?.visual).toBe(true);
  });

  test("parseVariables splits on the first `=` and reports malformed items", () => {
    const { variables, errors } = parseVariables(["GREEK", "=x", "A=b=c"]);

    expect(errors.map((error) => [error.code, error.index])).toEqual([
      ["invalid-variable", 0],
      ["invalid-variable", 1],
    ]);
    expect(variables.get("A")).toBe("b=c");
  });
});

describe("pattern validation", () => {
  test("a missing capture group is reported", () => {
    const { errors } = compile([
      entry({
        trigger: { kind: "regex", source: "(a)b", flags: "" },
        replacement: "[[1]]",
        options: "mA",
      }),
    ]);
    expect(errors[0]).toMatchObject({ code: "missing-capture" });
  });

  test("an unbalanced group and a `v`-flag literal are invalid patterns", () => {
    const { errors } = compile([
      entry({ trigger: { kind: "regex", source: "(a", flags: "" }, options: "mA" }),
      entry({ trigger: { kind: "regex", source: "a", flags: "v" }, options: "mA" }),
    ]);
    expect(errors.map((error) => error.code)).toEqual(["invalid-pattern", "invalid-pattern"]);
  });

  test("a non-finite priority is reported", () => {
    const { errors } = compile([entry({ options: "mA", priority: Number.NaN })]);
    expect(errors[0]).toMatchObject({ code: "invalid-priority" });
  });

  test("`w` requires a non-word character before the trigger", () => {
    const { set } = compile([entry({ trigger: { kind: "string", value: "dm" }, options: "tAw" })]);
    const snippet = set.byMode.text.auto[0]!;

    expect(snippet.pattern.test(" dm")).toBe(true);
    expect(snippet.pattern.test("dm")).toBe(true);
    expect(snippet.pattern.test("admin")).toBe(false);
    expect(snippet.pattern.test("adm")).toBe(false);
  });

  test("a literal trigger is regex-escaped", () => {
    const { set } = compile([entry({ trigger: { kind: "string", value: "a+b" }, options: "mA" })]);
    expect(set.byMode.inline.auto[0]?.pattern.test("a+b")).toBe(true);
  });
});

describe("the compiled set", () => {
  test("sorts by priority descending, then file order", () => {
    const { set } = compile([
      entry({ index: 0, trigger: { kind: "string", value: "a" }, options: "mA" }),
      entry({ index: 1, trigger: { kind: "string", value: "b" }, options: "mA", priority: 2 }),
      entry({ index: 2, trigger: { kind: "string", value: "c" }, options: "mA" }),
    ]);

    expect(set.byMode.inline.auto.map((snippet) => snippet.triggerText)).toEqual(["b", "a", "c"]);
  });

  test("splits automatic and Tab snippets, and puts `math` in both math buckets", () => {
    const { set } = compile([
      entry({ trigger: { kind: "string", value: "auto" }, options: "mA" }),
      entry({ trigger: { kind: "string", value: "tab" }, options: "m" }),
      entry({ trigger: { kind: "string", value: "inline" }, options: "nA" }),
      entry({ trigger: { kind: "string", value: "display" }, options: "MA" }),
      entry({ trigger: { kind: "string", value: "prose" }, options: "tA" }),
    ]);

    expect(set.byMode.inline.auto.map((s) => s.triggerText)).toEqual(["auto", "inline"]);
    expect(set.byMode.display.auto.map((s) => s.triggerText)).toEqual(["auto", "display"]);
    expect(set.byMode.inline.tab.map((s) => s.triggerText)).toEqual(["tab"]);
    expect(set.byMode.text.auto.map((s) => s.triggerText)).toEqual(["prose"]);
    expect(set.count).toBe(5);
  });

  test("keys visual snippets by mode and trigger", () => {
    const { set } = compile([
      entry({
        trigger: { kind: "string", value: "U" },
        replacement: "\\underbrace{${VISUAL}}",
        options: "mA",
      }),
    ]);

    expect(set.visual.get("inline:U")).toHaveLength(1);
    expect(set.visual.get("display:U")).toHaveLength(1);
    expect(set.visual.get("text:U")).toBeUndefined();
  });
});
