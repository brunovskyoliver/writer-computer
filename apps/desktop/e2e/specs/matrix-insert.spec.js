import { ok } from "node:assert/strict";

// Matrix-size prompt and stale-tabstop verification: seeds a document with an
// empty display block, a prose line, and a small bmatrix, then checks
//   - Cmd+Alt+M in display math opens the prompt at the caret, and `2x3 a`
//     writes a bmatrix of a_{11} … a_{23}
//   - a bad size keeps the prompt open and marks the input invalid; Escape
//     closes it without writing
//   - in prose the matrix arrives in its own `$$` block
//   - a subscript snippet the caret has left no longer captures Tab, so Tab
//     at the row's end opens a new element
// (see SPECs/matrix-brace-tools/spec.md, FR-10 and FR-11).
//
// Requires a restorable workspace, like the other latex specs: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// before launching. Self-skips on the welcome screen.
describe("Matrix insert prompt", function () {
  const FILE_STEM = "matrix-insert-e2e";
  const DOC = [
    "# Matrix insert check",
    "",
    "$$",
    "M=",
    "$$",
    "",
    "Prose goes here.",
    "",
    "$$",
    "\\begin{bmatrix}",
    "p & q",
    "\\end{bmatrix}",
    "$$",
    "",
    "$$",
    "Q=",
    "$$",
    "",
    "$$",
    "S=",
    "$$",
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

  function docLines() {
    return browser.execute(() =>
      [...document.querySelectorAll(".cm-line")].map((line) => line.textContent),
    );
  }

  function caretLine() {
    return browser.execute(() => {
      const node = document.getSelection()?.anchorNode;
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      return el?.closest(".cm-line")?.textContent ?? null;
    });
  }

  /** Synthetic keydown on the contentDOM — modifier chords through the driver
   *  are flaky on WKWebView (see matrix-brace.spec.js). */
  async function press(key, mods = {}) {
    await browser.execute(
      (pressedKey, m) => {
        document.querySelector(".cm-content")?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: pressedKey,
            metaKey: Boolean(m.meta),
            altKey: Boolean(m.alt),
            shiftKey: Boolean(m.shift),
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      key,
      mods,
    );
  }

  async function typeText(text) {
    await browser.execute((t) => {
      document.execCommand("insertText", false, t);
    }, text);
  }

  async function caretToLine(needle) {
    await press("a", { meta: true });
    await press("ArrowLeft");
    for (let i = 0; i < 30; i += 1) {
      const line = await caretLine();
      if (line !== null && line.includes(needle)) return;
      await browser.keys(["ArrowDown"]);
    }
    throw new Error(`caret never reached a line containing ${needle}`);
  }

  async function caretToLineEnd(needle) {
    await caretToLine(needle);
    // `End` does not reach the line end on macOS WebKit; Cmd+Right does.
    await press("ArrowRight", { meta: true });
  }

  function promptInput() {
    return $(".cm-matrix-prompt input");
  }

  async function openPrompt() {
    await press("m", { meta: true, alt: true });
    await promptInput().waitForExist({ timeout: 5_000, timeoutMsg: "prompt never opened" });
    await browser.waitUntil(
      () => browser.execute(() => document.activeElement?.closest(".cm-matrix-prompt") !== null),
      { timeout: 3_000, timeoutMsg: "prompt input never took focus" },
    );
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the matrix document into");

    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: DOC });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);

    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });

    const row = await $(`span*=Matrix insert check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-content")).length > 0, {
      timeout: 10_000,
      timeoutMsg: "editor never mounted",
    });
    await $(".cm-content").click();
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath }).catch(() => {});
  });

  it("writes a filled bmatrix from `2x3 a` in display math", async function () {
    await caretToLineEnd("M=");
    await openPrompt();
    await promptInput().addValue("2x3 a");
    await browser.keys(["Enter"]);

    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        const at = lines.findIndex((text) => text === "M=\\begin{bmatrix}");
        return (
          at !== -1 &&
          lines[at + 1] === "a_{11} & a_{12} & a_{13}\\\\" &&
          lines[at + 2] === "a_{21} & a_{22} & a_{23}" &&
          lines[at + 3] === "\\end{bmatrix}"
        );
      },
      { timeout: 5_000, timeoutMsg: "the 2x3 matrix was not written at the caret" },
    );
    ok(!(await promptInput().isExisting()), "prompt stayed open after inserting");

    // The caret sits just past \end{bmatrix}, so the next operand follows.
    await typeText("=");
    await browser.waitUntil(async () => (await docLines()).includes("\\end{bmatrix}="), {
      timeout: 5_000,
      timeoutMsg: "caret did not land after \\end{bmatrix}",
    });
  });

  it("keeps the prompt open on a bad size and closes on Escape", async function () {
    await caretToLineEnd("Prose goes here.");
    await openPrompt();
    await promptInput().addValue("three");
    await browser.keys(["Enter"]);
    await browser.waitUntil(
      async () => (await promptInput().getAttribute("aria-invalid")) === "true",
      { timeout: 3_000, timeoutMsg: "a bad size was not flagged" },
    );

    await browser.keys(["Escape"]);
    await promptInput().waitForExist({
      reverse: true,
      timeout: 3_000,
      timeoutMsg: "Escape did not close the prompt",
    });
    const after = await docLines();
    const at = after.indexOf("Prose goes here.");
    ok(at !== -1 && after[at + 1] === "", "a cancelled prompt changed the document");
    ok(!after.some((text) => text.includes("three")), "the prompt text leaked into the note");
  });

  it("wraps the matrix in its own $$ block in prose", async function () {
    await caretToLineEnd("Prose goes here.");
    await openPrompt();
    await promptInput().addValue("1 2 x");
    await browser.keys(["Enter"]);

    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        const at = lines.indexOf("Prose goes here.");
        return (
          lines[at + 1] === "$$" &&
          lines[at + 2] === "\\begin{bmatrix}" &&
          lines[at + 3] === "x_{11} & x_{12}" &&
          lines[at + 4] === "\\end{bmatrix}" &&
          lines[at + 5] === "$$"
        );
      },
      { timeout: 5_000, timeoutMsg: "the prose matrix was not wrapped in a $$ block" },
    );
  });

  it("leaves the matrix on Tab twice at a row's end", async function () {
    await caretToLineEnd("a_{21} & a_{22} & a_{23}");
    await press("Tab"); // opens an empty element
    await press("Tab"); // …which is dropped, and the caret leaves
    await typeText("X");
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return (
          lines.includes("a_{21} & a_{22} & a_{23}") &&
          lines.some((text) => text.startsWith("\\end{bmatrix}X"))
        );
      },
      { timeout: 5_000, timeoutMsg: "Tab twice did not leave the matrix" },
    );
  });

  it("leaves the matrix on Enter twice at the last row", async function () {
    await caretToLineEnd("p & q");
    await browser.keys(["Enter"]); // `p & q\\` + a fresh row
    await browser.keys(["Enter"]); // the empty row goes, the caret leaves
    await typeText("Y");
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        const at = lines.indexOf("p & q");
        return at !== -1 && lines[at + 1] === "\\end{bmatrix}Y";
      },
      { timeout: 5_000, timeoutMsg: "Enter twice did not leave the matrix" },
    );
  });

  it("does not let a left-behind subscript snippet capture Tab", async function () {
    await caretToLineEnd("p & q");
    await typeText("_"); // `_` expands to `_{$0}$1`
    await typeText("1");
    await browser.keys(["ArrowRight"]); // past `}` — the snippet's last stop
    await typeText(" + r"); // …and beyond it
    await press("Tab");

    await browser.waitUntil(async () => (await docLines()).includes("p & q_{1} + r & "), {
      timeout: 5_000,
      timeoutMsg: "Tab jumped back into the finished subscript instead of opening a cell",
    });
  });

  it("steps over a snippet's own closing brace instead of doubling it", async function () {
    await caretToLineEnd("Q=");
    await typeText("_"); // `_{|}`
    await typeText("T");
    await typeText("}");
    await typeText("x");
    await browser.waitUntil(async () => (await docLines()).includes("Q=_{T}x"), {
      timeout: 5_000,
      timeoutMsg: "typing } inside _{…} doubled the brace",
    });
  });

  it("steps out of a subscript on a space", async function () {
    await caretToLineEnd("S=");
    await typeText("x");
    await typeText("_"); // `x_{|}`
    await typeText("1");
    await typeText(" ");
    await typeText("+");
    await browser.waitUntil(async () => (await docLines()).includes("S=x_{1} +"), {
      timeout: 5_000,
      timeoutMsg: "a space inside x_{1} did not step out of the subscript",
    });
  });
});
