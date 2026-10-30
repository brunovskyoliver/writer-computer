import { decompressBoundedBase64 } from "./bounded-lz-string";

/** Limits are UTF-16 code units, bounding JS allocations before decoding/parsing. */
export const OBSIDIAN_DRAWING_LIMITS = {
  sourceCharacters: 4 * 1024 * 1024,
  outputCharacters: 8 * 1024 * 1024,
  dictionaryCharacters: 16 * 1024 * 1024,
  dictionaryEntries: 262_144,
  elements: 10_000,
  nesting: 64,
  containers: 250_000,
} as const;

export interface ObsidianDrawingScene {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check structural budgets incrementally, including while LZString expands. */
function jsonBudgetScanner(): (chunk: string) => void {
  let depth = 0;
  let containers = 0;
  let inString = false;
  let escaped = false;
  let rootString = "";
  let lastRootString = "";
  let valueKey = "";
  let awaitingValue = false;
  let inElements = false;
  let nextElement = false;
  let elementCount = 0;
  const rootKeys = new Set<string>();
  return (chunk) => {
    for (const char of chunk) {
      if (inString) {
        if (depth === 1) rootString += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          inString = false;
          if (depth === 1) lastRootString = rootString;
        }
        continue;
      }
      if (/\s/.test(char)) continue;
      if (inElements && depth === 2 && nextElement && char !== "]" && char !== ",") {
        if (++elementCount > OBSIDIAN_DRAWING_LIMITS.elements) {
          throw new Error("Drawing exceeds the element limit.");
        }
        nextElement = false;
      }
      if (char === '"') {
        inString = true;
        rootString = '"';
      } else if (char === ":" && depth === 1) {
        try {
          valueKey = JSON.parse(lastRootString) as string;
        } catch {
          throw new Error("Invalid drawing JSON property.");
        }
        if (rootKeys.has(valueKey)) throw new Error("Duplicate drawing JSON property.");
        rootKeys.add(valueKey);
        awaitingValue = true;
      } else if (char === "{" || char === "[") {
        if (depth === 1 && awaitingValue && valueKey === "elements" && char === "[") {
          inElements = true;
          nextElement = true;
        }
        awaitingValue = false;
        if (++depth > OBSIDIAN_DRAWING_LIMITS.nesting) {
          throw new Error("Drawing exceeds the JSON nesting limit.");
        }
        if (++containers > OBSIDIAN_DRAWING_LIMITS.containers) {
          throw new Error("Drawing exceeds the JSON container limit.");
        }
      } else if (char === "}" || char === "]") {
        if (inElements && depth === 2) inElements = false;
        depth--;
      } else if (char === ",") {
        if (inElements && depth === 2) nextElement = true;
        if (depth === 1) awaitingValue = false;
      }
    }
  };
}

function readSections(source: string): Map<string, string> {
  const headings = [
    ...source.matchAll(
      /^#{1,2} (Text Elements|Element Links|Embedded Files|Drawing|Markdown Images)[ \t]*\n/gm,
    ),
  ];
  const sections = new Map<string, string>();
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (sections.has(heading[1])) throw new Error(`Multiple ${heading[1]} sections in drawing.`);
    sections.set(
      heading[1],
      source.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? source.length),
    );
  }
  return sections;
}

function wrapperOnly(text: string): boolean {
  return text.split("\n").every((line) => line.trim() === "" || line.trim() === "%%");
}

const elementTypes = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "text",
  "arrow",
  "line",
  "freedraw",
  "image",
  "frame",
  "magicframe",
]);

