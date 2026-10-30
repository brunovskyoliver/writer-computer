import { describe, expect, test } from "vite-plus/test";
import { decompressBoundedBase64 } from "../src/lib/bounded-lz-string";
import {
  writeObsidianDrawing,
  OBSIDIAN_DRAWING_LIMITS,
  readObsidianDrawing,
} from "../src/lib/obsidian-drawing-format";

const textElement = {
  id: "text0001",
  type: "text",
  x: 10,
  y: 20,
  width: 120,
  height: 24,
  text: "stale scene",
  originalText: "stale scene",
  fontSize: 20,
  fontFamily: 1,
};
const scene = {
  type: "excalidraw",
  version: 2,
  elements: [textElement],
  appState: { viewBackgroundColor: "#fff" },
  files: {},
};
// Synthetic scene compressed independently with upstream lz-string 1.5.0.
const compressedScene =
  "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcmTGAWxkbBoQBtUHgTgUYAAzSAjGXDQ4iMBPnIEMyeQistIInjAALDSz1GY2AOZGwrACzkVyO4hpgsMAAQ1UvOOT0+NbYjFgAKqpuHpw+fowBIABmTGAAytgAXkpm5Cl8AGLoXNiYOvAyAL4AuuToUFBpHioIoBTYMEQAQuioANZW+PQAroy4AML0mEFiAMRJCyCVeaUwAvDAlZVAA";
function markdown(value: unknown = scene, before = ""): string {
  return `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n${before}%%\n## Drawing\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n%%\n`;
}
function compressedMarkdown(encoded = compressedScene): string {
  return `## Drawing\n\`\`\`compressed-json\n${encoded}\n\`\`\`\n%%\n`;
}

