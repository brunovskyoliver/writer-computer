import { ok } from "node:assert/strict";

// `\` completion (SPECs/latex-completions): in a note's display math `\fr`
// offers `\frac` with a rendered preview and Tab inserts it with stops; in a
// `.tex` file `\begin{it` completes the itemize block and `\cite{` lists the
// keys of the folder's `.bib`. Nothing opens in note prose.
//
// Requires a restorable workspace, like the other editor specs. Self-skips on
// the welcome screen.
describe("LaTeX completions", function () {
  const NOTE = ["# Completion check", "", "$$", "x=", "$$", "", "Prose line", ""].join("\n");
  const TEX = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Intro",
    "\\end{document}",
    "",
  ].join("\n");
  const BIB = "@book{knuth84,\n  title = {The TeXbook},\n}\n";

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

  async function press(key, mods = {}) {
    await browser.execute(
      (pressedKey, m) => {
        // The focused editor: a hidden tab's editor stays in the DOM too.
        const target =
          document.activeElement?.closest?.(".cm-content") ??
          [...document.querySelectorAll(".cm-content")].find((el) => el.offsetParent !== null);
        target?.dispatchEvent(
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

  function options() {
    return browser.execute(() =>
      [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((li) => ({
        label: li.querySelector(".cm-completionLabel")?.textContent ?? "",
        glyph: li.querySelector(".cm-latex-completion-glyph .katex") !== null,
      })),
    );
  }

  async function waitForOption(label) {
    await browser.waitUntil(
      async () => (await options()).some((option) => option.label === label),
      { timeout: 5_000, timeoutMsg: `completion "${label}" never offered` },
    );
  }

  async function openFile(label, firstLine) {
    const row = await $(`span=${label}`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await docLines()).includes(firstLine), {
      timeout: 10_000,
      timeoutMsg: `${label} never opened`,
    });
    await browser.execute(() => {
      const visible = [...document.querySelectorAll(".cm-content")].filter(
        (el) => el.offsetParent !== null,
      );
      visible[visible.length - 1]?.focus();
    });
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed into");
    for (const [name, content] of [
      ["completion-e2e.md", NOTE],
      ["paper.tex", TEX],
      ["refs.bib", BIB],
    ]) {
      const wrote = await invoke("write_file", { path: `${root}/${name}`, content });
      ok(wrote.ok, `failed to seed ${name}: ${wrote.error}`);
    }
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
    for (const name of ["completion-e2e.md", "paper.tex", "refs.bib"]) {
      await invoke("delete_entry", { path: `${root}/${name}` }).catch(() => {});
    }
  });

  it("offers \\frac with a preview in note math and Tab inserts it with stops", async function () {
    await openFile("Completion check", "# Completion check");
    await caretToLineEnd("x=");
    await typeText("\\fr");
    await waitForOption("\\frac");
    const shown = await options();
    ok(
      shown.some((option) => option.glyph),
      "no rendered preview beside the options",
    );

    await press("Tab"); // accept
    await typeText("1");
    await press("Tab"); // numerator → denominator
    await typeText("2");
    await browser.waitUntil(async () => (await docLines()).includes("x=\\frac{1}{2}"), {
      timeout: 5_000,
      timeoutMsg: "accepting \\frac did not insert a template Tab could fill",
    });
  });

  it("stays quiet in note prose", async function () {
    await caretToLineEnd("Prose line");
    await typeText(" \\fr");
    await browser.pause(400);
    ok((await options()).length === 0, "a completion list opened in Markdown prose");
  });

  it("still completes [[wiki links]] in note prose", async function () {
    await caretToLineEnd("Prose line");
    await typeText(" [[complet");
    await browser.waitUntil(
      async () => (await options()).some((option) => /ompletion/.test(option.label)),
      { timeout: 5_000, timeoutMsg: "wiki-link completion no longer opens" },
    );
    await press("Escape");
  });

  it("completes \\begin{it into an itemize block in a .tex file", async function () {
    await openFile("paper.tex", "\\documentclass{article}");
    await caretToLineEnd("Intro");
    await typeText("\n\\begin{it");
    await waitForOption("itemize");
    await browser.keys(["Enter"]);
    await typeText("First");
    await browser.waitUntil(
      async () => {
        const lines = await docLines();
        const at = lines.indexOf("\\begin{itemize}");
        return (
          at !== -1 &&
          lines[at + 1]?.trim() === "\\item First" &&
          lines[at + 2] === "\\end{itemize}"
        );
      },
      { timeout: 5_000, timeoutMsg: "the itemize block was not written" },
    );
  });

  it("lists .bib keys after \\cite{", async function () {
    await caretToLineEnd("\\item First");
    await typeText(" \\cite{");
    await waitForOption("knuth84");
    await browser.keys(["Enter"]);
    await browser.waitUntil(
      async () => (await docLines()).some((text) => text.includes("\\cite{knuth84}")),
      { timeout: 5_000, timeoutMsg: "accepting the key did not write it" },
    );
  });
});
