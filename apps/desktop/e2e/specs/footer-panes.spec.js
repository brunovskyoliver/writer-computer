import { ok, strictEqual } from "node:assert/strict";

// Per-pane document footer. The word/character/paragraph counts describe one
// document, so they sit at the bottom of the pane showing it. Before the
// footer was pane chrome it rendered once for the focused pane's tab,
// stretched across the full editor-area width and right-aligned: in a split
// the counts painted over the neighbouring PDF, and focusing a PDF tab
// removed them entirely.
//
// The split is driven through the quote-link path rather than a sidebar
// drag: clicking `[[footer-ref.pdf]]` runs `revealPdfAnchor`, which opens the
// PDF in a pane beside the note and focuses it — the same shape the bug was
// reported against.
//
// Requires a restorable workspace; self-skips on the welcome screen so it
// stays safe inside the default `pnpm run test:e2e` sweep.
describe("per-pane document footer", function () {
  const NOTES = {
    "footer-note": "# footer-note\n\nAlpha beta gamma delta.\n\n[[footer-ref.pdf]]\n",
    "footer-right": "# footer-right\n\nOne.\n\nTwo.\n\nThree.\n",
  };
  const PDF_STEM = "footer-ref";

  let workspaceRestored = false;
  let root = null;
  const seeded = [];

  // A one-page PDF small enough to seed through the text-only `write_file`
  // command — every byte is ASCII, so UTF-8 round-trips it exactly. The xref
  // offsets are computed while the string is assembled, so the document is
  // genuinely parseable rather than merely named `*.pdf`.
  function minimalPdf() {
    const stream = "BT /F1 24 Tf 100 700 Td (footer-ref) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    const offsets = objects.map((body, i) => {
      const at = out.length;
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return at;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
  }

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

  // Each pane slot as the DOM reports it: viewport rect plus whether the slot
  // owns a `[data-document-footer]` and, when it does, the footer's text and
  // whether the footer rect sits inside the pane rect — the visible form of
  // "the counts belong to this pane's document".
  async function readPanes() {
    return browser.execute(() => {
      const round = (r) => ({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      });
      return Array.from(document.querySelectorAll("[data-pane-id]")).map((pane) => {
        const rect = round(pane.getBoundingClientRect());
        const footer = pane.querySelector("[data-document-footer]");
        const fr = footer ? round(footer.getBoundingClientRect()) : null;
        return {
          id: pane.getAttribute("data-pane-id"),
          rect,
          footerText: footer ? footer.textContent : null,
          footerInside: fr
            ? fr.x >= rect.x - 1 && fr.right <= rect.right + 1 && fr.bottom <= rect.bottom + 1
            : null,
        };
      });
    });
  }

  // Dispatch the click sequence in page JS, not via input synthesis: under
  // tauri-webdriver `performActions` pointer moves/down/up only produce
  // `mousedown`/`mouseup` (no `pointerdown`, no `click`), and element
  // `click()` dispatches a coordinate-less `click` — `posAtCoords` then
  // resolves no editor position, so the wiki-link handler can't read the
  // target. A real sequence with real coordinates drives the same handlers
  // a user's click does: `pointerdown` for the pane-focus capture and
  // `click` for the link follow.
  async function clickEl(el) {
    await browser.execute((element) => {
      const r = element.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(
          new Ctor(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
          }),
        );
      }
    }, el);
    await browser.pause(200);
  }

  // Follow the note's rendered `[[…]]` link the way a user does. The wiki
  // link's own mousedown/click handlers run the follow, which for a `.pdf`
  // target resolves to `revealPdfAnchor` — a split, not a navigation.
  //
  // The query must filter for a *visible* link: background tabs keep their
  // editors mounted under `display: none`, and any note in the workspace
  // can carry `[[…]]` — the first `.cm-wiki-link` in the DOM is not
  // necessarily the one on screen.
  async function clickWikiLink() {
    const link = await browser.waitUntil(
      async () => {
        for (const el of await $$(".cm-wiki-link")) {
          if (await el.isDisplayed()) return el;
        }
        return false;
      },
      { timeout: 15_000, timeoutMsg: "no visible wiki link to click" },
    );
    await clickEl(link);
    return link;
  }

  // `readPanes` returns plain rect data, so find the pane's own element
  // back from its id before clicking — the click must land inside the pane
  // body for the focus handler's pointerdown capture to see it.
  async function clickPaneBody(pane) {
    const el = await $(`[data-pane-id="${pane.id}"]`);
    await clickEl(el);
  }

  async function openFromSidebar(name) {
    const row = await $(`[data-tree-path="${root}/${name}"]`);
    await row.waitForExist({ timeout: 20_000 });
    await row.click();
    await browser.pause(300);
  }

  // Collapse back to a single pane by closing every tab, re-querying after
  // each close — see tab-tiling.spec.js for why a static NodeList does not
  // work here.
  async function resetToOnePane() {
    for (let i = 0; i < 20; i++) {
      const closed = await browser.execute(() => {
        const button = document.querySelector('[data-pane-strip] [aria-label^="Close "]');
        if (!button) return false;
        button.click();
        return true;
      });
      if (!closed) break;
      await browser.pause(150);
    }
    await browser.waitUntil(async () => (await readPanes()).length === 1, {
      timeout: 10_000,
      timeoutMsg: "could not collapse back to a single pane",
    });
  }

  const leftFirst = (panes) => [...panes].sort((a, b) => a.rect.x - b.rect.x);

  async function splitWithPdfLink() {
    await openFromSidebar("footer-note.md");
    const solo = (await readPanes())[0];
    ok(solo.footerText, "setup: the single markdown pane should have a footer");
    ok(solo.footerInside, "setup: the footer should sit inside its own pane");

    await clickWikiLink();
    await browser.waitUntil(async () => (await readPanes()).length === 2, {
      timeout: 15_000,
      timeoutMsg: "the pdf link did not split the pane",
    });
    return { solo, panes: leftFirst(await readPanes()) };
  }

  before(async function () {
    workspaceRestored = await $('button[aria-label="Hide sidebar"]')
      .waitForExist({ timeout: 20_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the footer files into");

    for (const [stem, content] of Object.entries(NOTES)) {
      const path = `${root}/${stem}.md`;
      const wrote = await invoke("write_file", { path, content });
      ok(wrote.ok, `failed to seed ${path}: ${wrote.error}`);
      seeded.push(path);
    }
    const pdfPath = `${root}/${PDF_STEM}.pdf`;
    const wrotePdf = await invoke("write_file", { path: pdfPath, content: minimalPdf() });
    ok(wrotePdf.ok, `failed to seed ${pdfPath}: ${wrotePdf.error}`);
    seeded.push(pdfPath);

    // Reload rather than waiting on the workspace watcher: startup rebuilds the
    // file index from disk, so the seeded files are in the sidebar
    // deterministically.
    await browser.execute(() => window.location.reload());
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 20_000 });
  });

  beforeEach(async function () {
    if (!workspaceRestored) this.skip();
    await resetToOnePane();
  });

  after(async function () {
    if (!workspaceRestored) return;
    await resetToOnePane().catch(() => {});
    for (const path of seeded) await invoke("delete_entry", { path });
  });

  it("keeps the counts inside the markdown pane when a PDF splits the view", async function () {
    const { solo, panes } = await splitWithPdfLink();
    const [left, right] = panes;

    ok(left.footerText, "the markdown pane lost its footer to the split");
    strictEqual(
      left.footerText,
      solo.footerText,
      "the left pane's counts should still describe its own document",
    );
    ok(left.footerInside, "the footer overflows its pane into the PDF side");
    strictEqual(right.footerText, null, "the PDF pane shows document statistics it does not own");

    // The PDF pane takes focus when the split is created. Clicking it again
    // is a no-op for the layout but keeps the check honest if that rule ever
    // changes: the markdown pane's footer must survive either way.
    await clickPaneBody(right);
    const refocused = leftFirst(await readPanes());
    ok(refocused[0].footerText, "focusing the PDF pane removed the markdown pane's footer");
    strictEqual(refocused[1].footerText, null, "the focused PDF pane grew a footer");
  });

  it("gives each markdown pane the counts of its own document", async function () {
    const { solo, panes } = await splitWithPdfLink();
    const leftText = solo.footerText;

    // Focus the PDF pane, then open the second note into it from the sidebar:
    // an open lands in the pane it was started from, which is the rule the
    // footer should follow too.
    await clickPaneBody(panes[1]);
    await openFromSidebar("footer-right.md");

    const [left, right] = leftFirst(await readPanes());
    ok(left.footerInside && right.footerInside, "a footer escaped its pane bounds");
    strictEqual(left.footerText, leftText, "the first pane's counts changed under it");
    ok(
      right.footerText && right.footerText !== leftText,
      "the second pane's footer should describe its own document, not the first pane's",
    );
  });
});
