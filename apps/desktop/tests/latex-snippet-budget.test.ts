import { describe, expect, test, vi } from "vite-plus/test";
import { compileSnippetSet } from "../src/lib/latex-snippets/compile";
import {
  createSnippetPattern,
  MatchingBudget,
  PatternBudgetExceeded,
} from "../src/lib/latex-snippets/bounded-pattern";
import { matchSnippet } from "../src/lib/latex-snippets/match";
import type { EntryError } from "../src/lib/latex-snippets/options";

function compile(source: string, literal = false, variables = new Map<string, string>()) {
  return compileSnippetSet(
    [
      {
        index: 0,
        line: 1,
        trigger: literal ? { kind: "string", value: source } : { kind: "regex", source, flags: "" },
        replacement: "ok",
        options: "mA",
      },
    ],
    variables,
  );
}

describe("bounded snippet loading", () => {
  test.each([
    "a".repeat(2049),
    "(".repeat(33) + "a" + ")".repeat(33),
    "(a)".repeat(129),
    String.raw`(a)\1`,
    "(?<name>a)",
    "(?i:a)",
  ])("reports an unsupported or oversized pattern without executing it", (source) => {
    const { set, errors } = compile(source);
    expect(set.count).toBe(0);
    expect(errors).toEqual([expect.objectContaining({ code: "invalid-pattern", index: 0 })]);
  });

  test.each([false, true])("bounds trigger variable expansion (literal=%s)", (literal) => {
    const { set, errors } = compile("${BIG}${BIG}", literal, new Map([["BIG", "a".repeat(2048)]]));
    expect(set.count).toBe(0);
    expect(errors[0]?.code).toBe("invalid-pattern");
    expect(errors[0]?.message).toContain("2048");
  });

  test("literal trigger length is bounded too", () => {
    expect(compile("a".repeat(2049), true).errors[0]?.code).toBe("invalid-pattern");
  });

  test("large counted repetitions compile without unrolling", () => {
    const { set, errors } = compile("a{1000000000}");
    expect(errors).toEqual([]);
    expect(set.byMode.inline.auto[0]!.pattern.test("aaa")).toBe(false);
  });
});

describe("ordered regex semantics", () => {
  const subjects = [
    "",
    "a",
    "b",
    "ab",
    "aa",
    "aba",
    "aab",
    "abc",
    "abbc",
    "baax",
    "p mat",
    "pmat",
    "{pmat",
    "{beginpmat",
    "é3",
    "😀a",
    "😀😀",
    "_a",
    " a",
    "a\n",
    "\n",
    "(",
    "[]",
  ];
  // Native execution is confined to short, safe subjects in this parity test.
  test.each([
    "(a|ab)(b?)",
    "(a+)(a*)",
    "(a+?)(a*)",
    "(a?)*",
    "(a?)+",
    "(?:a?){2,4}",
    "((a)|(b))+",
    "((a?)*)*",
    "(?=(a*))a*",
    "(?!b(a))a*",
    "(?=(a|ab))ab",
    "(?<=([ab]+)([bc]+))c",
    "(?<=(a|ba))x",
    String.raw`(?<!\{[A-Za-z]*)([pbBvV]mat)`,
    String.raw`\b(a+)\b`,
    String.raw`\B(a+)`,
    String.raw`(\p{L}+)(\d)`,
    String.raw`([^\p{L}]+)(\p{L})`,
    "(😀+)(.)?",
    String.raw`(\ud83d)(.)`,
    String.raw`[()\[\]]+`,
    "^a*",
    "a*$",
    ".",
    String.raw`(?:\s|\S)`,
  ])("matches native alternatives, captures, assertions and offsets: %s", (source) => {
    const bounded = createSnippetPattern(source, true, false);
    const native = new RegExp(`(?:${source})$`, "u");
    for (const subject of subjects) {
      const expected = native.exec(subject);
      const actual = bounded.exec(subject);
      expect(
        actual && { index: actual.index, values: Array.from(actual) },
        `${source} on ${JSON.stringify(subject)}`,
      ).toEqual(expected && { index: expected.index, values: Array.from(expected) });
    }
  });

  test("complementary character classes consume whole astral code points", () => {
    // Node 26's native [\s\S] suffix search misses this astral match.
    // The equivalent universal class provides an independent native oracle.
    const bounded = createSnippetPattern(String.raw`[\s\S]`, true, false).exec("😀😀");
    const native = /[^]$/u.exec("😀😀");
    expect(bounded && { index: bounded.index, values: Array.from(bounded) }).toEqual(
      native && { index: native.index, values: Array.from(native) },
    );
  });

  test("a literal never starts halfway through a surrogate pair", () => {
    const source = "\uDE00";
    const pattern = createSnippetPattern(source, false, false);
    expect(pattern.exec("😀")).toBeNull();
    expect(pattern.exec(source)?.index).toBe(0);
    expect(pattern.exec("a" + source)?.index).toBe(1);
  });

  test.each(["a", "é", "𝒜", "字", "3", "_", " ", "😀"])(
    "literal word guard agrees with Unicode semantics after %s",
    (prefix) => {
      const pattern = createSnippetPattern("dm", false, true);
      expect(pattern.test(prefix + "dm")).toBe(/(?<![\p{L}\p{N}_])dm$/u.test(prefix + "dm"));
    },
  );
});

