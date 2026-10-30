import { expect, test } from "vite-plus/test";
import {
  courseName,
  lessonFolder,
  lessonNoteContent,
  lessonNoteName,
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

test("a sibling note's folder wins over a matching name, which wins over the default", () => {
  const math = event({ summary: "Math, (E26): Lessons - B" });
  const sibling = {
    path: "/v/M/Own notes/x.md",
    occurrence: "o",
    course: "Math, (E26): Lessons - A",
  };
  expect(lessonFolder(math, "/v", [sibling], ["Math"])).toBe("/v/M/Own notes");
  expect(lessonFolder(math, "/v", [], ["math"])).toBe("/v/math/Own notes");
  expect(lessonFolder(math, "/v", [], [])).toBe("/v/Own notes");
});

test("notes keep the plugin's frontmatter keys and quote feed text", () => {
  const content = lessonNoteContent(event({ summary: 'A: "B"' }));
  expect(content).toContain('course: "A: \\"B\\""');
  expect(content).toContain('calendar-occurrence: "u::2026-10-07T12:30:00.000Z"');
  expect(content.endsWith("---\nBody")).toBe(true);
});

test("note names contain no path or link characters", () => {
  expect(lessonNoteName(event({ summary: "a/b: c#d" }))).toMatch(
    /^ab cd \(2026-10-07 \d\d\.\d\d\)\.md$/,
  );
});

test("today's lessons are filtered by local day and sorted", () => {
  const late = event({ start: "2026-10-07T15:00:00.000Z" });
  const other = event({ start: "2026-10-09T15:00:00.000Z" });
  expect(lessonsOn([late, other, event()], new Date("2026-10-07T13:00:00.000Z"))).toEqual([
    event(),
    late,
  ]);
});
