import { describe, expect, test } from "vite-plus/test";
import {
  getPrimaryDefs,
  SETTINGS_SCHEMA,
  suffixOf,
  type SettingsMap,
  type ThemeMode,
} from "../src/lib/settings-schema";

// Every preset folder ships one JSON per mode holding exactly the editable
// primaries. Glob-load them the same way a preset picker would so adding a
// schema primary (e.g. mono-font) fails here until every preset defines it.
const presetFiles = import.meta.glob<Record<string, unknown>>("../shared/themes/*/*.json", {
  eager: true,
  import: "default",
});

describe("typography settings", () => {
  test("keep their persisted keys and CSS bindings under the Typography category", () => {
    const fonts = SETTINGS_SCHEMA.filter((def) => def.key.startsWith("fonts.")).map((def) => ({
      key: def.key,
      label: def.label,
      category: def.category,
      type: def.type,
      cssVar: def.cssVar,
    }));

    expect(fonts).toEqual([
      {
        key: "fonts.ui",
        label: "UI font",
        category: "Typography",
        type: "font",
        cssVar: "--ui-font",
      },
      {
        key: "fonts.editor",
        label: "Editor font",
        category: "Typography",
        type: "font",
        cssVar: "--editor-font",
      },
      {
        key: "fonts.mono",
        label: "Code font",
        category: "Typography",
        type: "font",
        cssVar: "--mono-font",
      },
    ]);
  });

  test("default to SF Pro for prose and SF Mono for code", () => {
    const defaults = Object.fromEntries(
      SETTINGS_SCHEMA.filter((def) => def.key.startsWith("fonts.")).map((def) => [
        def.key,
        String(def.default),
      ]),
    );

    const proseFallback =
      '-apple-system-body, ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"';
    const monoFallback =
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

    expect(defaults["fonts.ui"]).toBe(`"SF Pro", ${proseFallback}`);
    expect(defaults["fonts.editor"]).toBe(`"SF Pro", ${proseFallback}`);
    expect(defaults["fonts.mono"]).toBe(`"SF Mono", ${monoFallback}`);
  });
});

describe("vim mode setting", () => {
  test("is an off-by-default Editor boolean", () => {
    const definition = SETTINGS_SCHEMA.find((def) => def.key === "editor.vim-mode");
    expect(definition).toMatchObject({
      label: "Vim Mode",
      category: "Editor",
      type: "boolean",
      default: false,
    });
    expect(definition?.type).toBe("boolean");
    expect(definition?.default).toBe(false);
  });

  test("types the generated SettingsMap entry as boolean", () => {
    const settings: Partial<SettingsMap> = { "editor.vim-mode": true };
    const value: boolean | undefined = settings["editor.vim-mode"];
    expect(value).toBe(true);
  });
});

describe("default terminal setting", () => {
  test("exposes the cross-platform terminal preference contract", () => {
    const definition = SETTINGS_SCHEMA.find((def) => def.key === "workspace.default-terminal");
    expect(definition).toMatchObject({
      label: "Default Terminal",
      description:
        "Terminal application name on macOS, or executable name/full path on Windows and Linux. Leave blank for Writer's platform default; arguments are not supported.",
      category: "Workspace",
      type: "string",
      placeholder: "Platform default",
      normalize: "trim",
      scope: "global",
      default: "",
    });
  });
});

describe("LaTeX Suite settings", () => {
  test("declare the four toggles and the snippet-variable list as global keys", () => {
    const defs = SETTINGS_SCHEMA.filter((def) => def.key.startsWith("latex."));

    expect(defs.map((def) => [def.key, def.label, def.type, def.default])).toEqual([
      ["latex.snippets-enabled", "Snippets", "boolean", true],
      ["latex.tab-out", "Tab out of brackets", "boolean", true],
      ["latex.auto-fraction", "Auto fraction", "boolean", true],
      ["latex.highlight-source", "Highlight math source", "boolean", true],
      ["latex.snippet-variables", "Snippet variables", "list", defs[4]?.default],
    ]);

    for (const def of defs) {
      expect(def.category, def.key).toBe("LaTeX Suite");
      expect(def.scope, def.key).toBe("global");
    }
  });

  test("ship the snippet variables the default snippet file references", () => {
    const def = SETTINGS_SCHEMA.find((d) => d.key === "latex.snippet-variables");
    const items = def?.default as string[];

    expect(items.map((item) => item.split("=")[0])).toEqual([
      "GREEK",
      "SYMBOL",
      "MORE_SYMBOLS",
      "ACCENT",
      "SYMBOLS",
    ]);
    // SYMBOLS is an alias of SYMBOL so a pasted Obsidian file still resolves.
    expect(items[4]?.slice("SYMBOLS=".length)).toBe(items[1]?.slice("SYMBOL=".length));
    for (const item of items) expect(item).toMatch(/^[A-Z_]+=[a-zA-Z|]+$/);
  });
});

describe("theme presets", () => {
  test("at least one preset file is discovered", () => {
    expect(Object.keys(presetFiles).length).toBeGreaterThan(0);
  });

  test("define every editable primary from the settings schema", () => {
    for (const [path, preset] of Object.entries(presetFiles)) {
      const mode: ThemeMode = path.endsWith("/dark.json") ? "dark" : "light";
      const schemaKeys = getPrimaryDefs(mode)
        .map((def) => suffixOf(mode, def.key))
        .sort();
      expect(Object.keys(preset).sort(), path).toEqual(schemaKeys);
    }
  });
});
