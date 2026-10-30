import { describe, expect, test } from "vite-plus/test";
import { applyTextEdits, linkEditsForMove, type PathMove } from "../src/lib/rewrite-links";

const move = (oldPath: string, newPath: string, extra: Partial<PathMove> = {}): PathMove => ({
  oldPath,
  newPath,
  root: "/v",
  isDir: false,
  oldNameIsFree: true,
  newNameIsFree: true,
  ...extra,
});
const rewrite = (text: string, note: string, m: PathMove) =>
  applyTextEdits(text, linkEditsForMove(text, note, m));

describe("linkEditsForMove", () => {
  test("a moved note keeps its relative image links, in the SDU angle-bracket form", () => {
    const text = "![](<Lesson-assets/a b.jpg>) and [x](other.md#h)";
    expect(rewrite(text, "/v/math/Lesson.md", move("/v/Lesson.md", "/v/math/Lesson.md"))).toBe(
      "![](<../Lesson-assets/a b.jpg>) and [x](../other.md#h)",
    );
  });

  test("another note's relative link follows the target, keeping its fragment", () => {
    expect(rewrite("[a](sub/t.md#Top)", "/v/n.md", move("/v/sub/t.md", "/v/new/t2.md"))).toBe(
      "[a](new/t2.md#Top)",
    );
  });

  test("percent-encoded destinations are matched and links in a moved folder stay intact", () => {
    expect(rewrite("[a](my%20t.md)", "/v/n.md", move("/v/my t.md", "/v/d/my t.md"))).toBe(
      "[a](<d/my t.md>)",
    );
    expect(rewrite("[a](b.md)", "/v/new/a.md", move("/v/old", "/v/new"))).toBe("[a](b.md)");
  });

  test("a folder move rewrites links into it from outside", () => {
    expect(rewrite("[a](old/b.md) [[old/b]]", "/v/n.md", move("/v/old", "/v/new"))).toBe(
      "[a](new/b.md) [[new/b]]",
    );
  });

  test("a folder rename leaves a bare link to a same-named note alone", () => {
    expect(rewrite("[[old]]", "/v/n.md", move("/v/old", "/v/new", { isDir: true }))).toBe(
      "[[old]]",
    );
  });

  test("decoded names stay one path on the next parse", () => {
    const moved = (name: string) => move(`/v/${name}`, `/v/s/${name}`);
    expect(rewrite("[x](C%23.md)", "/v/n.md", moved("C#.md"))).toBe("[x](s/C%23.md)");
    expect(rewrite("[x](What%3F.md)", "/v/n.md", moved("What?.md"))).toBe("[x](s/What%3F.md)");
    expect(rewrite("[x](a\\(1.md)", "/v/n.md", moved("a(1.md"))).toBe("[x](<s/a(1.md>)");
  });

  test("reference definitions follow, and a wiki token inside a destination stays put", () => {
    expect(rewrite("[a][1]\n\n[1]: s/a.md\n", "/v/n.md", move("/v/s/a.md", "/v/t/a.md"))).toBe(
      "[a][1]\n\n[1]: t/a.md\n",
    );
    expect(rewrite("[t](<s/[[s/a]].md>)", "/v/n.md", move("/v/s", "/v/t", { isDir: true }))).toBe(
      "[t](t/[[s/a]].md)",
    );
  });

  test("sibling notes dragged together keep their link through sequential moves", () => {
    const first = rewrite("[a](a.md)", "/v/src/b.md", move("/v/src/a.md", "/v/dest/a.md"));
    expect(first).toBe("[a](../dest/a.md)");
    expect(rewrite(first, "/v/dest/b.md", move("/v/src/b.md", "/v/dest/b.md"))).toBe("[a](a.md)");
  });

  test("wiki links keep alias, fragment and embed form", () => {
    const m = move("/v/Foo.md", "/v/Bar.md");
    expect(rewrite("[[Foo#H|al]] ![[foo]] [[Foo.md]] [[Food]]", "/v/n.md", m)).toBe(
      "[[Bar#H|al]] ![[Bar]] [[Bar.md]] [[Food]]",
    );
  });

  test("a bare link is unaffected by a move that keeps the name", () => {
    expect(rewrite("[[Foo]]", "/v/n.md", move("/v/Foo.md", "/v/d/Foo.md"))).toBe("[[Foo]]");
  });

  test("an ambiguous old name is left alone; a taken new name gets a path", () => {
    expect(
      rewrite("[[Foo]]", "/v/n.md", move("/v/Foo.md", "/v/Bar.md", { oldNameIsFree: false })),
    ).toBe("[[Foo]]");
    expect(
      rewrite("[[Foo]]", "/v/n.md", move("/v/Foo.md", "/v/d/Bar.md", { newNameIsFree: false })),
    ).toBe("[[d/Bar]]");
  });

  test("attachments keep their extension; path wiki links with a note extension too", () => {
    const m = move("/v/img/a.png", "/v/img/b.png");
    expect(rewrite("![[a.png]] ![[img/a.png]] ![[a]]", "/v/n.md", m)).toBe(
      "![[b.png]] ![[img/b.png]] ![[a]]",
    );
  });

  test("code, external URLs and same-document anchors are untouched", () => {
    const text = [
      "`[[Foo]]` [u](https://x.dev/Foo.md) [s](#Foo)",
      "",
      "```",
      "[[Foo]] [a](Foo.md)",
      "```",
    ].join("\n");
    expect(rewrite(text, "/v/n.md", move("/v/Foo.md", "/v/Bar.md"))).toBe(text);
  });

  test("an unrelated note yields no edits at all", () => {
    expect(linkEditsForMove("[a](b.md) [[C]]", "/v/n.md", move("/v/x.md", "/v/y.md"))).toEqual([]);
  });
});
