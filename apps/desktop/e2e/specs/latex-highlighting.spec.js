import { ok } from "node:assert/strict";

const SHOTS = process.env.VERIFY_SHOT_DIR || "/tmp/verify-shots";

// Raw-LaTeX highlighting verification (SPECs/latex-suite, US3): five distinct
// token colours in unfolded math, bracket matching inside math and `latex` /
// `tex` fences, a plain `text` fence left alone, the KaTeX fold unchanged, and
// colours that follow a theme switch.
//
// Requires a restorable workspace; self-skips on the welcome screen so it stays
// safe inside the default `pnpm run test:e2e` sweep.
//
// Clicks on `.cm-line` do not move the CodeMirror caret under this WebDriver,
// so every caret move here is keyboard-driven from the document start.
const FILE_STEM = "highlight-check";
const DOC = [
  "# Highlight check",
  "",
  "$$\\begin{cases} \\frac{a}{b} & x \\\\ c & y \\end{cases} % note$$",
  "",
  "Prose line with no math.",
  "",
  "```latex",
  "\\frac{a}{b} = 1 % matching",
  "\\frac{a) % mismatched",
  "```",
  "",
  "```tex",
  "\\alpha^{2}_{n} + 42 % tex fence",
  "```",
  "",
  "```text",
  "\\frac{a}{b} plain fence, no highlight",
  "```",
  "",
].join("\n");

async function invoke(cmd, args) {
  return browser.executeAsync(
    (c, a, done) => {
      window.__TAURI_INTERNALS__
        .invoke(c, a)
        .then((v) => done({ ok: true, value: v }))
        .catch((e) => done({ ok: false, error: e && e.message ? e.message : String(e) }));
    },
    cmd,
    args,
  );
}

async function shoot(name) {
  await browser.saveScreenshot(`${SHOTS}/${name}.png`);
}

/** Park the caret at offset 0. `Meta+ArrowUp` drifts under this WebDriver;
 *  select-all followed by a collapsing ArrowLeft does not. */
async function gotoDocStart() {
  await $(".cm-content").click();
  await browser.keys(["Meta", "a"]);
  await browser.keys(["ArrowLeft"]);
}

async function caretLine() {
  return browser.execute(() => {
    const node = document.getSelection()?.anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest(".cm-line")?.textContent ?? null;
  });
}

/** Walk the caret down from the document start until it sits on the line
 *  containing `needle`, then park it at the line start. Line *indices* are
 *  unusable here: the math widget unfolds as the caret passes through it and
 *  wrapping makes ArrowDown a visual move. */
async function gotoLineWith(needle) {
  await gotoDocStart();
  for (let i = 0; i < 60; i++) {
    const line = await caretLine();
    if (line && line.includes(needle)) {
      await browser.keys(["Meta", "ArrowLeft"]);
      return;
    }
    await browser.keys(["ArrowDown"]);
  }
  throw new Error(`caret never reached a line containing ${JSON.stringify(needle)}`);
}

function lineColours(needle) {
  return browser.execute((text) => {
    const line = Array.from(document.querySelectorAll(".cm-line")).find((l) =>
      l.textContent.includes(text),
    );
    if (!line) return null;
    const spans = Array.from(line.querySelectorAll("span")).filter((s) => s.textContent.trim());
    const byColour = {};
    for (const span of spans) {
      const c = getComputedStyle(span).color;
      byColour[c] = (byColour[c] || "") + span.textContent;
    }
    return { colours: Object.keys(byColour), byColour, spans: spans.length };
  }, needle);
}