describe("Obsidian drawing reader", () => {
  test("reads plain and wrapped compressed JSON without changing source", () => {
    const source = compressedMarkdown(compressedScene.match(/.{1,50}/g)!.join("\n"));
    const original = source;
    expect(readObsidianDrawing(source)).toEqual(readObsidianDrawing(markdown()));
    expect(source).toBe(original);
    expect(readObsidianDrawing(source).elements[0]).toEqual(textElement);
  });
  test("accepts CRLF and empty scenes, with optional absent files", () => {
    expect(
      readObsidianDrawing(markdown({ ...scene, elements: [] }).replace(/\n/g, "\r\n")),
    ).toMatchObject({ elements: [], appState: scene.appState, files: {} });
    expect(readObsidianDrawing(markdown({ ...scene, files: undefined })).files).toEqual({});
  });
  test("Text Elements is authoritative, preserving multiline text and explicit links", () => {
    const source = markdown(
      scene,
      "## Text Elements\nChanged first line\n\nSecond line ^text0001\n\n## Element Links\ntext0001: [[Course#Overview|label]]\n\n",
    );
    expect(readObsidianDrawing(source).elements[0]).toMatchObject({
      text: "Changed first line\n\nSecond line",
      originalText: "Changed first line\n\nSecond line",
      rawText: "Changed first line\n\nSecond line",
      link: "[[Course#Overview|label]]",
    });
  });
  test("supports the plugin's dummy text mapping, leading blanks, and legacy text links", () => {
    const source = markdown(
      scene,
      "## Text Elements\nDummy ^_dummy!_\n\n\n%%***>>>text element-link:[[Course]]<<<***%%\nCurrent ^text0001\n\n",
    );
    expect(readObsidianDrawing(source).elements[0]).toMatchObject({
      text: "\nCurrent",
      link: "[[Course]]",
    });
  });
  test("supports non-text legacy link mappings and empty text", () => {
    const rectangle = { ...textElement, type: "rectangle" };
    expect(
      readObsidianDrawing(
        markdown({ ...scene, elements: [rectangle] }, "## Text Elements\n[[Target]] ^text0001\n\n"),
      ).elements[0].link,
    ).toBe("[[Target]]");
    expect(
      readObsidianDrawing(markdown(scene, "## Text Elements\n ^text0001\n\n")).elements[0].text,
    ).toBe("");
  });
  test("preserves scene links and deleted elements", () => {
    const element = { ...textElement, link: "https://example.com", isDeleted: true };
    expect(readObsidianDrawing(markdown({ ...scene, elements: [element] })).elements).toEqual([
      element,
    ]);
  });
  test("retains self-contained raster files", () => {
    const file = {
      id: "asset",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,iVBORw0KGgo=",
      created: 1,
    };
    const value = {
      ...scene,
      elements: [{ ...textElement, type: "image", fileId: "asset" }],
      files: { asset: file },
    };
    expect(readObsidianDrawing(markdown(value)).files).toEqual(value.files);
  });
  test.each([
    ["Embedded Files", "asset: [[picture.png]]\n"],
    ["Embedded Files", "asset: $$x^2$$\n"],
    ["Markdown Images", ""],
  ])("rejects unsupported %s wrappers explicitly", (heading, content) => {
    expect(() => readObsidianDrawing(markdown(scene, `## ${heading}\n${content}`))).toThrow(
      /not supported/,
    );
  });
  test("rejects Markdown image comment blocks before the data section", () => {
    expect(() =>
      readObsidianDrawing("<!-- excalidraw-markdown-image:asset -->\n" + markdown()),
    ).toThrow(/Markdown images/);
  });
  test.each([
    { ...scene, elements: [{ ...textElement, type: "image", fileId: "missing" }] },
    { ...scene, elements: [{ ...textElement, type: "embeddable" }] },
    {
      ...scene,
      files: {
        asset: { id: "asset", mimeType: "image/png", dataURL: "https://example.com/image.png" },
      },
    },
    {
      ...scene,
      files: {
        asset: {
          id: "asset",
          mimeType: "image/svg+xml",
          dataURL: "data:image/svg+xml;base64,PHN2Zy8+",
        },
      },
    },
  ])("rejects missing or unsupported external assets", (value) => {
    expect(() => readObsidianDrawing(markdown(value))).toThrow(/missing|Unsupported/);
  });
  test.each([
    null,
    [],
    {},
    { ...scene, type: "other" },
    { ...scene, elements: {} },
    { ...scene, appState: [] },
    { ...scene, files: [] },
    { ...scene, elements: [null] },
    { ...scene, elements: [textElement, textElement] },
    { ...scene, elements: [{ ...textElement, x: "10" }] },
    { ...scene, elements: [{ ...textElement, width: -1 }] },
    { ...scene, elements: [{ ...textElement, text: 2 }] },
    { ...scene, elements: [{ ...textElement, link: {} }] },
  ])("rejects malformed scenes", (value) => {
    expect(() => readObsidianDrawing(markdown(value))).toThrow();
  });
  test("rejects duplicate JSON keys and non-finite numbers", () => {
    expect(() =>
      readObsidianDrawing(markdown().replace('"version":2', '"version":2,"version":3')),
    ).toThrow(/Duplicate/);
    expect(() => readObsidianDrawing(markdown().replace('"x":10', '"x":1e999'))).toThrow(
      /Invalid drawing JSON/,
    );
  });
  test.each([
    "## Text Elements\nUnterminated text\n",
    "## Text Elements\nChanged ^absent01\n\n",
    "## Text Elements\nOne ^text0001\n\nTwo ^text0001\n\n",
    "## Element Links\ninvalid\n",
    "## Element Links\nabsent01: [[Missing]]\n",
    "## Element Links\ntext0001: [[One]]\ntext0001: [[Two]]\n",
  ])("rejects invalid or ambiguous mappings", (before) => {
    expect(() => readObsidianDrawing(markdown(scene, before))).toThrow(/mapping/);
  });
  test("rejects missing, duplicate, unsupported and unclosed drawing fences", () => {
    for (const source of [
      "",
      markdown() + markdown(),
      markdown().replace("```json", "```yaml"),
      markdown().replace("\n```\n%%", ""),
      markdown() + "```json\n{}\n```\n",
    ]) {
      expect(() => readObsidianDrawing(source)).toThrow();
    }
  });
  test("rejects corrupt base64, truncated streams and corrupt JSON", () => {
    for (const encoded of [
      "",
      "!!!!",
      "AA==",
      compressedScene.slice(0, -8),
      compressedScene + "AAAA",
    ]) {
      expect(() => readObsidianDrawing(compressedMarkdown(encoded))).toThrow();
    }
    expect(() => readObsidianDrawing(markdown().replace('"elements":', '"elements"'))).toThrow(
      /JSON/,
    );
  });
  test("bounds source before normalization and nesting before parsing", () => {
    expect(() =>
      readObsidianDrawing("x".repeat(OBSIDIAN_DRAWING_LIMITS.sourceCharacters + 1)),
    ).toThrow(/source size limit/);
    const source = markdown().replace(
      '"files":{}',
      '"files":' + "[".repeat(65) + "0" + "]".repeat(65),
    );
    expect(() => readObsidianDrawing(source)).toThrow(/nesting limit/);
  });
  test("bounds element count before JSON parsing", () => {
    const value = { ...scene, elements: Array(OBSIDIAN_DRAWING_LIMITS.elements + 1).fill({}) };
    expect(() => readObsidianDrawing(markdown(value))).toThrow(/element limit/);
  });
});

