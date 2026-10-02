/** Ordered backtracking with interruptible work and bounded state allocation. */
import { PATTERN_TIME_BUDGET_MS } from "./options";
import { compileProgram, PATTERN_SOURCE_LIMIT, type Program } from "./pattern-program";

export { PATTERN_SOURCE_LIMIT } from "./pattern-program";
const PATTERN_OPERATION_LIMIT = 25_000;
const SCAN_OPERATION_LIMIT = 50_000;
const STATE_LIMIT = 256;

export class PatternBudgetExceeded extends Error {
  constructor(
    readonly scope: "pattern" | "scan",
    reason: string,
  ) {
    super(`Snippet ${scope} exceeded its ${reason} budget`);
  }
}

/** One per matcher scan, shared by every candidate and nested lookaround. */
export class MatchingBudget {
  readonly started = performance.now();
  operations = 0;
  activeStates = 0;
  exhausted = false;

  hasTime(): boolean {
    return performance.now() - this.started <= PATTERN_TIME_BUDGET_MS;
  }
}

class PatternRun {
  private operations = 0;
  private readonly started: number;
  constructor(readonly scan: MatchingBudget) {
    this.started = performance.now();
  }
  tick(): void {
    this.operations += 1;
    this.scan.operations += 1;
    if (this.operations > PATTERN_OPERATION_LIMIT)
      this.fail("pattern", `${PATTERN_OPERATION_LIMIT} operation`);
    if (this.scan.operations > SCAN_OPERATION_LIMIT)
      this.fail("scan", `${SCAN_OPERATION_LIMIT} operation`);
    if ((this.operations & 63) === 1) this.checkTime();
  }
  checkTime(): void {
    const now = performance.now();
    if (now - this.started > PATTERN_TIME_BUDGET_MS)
      this.fail("pattern", `${PATTERN_TIME_BUDGET_MS}ms`);
    if (now - this.scan.started > PATTERN_TIME_BUDGET_MS)
      this.fail("scan", `${PATTERN_TIME_BUDGET_MS}ms`);
  }
  reserveState(): void {
    if (this.scan.activeStates >= STATE_LIMIT)
      this.fail("pattern", `${STATE_LIMIT} backtracking state`);
    this.scan.activeStates += 1;
  }
  private fail(scope: "pattern" | "scan", reason: string): never {
    this.scan.exhausted = scope === "scan" || this.scan.operations > SCAN_OPERATION_LIMIT;
    throw new PatternBudgetExceeded(scope, reason);
  }
}

export interface SnippetPattern {
  readonly kind: "literal" | "regex";
  readonly source: string;
  readonly captureCount: number;
  exec(subject: string, scan?: MatchingBudget): RegExpExecArray | null;
  test(subject: string): boolean;
}

/** UTF-16 offsets throughout; only the current code point is decoded. */
function pointSize(subject: string, pos: number, direction: 1 | -1): number {
  if (direction === 1) return (subject.codePointAt(pos) ?? 0) > 0xffff ? 2 : 1;
  const last = subject.charCodeAt(pos - 1);
  const previous = subject.charCodeAt(pos - 2);
  return last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 2 : 1;
}

type State = {
  pc: number;
  pos: number;
  captures: Int32Array;
  counts: Uint32Array;
  positions: Int32Array;
};
function copyState(state: State, pc: number): State {
  return {
    pc,
    pos: state.pos,
    captures: state.captures.slice(),
    counts: state.counts.slice(),
    positions: state.positions.slice(),
  };
}

