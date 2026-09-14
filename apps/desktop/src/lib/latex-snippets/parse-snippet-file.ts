/**
 * Read the snippet file's *syntax*, never its semantics: `acorn` parses it and
 * we walk the AST. Nothing in the file is ever evaluated, so a snippet cannot
 * run code (FR-002a), and every entry keeps the line it came from for the
 * error list in Settings.
 *
 * Accepted shapes and per-key values: SPECs/latex-suite/contracts/snippet-file-format.md
 */

import type { EntryError, EntryErrorCode, LoadError } from "./options";

export type SnippetTrigger =
  | { kind: "string"; value: string }
  | { kind: "regex"; source: string; flags: string };

/** One parsed entry. Not validated yet — `compile.ts` does that. */
export type SnippetEntry = {
  index: number;
  line: number;
  trigger: SnippetTrigger;
  replacement: string;
  options: string;
  priority?: number;
  description?: string;
};

export type ParsedSnippetFile =
  | { entries: SnippetEntry[]; errors: EntryError[] }
  | { failure: LoadError };

/** Minimal shape of the acorn nodes we look at. Keeping it local means the
 *  module has no type dependency on the lazily-imported parser. */
type Node = {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};

const FILE_SHAPE_MESSAGE =
  "Expected the file to be one array of snippets, either `export default [...]` or `[...]`";

/** The array the file is built around, or `null` when the file is some other
 *  program. Comments are already gone at this point. */
function snippetArray(program: Node): Node | null {
  const body = (program.body as Node[]) ?? [];
  if (body.length !== 1) return null;
  const statement = body[0]!;
  const expression =
    statement.type === "ExportDefaultDeclaration"
      ? (statement.declaration as Node)
      : statement.type === "ExpressionStatement"
        ? (statement.expression as Node)
        : null;
  return expression?.type === "ArrayExpression" ? expression : null;
}

function lineOf(node: Node | null | undefined): number | undefined {
  return node?.loc?.start.line;
}

/** A string literal or a template literal with no `${}` expressions; anything
 *  else (including a template literal that interpolates) is not a string we
 *  can take without evaluating the file. */
function stringValue(node: Node): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as Node[]).length === 0) {
    const quasis = node.quasis as { value: { cooked?: string | null; raw: string } }[];
    return quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return null;
}

function numberValue(node: Node): number | null {
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const inner = numberValue(node.argument as Node);
    if (inner !== null) return node.operator === "-" ? -inner : inner;
  }
  return null;
}

function triggerValue(node: Node): SnippetTrigger | null {
  if (node.type === "Literal" && node.regex) {
    const { pattern, flags } = node.regex as { pattern: string; flags: string };
    return { kind: "regex", source: pattern, flags };
  }
  const text = stringValue(node);
  return text === null ? null : { kind: "string", value: text };
}

/** The property name for `{ trigger: … }` and `{ "trigger": … }`. Computed
 *  keys would need evaluation, so they are simply not names we know. */
function propertyName(property: Node): string | null {
  if (property.computed) return null;
  const key = property.key as Node;
  if (key.type === "Identifier") return key.name as string;
  return typeof key.value === "string" ? key.value : null;
}

const FUNCTION_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression"]);

type EntryFailure = { code: EntryErrorCode; message: string };

function failureFor(key: string, value: Node): EntryFailure {
  if (key === "replacement" && FUNCTION_TYPES.has(value.type)) {
    return {
      code: "function-replacement",
      message:
        "`replacement` is a function — Writer never runs the snippet file, so this entry is skipped",
    };
  }
  return {
    code: "unsupported-value",
    message: `\`${key}\` must be a plain string${key === "trigger" ? " or a regular expression" : ""}`,
  };
}

/** Walk one array element into either an entry or the reason it is not one. */
function readEntry(element: Node | null, index: number): SnippetEntry | EntryError {
  if (element === null || element.type !== "ObjectExpression") {
    return {
      code: "not-an-object",
      index,
      line: lineOf(element),
      message: "Every snippet must be an object literal",
    };
  }

  let trigger: SnippetTrigger | null = null;
  let replacement: string | null = null;
  let options: string | null = null;
  let priority: number | undefined;
  let description: string | undefined;
  let failure: EntryFailure | null = null;

  for (const property of element.properties as Node[]) {
    if (property.type !== "Property") continue;
    const name = propertyName(property);
    if (name === null) continue;
    const value = property.value as Node;

    switch (name) {
      case "trigger":
        trigger = triggerValue(value);
        failure ??= trigger === null ? failureFor(name, value) : null;
        break;
      case "replacement":
        replacement = stringValue(value);
        failure ??= replacement === null ? failureFor(name, value) : null;
        break;
      case "options":
        options = stringValue(value);
        failure ??= options === null ? failureFor(name, value) : null;
        break;
      case "priority": {
        const number = numberValue(value);
        if (number === null) failure ??= failureFor(name, value);
        else priority = number;
        break;
      }
      case "description":
        description = stringValue(value) ?? undefined;
        break;
      default:
        // Unknown keys (`excludedMacros`, …) are ignored, not errors.
        break;
    }
  }

  const literalTrigger = trigger?.kind === "string" ? trigger.value : undefined;
  const line = lineOf(element);

  if (failure) return { ...failure, index, line, trigger: literalTrigger };
  if (trigger === null || replacement === null || options === null) {
    const missing = [
      trigger === null ? "trigger" : null,
      replacement === null ? "replacement" : null,
      options === null ? "options" : null,
    ].filter((name) => name !== null);
    return {
      code: "missing-field",
      index,
      line,
      trigger: literalTrigger,
      message: `Missing ${missing.join(", ")}`,
    };
  }

  return {
    index,
    line: line ?? 0,
    trigger,
    replacement,
    options,
    ...(priority === undefined ? {} : { priority }),
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * Parse the snippet file. A syntax error or an unexpected file shape is a
 * whole-file `failure` (the store keeps the last valid set); a single bad
 * entry is an `EntryError` and the rest of the file still loads (FR-018).
 *
 * `acorn` is imported lazily so it stays off the startup path.
 */
export async function parseSnippetFile(source: string): Promise<ParsedSnippetFile> {
  const { parse } = await import("acorn");

  let program: Node;
  try {
    program = parse(source, {
      sourceType: "module",
      ecmaVersion: 2022,
      locations: true,
    }) as unknown as Node;
  } catch (error) {
    const syntaxError = error as SyntaxError & { loc?: { line: number; column: number } };
    return {
      failure: {
        message: syntaxError.message,
        line: syntaxError.loc?.line,
        column: syntaxError.loc?.column,
      },
    };
  }

  const array = snippetArray(program);
  if (!array) return { failure: { message: FILE_SHAPE_MESSAGE } };

  const entries: SnippetEntry[] = [];
  const errors: EntryError[] = [];
  (array.elements as (Node | null)[]).forEach((element, index) => {
    const result = readEntry(element, index);
    if ("code" in result) errors.push(result);
    else entries.push(result);
  });

  return { entries, errors };
}
