import { ok } from "node:assert/strict";

// LaTeX documents end to end (SPECs/latex-documents): seeds a `.tex` file and
// checks
//   - the sidebar lists `main.tex` and it opens as LaTeX source
//   - Cmd+Alt+P compiles with Tectonic and opens the PDF beside the source
//   - an edit recompiles on save and the preview reloads in place
//   - a compile error is named in the footer, clicking it goes to the line,
//     and the last good PDF stays on screen
//   - math snippets and the matrix prompt work inside an equation
//   - Cmd+Alt+P again closes the preview
//
// Needs Tectonic installed (`brew install tectonic`) and a restorable
// workspace, like the other editor specs. Self-skips on the welcome screen.
describe("LaTeX documents with a PDF preview", function () {
  const DOC = [
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    "\\begin{document}",
    "Hello matrices.",
    "\\begin{equation}",
    "A=",
    "\\end{equation}",
    "\\end{document}",
    "",
  ].join("\n");

  let workspaceRestored = false;
  let root = null;

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

  /** Synthetic keydown on the source editor — chords through the driver are
   *  flaky on WKWebView (see matrix-brace.spec.js). */
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

  async function caretToLineEnd(needle) {
    await press("a", { meta: true });
    await press("ArrowLeft");
    for (let i = 0; i < 30; i += 1) {
      const line = await caretLine();
      if (line !== null && line.includes(needle)) {
        await press("ArrowRight", { meta: true });
        return;
      }
      await browser.keys(["ArrowDown"]);
    }
    throw new Error(`caret never reached a line containing ${needle}`);
  }

  function pdfPageCount() {
    return browser.execute(() => document.querySelectorAll("[data-pdf-page]").length);
  }

  function status() {
    return browser.execute(() => {
      const el = document.querySelector("[data-latex-status]");
      return el ? { state: el.getAttribute("data-latex-status"), text: el.textContent } : null;
    });
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the LaTeX document into");
    const wrote = await invoke("write_file", { path: `${root}/main.tex`, content: DOC });
    ok(wrote.ok, `failed to seed main.tex: ${wrote.error}`);

    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (!root) return;
    for (const name of ["main.tex", "main.pdf"]) {
      await invoke("delete_entry", { path: `${root}/${name}` }).catch(() => {});
    }
  });

  it("lists main.tex in the sidebar and opens it as LaTeX source", async function () {
    const row = await $("span=main.tex");
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await docLines()).includes("Hello matrices."), {
      timeout: 10_000,
      timeoutMsg: "main.tex never opened in the editor",
    });
    await $(".cm-content").click();
    const idle = await status();
    ok(idle?.state === "idle", `footer did not show the LaTeX status: ${JSON.stringify(idle)}`);
  });

  it("compiles and opens the PDF beside the source on Cmd+Alt+P", async function () {
    await press("p", { meta: true, alt: true });
    await $('[data-pdf-page="1"]').waitForExist({
      timeout: 120_000, // a first compile may fetch packages
      timeoutMsg: "the PDF preview never opened",
    });
    await browser.waitUntil(async () => (await status())?.state === "ok", {
      timeout: 10_000,
      timeoutMsg: "footer never reported a finished compile",
    });
    ok((await pdfPageCount()) === 1, "expected a one-page PDF");
    // The source keeps the focus: typing goes into the .tex, not the PDF.
    ok((await docLines()).includes("Hello matrices."), "the source pane was replaced");
  });

  it("recompiles on save and reloads the preview in place", async function () {
    await caretToLineEnd("Hello matrices.");
    await typeText("\n\\newpage\nPage two.");
    await browser.waitUntil(async () => (await pdfPageCount()) === 2, {
      timeout: 60_000,
      timeoutMsg: "the preview never showed the second page after an edit",
    });
    ok(await $('[data-pdf-page="1"]').isExisting(), "page 1 vanished during the reload");
  });

  it("names a compile error in the footer and jumps to its line", async function () {
    await caretToLineEnd("Page two.");
    await typeText("\n\\nosuchmacro");
    await browser.waitUntil(async () => (await status())?.state === "failed", {
      timeout: 60_000,
      timeoutMsg: "the footer never reported the compile error",
    });
    const failed = await status();
    ok(/line 7/.test(failed.text), `the error did not name line 7: ${failed.text}`);
    ok((await pdfPageCount()) === 2, "the last good PDF was not kept on screen");

    await caretToLineEnd("Hello matrices.");
    await $('[data-latex-status="failed"]').click();
    await browser.waitUntil(async () => (await caretLine()) === "\\nosuchmacro", {
      timeout: 5_000,
      timeoutMsg: "clicking the error did not put the caret on its line",
    });

    // Fix it: delete the bad line's text; the next save compiles clean.
    await press("ArrowRight", { meta: true });
    await press("Backspace", { meta: true });
    await browser.waitUntil(async () => (await status())?.state === "ok", {
      timeout: 60_000,
      timeoutMsg: "the fixed document never compiled clean again",
    });
  });

  it("runs math snippets and the matrix prompt inside an equation", async function () {
    await caretToLineEnd("A=");
    await press("m", { meta: true, alt: true });
    const input = await $(".cm-matrix-prompt input");
    await input.waitForExist({ timeout: 5_000, timeoutMsg: "matrix prompt did not open" });
    await input.addValue("2x2 a");
    await browser.keys(["Enter"]);
    await browser.waitUntil(async () => (await docLines()).includes("a_{11} & a_{12}\\\\"), {
      timeout: 5_000,
      timeoutMsg: "the matrix prompt did not write into the equation",
    });

    await typeText("+x");
    await typeText("_");
    await typeText("1");
    await typeText(" ");
    await browser.waitUntil(
      async () => (await docLines()).some((text) => text.endsWith("\\end{bmatrix}+x_{1} ")),
      { timeout: 5_000, timeoutMsg: "the subscript snippet did not fire in the equation" },
    );

    // Outside math the snippets stay quiet: `_` in prose is just `_`.
    await caretToLineEnd("Page two.");
    await typeText(" a_b");
    await browser.waitUntil(async () => (await docLines()).includes("Page two. a_b"), {
      timeout: 5_000,
      timeoutMsg: "a snippet fired in prose",
    });
  });

  it("closes the preview on Cmd+Alt+P again", async function () {
    await press("p", { meta: true, alt: true });
    await $('[data-pdf-page="1"]').waitForExist({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: "the preview did not close",
    });
    ok((await docLines()).includes("Hello matrices."), "the source tab closed too");
  });
});