function run(
  program: Program,
  subject: string,
  pos: number,
  captures: Int32Array,
  budget: PatternRun,
): State | null {
  let state: State = {
    pc: program.start,
    pos,
    captures: captures.slice(),
    counts: new Uint32Array(program.repeatCount),
    positions: new Int32Array(program.repeatCount),
  };
  const stack: State[] = [];
  function fork(pc: number): void {
    budget.reserveState();
    stack.push(copyState(state, pc));
  }
  try {
    while (true) {
      budget.tick();
      const instruction = program.instructions[state.pc]!;
      let failed = false;
      switch (instruction.op) {
        case "accept":
          return state;
        case "char": {
          if (program.direction === 1 ? state.pos >= subject.length : state.pos <= 0) {
            failed = true;
            break;
          }
          const size = pointSize(subject, state.pos, program.direction);
          const next = state.pos + size * program.direction;
          const point = subject.slice(Math.min(state.pos, next), Math.max(state.pos, next));
          if (!instruction.accepts(point)) failed = true;
          else {
            state.pos = next;
            state.pc = instruction.next;
          }
          break;
        }
        case "split":
          fork(instruction.second);
          state.pc = instruction.first;
          break;
        case "save":
          state.captures[instruction.slot] = state.pos;
          state.pc = instruction.next;
          break;
        case "clear":
          for (const slot of instruction.slots) state.captures[slot] = -1;
          state.pc = instruction.next;
          break;
        case "init":
          state.counts[instruction.id] = 0;
          state.pc = instruction.next;
          break;
        case "repeat": {
          const count = state.counts[instruction.id]!;
          if (count >= instruction.max) {
            state.pc = instruction.exit;
            break;
          }
          if (count >= instruction.min) {
            if (!instruction.greedy) {
              state.positions[instruction.id] = state.pos;
              fork(instruction.body);
              state.pc = instruction.exit;
              break;
            }
            fork(instruction.exit);
          }
          state.positions[instruction.id] = state.pos;
          state.pc = instruction.body;
          break;
        }
        case "increment": {
          const id = instruction.id;
          // Optional empty iterations must fail so previous captures survive.
          if (state.positions[id] === state.pos && state.counts[id]! >= instruction.min)
            failed = true;
          else {
            state.counts[id] += 1;
            state.pc = instruction.next;
          }
          break;
        }
        case "edge": {
          let passes: boolean;
          if (instruction.kind === "start") passes = state.pos === 0;
          else if (instruction.kind === "end") passes = state.pos === subject.length;
          else
            passes =
              /[A-Za-z0-9_]/.test(subject[state.pos - 1] ?? "") !==
              /[A-Za-z0-9_]/.test(subject[state.pos] ?? "");
          if (passes === instruction.negate) failed = true;
          else state.pc = instruction.next;
          break;
        }
        case "look": {
          budget.reserveState();
          let found: State | null;
          try {
            found = run(instruction.program, subject, state.pos, state.captures, budget);
          } finally {
            budget.scan.activeStates -= 1;
          }
          if ((found !== null) === instruction.negate) failed = true;
          else {
            if (found !== null) state.captures = found.captures;
            state.pc = instruction.next;
          }
          break;
        }
      }
      if (failed) {
        const previous = stack.pop();
        if (!previous) return null;
        budget.scan.activeStates -= 1;
        state = previous;
      }
    }
  } finally {
    budget.scan.activeStates -= stack.length;
  }
}

function result(subject: string, from: number, captures: (string | undefined)[]): RegExpExecArray {
  return Object.assign([subject.slice(from), ...captures], {
    index: from,
    input: subject,
    groups: undefined,
  }) as RegExpExecArray;
}

export function createSnippetPattern(
  source: string,
  regex: boolean,
  wordBoundary: boolean,
): SnippetPattern {
  if (source.length > PATTERN_SOURCE_LIMIT)
    throw new Error(`Snippet triggers are limited to ${PATTERN_SOURCE_LIMIT} characters`);
  if (!regex) {
    return {
      kind: "literal",
      source: `${wordBoundary ? "(?<![\\p{L}\\p{N}_])" : ""}(?:${source.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")})$`,
      captureCount: 0,
      exec(subject) {
        if (!subject.endsWith(source)) return null;
        const from = subject.length - source.length;
        if (from > 0 && pointSize(subject, from + 1, -1) === 2) return null;
        if (wordBoundary && from > 0) {
          const size = pointSize(subject, from, -1);
          if (/[\p{L}\p{N}_]/u.test(subject.slice(from - size, from))) return null;
        }
        return result(subject, from, []);
      },
      test(subject) {
        return this.exec(subject) !== null;
      },
    };
  }
  const compiled = compileProgram(source, wordBoundary);
  const { program, captureCount } = compiled;
  return {
    kind: "regex",
    source: compiled.source,
    captureCount,
    exec(subject, scan = new MatchingBudget()) {
      const budget = new PatternRun(scan);
      budget.tick();
      const { min, max, last } = program.bounds;
      if (min > subject.length) return null;
      if (min > 0 && last.length > 0) {
        const size = pointSize(subject, subject.length, -1);
        const point = subject.slice(subject.length - size);
        let possible = false;
        for (const accepts of last) {
          budget.tick();
          if (accepts(point)) {
            possible = true;
            break;
          }
        }
        if (!possible) return null;
      }
      const captures = new Int32Array((captureCount + 1) * 2).fill(-1);
      const end = subject.length - min;
      for (let from = Math.max(0, subject.length - max); from <= end; ) {
        // A conservative UTF-16 length bound can begin inside a surrogate pair.
        if (from > 0 && pointSize(subject, from + 1, -1) === 2) {
          from += 1;
          continue;
        }
        budget.tick();
        const found = run(program, subject, from, captures, budget);
        if (found) {
          budget.checkTime();
          const groups = [];
          for (let index = 1; index <= captureCount; index += 1) {
            const start = found.captures[index * 2]!;
            const finish = found.captures[index * 2 + 1]!;
            groups.push(start === -1 || finish === -1 ? undefined : subject.slice(start, finish));
          }
          return result(subject, from, groups);
        }
        from += pointSize(subject, from, 1);
      }
      budget.checkTime();
      return null;
    },
    test(subject) {
      return this.exec(subject) !== null;
    },
  };
}
