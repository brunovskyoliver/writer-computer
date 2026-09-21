import { ok, strictEqual } from "node:assert/strict";

// PDF pinch zoom (SPECs/pdf-pinch-zoom-spec.md), non-destructive opens
// (SPECs/open-without-replace-spec.md), and the indexed fuzzy file search
// (SPECs/workspace-index-fuzzy-search-spec.md).
//
// Runs against the seeded workspace at /tmp/writer-e2e-ws (restored via
// recent_workspaces.json):
//
//   notes.md                       markdown, H1 "notes"
//   report.pdf                     one-pager, real PDF
//   meetings/meeting-notes.md      fuzzy target for "mtns"
//   QuarterlyReport.md             fuzzy target for "qr" / palette-open target
//   roadmap.excalidraw.svg         drawing — must be indexed and findable
//
// WKWebView delivers a trackpad pinch as gesturestart/change/end events with
// a cumulative `scale` — it does NOT synthesize ctrl+wheel like Chrome. The
// spec drives both channels: gesture events for the trackpad path and
// WheelEvent ctrlKey for the Ctrl/Cmd-scroll path.

async function pressKey(init) {
  await browser.execute((opts) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { ...opts, bubbles: true, cancelable: true }),
    );
  }, init);
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

/** The PDF pane's scroll container — the element the wheel listener lives on. */
async function pdfScroller() {
  return browser.execute(() => {
    const page = document.querySelector("[data-pdf-page]");
    return page ? page.parentElement.parentElement : null;
  });
}

/** Dispatch a wheel event on the PDF scroll container; returns defaultPrevented. */
async function wheelOnPdf(init) {
  return browser.execute((opts) => {
    const page = document.querySelector("[data-pdf-page]");
    if (!page) return null;
    const scroller = page.parentElement.parentElement;
    const rect = scroller.getBoundingClientRect();
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      ...opts,
    });
    scroller.dispatchEvent(event);
    return event.defaultPrevented;
  }, init);
}

/** The toolbar's zoom readout — the button whose label is a percentage inside
 *  the pane that hosts the rendered PDF. XPath `contains(text(), "%")` misses
 *  it: React renders `{n}%` as two text nodes, and `text()` only sees the
 *  first. Query in JS instead. */
async function zoomLabel() {
  return browser.execute(() => {
    const page = document.querySelector("[data-pdf-page]");
    if (!page) return null;
    const pane = page.closest("[data-pane-id]") ?? page.parentElement.parentElement.parentElement;
    const btn = Array.from(pane.querySelectorAll("button")).find((b) =>
      /^\d+%$/.test(b.textContent.trim()),
    );
    return btn ? btn.textContent.trim() : null;
  });
}

async function waitForZoom(text) {
  await browser.waitUntil(async () => (await zoomLabel()) === text, {
    timeout: 10_000,
    timeoutMsg: `zoom label never reached ${text}`,
  });
}

/** Content transform the pinch preview applies to the PDF pages wrapper. */
async function pdfContentTransform() {
  return browser.execute(() => {
    const page = document.querySelector("[data-pdf-page]");
    if (!page) return null;
    return page.parentElement.style.transform || "";
  });
}

/** Labels of every tab strip entry, in DOM order — the × close glyph is part
 *  of the button's textContent, so strip it. */
async function tabLabels() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("[data-pane-strip] [data-tab-id]")).map((t) =>
      t.textContent.replace(/×\s*$/, "").trim(),
    ),
  );
}

async function clickTreeFile(path) {
  const node = await $(`[data-tree-path="${path}"]`);
  await node.waitForExist({ timeout: 10_000 });
  await node.click();
}

async function openPalette(query) {
  await pressKey({ key: "p", metaKey: true });
  const input = await $('[cmdk-input][placeholder="Search..."]');
  await input.waitForExist({ timeout: 5_000 });
  if (query) await input.addValue(query);
  return input;
}

async function closePalette() {
  await pressKey({ key: "Escape" });
  await browser.pause(150);
}

async function itemWithText(text) {
  return $(`//*[@cmdk-item and contains(., "${text}")]`);
}

