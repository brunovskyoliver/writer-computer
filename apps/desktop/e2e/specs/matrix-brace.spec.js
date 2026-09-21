import { ok } from "node:assert/strict";

// Matrix-row Enter and brace-annotation verification: seeds a document with a
// `pmatrix` in display math plus prose, then checks
//   - Enter inside a matrix row inserts `\\` + a fresh row
//   - Enter on an empty matrix row falls back to a plain newline
//   - Cmd+Alt+U / Cmd+Alt+O wrap the selection in \underbrace / \overbrace
//     (math in place, prose inside `\text{}`) with the caret in the note
//   - both commands are reachable from the command palette
// (see SPECs/matrix-brace-tools/spec.md).
//
// Requires a restorable workspace, like the other latex specs: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// before launching. Self-skips on the welcome screen.
describe("Matrix rows and brace annotations", function () {
  const FILE_STEM = "matrix-brace-e2e";
  const DOC = [
    "# Brace matrix check",
    "",
    "$$",
    "\\begin{pmatrix}",
    "1 & 2",
    "\\end{pmatrix}",
    "$$",
    "",
    "Wrap this word.",
    "",
    "Euler: $e^{i\\pi}+1=0$",
    "",
    "Wrap vim word too.",
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

  /** Every `.cm-line`'s text, in document order. */
  function docLines() {
    return browser.execute(() =>
      [...document.querySelectorAll(".cm-line")].map((line) => line.textContent),
    );
  }

  /** Text of the `.cm-line` the caret currently sits on. */
  function caretLine() {
    return browser.execute(() => {
      const node = document.getSelection()?.anchorNode;
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      return el?.closest(".cm-line")?.textContent ?? null;
    });
  }

  function selectedText() {
    return browser.execute(() => document.getSelection()?.toString() ?? "");
  }

  /**
   * Synthetic keydown on the contentDOM: modifier chords through the driver
   * are flaky on WKWebView (the modifier can drop, turning Meta+Right into a
   * bare ArrowRight), and an untrusted event still reaches the CodeMirror
   * keymap. Real `browser.keys` is only safe for unmodified keys.
   */
  async function press(key, mods = {}) {
    await browser.execute(
      (pressedKey, m) => {
        document.querySelector(".cm-content")?.dispatchEvent(
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

  async function pressTimes(key, count, mods = {}) {
    for (let i = 0; i < count; i += 1) await press(key, mods);
  }

  /**
   * Insert text at the caret. `browser.keys` never reaches CodeMirror's input
   * handling on WKWebView (text lands via beforeinput, not keydown), so go
   * through execCommand — a real contenteditable mutation CM observes.
   */
  async function typeText(text) {
    await browser.execute((t) => {
      document.execCommand("insertText", false, t);
    }, text);
  }

  /** Collapse the caret to the document start. */
  async function caretToStart() {
    await press("a", { meta: true });
    await press("ArrowLeft");
  }

  /**
   * Walk the caret down from the document start until it lands on the line
   * containing `needle`. Folded math shows as one widget line, so the source
   * line index is useless until the caret enters the math and unfolds it —
   * poll the caret's own line instead (same trick as `latex-math.spec.js`).
   */
  async function caretToLine(needle) {
    await caretToStart();
    for (let i = 0; i < 30; i += 1) {
      const line = await caretLine();
      if (line !== null && line.includes(needle)) return;
      await browser.keys(["ArrowDown"]);
    }
    throw new Error(`caret never reached a line containing ${needle}`);
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

    const row = await $(`span*=Brace matrix check`);
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
    if (workspaceRestored) {
      await invoke("set_setting", {
        key: "editor.vim-mode",
        value: false,
        scope: "global",
      }).catch(() => {});
    }
    if (filePath) await invoke("delete_entry", { path: filePath }).catch(() => {});
  });

  it("turns Enter inside a matrix row into `\\\\` plus a fresh row", async function () {
    await caretToLine("1 & 2");
    await pressTimes("ArrowRight", 5); // end of "1 & 2"
    await browser.keys(["Enter"]);

    await browser.waitUntil(async () => (await lineIndex("1 & 2\\\\")) > 0, {
      timeout: 5_000,
      timeoutMsg: "Enter did not append a row break to the matrix row",
    });

    // The caret sits on the fresh row: a second Enter must not add another
    // `\\` — an empty row means a plain newline (the way out of the matrix).
    await browser.keys(["Enter"]);
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        const at = lines.findIndex((text) => text.includes("1 & 2"));
        return (
          lines[at] === "1 & 2\\\\" &&
          lines[at + 1] === "" &&
          lines[at + 2] === "" &&
          lines[at + 3]?.includes("\\end{pmatrix}")
        );
      },
      {
        timeout: 5_000,
        timeoutMsg: "Enter on an empty matrix row did not fall back to a newline",
      },
    );
  });

  it("wraps a math selection with Cmd+Alt+U and puts the caret in the note", async function () {
    await caretToLine("Euler:");
    await pressTimes("ArrowRight", 8); // past "Euler: $"
    await pressTimes("ArrowRight", 8, { shift: true }); // e^{i\pi}
    ok((await selectedText()) === "e^{i\\pi}", "math fragment not selected");

    await press("u", { meta: true, alt: true });
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return lines.some((text) => text.includes("\\underbrace{e^{i\\pi}}_{"));
      },
      { timeout: 5_000, timeoutMsg: "Cmd+Alt+U did not wrap the math selection" },
    );

    // The caret lands inside the annotation group: typing fills the note.
    await typeText("c");
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return lines.some((text) => text.includes("\\underbrace{e^{i\\pi}}_{c}"));
      },
      { timeout: 5_000, timeoutMsg: "typed note did not land inside the annotation group" },
    );
  });

  it("wraps a prose selection with Cmd+Alt+O inside \\text{}", async function () {
    await caretToLine("Wrap this word.");
    await pressTimes("ArrowRight", 4, { shift: true }); // "Wrap"
    ok((await selectedText()) === "Wrap", "prose fragment not selected");

    await press("o", { meta: true, alt: true });
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return lines.some((text) => text.includes("\\overbrace{\\text{Wrap}}^{\\text{"));
      },
      { timeout: 5_000, timeoutMsg: "Cmd+Alt+O did not wrap the prose selection" },
    );

    await typeText("note");
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return lines.some((text) => text.includes("\\overbrace{\\text{Wrap}}^{\\text{note}}"));
      },
      { timeout: 5_000, timeoutMsg: "typed note did not land inside the prose annotation" },
    );
  });

  it("drops into insert mode when a brace wraps from Vim visual/normal", async function () {
    await invoke("set_setting", { key: "editor.vim-mode", value: true, scope: "global" });
    await $('[data-vim-mode="NORMAL"]').waitForExist({ timeout: 10_000 });

    // Vim motions, not caretToLine: select-all reads as a VISUAL selection to
    // Vim and its block cursor hides the DOM caret line, so navigate with
    // `G`/`k`/`l` through Vim's own key path. The vim test has its own prose
    // line at the document end — earlier tests rewrote the first "Wrap".
    await press("G", { shift: true }); // last line (blank)
    await press("k"); // up to "Wrap vim word too."
    await press("v"); // visual mode
    await pressTimes("l", 3); // extend over "Wrap"
    await press("o", { meta: true, alt: true });

    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return lines.some((text) => text.includes("\\overbrace{\\text{Wrap}}^{\\text{"));
      },
      { timeout: 5_000, timeoutMsg: "Cmd+Alt+O did not wrap the visual selection" },
    );
    await $('[data-vim-mode="INSERT"]').waitForExist({
      timeout: 5_000,
      timeoutMsg: "brace wrap left Vim outside insert mode",
    });

    // In insert mode the note types; in Normal it would have been motions.
    await typeText("note");
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        return lines.some((text) => text.includes("\\overbrace{\\text{Wrap}}^{\\text{note}}"));
      },
      { timeout: 5_000, timeoutMsg: "typed note did not land inside the annotation" },
    );
  });

  it("exposes both brace commands in the command palette", async function () {
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const under = await $('[cmdk-item][data-value="underbrace"]');
    const over = await $('[cmdk-item][data-value="overbrace"]');
    await under.waitForExist({ timeout: 5_000 });
    await over.waitForExist({ timeout: 5_000 });
    await browser.keys(["Escape"]);
  });

  async function lineIndex(needle) {
    const lines = await docLines();
    return lines.findIndex((text) => text.includes(needle));
  }
});
