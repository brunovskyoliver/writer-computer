/** Compile syntax into a compact program. No parser nodes survive compilation. */
import { RegExpParser, visitRegExpAST, type AST } from "@eslint-community/regexpp";

export const PATTERN_SOURCE_LIMIT = 2048;
const NESTING_LIMIT = 32;
const CAPTURE_LIMIT = 128;
const INSTRUCTION_LIMIT = 8192;

type Predicate = (point: string) => boolean;
// Module-level factories keep the compiler's AST/maps out of retained closures.
function literalPredicate(value: number): Predicate {
  return (point) => point.codePointAt(0) === value;
}
function classPredicate(raw: string): Predicate {
  const singlePoint = new RegExp(`^(?:${raw})$`, "u");
  return (point) => singlePoint.test(point);
}
export type Instruction =
  | { op: "char"; accepts: Predicate; next: number }
  | { op: "split"; first: number; second: number }
  | { op: "save"; slot: number; next: number }
  | { op: "clear"; slots: number[]; next: number }
  | { op: "init"; id: number; next: number }
  | {
      op: "repeat";
      id: number;
      min: number;
      max: number;
      greedy: boolean;
      body: number;
      exit: number;
    }
  | { op: "increment"; id: number; min: number; next: number }
  | { op: "edge"; kind: "start" | "end" | "word"; negate: boolean; next: number }
  | { op: "look"; program: Program; negate: boolean; next: number }
  | { op: "accept" };

type Bounds = { min: number; max: number; last: Predicate[] };
export type Program = {
  instructions: Instruction[];
  start: number;
  direction: 1 | -1;
  repeatCount: number;
  bounds: Bounds;
};

/** This runs before the recursive parser, including for malformed patterns. */
function checkSource(source: string): void {
  if (source.length > PATTERN_SOURCE_LIMIT)
    throw new Error(`Snippet triggers are limited to ${PATTERN_SOURCE_LIMIT} characters`);
  let depth = 0;
  let inClass = false;
  for (let pos = 0; pos < source.length; pos += 1) {
    const char = source[pos];
    if (char === "\\") {
      pos += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") {
      if (++depth > NESTING_LIMIT)
        throw new Error(`Snippet patterns are limited to ${NESTING_LIMIT} nested groups`);
    } else if (char === ")") depth -= 1;
  }
}

function multiply(length: number, count: number): number {
  if (length === 0 || count === 0) return 0;
  const product = length * count;
  return Number.isSafeInteger(product) ? product : Infinity;
}