test("rejects excessive elements while decompressing, before validating scene elements", () => {
  // 10,001 synthetic empty element objects, compressed by upstream lz-string 1.5.0.
  const encoded =
    "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGiUxgFsYA7MAZwQG1gBfU9zjr3n/7oL5CBwsaIkip46ZJny5i2coUqlqjeq1qdm3dr2GDx/aaNmT5q5ZsW71+7YfOnrx+5ce3nn979eA30D/INCQ8ODIsKiI6LjYhJik+OTElPS0zNTsjJys3IL8orySwtLissqK6vLaqrqa+qbGloa25vbWju6u3s7+noG+wZHhsaGJ0cnxqdmZ+enFuaWF5bXVjZWt9e3Nnf29w93jg5Oj04vzq7Oby9vru8eH5/vXp7eX96/Pn4+/7/+vwBwKBoMB4JBELBkJh0LhUIRsMR8KRqJR6ORmLRWIx2LxuIJOKJ+OJhJJ5LJlNJ1IpNKptIZ9KZdJZjNZzLZnI53PZvK5fJ5/KFgpFArFwvFool0qlssl8plCrlipVyrVSo1qs16q1up1+u1hr1RoNxrNpotJqt5utlpt9rtjttzodLqdro97q9bp9nt93r9gYDwf9oaDYZD4ajkZjEbj0fjsYTyaTqcT6ZTGbTmZz2bzWYLucL+aLpZL5eLlbLVYr1brtYbNab9ebjZb7bbndb3Y7Pa7vYH/aHfZHg9Hw7Hk4n0/Hs6nc5n86Xi5XC7Xy/Xq43269AF1yOgoFAAMpgdBgODwLggABm2EoTCvbDYQA===";
  expect(() => readObsidianDrawing(compressedMarkdown(encoded))).toThrow(/element limit/);
});

