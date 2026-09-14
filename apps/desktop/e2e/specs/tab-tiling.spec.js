import { ok, strictEqual } from "node:assert/strict";

// Tab tiling: the desktop gesture journey (see SPECs/tab-tiling-splits/).
//
// This is the one automated pass over the gestures that only exist in a real
// window: a sidebar file dragged to a pane edge, a tab moved and reordered
// between strips, the drop preview agreeing with the geometry that is actually
// committed, cancellation leaving nothing behind, focus routing, separator
// resizing, and the layout surviving a reload. The tree/drop maths itself is
// unit-covered (`tests/editor-layout.test.ts`, `tests/stores.test.ts`); what
// cannot be covered there is that a real pointer, over the real layout,
// produces those results.
//
// The drag coordinator is pointer-based with pointer capture
// (`hooks/use-editor-drag.ts`), not HTML5 drag-and-drop, so W3C `performActions`
// can drive a genuine gesture. Input state persists between `performActions`
// calls until `releaseActions`, which is what lets a test hold a drag mid-flight,
// read the preview, and only then release.
//
// Requires a restorable workspace; self-skips on the welcome screen so it stays
// safe inside the default `pnpm run test:e2e` sweep.
describe("tab tiling", function () {
  // A tab is labelled with the document's inferred title (its first H1), not its
  // filename, so each note's heading is its own stem. That keeps one string
  // usable as the path, the tab label, and the close button's `aria-label`.
  const NOTES = {
    "tiling-a": "# tiling-a\n\nFirst note.\n",
    "tiling-b": "# tiling-b\n\nSecond note.\n",
    "tiling-c": "# tiling-c\n\nThird note.\n",
  };

  let workspaceRestored = false;
  let root = null;
  const seeded = [];

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

  // The live layout as the DOM reports it: one entry per pane slot, in document
  // order, with the viewport rectangle the slot occupies and the tabs in its
  // own strip. Everything the assertions below need comes from here, so no test
  // reaches into the store.
  async function readLayout() {
    return browser.execute(() => {
      const round = (r) => ({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      return Array.from(document.querySelectorAll("[data-pane-id]")).map((pane) => ({
        id: pane.getAttribute("data-pane-id"),
        focused: pane.hasAttribute("data-pane-focused"),
        rect: round(pane.getBoundingClientRect()),
        tabs: Array.from(pane.querySelectorAll("[data-pane-strip] [data-tab-id]")).map((tab) => ({
          id: tab.getAttribute("data-tab-id"),
          label: tab.textContent.trim(),
          rect: round(tab.getBoundingClientRect()),
        })),
      }));
    });
  }

  // The drop overlay, or null while there is no candidate. `DropPreview` mounts
  // nothing without one, so "no element" is the assertion for "no candidate".
  async function readPreview() {
    return browser.execute(() => {
      const el = document.querySelector("[data-drop-preview]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        kind: el.getAttribute("data-drop-preview"),
        rect: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      };
    });
  }

  // Rectangles are compared with a small tolerance. The separator is not part
  // of the slack: a split's `ratio` is the first child's share of the space
  // *left after* the separator (`lib/editor-layout.ts`, `SEPARATOR_SIZE = 4`),
  // so `computeBounds` already subtracts it and the preview and the committed
  // pane are computed from the same arithmetic. What is left is sub-pixel
  // rounding — the preview is painted from the candidate's own numbers while
  // the committed pane is laid out by the resize library — which a few pixels
  // covers and no user could see.
  function rectsAgree(a, b, tolerance = 4) {
    return (
      Math.abs(a.x - b.x) <= tolerance &&
      Math.abs(a.y - b.y) <= tolerance &&
      Math.abs(a.width - b.width) <= tolerance &&
      Math.abs(a.height - b.height) <= tolerance
    );
  }

  const centreOf = (rect) => ({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  });

  // Press at `from` and walk to `to`, leaving the button down. The walk is
  // split into steps because the coordinator resolves one candidate per frame
  // from real `pointermove` events: a single jump would cross the 4 px
  // activation threshold and the whole layout in one event and never let the
  // geometry pass run over the intermediate positions.
  async function pressAndDragTo(from, to, steps = 8) {
    const moves = [];
    for (let i = 1; i <= steps; i++) {
      moves.push({
        type: "pointerMove",
        duration: 30,
        origin: "viewport",
        x: Math.round(from.x + ((to.x - from.x) * i) / steps),
        y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      });
      moves.push({ type: "pause", duration: 30 });
    }

    await browser.performActions([
      {
        type: "pointer",
        id: "finger",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x: from.x, y: from.y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 50 },
          ...moves,
        ],
      },
    ]);
  }

  async function releaseDrag() {
    await browser.performActions([
      {
        type: "pointer",
        id: "finger",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerUp", button: 0 }],
      },
    ]);
    await browser.releaseActions();
    await browser.pause(200);
  }

  // Escape while the button is still down. A separate `performActions` call is
  // enough: input state survives between calls until `releaseActions`, so the
  // pointer is still pressed when the key lands.
  async function cancelDragWithEscape() {
    await browser.performActions([
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: "\uE00C" },
          { type: "keyUp", value: "\uE00C" },
        ],
      },
    ]);
    await browser.pause(100);
    await releaseDrag();
  }

  async function openFromSidebar(stem) {
    const row = await $(`[data-tree-path="${root}/${stem}.md"]`);
    await row.waitForExist({ timeout: 20_000 });
    await row.click();
    await browser.pause(300);
  }

  // Press on a sidebar row and drag it to a viewport point, button still down.
  async function dragSidebarFileTo(stem, to) {
    const row = await $(`[data-tree-path="${root}/${stem}.md"]`);
    await row.waitForExist({ timeout: 20_000 });
    const { x, y } = await row.getLocation();
    const { width, height } = await row.getSize();
    await pressAndDragTo(centreOf({ x, y, width, height }), to);
  }

  // A point well inside a pane's right edge band (the bands are 30% per axis)
  // and clear of the strip floating over the top of the body.
  const rightEdgeOf = (rect) => ({
    x: Math.round(rect.x + rect.width * 0.9),
    y: Math.round(rect.y + rect.height * 0.6),
  });

  // The setup most of these tests share: `tiling-a` open alone, then `stem`
  // dragged from the sidebar onto the right edge of that one pane. Returns the
  // pane rectangle before the split and the two panes after it, left first.
  async function splitRightWith(stem) {
    await openFromSidebar("tiling-a");
    const solo = (await readLayout())[0].rect;
    await dragSidebarFileTo(stem, rightEdgeOf(solo));
    await releaseDrag();

    const panes = await readLayout();
    strictEqual(panes.length, 2, "setup: the edge drop should have produced two panes");
    return { solo, panes: [...panes].sort((a, b) => a.rect.x - b.rect.x) };
  }

  // Collapse back to a single pane by closing every tab, so each test starts
  // from a layout it fully controls rather than the previous test's leftovers.
  //
  // One `querySelectorAll` pass would not do it: the returned NodeList is
  // static, and React re-renders the strip after the first close, so every
  // later entry is a detached node whose `click()` does nothing. Close one tab
  // at a time, re-querying, and assert the collapse actually happened — a
  // silent no-op here would make every later test fail as if tiling were
  // broken.
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
    await browser.waitUntil(async () => (await readLayout()).length === 1, {
      timeout: 10_000,
      timeoutMsg: "could not collapse back to a single pane",
    });
  }

  before(async function () {
    workspaceRestored = await $('button[aria-label="Hide sidebar"]')
      .waitForExist({ timeout: 20_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the tiling notes into");

    for (const [stem, content] of Object.entries(NOTES)) {
      const path = `${root}/${stem}.md`;
      const wrote = await invoke("write_file", { path, content });
      ok(wrote.ok, `failed to seed ${path}: ${wrote.error}`);
      seeded.push(path);
    }

    // Reload rather than waiting on the workspace watcher: startup rebuilds the
    // file index from disk, so the seeded notes are in the sidebar
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
    // Leave the shared e2e profile as a single pane. The layout is persisted,
    // and `wdio.conf.js` globs every spec, so a split left behind here would
    // have the next spec measuring geometry inside a half-width pane.
    await resetToOnePane().catch(() => {});
    for (const path of seeded) await invoke("delete_entry", { path });
  });

  it("splits a pane by dragging a file from the sidebar onto its right edge", async function () {
    await openFromSidebar("tiling-a");

    const before = await readLayout();
    strictEqual(before.length, 1, "expected to start from a single pane");
    const target = before[0].rect;

    await dragSidebarFileTo("tiling-b", rightEdgeOf(target));

    const preview = await readPreview();
    ok(preview, "no drop preview while hovering a pane edge");
    strictEqual(preview.kind, "body", "an edge drop should preview a body region, not a strip gap");
    ok(
      preview.rect.width < target.width * 0.75,
      `an edge preview should cover part of the pane, got ${preview.rect.width} of ${target.width}`,
    );

    await releaseDrag();

    const after = await readLayout();
    strictEqual(after.length, 2, "the edge drop should have produced two panes");
    strictEqual(await readPreview(), null, "the preview should be gone after release");

    // The contract that matters: what the preview promised is what got built.
    const landed = after.find((pane) => pane.rect.x > target.x + target.width / 2);
    ok(landed, "no pane occupies the right half after a right-edge drop");
    ok(
      rectsAgree(preview.rect, landed.rect),
      `preview ${JSON.stringify(preview.rect)} != committed ${JSON.stringify(landed.rect)}`,
    );
    ok(
      landed.tabs.some((tab) => tab.label.includes("tiling-b")),
      `the dropped file should be the new pane's tab, got ${landed.tabs.map((t) => t.label).join(", ")}`,
    );
  });

  it("moves a tab to the other pane's strip and the source pane collapses", async function () {
    const {
      solo,
      panes: [left, right],
    } = await splitRightWith("tiling-b");
    strictEqual(right.tabs.length, 1, "the right pane should hold exactly the moved file");

    // Moving the right pane's only tab into the left strip empties the right
    // pane, so it collapses and the left pane takes the whole area back.
    const movedId = right.tabs[0].id;
    await pressAndDragTo(centreOf(right.tabs[0].rect), centreOf(left.tabs[0].rect));

    const preview = await readPreview();
    ok(preview, "no preview while holding a tab over another strip");
    strictEqual(preview.kind, "strip", "a strip hover should preview an insertion gap");

    await releaseDrag();

    const merged = await readLayout();
    strictEqual(merged.length, 1, "the emptied source pane should have collapsed");
    ok(
      rectsAgree(merged[0].rect, solo, 6),
      "the surviving pane should take back the whole editor area",
    );
    strictEqual(merged[0].tabs.length, 2, "both tabs should now live in one strip");
    ok(
      merged[0].tabs.some((tab) => tab.id === movedId),
      "the moved tab should keep its identity across the move",
    );
  });

  it("cancels a drag with Escape without touching the layout", async function () {
    await openFromSidebar("tiling-a");

    const before = await readLayout();
    const target = before[0].rect;

    await dragSidebarFileTo("tiling-c", rightEdgeOf(target));

    ok(await readPreview(), "setup: the drag should have a candidate before it is cancelled");

    await cancelDragWithEscape();

    strictEqual(await readPreview(), null, "the overlay must not survive cancellation");
    const after = await readLayout();
    strictEqual(after.length, before.length, "a cancelled drag must not change the pane count");
    strictEqual(
      after[0].tabs.length,
      before[0].tabs.length,
      "a cancelled drag must not open the dragged file",
    );
  });

  it("routes focus to the pane last clicked", async function () {
    const {
      panes: [left, right],
    } = await splitRightWith("tiling-b");

    for (const pane of [left, right]) {
      // Click the body, below the strip, the way a user picks up a caret.
      await browser.performActions([
        {
          type: "pointer",
          id: "finger",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: Math.round(pane.rect.x + pane.rect.width / 2),
              y: Math.round(pane.rect.y + pane.rect.height * 0.7),
            },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      await browser.pause(200);

      const now = await readLayout();
      const focused = now.filter((p) => p.focused);
      strictEqual(focused.length, 1, "exactly one pane may be focused at a time");
      strictEqual(focused[0].id, pane.id, "focus should follow the pane just clicked");
    }
  });

  it("resizes a split from the separator with the arrow keys", async function () {
    const {
      panes: [leftBefore],
    } = await splitRightWith("tiling-b");

    const separator = await $("[data-pane-separator]");
    await separator.waitForExist({ timeout: 10_000 });
    await browser.execute(() => document.querySelector("[data-pane-separator]").focus());
    for (let i = 0; i < 6; i++) await browser.keys(["ArrowLeft"]);
    await browser.pause(300);

    const after = await readLayout();
    const leftAfter = after[0].rect.x <= after[1].rect.x ? after[0] : after[1];
    ok(
      leftAfter.rect.width < leftBefore.rect.width,
      `ArrowLeft should shrink the left pane, ${leftBefore.rect.width} -> ${leftAfter.rect.width}`,
    );
  });

  it("restores the split layout, its ratio and its tabs after a reload", async function () {
    const { panes: before } = await splitRightWith("tiling-b");

    // Persistence is debounced at 500 ms; wait past it so the reload reads a
    // written session rather than racing the writer.
    await browser.pause(1200);

    // A webview reload, not a process relaunch: the session is read from disk
    // by the same startup path either way, which is the part under test. A true
    // quit-and-reopen stays a manual check (see quickstart.md).
    await browser.execute(() => window.location.reload());
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 20_000 });
    await browser.waitUntil(async () => (await readLayout()).length === 2, {
      timeout: 20_000,
      timeoutMsg: "the split layout did not come back after a reload",
    });

    const [beforeLeft, beforeRight] = before;
    const [afterLeft, afterRight] = (await readLayout()).sort((a, b) => a.rect.x - b.rect.x);

    ok(
      rectsAgree(beforeLeft.rect, afterLeft.rect, 8),
      `left pane geometry drifted: ${JSON.stringify(beforeLeft.rect)} -> ${JSON.stringify(afterLeft.rect)}`,
    );
    ok(
      rectsAgree(beforeRight.rect, afterRight.rect, 8),
      `right pane geometry drifted: ${JSON.stringify(beforeRight.rect)} -> ${JSON.stringify(afterRight.rect)}`,
    );
    strictEqual(
      afterLeft.tabs.map((t) => t.label).join("|"),
      beforeLeft.tabs.map((t) => t.label).join("|"),
      "the left strip's tabs should come back unchanged",
    );
    strictEqual(
      afterRight.tabs.map((t) => t.label).join("|"),
      beforeRight.tabs.map((t) => t.label).join("|"),
      "the right strip's tabs should come back unchanged",
    );

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/tab-tiling.png`);
    }
  });
});
