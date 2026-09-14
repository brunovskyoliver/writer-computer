import { describe, expect, test } from "vite-plus/test";
import { compileSnippetSet } from "../src/lib/latex-snippets/compile";
import type { SnippetEntry } from "../src/lib/latex-snippets/parse-snippet-file";
import { matchSnippet } from "../src/lib/latex-snippets/match";
import type { MathContext } from "../src/lib/latex-snippets/math-context";
import type { EntryError } from "../src/lib/latex-snippets/options";

type Entry = {
  trigger: string | { source: string; flags?: string };
  replacement: string;
  options: string;
  priority?: number;
};

function entries(list: Entry[]): SnippetEntry[] {
  return list.map((entry, index) => ({
    index,
    line: index + 1,
    trigger:
      typeof entry.trigger === "string"
        ? { kind: "string" as const, value: entry.trigger }
        : {
            kind: "regex" as const,
            source: entry.trigger.source,
            flags: entry.trigger.flags ?? "",
          },
    replacement: entry.replacement,
    options: entry.options,
    ...(entry.priority === undefined ? {} : { priority: entry.priority }),
  }));
}

function compile(list: Entry[], variables: Record<string, string> = {}) {
  const { set, errors } = compileSnippetSet(entries(list), new Map(Object.entries(variables)));
  expect(errors).toEqual([]);
  return set;
}

const INLINE: MathContext = {
  kind: "inline",
  node: { from: 0, to: 10, formulaFrom: 1, formulaTo: 9 },
};
const PROSE: MathContext = { kind: "prose" };

function match(
  set: ReturnType<typeof compile>,
  lineBefore: string,
  options: {
    context?: MathContext;
    kind?: "auto" | "tab";
    selectionText?: string;
    typedText?: string;
    onDisable?: (id: number, error: EntryError) => void;
  } = {},
) {
  return matchSnippet({
    lineBefore,
    context: options.context ?? INLINE,
    set,
    kind: options.kind ?? "auto",
    selectionText: options.selectionText ?? "",
    ...(options.typedText === undefined ? {} : { typedText: options.typedText }),
    onDisable: options.onDisable ?? (() => {}),
  });
}

describe("matchSnippet", () => {
  test("word boundary: `dm` fires on its own but not inside `admin`", () => {
    const set = compile([{ trigger: "dm", replacement: "$$$0$$", options: "tAw" }]);
    const prose = { context: PROSE };

    expect(match(set, "dm", prose)?.from).toBe(0);
    expect(match(set, "text dm", prose)?.from).toBe(5);
    expect(match(set, "admin", prose)).toBeNull();
  });

  test("priority wins over file order: `ddot` beats `dot`", () => {
    const set = compile([
      { trigger: "dot", replacement: "\\dot{$0}", options: "mA" },
      { trigger: "ddot", replacement: "\\ddot{$0}", options: "mA", priority: 1 },
    ]);

    expect(match(set, "ddot")?.snippet.triggerText).toBe("ddot");
    expect(match(set, "dot")?.snippet.triggerText).toBe("dot");
  });

  test("a math snippet does not fire in prose", () => {
    const set = compile([{ trigger: "sin", replacement: "\\sin", options: "mA" }]);

    expect(match(set, "sin")).not.toBeNull();
    expect(match(set, "the sin", { context: PROSE })).toBeNull();
  });

  test("no snippet fires in code or inside \\text{}", () => {
    const set = compile([{ trigger: "sin", replacement: "\\sin", options: "mA" }]);

    expect(match(set, "sin", { context: { kind: "code" } })).toBeNull();
    expect(match(set, "sin", { context: { ...INLINE, kind: "text" } })).toBeNull();
  });

  test("macro guard: typing inside a control sequence suppresses the match", () => {
    const set = compile(
      [
        { trigger: "text", replacement: "\\text{$0}", options: "mA" },
        // The shipped "space after a Greek letter" rule, in miniature.
        {
          trigger: { source: "\\\\(?!(?:alpha|in|int)$)(alpha|in|int)([A-Za-z])" },
          replacement: "\\[[0]] [[1]]",
          options: "rmA",
        },
      ],
      {},
    );

    // `\tex` + `t` must stay `\text`, not expand the `text` snippet.
    expect(match(set, "\\text")).toBeNull();
    // `\alpha` + `x` is a complete macro followed by a letter: the space rule fires.
    expect(match(set, "\\alphax")?.groups).toEqual(["alpha", "x"]);
    // `\in` + `t` is still building `\int`: the lookahead keeps it literal.
    expect(match(set, "\\int")).toBeNull();
  });

  test("the macro guard only applies to automatic snippets", () => {
    const set = compile([{ trigger: "text", replacement: "\\text{$0}", options: "m" }]);

    expect(match(set, "\\text", { kind: "tab" })).not.toBeNull();
  });

  test("visual snippets need a selection and the exact typed trigger", () => {
    const set = compile([
      { trigger: "S", replacement: "\\sqrt{ ${VISUAL} }", options: "mA" },
      { trigger: "sin", replacement: "\\sin", options: "mA" },
    ]);

    const hit = match(set, "S", { selectionText: "a+b", typedText: "S" });
    expect(hit?.snippet.triggerText).toBe("S");
    expect(hit?.visualText).toBe("a+b");
    expect(hit?.from).toBe(-1);

    // No selection: `S` is literal.
    expect(match(set, "S")).toBeNull();
    // With a selection, a non-visual snippet never fires.
    expect(match(set, "sin", { selectionText: "a+b", typedText: "n" })).toBeNull();
  });

  test("a pattern that throws is reported and the scan continues", () => {
    const set = compile([
      { trigger: "boom", replacement: "x", options: "mA" },
      { trigger: "oom", replacement: "ok", options: "mA" },
    ]);
    const first = set.byMode.inline.auto[0]!;
    first.pattern = { exec: () => throwing() } as unknown as RegExp;

    const disabled: EntryError[] = [];
    const hit = match(set, "boom", { onDisable: (_id, error) => disabled.push(error) });

    expect(disabled.map((error) => error.code)).toEqual(["pattern-threw"]);
    expect(hit?.snippet.triggerText).toBe("oom");
  });

  test("capture groups come back with the match", () => {
    const set = compile([
      { trigger: { source: "(\\w+)bar" }, replacement: "\\[[0]]", options: "mA" },
    ]);

    expect(match(set, "foobar")?.groups).toEqual(["foo"]);
  });
});

function throwing(): never {
  throw new Error("catastrophic backtracking");
}
