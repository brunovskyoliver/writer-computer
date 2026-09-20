import { ok, strictEqual } from "node:assert/strict";

// Global content search (SPECs/global-content-search). Runs against the
// seeded fixture at /tmp/search-fixture via recent_workspaces.json:
//
//   notes.md      "The ferry departs at dawn." (line 2)
//   docs/plan.txt "The ferry tickets cost 40." (name contains "plan", content does not)
//   report.pdf    generated one-pager with "ferry" on page 1
//   ignored.md    gitignored, contains "ferry"/"never"
//   .hidden.md    hidden, contains "ferry"/"hidden"
//   many.md       300 "match-N" lines → per-file cap → truncated
//
// Chords go through synthetic KeyboardEvents — the driver's native key path
// is flaky on WKWebView (same trick the other specs use for Cmd+P).

const PLACEHOLDER = "Search in files (including PDFs)...";

async function pressKey(init) {
  await browser.execute((opts) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { ...opts, bubbles: true, cancelable: true }),
    );
  }, init);
}

async function openContentSearch() {
  await pressKey({ key: "F", metaKey: true, shiftKey: true });
  const input = await $(`[cmdk-input][placeholder="${PLACEHOLDER}"]`);
  await input.waitForExist({ timeout: 5_000 });
  return input;
}

async function reopen() {
  await pressKey({ key: "Escape" });
  return openContentSearch();
}

async function itemWithText(text) {
  return $(`//*[@cmdk-item and contains(., "${text}")]`);
}

async function waitForDone() {
  // "Searching..." means the scan is still live; anything else is settled.
  await browser.waitUntil(
    async () => {
      const heading = await $("[cmdk-group-heading]");
      if (!(await heading.isExisting())) return true;
      return (await heading.getText()) !== "Searching...";
    },
    { timeout: 10_000, timeoutMsg: "scan never left the searching state" },
  );
}

describe("content search palette", function () {
  before(async function () {
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 15_000 });
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 15_000,
    });
  });

  it("opens on Cmd+Shift+F with the hint state", async function () {
    const input = await openContentSearch();
    strictEqual(await input.getValue(), "");
    const empty = await $("[cmdk-empty]");
    ok(
      (await empty.getText()).includes("search inside every file"),
      "empty query shows the hint, not a workspace listing",
    );
  });

  it("finds ferry in markdown, plain text, and the PDF — but not ignored or hidden files", async function () {
    const input = await openContentSearch();
    await input.addValue("ferry");
    await (await itemWithText("notes.md")).waitForExist({ timeout: 10_000 });
    await waitForDone();

    ok(await (await itemWithText("notes.md")).isExisting(), "notes.md matched");
    ok(await (await itemWithText("plan.txt")).isExisting(), "plan.txt matched");
    ok(await (await itemWithText("report.pdf")).isExisting(), "report.pdf matched");
    ok(await (await itemWithText("L2")).isExisting(), "text rows carry an L<n> location");
    ok(
      await (await itemWithText("Page 1")).isExisting(),
      "the PDF row carries a Page <n> location",
    );
    strictEqual(await (await itemWithText("ignored.md")).isExisting(), false);
    strictEqual(await (await itemWithText(".hidden.md")).isExisting(), false);
  });

  it("shows the context preview for the highlighted row", async function () {
    const preview = await $(".content-search-preview");
    await preview.waitForExist({ timeout: 5_000 });
    const text = await preview.getText();
    ok(text.includes("ferry"), "preview contains the matched line");
    ok(text.includes("Page 1") || /\bL\d/.test(text), "preview carries a location header");
  });

  it("returns no results for strings that only exist in excluded files", async function () {
    const input = await reopen();
    await input.addValue("never");
    const empty = await $("[cmdk-empty]");
    await browser.waitUntil(async () => (await empty.getText()) === "No results found.", {
      timeout: 10_000,
    });
  });

  it("does not match on filename alone", async function () {
    const input = await reopen();
    await input.addValue("plan");
    const empty = await $("[cmdk-empty]");
    await browser.waitUntil(async () => (await empty.getText()) === "No results found.", {
      timeout: 10_000,
    });
  });

  it("marks a result set past the per-file cap as truncated", async function () {
    const input = await reopen();
    await input.addValue("match-");
    await browser.waitUntil(
      async () => {
        const heading = await $("[cmdk-group-heading]");
        return (await heading.isExisting()) && (await heading.getText()).includes("truncated");
      },
      { timeout: 10_000, timeoutMsg: "truncation indicator never appeared" },
    );
  });

  it("treats an uppercase query as case-sensitive", async function () {
    const input = await reopen();
    await input.addValue("Ferry");
    const empty = await $("[cmdk-empty]");
    await browser.waitUntil(async () => (await empty.getText()) === "No results found.", {
      timeout: 10_000,
    });
  });

  it("activating a text result opens the file at the match", async function () {
    const input = await reopen();
    await input.addValue("ferry");
    const row = await itemWithText("notes.md");
    await row.waitForExist({ timeout: 10_000 });
    await row.click();
    await $(".cm-editor").waitForExist({ timeout: 10_000 });
    ok((await $(".cm-editor").getText()).includes("ferry"), "the note opened in the editor");
  });

  it("activating the PDF result opens the PDF pane on the page", async function () {
    const input = await reopen();
    await input.addValue("ferry");
    const row = await itemWithText("report.pdf");
    await row.waitForExist({ timeout: 10_000 });
    await row.click();
    await $('[data-pdf-page="1"]').waitForExist({ timeout: 15_000 });
  });
});