describe("matching work limits", () => {
  test("earlier scan time is never charged to a pattern's own timer", () => {
    let time = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    try {
      const pattern = createSnippetPattern("a", true, false);
      const scan = new MatchingBudget();
      time = 21;
      let failure: unknown;
      try {
        pattern.exec("a", scan);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(PatternBudgetExceeded);
      expect((failure as PatternBudgetExceeded).scope).toBe("scan");
    } finally {
      clock.mockRestore();
    }
  });
  test.each(["(a+)+b", "(a|aa)+b", "(?=(a+)+c)a+b"])(
    "interrupts pathological work and releases states: %s",
    (source) => {
      const pattern = createSnippetPattern(source, true, false);
      const budget = new MatchingBudget();
      expect(() => pattern.exec("a".repeat(80) + "b".repeat(2), budget)).toThrow(
        PatternBudgetExceeded,
      );
      expect(budget.activeStates).toBe(0);
      expect(budget.exhausted).toBe(false);
    },
  );

  test("state limits stop a deep linear backtracking stack", () => {
    const pattern = createSnippetPattern("a+", true, false);
    expect(() => pattern.exec("a".repeat(500))).toThrow(/backtracking state/);
  });

  test("an individual hostile pattern is disabled, later literal and fresh input still work", () => {
    const { set } = compile("(a+)+b");
    const literal = compile("b", true).set.byMode.inline.auto[0]!;
    literal.id = 1;
    set.byMode.inline.auto.push(literal);
    const failures: string[] = [];
    const args = {
      context: { kind: "inline" as const, node: { from: 0, to: 0, formulaFrom: 0, formulaTo: 0 } },
      set,
      kind: "auto" as const,
      selectionText: "",
      onDisable(id: number, error: EntryError) {
        failures.push(error.code);
        set.byMode.inline.auto.find((snippet) => snippet.id === id)!.disabled = error;
      },
    };
    expect(matchSnippet({ ...args, lineBefore: "a".repeat(80) + "bb" })?.snippet.id).toBe(1);
    expect(failures).toEqual(["pattern-timeout"]);
    expect(matchSnippet({ ...args, lineBefore: "b" })?.snippet.id).toBe(1);
    expect(failures).toHaveLength(1);
  });

  test("individual state failure leaves enough scan capacity for a later regex", () => {
    const { set } = compile("a+");
    const later = compile("a{500}").set.byMode.inline.auto[0]!;
    later.id = 1;
    set.byMode.inline.auto.push(later);
    const onDisable = vi.fn((id: number, error: EntryError) => {
      set.byMode.inline.auto.find((snippet) => snippet.id === id)!.disabled = error;
    });
    expect(
      matchSnippet({
        lineBefore: "a".repeat(500),
        context: { kind: "inline", node: { from: 0, to: 0, formulaFrom: 0, formulaTo: 0 } },
        set,
        kind: "auto",
        selectionText: "",
        onDisable,
      })?.snippet.id,
    ).toBe(1);
    expect(onDisable).toHaveBeenCalledOnce();
    expect(onDisable.mock.calls[0]![0]).toBe(0);
    expect(later.disabled).toBeNull();
  });

  test("shared exhaustion leaves a cheap later pattern enabled for fresh input", () => {
    // Freeze only the clock; actual instruction work still uses production limits.
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const costly = compile("^a{7000}dc").set.byMode.inline.auto[0]!;
      const second = compile("^a{7000}fc").set.byMode.inline.auto[0]!;
      second.id = 1;
      const healthy = compile("^(?:a{7000}ec|ac)").set.byMode.inline.auto[0]!;
      healthy.id = 2;
      const set = compile("unused", true).set;
      const untouched = compile("ec").set.byMode.inline.auto[0]!;
      untouched.id = 3;
      const laterExec = vi.spyOn(untouched.pattern, "exec");
      set.byMode.inline.auto = [costly, second, healthy, untouched];
      const onDisable = vi.fn();
      const args = {
        context: {
          kind: "inline" as const,
          node: { from: 0, to: 0, formulaFrom: 0, formulaTo: 0 },
        },
        set,
        kind: "auto" as const,
        selectionText: "",
        onDisable,
      };
      const lineBefore = "a".repeat(7000) + "ec";
      expect(healthy.pattern.test(lineBefore)).toBe(true);
      expect(matchSnippet({ ...args, lineBefore })).toBeNull();
      expect(onDisable).not.toHaveBeenCalled();
      expect(laterExec).not.toHaveBeenCalled();
      expect(healthy.disabled).toBeNull();
      expect(matchSnippet({ ...args, lineBefore: "ac" })?.snippet.id).toBe(2);
      expect(untouched.disabled).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  test("the shared deadline stops literal scanning without blaming an untouched entry", () => {
    const { set } = compile("a", true);
    const onDisable = vi.fn();
    const args = {
      lineBefore: "a",
      context: { kind: "inline" as const, node: { from: 0, to: 0, formulaFrom: 0, formulaTo: 0 } },
      set,
      kind: "auto" as const,
      selectionText: "",
      onDisable,
    };
    expect(matchSnippet(args)?.snippet.id).toBe(0);
    const exec = vi.spyOn(set.byMode.inline.auto[0]!.pattern, "exec");
    let time = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (time += 21));
    try {
      expect(matchSnippet(args)).toBeNull();
      expect(onDisable).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