describe("pdf pinch zoom + open semantics + fuzzy index", function () {
  let root = null;

  before(async function () {
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 20_000 });
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 15_000,
    });
    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root restored");
  });

  it("opens the PDF in a new tab and keeps the note tab", async function () {
    await clickTreeFile(`${root}/notes.md`);
    await browser.waitUntil(async () => (await tabLabels()).includes("notes"), {
      timeout: 10_000,
      timeoutMsg: "notes tab never opened",
    });
    const before = await tabLabels();

    await clickTreeFile(`${root}/report.pdf`);
    await $("[data-pdf-page]").waitForExist({ timeout: 15_000 });
    await waitForZoom("100%");

    const after = await tabLabels();
    ok(after.includes("notes"), `note tab was replaced: ${after}`);
    strictEqual(after.length, before.length + 1, "PDF did not open as a new tab");
  });

  it("ctrl+wheel zooms the PDF while the webview stays put", async function () {
    const innerWidth = await browser.execute(() => window.innerWidth);

    const prevented = await wheelOnPdf({ ctrlKey: true, deltaY: -80, deltaMode: 0 });
    strictEqual(prevented, true, "ctrl+wheel was not captured by the PDF pane");
    await wheelOnPdf({ ctrlKey: true, deltaY: -80, deltaMode: 0 });

    // The preview transform is applied synchronously during the gesture…
    ok((await pdfContentTransform()).startsWith("scale("), "pinch produced no preview transform");
    // …and commits to the toolbar readout once the gesture settles. The null
    // guard keeps a missing readout from trivially satisfying !== "100%".
    await browser.waitUntil(
      async () => {
        const label = await zoomLabel();
        return label !== null && label !== "100%";
      },
      { timeout: 10_000, timeoutMsg: "pinch never committed a new zoom" },
    );

    // Whole-webview magnification would shrink the CSS viewport — the leak
    // that made the neighbouring markdown pane appear to zoom.
    strictEqual(
      await browser.execute(() => window.innerWidth),
      innerWidth,
      "the gesture leaked into webview magnification",
    );
    ok((await tabLabels()).includes("notes"), "note tab disappeared during zoom");
  });

  it("leaves plain wheel scrolling alone", async function () {
    const prevented = await wheelOnPdf({ deltaY: 120, deltaMode: 0 });
    strictEqual(prevented, false, "an unmodified wheel event was swallowed");
  });

  it("zooms on WebKit gesture events — the real trackpad channel", async function () {
    // WKWebView reports a trackpad pinch as gesturestart/change/end carrying a
    // cumulative `scale`, not as ctrl+wheel. A synthetic Event has no `scale`
    // field, so assign it — the handler reads it off the event object.
    //
    // The wheel test above left the scale high; the toolbar's % button resets
    // to 100% so this assertion can't pass vacuously on a stale value.
    const innerWidthBefore = await browser.execute(() => window.innerWidth);
    await browser.execute(() => {
      const page = document.querySelector("[data-pdf-page]");
      const pane = page.closest("[data-pane-id]") ?? page.parentElement.parentElement.parentElement;
      Array.from(pane.querySelectorAll("button"))
        .find((b) => /^\d+%$/.test(b.textContent.trim()))
        ?.click();
    });
    await waitForZoom("100%");

    const prevented = await browser.execute(() => {
      const page = document.querySelector("[data-pdf-page]");
      const scroller = page.parentElement.parentElement;
      const rect = scroller.getBoundingClientRect();
      const dispatch = (type, scale) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        if (scale !== undefined) {
          e.scale = scale;
          e.clientX = rect.left + rect.width / 2;
          e.clientY = rect.top + rect.height / 2;
        }
        scroller.dispatchEvent(e);
        return e.defaultPrevented;
      };
      return [dispatch("gesturestart", 1), dispatch("gesturechange", 2), dispatch("gestureend", 2)];
    });
    ok(prevented.every(Boolean), `gesture events not suppressed: ${prevented}`);
    await waitForZoom("200%");
    strictEqual(
      await browser.execute(() => window.innerWidth),
      innerWidthBefore,
      "webview magnified",
    );
  });

  it("clamps pinch zoom between 40% and 400%", async function () {
    for (let i = 0; i < 4; i++) {
      await wheelOnPdf({ ctrlKey: true, deltaY: -120, deltaMode: 0 });
    }
    await waitForZoom("400%");
    for (let i = 0; i < 6; i++) {
      await wheelOnPdf({ ctrlKey: true, deltaY: 120, deltaMode: 0 });
    }
    await waitForZoom("40%");
  });

  it("finds files by subsequence — markdown, drawings, and PDFs", async function () {
    let input = await openPalette("mtns");
    await (await itemWithText("meeting-notes.md")).waitForExist({ timeout: 10_000 });
    await closePalette();

    input = await openPalette("rdmp");
    await (await itemWithText("roadmap.excalidraw.svg")).waitForExist({ timeout: 10_000 });
    await closePalette();

    input = await openPalette("report");
    await (await itemWithText("report.pdf")).waitForExist({ timeout: 10_000 });
    await closePalette();
  });

  it("opens a palette result as a new tab without replacing the note", async function () {
    const before = await tabLabels();
    // Sessions restore across runs: if the target was left open by an earlier
    // run, openFile focuses it — same count, still correct. Otherwise +1.
    const alreadyOpen = before.includes("Quarterly Report");
    await openPalette("quarter");
    const item = await itemWithText("QuarterlyReport.md");
    await item.waitForExist({ timeout: 10_000 });
    await item.click();
    await closePalette();

    const after = await tabLabels();
    ok(after.includes("notes"), `note tab was replaced: ${after}`);
    ok(after.includes("Quarterly Report"), `palette result never opened: ${after}`);
    strictEqual(
      after.length,
      before.length + (alreadyOpen ? 0 : 1),
      `unexpected tab count: ${before} → ${after}`,
    );
  });

  it("reopening an open file focuses its tab instead of duplicating it", async function () {
    const before = await tabLabels();
    await clickTreeFile(`${root}/notes.md`);
    await browser.pause(300);
    const after = await tabLabels();
    strictEqual(after.length, before.length, "sidebar click duplicated an open tab");
  });

  it("indexes files created after startup", async function () {
    const path = `${root}/fuzzy-probe-zz.md`;
    const wrote = await invoke("write_file", { path, content: "# fuzzy probe\n" });
    ok(wrote.ok, `seed write failed: ${wrote.error}`);

    await openPalette("fzpz");
    await browser.waitUntil(async () => (await itemWithText("fuzzy-probe-zz.md")).isExisting(), {
      timeout: 10_000,
      timeoutMsg: "watcher never indexed the new file",
    });
    await closePalette();
    await invoke("delete_entry", { path });
  });
});
