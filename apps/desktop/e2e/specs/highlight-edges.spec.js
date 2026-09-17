import { ok } from "node:assert/strict";
import { writeFileSync } from "node:fs";

// Highlight-bar refusals and edges (SPECs/formula-highlight-colors,
// quickstart steps 19–23): a caret or a selection inside code raises no bar,
// a selection running out of a math block never swallows the `$$` delimiters,
// an external write closes an open bar without writing, and a hand-edited
// off-palette hex renders as written with no active swatch.
//
// Selections are driven with real key input (arrow steps are document
// positions, immune to concealed markup) plus one stepped pointer drag for
// the folded-widget case. Requires a restorable workspace (see
// latex-math.spec.js); self-skips on the welcome screen.
describe("highlight bar refusals and edges", function () {
  const FILE_STEM = "highlight-edges-e2e";
  // Line offsets below count DOCUMENT characters; concealed markup still
  // occupies positions, so the counts stay stable when it reveals.
  const DOC = [
    "# Edge walk", // L0
    "",
    "para one has `inline code` inside", // L2
    "",
    "```", // L4
    "fenced code words here", // L5
    "```", // L6
    "",
    "$$a+b$$", // L8
    "",
    "prose after the math block", // L10
    "",
    '<span style="color:#123abc">off palette words</span> trailing', // L12
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

  async function keys(chord, times = 1) {
    for (let i = 0; i < times; i++) await browser.keys(chord);
  }

  async function focusEditor() {
    const line = await $(".cm-content .cm-line");
    await line.click();
  }

  async function docStart() {
    await focusEditor();
    await keys(["Meta", "a"]);
    await keys(["ArrowLeft"]);
  }

  /** Caret at doc start, then `down` lines and `right` characters. */
  async function caretAt(down, right) {
    await docStart();
    await keys(["ArrowDown"], down);
    await keys(["Meta", "ArrowLeft"]);
    await keys(["ArrowRight"], right);
  }

  /** Non-empty selection: caret at (down, right), extended `len` chars. */
  async function selectRange(down, right, len) {
    await caretAt(down, right);
    await keys(["Shift", "ArrowRight"], len);
  }

  async function barExists() {
    return $(".highlight-bar").isExisting();
  }

  /** Drag-select the `from`–`to` character subrange of the first text node
   *  containing `needle`, via a stepped pointer drag. */
  async function dragSelectText(needle, from, to) {
    const pts = await browser.execute(
      (n, f, t) => {
        const root = document.querySelector(".cm-content");
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const i = walker.currentNode.data.indexOf(n);
          if (i < 0) continue;
          const rectFor = (a, b) => {
            const range = document.createRange();
            range.setStart(walker.currentNode, i + a);
            range.setEnd(walker.currentNode, i + b);
            const r = range.getBoundingClientRect();
            return { x: Math.round(r.left + 1), y: Math.round(r.top + r.height / 2) };
          };
          return { start: rectFor(f, f + 1), end: rectFor(t - 1, t) };
        }
        return null;
      },
      needle,
      from,
      to,
    );
    ok(pts, `could not measure drag endpoints for ${needle}`);

    await browser.pause(600); // stay above the multi-click threshold
    const moves = [];
    for (let i = 1; i <= 6; i++) {
      moves.push({
        type: "pointerMove",
        duration: 30,
        origin: "viewport",
        x: Math.round(pts.start.x + ((pts.end.x - pts.start.x) * i) / 6),
        y: Math.round(pts.start.y + ((pts.end.y - pts.start.y) * i) / 6),
      });
      moves.push({ type: "pause", duration: 30 });
    }
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x: pts.start.x, y: pts.start.y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 50 },
          ...moves,
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
  }

  /** The bar publishes through requestMeasure, so its absence is only
   *  meaningful after a beat. */
  async function expectNoBar(context) {
    await browser.pause(800);
    const selText = await browser.execute(() => document.getSelection()?.toString() ?? "");
    ok(
      !(await barExists()),
      `highlight bar appeared for ${context} — selection was ${JSON.stringify(selText)}`,
    );
  }

  async function expectBar(context) {
    const found = await browser
      .waitUntil(async () => barExists(), { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const diag = await browser.execute(() => ({
      sel: document.getSelection()?.toString() ?? "",
      active: `${document.activeElement?.tagName}.${document.activeElement?.className}`,
      cmFocused: document.querySelector(".cm-content")?.classList.contains("cm-focused"),
      anchorLine:
        (document.getSelection()?.anchorNode?.nodeType === 1
          ? document.getSelection()?.anchorNode
          : document.getSelection()?.anchorNode?.parentElement
        )?.closest?.(".cm-line")?.textContent ?? null,
      doc: document.querySelector(".cm-content")?.innerText?.slice(0, 300) ?? "no content",
    }));
    ok(found, `highlight bar never opened for ${context} — ${JSON.stringify(diag)}`);
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the edge document into");

    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: DOC });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);

    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });

    const row = await $(`span*=Edge walk`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-content")).length > 0, {
      timeout: 10_000,
      timeoutMsg: "editor never mounted",
    });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath });
  });

  it("step 19: a caret-only selection shows no bar", async function () {
    await caretAt(2, 4);
    await expectNoBar("a collapsed selection");
  });

  it("step 20: selections inside fenced and inline code show no bar", async function () {
    // "fenced code words here" — "code words" starts at char 7.
    await selectRange(5, 7, 10);
    await expectNoBar("a fenced-code selection");

    // "para one has `inline code` inside" — "inline code" starts at char 14.
    await selectRange(2, 14, 11);
    await expectNoBar("an inline-code selection");
  });

  it("step 21: a selection out of a math block never swallows $$", async function () {
    // Caret into the math block unfolds it to source (same arrow-key
    // approach as highlight.spec.js).
    await docStart();
    for (let i = 0; i < 12; i++) {
      const line = await browser.execute(() => {
        const node = document.getSelection()?.anchorNode;
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        return el?.closest(".cm-line")?.textContent ?? null;
      });
      if (line && line.includes("$$")) break;
      await keys(["ArrowDown"]);
    }
    await keys(["Meta", "ArrowLeft"]);
    await keys(["ArrowRight"], 2);
    await browser.waitUntil(async () => (await $(".cm-content").getText()).includes("$$a+b$$"), {
      timeout: 5_000,
      timeoutMsg: "display math never unfolded to source",
    });

    // Select "a+b", then extend two visual lines down into the prose after
    // the block — a selection running out of math into prose.
    await keys(["Shift", "ArrowRight"], 3);
    await keys(["Shift", "ArrowDown"], 2);
    await expectNoBar("a selection spanning math into prose");

    // Collapse at the head (prose) so the widget refolds.
    await keys(["ArrowRight"]);
    await browser.waitUntil(async () => (await $$(".cm-math-widget")).length > 0, {
      timeout: 5_000,
      timeoutMsg: "math widget never refolded",
    });

    // Now the folded case: drag from the rendered widget into the prose.
    // Whatever the press resolves to — refused, or prose starting after the
    // block — the file must keep `$$a+b$$` outside any written span.
    const widgetPt = await browser.execute(() => {
      const el = document.querySelector(".cm-math-widget");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) };
    });
    const prosePt = await browser.execute(() => {
      const root = document.querySelector(".cm-content");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const i = walker.currentNode.data.indexOf("math block");
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(walker.currentNode, i + 4);
        range.setEnd(walker.currentNode, i + 5);
        const r = range.getBoundingClientRect();
        return { x: Math.round(r.left + 1), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    });
    ok(widgetPt && prosePt, "could not measure the widget drag endpoints");

    const moves = [];
    for (let i = 1; i <= 6; i++) {
      moves.push({
        type: "pointerMove",
        duration: 30,
        origin: "viewport",
        x: Math.round(widgetPt.x + ((prosePt.x - widgetPt.x) * i) / 6),
        y: Math.round(widgetPt.y + ((prosePt.y - widgetPt.y) * i) / 6),
      });
      moves.push({ type: "pause", duration: 30 });
    }
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x: widgetPt.x, y: widgetPt.y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 50 },
          ...moves,
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.pause(800);

    if (await barExists()) {
      await $('button[aria-label="Highlight Blue"]').click();
      await keys(["Meta", "s"]);
      let content = "";
      await browser.waitUntil(
        async () => {
          const r = await invoke("read_file", { path: filePath });
          if (r.ok && r.value.content.includes("#0969da")) {
            content = r.value.content;
            return true;
          }
          return false;
        },
        { timeout: 10_000, timeoutMsg: "written file never contained a span" },
      );
      ok(content.includes("$$a+b$$"), `math source damaged:\n${content}`);
      const spanBodies = [...content.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
      ok(
        spanBodies.every((body) => !body.includes("$$")),
        `$$ delimiters swallowed into a span:\n${content}`,
      );
      writeFileSync("/tmp/highlight-21b-outcome.txt", `bar branch\n${content}`);
    } else {
      const r = await invoke("read_file", { path: filePath });
      ok(
        r.ok && !r.value.content.includes('<span style="color:#0969da">'),
        "refused path wrote a span",
      );
      ok(r.value.content.includes("$$a+b$$"), "math source damaged on the refused path");
      writeFileSync("/tmp/highlight-21b-outcome.txt", `refused branch\n${r.value.content}`);
    }
  });

  it("step 22: an external write closes the open bar without writing", async function () {
    // Drag-select "trailing" on the last line (pointer drags proved reliable
    // for prose selections; shift-chords do not extend here).
    await dragSelectText("trailing", 0, 8);
    await expectBar("a prose selection");

    const before = await invoke("read_file", { path: filePath });
    ok(before.ok, "could not read file before external edit");
    writeFileSync(filePath, `${before.value.content}external tail\n`);

    await browser.waitUntil(
      async () => (await $(".cm-content").getText()).includes("external tail"),
      { timeout: 10_000, timeoutMsg: "external edit never reloaded into the editor" },
    );
    await browser.pause(800);
    ok(!(await barExists()), "bar stayed open across an external edit");
  });

  it("step 23: an off-palette hex renders as written with no active swatch", async function () {
    // Drag-select the inner text of the concealed off-palette span.
    await dragSelectText("off palette words", 0, 17);
    await expectBar("the off-palette highlight");

    const pressed = await $$('.highlight-bar button[aria-pressed="true"]');
    ok(pressed.length === 0, "an off-palette hex claimed an active swatch");
    const remove = await $('.highlight-bar button[aria-label="Remove highlight"]');
    ok(await remove.isExisting(), "remove action missing for a recognised highlight");
    ok(!(await remove.getAttribute("disabled")), "remove disabled on an off-palette highlight");
  });
});
