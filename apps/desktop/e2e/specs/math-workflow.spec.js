import { ok } from "node:assert/strict";

// Math-workflow batch verification (SPECs/math-workflow/spec.md): seeds a
// document with a derivation, a constant formula, a messy matrix, and a
// ```plot fence, then checks
//   - the plot fence renders an inline SVG
//   - the constant formula carries a muted ≈ annotation
//   - Cmd+Enter inside math copies the step into a fresh $$ block
//   - Enter on the last line of a $$ block opens an empty $$ block
//   - typing $ autopairs, typing the closing $ steps over it
//   - "Math: Tidy Notation" rewrites \; separators to & and * to \cdot
//   - "Math: Align" folds a $$ run into \begin{aligned}, "Split" restores
//   - "Math: Check Step" produces a notice
//   - Cmd+Shift+M opens the symbol palette and inserts the code
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// before launching. Self-skips on the welcome screen.
describe("Math workflow", function () {
  const FILE_STEM = "math-workflow-e2e";
  const DOC = [
    "# Math workflow check",
    "",
    "$$",
    "x^2 + 2x",
    "$$",
    "",
    "$$",
    "x^2 + 2x + 1",
    "$$",
    "",
    "$$",
    "\\frac{2660-2565}{2}",
    "$$",
    "",
    "$$",
    "\\begin{bmatrix} 1\\;2 \\\\ 3\\;4 \\end{bmatrix} * 5",
    "$$",
    "",
    "```plot",
    "domain=-3:3",
    "y = x^2 - 2",
    "```",
    "",
    "Plain prose line for symbol insertion.",
    "",
  ].join("\n");

  let workspaceRestored = false;
  let filePath = null;

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

  /** Every `.cm-line` in the editor showing our seeded document, in
   *  document order. Restored sessions can mount several panes (hidden ones
   *  are `display: none`), and a split can show more than one — match on
   *  the doc's own heading text. Folded widgets show
   *  the rendered text, not the source — the caret must sit inside a math
   *  block for its source lines to appear. */
  function docLines() {
    return browser.execute(() => {
      const content = [...document.querySelectorAll(".cm-content")].find(
        (c) =>
          c.offsetParent !== null &&
          c.closest(".cm-editor").textContent.includes("Math workflow check"),
      );
      if (!content) return [];
      return [...content.querySelectorAll(".cm-line")].map((l) => l.textContent);
    });
  }

  /** Text of the `.cm-line` the caret currently sits on. */
  function caretLine() {
    return browser.execute(() => {
      const node = document.getSelection()?.anchorNode;
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      return el?.closest(".cm-line")?.textContent ?? null;
    });
  }

  /** The caret line plus the lines around it: [prev, current, next]. */
  function caretNeighborhood() {
    return browser.execute(() => {
      const node = document.getSelection()?.anchorNode;
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      const line = el?.closest(".cm-line");
      if (!line) return null;
      return [
        line.previousElementSibling?.textContent ?? "",
        line.textContent,
        line.nextElementSibling?.textContent ?? "",
      ];
    });
  }

  /** Synthetic keydown on the contentDOM — modifier chords through the
   *  driver are flaky on WKWebView, but untrusted events still reach the
   *  CodeMirror keymap. */
  async function press(key, mods = {}) {
    await browser.execute(
      (pressedKey, m) => {
        const content = [...document.querySelectorAll(".cm-content")].find(
          (c) =>
            c.offsetParent !== null &&
            c.closest(".cm-editor").textContent.includes("Math workflow check"),
        );
        content?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: pressedKey,
            metaKey: Boolean(m.meta),
            altKey: Boolean(m.alt),
            shiftKey: Boolean(m.shift),
            ctrlKey: Boolean(m.ctrl),
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      key,
      mods,
    );
  }

  /** Global shortcuts live on the window handler — dispatch there. */
  async function pressGlobal(key, mods = {}) {
    await browser.execute(
      (pressedKey, m) => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: pressedKey,
            metaKey: Boolean(m.meta),
            altKey: Boolean(m.alt),
            shiftKey: Boolean(m.shift),
            ctrlKey: Boolean(m.ctrl),
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      key,
      mods,
    );
  }

  /** Insert text at the caret through execCommand (CM observes it, so the
   *  closeBrackets input handler fires for `$`). */
  async function typeText(text) {
    await browser.execute((t) => {
      document.execCommand("insertText", false, t);
    }, text);
  }

  async function caretToStart() {
    await press("a", { meta: true });
    await press("ArrowLeft");
  }

  /**
   * Walk the caret down from the document start until it lands on the line
   * containing `needle`. Entering a folded math widget unfolds it to source,
   * so the caret line reports source text once inside.
   */
  async function caretToLine(needle) {
    await caretToStart();
    for (let i = 0; i < 40; i += 1) {
      const line = await caretLine();
      if (line !== null && line.includes(needle)) return;
      await browser.keys(["ArrowDown"]);
    }
    const lines = await docLines();
    throw new Error(
      `caret never reached a line containing ${needle}; doc lines: ${JSON.stringify(lines)}`,
    );
  }

  /** Caret to the end of the current line — Mod-ArrowRight is the bound
   *  keymap entry ("End" is not handled by an untrusted keydown). */
  async function caretToLineEnd() {
    await press("ArrowRight", { meta: true });
  }

  /** The transient editor notice banner's text ("" when none is up). The
   *  banner is the button absolutely positioned at top-6 over the pane. */
  function noticeText() {
    return browser.execute(() => {
      const el = document.querySelector('button[class*="top-6"]');
      return el?.textContent ?? "";
    });
  }

  /** Debug snapshot for failure messages. */
  async function debugState() {
    const [lines, caret, notice] = await Promise.all([docLines(), caretLine(), noticeText()]);
    return `caret=${JSON.stringify(caret)} notice=${JSON.stringify(notice)} lines=${JSON.stringify(lines)}`;
  }

  /** Open the command palette, filter by `query`, click the item whose
   *  data-value is exactly `value`. */
  async function runPaletteCommand(query, value) {
    await pressGlobal("p", { meta: true });
    const input = await $("[cmdk-input]");
    await input.waitForExist({ timeout: 5_000 });
    await input.addValue(query);
    const item = await $(`[cmdk-item][data-value="${value}"]`);
    await item.waitForExist({ timeout: 5_000 });
    await item.click();
    // Palette close does not hand DOM focus back to the editor — do it
    // explicitly so the next caret walk's ArrowDowns reach CodeMirror.
    await browser.execute(() => {
      const content = [...document.querySelectorAll(".cm-content")].find(
        (c) =>
          c.offsetParent !== null &&
          c.closest(".cm-editor").textContent.includes("Math workflow check"),
      );
      content?.focus();
    });
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the math document into");

    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", {
      path: filePath,
      content: DOC,
    });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);

    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });

    const row = await $(`span*=Math workflow check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-content")).length > 0, {
      timeout: 10_000,
      timeoutMsg: "editor never mounted",
    });
    await browser.execute(() => {
      const content = [...document.querySelectorAll(".cm-content")].find(
        (c) =>
          c.offsetParent !== null &&
          c.closest(".cm-editor").textContent.includes("Math workflow check"),
      );
      content?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      content?.focus();
    });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath }).catch(() => {});
  });

  it("renders the plot fence as an inline SVG", async function () {
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll(".cm-plot-widget svg").length)) > 0,
      { timeout: 8_000, timeoutMsg: "no SVG rendered for the ```plot fence" },
    );
  });

  it("annotates the constant formula with ≈", async function () {
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            [...document.querySelectorAll(".cm-math-annotation")].filter((el) =>
              el.textContent.includes("≈"),
            ).length,
        )) > 0,
      { timeout: 8_000, timeoutMsg: "no ≈ annotation on the constant formula" },
    );
  });

  it("Cmd+Enter inside math copies the step into a new $$ block", async function () {
    await caretToLine("x^2 + 2x"); // first block — prefix of the second's text
    await caretToLineEnd();
    await press("Enter", { meta: true });

    // Caret sits at the end of the copied formula inside a fresh $$ pair.
    await browser.waitUntil(
      async () => {
        const n = await caretNeighborhood();
        return n !== null && n[0] === "$$" && n[1] === "x^2 + 2x" && n[2] === "$$";
      },
      {
        timeout: 5_000,
        timeoutMsg: "Cmd+Enter did not leave the caret on the copied formula inside a new $$ block",
      },
    );
    await press("z", { meta: true });
  });

  it("Enter at the end of a $$ block opens an empty $$ block", async function () {
    await caretToLine("x^2 + 2x");
    await caretToLineEnd();
    await browser.keys(["Enter"]);

    await browser.waitUntil(
      async () => {
        const n = await caretNeighborhood();
        return n !== null && n[0] === "$$" && n[1].trim() === "" && n[2] === "$$";
      },
      {
        timeout: 5_000,
        timeoutMsg: "Enter did not open an empty $$ block under the caret",
      },
    );
    await press("z", { meta: true });
  });

  it("$ autopairs in prose and the closing $ steps over", async function () {
    await caretToLine("Plain prose line");
    await caretToLineEnd();
    await typeText(" ");
    await typeText("$");
    let line = await caretLine();
    ok(line?.includes("$$"), `expected an autopaired $$, got: ${line}`);

    await typeText("\\alpha");
    await typeText("$");
    line = await caretLine();
    const dollars = (line.match(/\$/g) ?? []).length;
    ok(dollars === 2, `expected the closing $ to step over, got ${dollars} dollars: ${line}`);
    ok(line.includes("\\alpha"), `formula text missing: ${line}`);
    for (let i = 0; i < 4; i += 1) await press("z", { meta: true });
  });

  it("Math: Tidy Notation rewrites \\; → & and * → \\cdot", async function () {
    await caretToLine("bmatrix");
    await runPaletteCommand("Tidy", "math-tidy");

    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return lines.some((l) => l.includes("bmatrix") && l.includes("&") && l.includes("\\cdot"));
      },
      {
        timeout: 5_000,
        timeoutMsg: "tidy did not rewrite the matrix source",
      },
    );
    const lines = await docLines();
    const row = lines.find((l) => l.includes("bmatrix"));
    ok(!row.includes("\\;"), `tidy left \\; separators: ${row}`);
    await press("z", { meta: true });
  });

  it("Math: Align folds the $$ run into aligned, Split restores", async function () {
    await caretToLine("x^2 + 2x");
    await runPaletteCommand("Align", "math-align");
    await browser.waitUntil(
      async () => (await docLines()).some((l) => l.includes("\\begin{aligned}")),
      { timeout: 5_000, timeoutMsg: "align did not produce \\begin{aligned}" },
    );

    await runPaletteCommand("Split", "math-split");
    await browser.waitUntil(
      async () => !(await docLines()).some((l) => l.includes("\\begin{aligned}")),
      { timeout: 5_000, timeoutMsg: `split did not restore $$ blocks — ${await debugState()}` },
    );
  });

  it("Math: Check Step produces a verdict notice", async function () {
    await caretToLine("x^2 + 2x + 1");
    await runPaletteCommand("Check", "math-check");
    await browser.waitUntil(async () => (await noticeText()).length > 0, {
      timeout: 5_000,
      timeoutMsg: `check step produced no notice — ${await debugState()}`,
    });
  });

  it("Cmd+Shift+M opens the symbol palette and inserts into prose", async function () {
    await caretToLine("Plain prose line");
    await caretToLineEnd();
    await pressGlobal("m", { meta: true, shift: true });

    const input = await $("[cmdk-input]");
    await input.waitForExist({ timeout: 5_000 });
    await input.addValue("nabla");
    const item = await $(`[cmdk-item][data-value*="nabla"]`);
    await item.waitForExist({ timeout: 5_000 });
    await item.click();

    // Assert on the document, not the caret line — after the palette
    // unmounts, getSelection() can stay anchored on a detached node even
    // though the editor's own selection moved correctly.
    await browser.waitUntil(async () => (await docLines()).some((l) => l.includes("$\\nabla$")), {
      timeout: 5_000,
      timeoutMsg: `symbol did not insert wrapped — ${await debugState()}`,
    });

    await browser.saveScreenshot("/tmp/math-workflow-e2e.png");
  });
});
