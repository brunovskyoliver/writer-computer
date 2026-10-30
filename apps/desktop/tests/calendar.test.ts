import { expect, test } from "vite-plus/test";
import {
  courseName,
  lessonFolder,
  lessonKind,
  lessonNoteContent,
  lessonTopic,
  lessonsInProgress,
  planLessonMoves,
  lessonsOn,
} from "../src/lib/calendar";
import type { CalendarEvent } from "../src/lib/tauri";

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  uid: "u",
  occurrence_key: "u::2026-10-07T12:30:00.000Z",
  summary: "Semester project: Software, (E26): Lessons - Room 1",
  description: "Body",
  location: null,
  start: "2026-10-07T12:30:00.000Z",
  end: "2026-10-07T14:15:00.000Z",
  ...over,
});

test("course names keep inner colons and drop lesson type and room", () => {
  expect(courseName(event().summary)).toBe("Semester project: Software, (E26)");
  expect(courseName("Math, (E26): MATH1 - Lessons - Room")).toBe("Math, (E26)");
  expect(courseName("Party 30. oktober 2026: Parties - Hall")).toBeNull();
});

test("notes keep the plugin's frontmatter keys and quote feed text", () => {
  const content = lessonNoteContent(event({ summary: 'A: "B"' }));
  expect(content).toContain('course: "A: \\"B\\""');
  expect(content).toContain('calendar-occurrence: "u::2026-10-07T12:30:00.000Z"');
  expect(content.endsWith("---\nBody")).toBe(true);
});

test("today's lessons are filtered by local day and sorted", () => {
  const late = event({ start: "2026-10-07T15:00:00.000Z" });
  const other = event({ start: "2026-10-09T15:00:00.000Z" });
  expect(lessonsOn([late, other, event()], new Date("2026-10-07T13:00:00.000Z"))).toEqual([
    event(),
    late,
  ]);
});

const MATH = "Mathematics for Science 1, (E26): MATH1 - Lessons - Room 104";
const note = (path: string, date = "2026-10-05", course = MATH) => ({
  path,
  course,
  content: `---\ncourse: "${course}"\nlesson-date: ${date}\nlesson-start: ${date}T08:15:00.000Z\n---\nRoom Teacher\\r\n\nEigenvalues and eigenvectors. Homework: watch\n`,
});

test("kind and topic come from the summary and description", () => {
  expect(lessonKind(MATH)).toBe("Lesson");
  expect(lessonKind("OOP, (E26): Lecture - Room 9")).toBe("Lecture");
  expect(lessonKind("Project, (E26): Exam, oral - Room")).toBe("Exam, oral");
  expect(lessonTopic("Room Teacher\\r\n\nEigenvalues and eigenvectors. Homework: x")).toBe(
    "Eigenvalues and eigenvectors",
  );
  expect(lessonTopic("Room Teacher")).toBe("");
  expect(lessonTopic(`Room\n\nIn this module we ${"word ".repeat(30)}`).length).toBeLessThanOrEqual(
    60,
  );
});

test("misplaced notes don't vote, and a course with no folder gets its own", () => {
  const stray = note("/v/Own notes/a.md");
  const placed = note("/v/Math stuff/Own notes/b.md");
  expect(lessonFolder(MATH, "/v", [stray, placed], [])).toBe("/v/Math stuff/Own notes");
  expect(lessonFolder(MATH, "/v", [stray], ["mathematics for science 1"])).toBe(
    "/v/mathematics for science 1/Own notes",
  );
  expect(lessonFolder(MATH, "/v", [stray], [])).toBe("/v/Mathematics for Science 1/Own notes");
  expect(lessonFolder("Party: Hall", "/v", [], [])).toBe("/v/Own notes");
});

test("plans sort generated notes, leave renamed ones, and settle after one pass", () => {
  const generated = "Mathematics for Science 1, (E26) MATH1 - Lessons - Room 104";
  const folders = ["Mathematics for Science 1"];
  const files = [
    note(`/v/Own notes/${generated} (2026-10-05).md`),
    note(`/v/Mathematics for Science 1/Own notes/${generated} 1.md`, "2026-09-07"),
    note("/v/Mathematics for Science 1/Own notes/Lecture 1 Functions.md", "2026-09-01"),
    note("/v/Own notes/My own name.md", "2026-09-02"),
  ];
  const moves = planLessonMoves(files, "/v", folders, new Set(files.map((file) => file.path)));
  const dir = "/v/Mathematics for Science 1/Own notes";
  expect(moves.map((move) => move.to)).toEqual([
    `${dir}/2026-10-05 Lesson - Eigenvalues and eigenvectors.md`,
    `${dir}/2026-09-07 Lesson - Eigenvalues and eigenvectors.md`,
    `${dir}/My own name.md`,
  ]);
  const after = files.map((file) => {
    const move = moves.find((candidate) => candidate.from === file.path);
    return { ...file, path: move?.to ?? file.path };
  });
  expect(planLessonMoves(after, "/v", folders, new Set(after.map((file) => file.path)))).toEqual(
    [],
  );
});

test("same-day lessons get the start time, and foreign notes are ignored", () => {
  const a = note("/v/Own notes/Mathematics for Science 1, (E26) x.md");
  const b = note("/v/Own notes/Mathematics for Science 1, (E26) y.md");
  const paths = new Set([a.path, b.path]);
  const moves = planLessonMoves(
    [a, b, { path: "/v/x.md", course: null, content: "" }],
    "/v",
    [],
    paths,
  );
  expect(moves).toHaveLength(2);
  expect(moves[1].to).toMatch(/Eigenvectors|eigenvectors \d\d\.\d\d\.md$/);
});

test("only running lessons of a real course get an automatic note", () => {
  const now = new Date("2026-10-07T13:00:00.000Z");
  const running = event();
  const finished = event({ end: "2026-10-07T13:00:00.000Z", start: "2026-10-07T12:00:00.000Z" });
  const party = event({ summary: "Party: Hall" });
  expect(lessonsInProgress([running, finished, party], now)).toEqual([running]);
});