function validateScene(value: unknown): ObsidianDrawingScene {
  if (!isRecord(value) || value.type !== "excalidraw" || !Array.isArray(value.elements)) {
    throw new Error("Drawing JSON must contain an Excalidraw scene and elements array.");
  }
  if (value.elements.length > OBSIDIAN_DRAWING_LIMITS.elements) {
    throw new Error("Drawing exceeds the element limit.");
  }
  if (!isRecord(value.appState) || (value.files !== undefined && !isRecord(value.files))) {
    throw new Error("Invalid drawing app state or files.");
  }
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (
      !isRecord(element) ||
      typeof element.id !== "string" ||
      !element.id ||
      typeof element.type !== "string"
    )
      throw new Error("Invalid drawing element.");
    if (!elementTypes.has(element.type)) {
      throw new Error(`Unsupported drawing element type: ${element.type}.`);
    }
    if (ids.has(element.id)) throw new Error("Duplicate drawing element ID.");
    ids.add(element.id);
    for (const key of ["x", "y", "width", "height"]) {
      if (typeof element[key] !== "number" || !Number.isFinite(element[key])) {
        throw new Error(`Invalid drawing element ${key}.`);
      }
    }
    if ((element.width as number) < 0 || (element.height as number) < 0) {
      throw new Error("Invalid drawing element dimensions.");
    }
    if (element.type === "text" && typeof element.text !== "string") {
      throw new Error("Invalid drawing text element.");
    }
    if (element.link !== undefined && element.link !== null && typeof element.link !== "string") {
      throw new Error("Invalid drawing element link.");
    }
  }
  const files = value.files ?? {};
  for (const [id, file] of Object.entries(files)) {
    if (
      !isRecord(file) ||
      file.id !== id ||
      typeof file.dataURL !== "string" ||
      typeof file.mimeType !== "string" ||
      !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(file.dataURL) ||
      !file.dataURL.startsWith(`data:${file.mimeType};base64,`)
    )
      throw new Error(
        "Unsupported or invalid drawing image asset. Only embedded raster images are supported.",
      );
  }
  for (const element of value.elements) {
    if (
      element.type === "image" &&
      !element.isDeleted &&
      (typeof element.fileId !== "string" ||
        !Object.prototype.hasOwnProperty.call(files, element.fileId))
    ) {
      throw new Error(
        "Drawing image asset is missing. External Obsidian assets are not supported.",
      );
    }
  }
  // Spread: the writer keeps top-level keys like `source` that nothing here reads.
  return {
    ...value,
    elements: value.elements,
    appState: value.appState,
    files,
  } as ObsidianDrawingScene;
}

function applyMappings(scene: ObsidianDrawingScene, sections: Map<string, string>): void {
  const elements = new Map(scene.elements.map((element) => [element.id, element]));
  const text = sections.get("Text Elements");
  if (text !== undefined) {
    let cursor = 0;
    const seen = new Set<string>();
    for (const match of text.matchAll(/[ \t]\^([\w!-]+)[ \t]*(?:\n|$)/g)) {
      const id = match[1];
      let content = text.slice(cursor, match.index);
      cursor = match.index + match[0].length;
      // Each plugin record ends in exactly two newlines; other newlines belong
      // to the text, including leading blanks introduced by a Markdown linter.
      if (text[cursor] === "\n") cursor++;
      if (id === "_dummy!_") continue;
      if (seen.has(id)) throw new Error("Duplicate Text Elements mapping.");
      seen.add(id);
      const element = elements.get(id);
      if (!element) throw new Error("Text Elements mapping refers to a missing element.");
      if (element.type === "text") {
        const legacyLink = /^%%\*\*\*>>>text element-link:(\[\[[^\n]*?\]\])<<<\*\*\*%%\n?/m;
        const link = content.match(legacyLink);
        if (link) {
          element.link = link[1];
          content = content.replace(legacyLink, "");
        }
        element.text = content;
        element.originalText = content;
        element.rawText = content;
      } else {
        // Older plugin versions put non-text element links in this section.
        element.link = content;
      }
    }
    if (!wrapperOnly(text.slice(cursor))) throw new Error("Invalid Text Elements mapping.");
  }
  const links = sections.get("Element Links");
  if (links !== undefined) {
    const seen = new Set<string>();
    for (const line of links.split("\n")) {
      if (wrapperOnly(line)) continue;
      const match = /^([\w-]+):[ \t]*(.*)$/.exec(line);
      if (!match) throw new Error("Invalid Element Links mapping.");
      if (seen.has(match[1])) throw new Error("Duplicate Element Links mapping.");
      seen.add(match[1]);
      const element = elements.get(match[1]);
      if (!element) throw new Error("Element Links mapping refers to a missing element.");
      element.link = match[2];
    }
  }
}

/** Pure reader. Throws a displayable error; never accesses a vault or runs plugins. */
export function readObsidianDrawing(source: string): ObsidianDrawingScene {
  if (source.length > OBSIDIAN_DRAWING_LIMITS.sourceCharacters) {
    throw new Error("Drawing exceeds the source size limit.");
  }
  const normalized = source.replace(/\r\n/g, "\n");
  const sections = readSections(normalized);
  if (sections.has("Markdown Images") || normalized.includes("<!-- excalidraw-markdown-image:")) {
    throw new Error("Obsidian Markdown images are not supported. Open this drawing in Obsidian.");
  }
  const embedded = sections.get("Embedded Files");
  if (embedded !== undefined && !wrapperOnly(embedded)) {
    throw new Error(
      "Obsidian embedded-file references are not supported. Open this drawing in Obsidian.",
    );
  }
  const drawing = sections.get("Drawing");
  if (drawing === undefined) throw new Error("Missing Drawing section.");
  const fence = /^[ \t\n]*```(compressed-json|json)[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n|$)/.exec(
    drawing,
  );
  if (!fence) throw new Error("Missing or unsupported Drawing JSON fence.");
  const tail = drawing.slice(fence[0].length);
  if (/^```(?:compressed-json|json)\b/m.test(tail))
    throw new Error("Multiple Drawing JSON fences.");
  const accept = jsonBudgetScanner();
  let json: string;
  if (fence[1] === "compressed-json") {
    json = decompressBoundedBase64(
      fence[2].replace(/[ \t\n]/g, ""),
      OBSIDIAN_DRAWING_LIMITS,
      accept,
    );
  } else {
    json = fence[2];
    if (json.length > OBSIDIAN_DRAWING_LIMITS.outputCharacters) {
      throw new Error("Drawing exceeds the decoded size limit.");
    }
    accept(json);
  }
  let value: unknown;
  try {
    value = JSON.parse(json, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite number.");
      return item;
    });
  } catch {
    throw new Error("Invalid drawing JSON.");
  }
  const scene = validateScene(value);
  applyMappings(scene, sections);
  return scene;
}