describe("bounded LZString decoder", () => {
  // Independent fixtures from upstream's compressor, including UTF-16 surrogates.
  test.each([
    ["Q===", ""],
    ["BYUwNmD2AEoTcpA=", "hello hello hello"],
    ["GMIwNgpgBItHKOGmVC8G4KN3DwfwKAM4QMYHsA7AEyjAEsCIg===", "Æble 中文 🖊️\nsecond line"],
    ["IY18ZXTt/DFOS1b0c17Pd/wYUcSaWeRZVdTbXSUA", "a".repeat(1024)],
    [
      "AwRgTAzALArAbAdgBwE5SVo17r2W8XLAjPbQzfHS8046skoqixh+1jul725vmk0Hse/IW06jhkgRN7iuYkbMXT5yhVLlKZmlVtXa1O9bo3mzl09ZO3j9o48PODr/e72eLNhy4/e7JzcvK0C/EJ8g/1DfYIDY6Mjw+MYgA===",
      "0123456789".repeat(100),
    ],
  ])("matches upstream compressed fixtures", (encoded, expected) => {
    expect(decompressBoundedBase64(encoded, OBSIDIAN_DRAWING_LIMITS)).toBe(expected);
  });
  test("stops expansion before accepting an oversized output chunk", () => {
    let accepted = 0;
    expect(() =>
      decompressBoundedBase64(
        "IY18ZXTt/DFOS1b0c17Pd/wYUcSaWeRZVdTbXSUA",
        { ...OBSIDIAN_DRAWING_LIMITS, outputCharacters: 100 },
        (chunk) => {
          accepted += chunk.length;
        },
      ),
    ).toThrow(/decoded size limit/);
    expect(accepted).toBeLessThanOrEqual(100);
    expect(decompressBoundedBase64("BYUwNmD2AEoTcpA=", OBSIDIAN_DRAWING_LIMITS)).toBe(
      "hello hello hello",
    );
  });
  test("bounds dictionary entries and retained characters while decoding", () => {
    expect(() =>
      decompressBoundedBase64(compressedScene, {
        ...OBSIDIAN_DRAWING_LIMITS,
        dictionaryEntries: 5,
      }),
    ).toThrow(/dictionary limit/);
    expect(() =>
      decompressBoundedBase64(compressedScene, {
        ...OBSIDIAN_DRAWING_LIMITS,
        dictionaryCharacters: 5,
      }),
    ).toThrow(/dictionary limit/);
  });
});

describe("writeObsidianDrawing", () => {
  const rect = {
    id: "r1",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 5,
    height: 5,
    version: 1,
    versionNonce: 1,
    customData: { keep: true },
  };
  const label = {
    id: "t1",
    type: "text",
    x: 1,
    y: 1,
    width: 5,
    height: 5,
    version: 1,
    versionNonce: 2,
    text: "old",
    originalText: "old",
    rawText: "old",
  };
  const source = [
    "---",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw, keep]",
    "---",
    "==⚠ Switch ⚠== my note $& stays",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    "old ^t1",
    "",
    "%%",
    "## Drawing",
    "```json",
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "plugin",
      elements: [rect, label],
      appState: { theme: "dark" },
      files: {},
    }),
    "```",
    "%%",
    "",
  ].join("\n");

  test("keeps everything outside the drawing and untouched elements' unknown fields", () => {
    const edited = [
      { ...rect, customData: undefined },
      { ...label, version: 2, versionNonce: 9, text: "new $&", originalText: "new $&" },
    ];
    const output = writeObsidianDrawing(source, { elements: edited });
    expect(output.slice(0, output.indexOf("## Text Elements"))).toBe(
      source.slice(0, source.indexOf("## Text Elements")),
    );
    expect(output).toContain("new $& ^t1\n\n%%\n## Drawing\n```json\n");
    const scene = readObsidianDrawing(output);
    expect(scene.elements[0].customData).toEqual({ keep: true });
    expect(scene.elements[1].rawText).toBe("new $&");
    expect(scene.appState).toEqual({ theme: "dark" });
    expect((scene as unknown as { source: string }).source).toBe("plugin");
  });

  test("an unchanged scene leaves its sections alone and repeats exactly", () => {
    const once = writeObsidianDrawing(source, { elements: [rect, label] });
    expect(once).toContain("## Text Elements\nold ^t1\n\n%%\n## Drawing");
    expect(writeObsidianDrawing(once, { elements: [rect, label] })).toBe(once);
  });

  test("a deleted text leaves the mapping section, and new images are refused", () => {
    const output = writeObsidianDrawing(source, {
      elements: [rect, { ...label, isDeleted: true, version: 2 }],
    });
    expect(output).toContain("## Text Elements\n%%\n## Drawing");
    expect(readObsidianDrawing(output).elements[1].isDeleted).toBe(true);
    const image = { ...rect, id: "i1", type: "image", fileId: "new" };
    expect(() => writeObsidianDrawing(source, { elements: [image] })).toThrow(/in Obsidian/);
  });
});