describe("LaTeX source highlighting (US3)", function () {
  let seeded = false;
  let filePath = null;

  before(async function () {
    const restored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!restored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    if (!root) return;
    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: DOC });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);

    // Reload rather than waiting on the workspace watcher: startup rebuilds the
    // file index from disk, so the seeded document lands in the sidebar
    // deterministically (same trick as `table-column-sizing.spec.js`).
    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({ timeout: 20_000 });
    seeded = true;
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath });
  });

  beforeEach(function () {
    if (!seeded) this.skip();
  });

  it("opens the seeded document", async function () {
    const row = await $("span*=Highlight check");
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-content")).length > 0, {
      timeout: 10_000,
      timeoutMsg: "editor never mounted",
    });
  });

  it("still folds display math into a KaTeX widget", async function () {
    const widget = await $(".cm-math-widget.cm-math-display .katex-display");
    await widget.waitForExist({ timeout: 10_000 });
    await shoot("us3-folded");
  });

  it("colours the raw source when the math unfolds", async function () {
    // The math line is a KaTeX widget while folded, so its text has nothing to
    // seek on: step down to it by position instead.
    await gotoDocStart();
    await browser.keys(["ArrowDown"]);
    await browser.waitUntil(
      async () => (await $(".cm-content").getText()).includes("\\begin{cases}"),
      {
        timeout: 5_000,
        timeoutMsg: async () =>
          `display math never unfolded; caret line=${JSON.stringify(await caretLine())}`,
      },
    );
    const report = await lineColours("\\begin{cases}");
    await shoot("us3-unfolded");
    ok(
      report && report.colours.length >= 5,
      `expected >=5 distinct colours in the math source, got ${JSON.stringify(report)}`,
    );
  });

  it("outlines a matched brace and flags an unmatched one in a latex fence", async function () {
    await gotoLineWith("= 1 % matching");
    for (let i = 0; i < 6; i++) await browser.keys(["ArrowRight"]); // caret after `\frac{`
    await browser.waitUntil(async () => (await $$(".cm-matchingBracket")).length >= 2, {
      timeout: 5_000,
      timeoutMsg: "no matching-bracket marks next to the balanced brace",
    });
    await shoot("us3-bracket-match");

    await gotoLineWith("% mismatched");
    for (let i = 0; i < 6; i++) await browser.keys(["ArrowRight"]); // caret after `\frac{`
    await browser.waitUntil(async () => (await $$(".cm-nonmatchingBracket")).length >= 1, {
      timeout: 5_000,
      timeoutMsg: "no nonmatching-bracket mark next to the unbalanced brace",
    });
    const errorColour = await browser.execute(() => {
      const paint = (el) => (el ? getComputedStyle(el.querySelector("span") ?? el).color : null);
      const braceIn = (needle) =>
        Array.from(document.querySelectorAll(".cm-line"))
          .find((l) => l.textContent.includes(needle))
          ?.querySelector("span");
      const mark = document.querySelector(".cm-nonmatchingBracket");
      return {
        mark: paint(mark),
        // Same `{` glyph on the balanced line, still wearing the token colour.
        plainBracket: getComputedStyle(
          Array.from(braceIn("= 1 % matching").parentElement.querySelectorAll("span")).find(
            (s) => s.textContent === "{",
          ),
        ).color,
      };
    });
    ok(
      errorColour.mark && errorColour.mark !== errorColour.plainBracket,
      `error colour must beat the token colour: ${JSON.stringify(errorColour)}`,
    );
    await shoot("us3-bracket-nonmatch");
  });

  it("colours latex and tex fences but leaves a text fence plain", async function () {
    const latex = await lineColours("\\frac{a}{b} = 1");
    const tex = await lineColours("\\alpha^{2}_{n}");
    const text = await lineColours("plain fence");
    ok(latex && latex.colours.length >= 4, `latex fence: ${JSON.stringify(latex)}`);
    ok(tex && tex.colours.length >= 4, `tex fence: ${JSON.stringify(tex)}`);
    const latexColours = new Set([...latex.colours, ...tex.colours]);
    ok(
      text && text.colours.every((c) => !latexColours.has(c)),
      `text fence must not pick up latex colours: ${JSON.stringify(text)}`,
    );
    await shoot("us3-fences");
  });

  it("follows a theme switch", async function () {
    const themeOf = () => browser.execute(() => document.documentElement.dataset.theme);
    const before = await themeOf();
    const beforeColours = await lineColours("\\alpha^{2}_{n}");
    // Real path: command palette → "Toggle Dark Mode" (system → light → dark).
    for (let i = 0; i < 3; i++) {
      await browser.keys(["Meta", "p"]);
      const input = await $("[cmdk-input]");
      await input.waitForExist({ timeout: 5_000 });
      await browser.keys("Toggle Dark Mode");
      await browser.keys(["Enter"]);
      await browser.pause(400);
      if ((await themeOf()) !== before) break;
    }
    const after = await themeOf();
    ok(after && after !== before, `theme did not change: ${before} → ${after}`);
    const afterColours = await lineColours("\\alpha^{2}_{n}");
    ok(
      JSON.stringify(afterColours.colours) !== JSON.stringify(beforeColours.colours),
      `token colours did not follow the theme: ${JSON.stringify({ beforeColours, afterColours })}`,
    );
    await shoot(`us3-theme-${after}`);
  });
});