function replaceSection(source: string, name: string, body: string): string {
  const heading = new RegExp(`^#{1,2} ${name}[ \\t]*\\n`, "m").exec(source);
  if (!heading) return source;
  const start = heading.index + heading[0].length;
  const next = /^#{1,2} (Text Elements|Element Links|Embedded Files|Drawing)[ \t]*\n/m.exec(
    source.slice(start),
  );
  const end = next ? start + next.index : source.length;
  // The `%%` that opens Obsidian's hidden block can end this section; it must survive.
  const closing = /(?:^|\n)%%[ \t\n]*$/.test(source.slice(start, end)) ? "%%\n" : "";
  return source.slice(0, start) + body + closing + source.slice(end);
}

function liveLinks(elements: Record<string, unknown>[]) {
  return new Map(
    elements
      .filter((element) => element.type !== "text" && !element.isDeleted && element.link)
      .map((element) => [element.id as string, element.link as string]),
  );
}

/**
 * The source with only its drawing, and any text or links that changed, replaced.
 * Frontmatter and everything else stay byte for byte, and an element whose version
 * didn't change keeps its original record, including fields Excalidraw would drop.
 * Throws rather than return something that wouldn't read back.
 *
 * ponytail: writes the plugin's uncompressed `json` fence, so a saved file is several
 * times larger. Compress with lz-string if a drawing outgrows the source limit.
 */
export function writeObsidianDrawing(
  source: string,
  edited: { elements: readonly object[] },
): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const original = readObsidianDrawing(normalized);
  const originals = new Map(original.elements.map((element) => [element.id as string, element]));
  const elements = (edited.elements as Record<string, unknown>[]).map((element) => {
    const before = originals.get(element.id as string);
    if (
      before &&
      before.version === element.version &&
      before.versionNonce === element.versionNonce &&
      before.isDeleted === element.isDeleted
    )
      return before;
    const merged = { ...before, ...element };
    if (merged.type === "text") merged.rawText = merged.originalText ?? merged.text;
    return merged;
  });
  for (const element of elements) {
    if (element.type !== "image" || element.isDeleted) continue;
    if (!Object.prototype.hasOwnProperty.call(original.files, element.fileId as string)) {
      throw new Error("Add images to this drawing in Obsidian. Your other changes aren't saved.");
    }
  }

  const textRecords = (list: Record<string, unknown>[]) =>
    list
      .filter((element) => element.type === "text" && !element.isDeleted)
      .map((element) => `${element.rawText as string} ^${element.id as string}\n\n`)
      .sort()
      .join("");
  let output = normalized;
  if (textRecords(elements) !== textRecords(original.elements)) {
    const records = elements
      .filter((element) => element.type === "text" && !element.isDeleted)
      .map((element) => `${element.rawText as string} ^${element.id as string}\n\n`);
    output = replaceSection(output, "Text Elements", records.join(""));
  }
  const links = liveLinks(elements);
  const previous = liveLinks(original.elements);
  const linksChanged =
    links.size !== previous.size || [...links].some(([id, link]) => previous.get(id) !== link);
  if (linksChanged) {
    const lines = [...links].map(([id, link]) => `${id}: ${link}\n`);
    output = replaceSection(output, "Element Links", `${lines.join("")}\n`);
  }
  const json = JSON.stringify({ ...original, elements }, null, "\t");
  const drawing =
    /^#{1,2} Drawing[ \t]*\n[ \t\n]*```(?:compressed-json|json)[ \t]*\n[\s\S]*?\n```/m;
  // A function, so `$` in the drawing's text isn't read as a replacement pattern.
  output = output.replace(drawing, () => `## Drawing\n\`\`\`json\n${json}\n\`\`\``);
  readObsidianDrawing(output);
  return output;
}