export function compileProgram(
  source: string,
  wordBoundary: boolean,
): {
  source: string;
  program: Program;
  captureCount: number;
} {
  checkSource(source);
  const wrapped = `${wordBoundary ? "(?<![\\p{L}\\p{N}_])" : ""}(?:${source})$`;
  const ast = new RegExpParser().parsePattern(wrapped, 0, wrapped.length, { unicode: true });
  const captures = new Map<AST.CapturingGroup, number>();
  const captureRanges: { start: number; end: number; index: number }[] = [];
  visitRegExpAST(ast, {
    onCapturingGroupEnter(node) {
      if (node.name !== null) throw new Error("Named snippet capture groups are not supported");
      if (captures.size >= CAPTURE_LIMIT)
        throw new Error(`Snippet patterns are limited to ${CAPTURE_LIMIT} capture groups`);
      const index = captures.size + 1;
      captures.set(node, index);
      captureRanges.push({ start: node.start, end: node.end, index });
    },
    onBackreferenceEnter() {
      throw new Error("Snippet backreferences are not supported");
    },
    onModifiersEnter() {
      throw new Error("Snippet inline flag modifiers are not supported");
    },
    onQuantifierEnter(node) {
      if (
        !Number.isSafeInteger(node.min) ||
        (node.max !== Infinity && !Number.isSafeInteger(node.max))
      )
        throw new Error("Snippet repetition counts must be safe integers");
    },
  });

  const predicates = new Map<AST.Element, Predicate>();
  const boundsCache = new Map<AST.Element, Bounds>();
  function predicate(node: AST.Element): Predicate {
    const cached = predicates.get(node);
    if (cached) return cached;
    let accepts: Predicate;
    if (node.type === "Character") {
      accepts = literalPredicate(node.value);
    } else if (node.type === "CharacterClass" || node.type === "CharacterSet") {
      // These AST kinds consume exactly one code point under u semantics.
      // A user quantifier, group or assertion never enters the native engine.
      accepts = classPredicate(node.raw);
    } else throw new Error(`Unsupported snippet pattern node: ${node.type}`);
    predicates.set(node, accepts);
    return accepts;
  }

  function alternativesBounds(alternatives: AST.Alternative[]): Bounds {
    const choices = alternatives.map((alternative) => {
      const parts = alternative.elements.map(bounds);
      const last: Predicate[] = [];
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        last.push(...parts[index]!.last);
        if (parts[index]!.min > 0) break;
      }
      return {
        min: parts.reduce((sum, part) => sum + part.min, 0),
        max: parts.reduce((sum, part) => sum + part.max, 0),
        last,
      };
    });
    return {
      min: Math.min(...choices.map((choice) => choice.min)),
      max: Math.max(...choices.map((choice) => choice.max)),
      last: choices.flatMap((choice) => choice.last),
    };
  }

  function bounds(node: AST.Element): Bounds {
    const cached = boundsCache.get(node);
    if (cached) return cached;
    let result: Bounds;
    switch (node.type) {
      case "Assertion":
        result = { min: 0, max: 0, last: [] };
        break;
      case "Group":
      case "CapturingGroup":
        result = alternativesBounds(node.alternatives);
        break;
      case "Quantifier": {
        const child = bounds(node.element);
        result = {
          min: multiply(child.min, node.min),
          max: multiply(child.max, node.max),
          last: node.max === 0 ? [] : child.last,
        };
        break;
      }
      case "Character": {
        const size = node.value > 0xffff ? 2 : 1;
        result = { min: size, max: size, last: [predicate(node)] };
        break;
      }
      case "CharacterClass":
      case "CharacterSet":
        result = { min: 1, max: 2, last: [predicate(node)] };
        break;
      default:
        throw new Error(`Unsupported snippet pattern node: ${node.type}`);
    }
    boundsCache.set(node, result);
    return result;
  }

  let totalInstructions = 0;
  function build(alternatives: AST.Alternative[], direction: 1 | -1): Program {
    const instructions: Instruction[] = [];
    let repeatCount = 0;
    function emit(instruction: Instruction): number {
      if (++totalInstructions > INSTRUCTION_LIMIT)
        throw new Error(`Snippet programs are limited to ${INSTRUCTION_LIMIT} instructions`);
      return instructions.push(instruction) - 1;
    }
    function choices(alts: AST.Alternative[], next: number): number {
      const starts = alts.map((alt) => {
        const elements = direction === 1 ? alt.elements.slice().reverse() : alt.elements;
        return elements.reduce((continuation, element) => compile(element, continuation), next);
      });
      return starts.reduceRight((second, first) => emit({ op: "split", first, second }));
    }
    function compile(node: AST.Element, next: number): number {
      switch (node.type) {
        case "Character":
        case "CharacterClass":
        case "CharacterSet":
          return emit({ op: "char", accepts: predicate(node), next });
        case "Group":
          return choices(node.alternatives, next);
        case "CapturingGroup": {
          const slot = captures.get(node)! * 2;
          const exit = emit({ op: "save", slot: slot + (direction === 1 ? 1 : 0), next });
          const body = choices(node.alternatives, exit);
          return emit({ op: "save", slot: slot + (direction === 1 ? 0 : 1), next: body });
        }
        case "Assertion": {
          if (node.kind === "lookahead" || node.kind === "lookbehind")
            return emit({
              op: "look",
              program: build(node.alternatives, node.kind === "lookbehind" ? -1 : 1),
              negate: node.negate,
              next,
            });
          return emit({
            op: "edge",
            kind: node.kind,
            negate: node.kind === "word" && node.negate,
            next,
          });
        }
        case "Quantifier": {
          const id = repeatCount++;
          const repeat: Extract<Instruction, { op: "repeat" }> = {
            op: "repeat",
            id,
            min: node.min,
            max: node.max,
            greedy: node.greedy,
            body: -1,
            exit: next,
          };
          const loop = emit(repeat);
          const increment = emit({ op: "increment", id, min: node.min, next: loop });
          const body = compile(node.element, increment);
          const slots = captureRanges
            .filter((group) => group.start >= node.element.start && group.end <= node.element.end)
            .flatMap((group) => [group.index * 2, group.index * 2 + 1]);
          repeat.body = slots.length ? emit({ op: "clear", slots, next: body }) : body;
          return emit({ op: "init", id, next: loop });
        }
        default:
          throw new Error(`Unsupported snippet pattern node: ${node.type}`);
      }
    }
    const start = choices(alternatives, emit({ op: "accept" }));
    return {
      instructions,
      start,
      direction,
      repeatCount,
      bounds: alternativesBounds(alternatives),
    };
  }

  return { source: wrapped, program: build(ast.alternatives, 1), captureCount: captures.size };
}
