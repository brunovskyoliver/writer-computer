import { describe, expect, test, vi } from "vite-plus/test";
import { parseWikiLink, resolveWikiLink, resolveWikiPdf } from "../src/lib/wiki-links";

/**
 * PDF targets resolve on a different path from notes (T024, research.md R3).
 * The whole quote-link round trip rests on two facts this file pins down: a
 * `.pdf` target keeps its extension all the way through, and it is never
 * resolved by the Markdown-only stem lookup.
 */

const ROOT = "/vault";

function existing(...paths: string[]) {
  const set = new Set(paths);
  return (path: string) => Promise.resolve(set.has(path));
}

const noFind = () => Promise.resolve(null);

describe("parseWikiLink with a PDF target", () => {
  test("keeps the .pdf extension while stripping .md from notes", () => {
    expect(parseWikiLink("papers/apology.pdf").path).toBe("papers/apology.pdf");
    expect(parseWikiLink("notes/reading.md").path).toBe("notes/reading");
  });

  test("splits the anchor fragment off the path", () => {
    const link = parseWikiLink("papers/apology.pdf#page=12&text=the%20unexamined|apology.pdf p.12");
    expect(link.path).toBe("papers/apology.pdf");
    expect(link.fragment).toBe("page=12&text=the%20unexamined");
    expect(link.alias).toBe("apology.pdf p.12");
  });
});

describe("resolveWikiPdf", () => {
  test("resolves a workspace-relative path with its extension intact", async () => {
    const path = await resolveWikiPdf(
      "papers/apology.pdf",
      ROOT,
      "/vault/notes/reading.md",
      existing("/vault/papers/apology.pdf"),
      noFind,
    );
    expect(path).toBe("/vault/papers/apology.pdf");
  });

  test("probes beside the note before falling back to a basename search", async () => {
    const findFileByName = vi.fn(() => Promise.resolve("/vault/elsewhere/apology.pdf"));
    const beside = await resolveWikiPdf(
      "apology.pdf",
      ROOT,
      "/vault/notes/reading.md",
      existing("/vault/notes/apology.pdf"),
      findFileByName,
    );
    expect(beside).toBe("/vault/notes/apology.pdf");
    expect(findFileByName).not.toHaveBeenCalled();

    const searched = await resolveWikiPdf(
      "apology.pdf",
      ROOT,
      "/vault/notes/reading.md",
      existing(),
      findFileByName,
    );
    expect(searched).toBe("/vault/elsewhere/apology.pdf");
  });

  test("returns null for a PDF that is not there, so a stale link opens nothing", async () => {
    const path = await resolveWikiPdf(
      "papers/gone.pdf",
      ROOT,
      "/vault/notes/reading.md",
      existing("/vault/papers/apology.pdf"),
      noFind,
    );
    expect(path).toBeNull();
  });

  test("normalizes backslashes and a leading slash like every other target", async () => {
    const path = await resolveWikiPdf(
      "/papers\\apology.pdf",
      ROOT,
      null,
      existing("/vault/papers/apology.pdf"),
      noFind,
    );
    expect(path).toBe("/vault/papers/apology.pdf");
  });
});

describe("the Markdown path cannot find a PDF", () => {
  test("does not resolve a bare PDF stem to a note", async () => {
    // The fuzzy index is Markdown-only, so a stem lookup for a PDF either
    // finds nothing or — the case that matters — finds a same-named note.
    const fuzzySearch = vi.fn(() =>
      Promise.resolve([
        {
          path: "/vault/notes/apology.md",
          filename: "apology.md",
          relative_path: "notes/apology.md",
        },
      ]),
    );
    const result = await resolveWikiLink(
      "apology.pdf",
      ROOT,
      fuzzySearch as never,
      existing("/vault/papers/apology.pdf"),
      "/vault/notes/reading.md",
    );
    expect(result).toEqual({ kind: "unresolved" });
  });
});
