// Suspension correctness check (companion to perf-audit, not CI-gated).
// Opens enough tabs to push the first-opened document past the hidden-view
// budget (MAX_HIDDEN_VIEWS = 8), then reactivates it and asserts the body
// remounted with content, scroll position, and a working editor.

import { appendFileSync } from "node:fs";

const WS = "/private/tmp/writer-perf-ws";
const REPORT = "/tmp/writer-perf-report.jsonl";

function report(rec) {
  appendFileSync(REPORT, JSON.stringify(rec) + "\n");
  console.log(`[perf-suspend] ${JSON.stringify(rec)}`);
}

async function openTreeFile(path) {
  const sel = `[data-tree-path="${path}"]`;
  const row = await $(sel);
  await row.waitForExist({ timeout: 10_000 });
  await row.click();
}

// The visible tab-host's id — one is shown per pane.
function visibleTabHostId() {
  return browser.execute(() => {
    const host = [...document.querySelectorAll("[data-tab-host]")].find(
      (h) => h.offsetParent !== null,
    );
    return host?.getAttribute("data-tab-host") ?? null;
  });
}

function visibleEditorState() {
  return browser.execute(() => {
    const host = [...document.querySelectorAll("[data-tab-host]")].find(
      (h) => h.offsetParent !== null,
    );
    if (!host) return { host: false };
    const scroller = host.querySelector(".overflow-y-auto");
    const content = host.querySelector(".cm-content");
    return {
      host: true,
      docLen: content ? content.textContent.length : 0,
      scrollTop: scroller ? scroller.scrollTop : -1,
      scrollHeight: scroller ? scroller.scrollHeight : -1,
    };
  });
}

describe("suspended tab remount", function () {
  this.timeout(240_000);

  before(async function () {
    const sidebar = await $('button[aria-label="Hide sidebar"]');
    await sidebar.waitForExist({ timeout: 30_000 });
    await browser.pause(2000);
  });

  it("remounts a suspended large-doc tab with scroll and content intact", async function () {
    // Open the large document first and scroll deep into it.
    await openTreeFile(`${WS}/large-01.md`);
    await browser.waitUntil(async () => (await visibleEditorState()).docLen > 500, {
      timeout: 60_000,
      timeoutMsg: "large doc never mounted",
    });
    const firstTabId = await visibleTabHostId();
    await browser.executeAsync((done) => {
      const host = [...document.querySelectorAll("[data-tab-host]")].find(
        (h) => h.offsetParent !== null,
      );
      const scroller = host?.querySelector(".overflow-y-auto");
      if (!scroller) return done(-1);
      scroller.scrollTop = Math.floor(scroller.scrollHeight / 2);
      // The scroll listener publishes into viewStateByTab synchronously.
      setTimeout(() => done(), 300);
    });
    const before = await visibleEditorState();
    report({ label: "suspend-before", firstTabId, ...before });
    if (!(before.scrollTop > 1000)) throw new Error("large doc did not scroll");

    // Open 10 more files — first tab's hidden rank falls below the
    // 8-view budget, so its body suspends (unmounts) while hidden.
    for (let i = 1; i <= 10; i++) {
      await openTreeFile(`${WS}/note-${String(i).padStart(2, "0")}.md`);
    }
    await browser.pause(500);

    // Its host should now be empty (suspended = unmounted body).
    const suspended = await browser.execute((tabId) => {
      const host = document.querySelector(`[data-tab-host="${tabId}"]`);
      return host ? { present: true, childCount: host.childElementCount } : { present: false };
    }, firstTabId);
    report({ label: "suspend-evicted", ...suspended });

    // Reactivate the first tab — click its tab-strip button.
    const tabButton = await $(`[data-tab-id="${firstTabId}"] [role="button"]`);
    await tabButton.waitForExist({ timeout: 10_000 });
    const t0 = Date.now();
    await tabButton.click();
    await browser.waitUntil(async () => (await visibleEditorState()).docLen > 500, {
      timeout: 30_000,
      timeoutMsg: "suspended tab never remounted",
    });
    report({ label: "suspend-remount-ms", ms: Date.now() - t0 });

    // Let the rAF scroll restore land, then compare.
    await browser.pause(600);
    const after = await visibleEditorState();
    report({ label: "suspend-after", ...after });
    if (Math.abs(after.scrollTop - before.scrollTop) > 50) {
      throw new Error(`scroll not restored: before=${before.scrollTop} after=${after.scrollTop}`);
    }

    // The remounted editor is live — focus it through the CM view handle
    // (dom.cmView is the same seam EditorView.findFromDOM uses). Assert on
    // document.activeElement: `.cm-focused` requires document.hasFocus(),
    // which is false under the driver since the window lacks OS focus.
    await browser.execute(() => {
      const host = [...document.querySelectorAll("[data-tab-host]")].find(
        (h) => h.offsetParent !== null,
      );
      host?.querySelector(".cm-editor")?.cmView?.focus();
    });
    await browser.pause(300);
    const focused = await browser.execute(() => {
      const host = [...document.querySelectorAll("[data-tab-host]")].find(
        (h) => h.offsetParent !== null,
      );
      const active = document.activeElement;
      return {
        focusedInHost: !!host && !!active && host.contains(active),
        active: active?.className ?? null,
      };
    });
    report({ label: "suspend-after-focus", ...focused });
    if (!focused.focusedInHost) {
      throw new Error("remounted editor does not take focus");
    }
  });
});
