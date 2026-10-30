import type { CalendarEvent, CalendarNote } from "@/lib/tauri";

// ponytail: fixed folder name from the SDU convention; a setting when another vault needs one.
const NOTES_FOLDER = "Own notes";

/** "Course, (E26): Lessons - Room" -> "Course, (E26)". Course names may contain colons. */
export function courseName(summary: string): string | null {
  return summary.match(/^(.+?, \([^)]*\)):/)?.[1] ?? null;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function localDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTime(iso: string) {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function lessonsOn(events: CalendarEvent[], day: Date) {
  const today = localDate(day);
  return events
    .filter((event) => localDate(new Date(event.start)) === today)
    .sort((a, b) => a.start.localeCompare(b.start));
}

function yamlQuote(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/** The frontmatter keys match existing lesson notes, so Obsidian and Writer read the same files. */
export function lessonNoteContent(event: CalendarEvent) {
  const lines = [
    "---",
    `course: ${yamlQuote(event.summary)}`,
    `lesson-date: ${localDate(new Date(event.start))}`,
    `lesson-start: ${event.start}`,
    `lesson-end: ${event.end}`,
    `calendar-uid: ${yamlQuote(event.uid)}`,
    `calendar-occurrence: ${yamlQuote(event.occurrence_key)}`,
  ];
  if (event.location) lines.push(`location: ${yamlQuote(event.location)}`);
  return `${lines.join("\n")}\n---\n${event.description}`;
}

export function lessonNoteName(event: CalendarEvent) {
  const start = new Date(event.start);
  const title = event.summary.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Lesson";
  return `${title} (${localDate(start)} ${localTime(event.start).replace(":", ".")}).md`;
}

/** A sibling note of the same course decides, then a top-level folder named after the course. */
export function lessonFolder(
  event: CalendarEvent,
  root: string,
  notes: CalendarNote[],
  topLevelFolders: string[],
) {
  const course = courseName(event.summary);
  const sibling = course && notes.find((note) => note.course && courseName(note.course) === course);
  if (sibling) return sibling.path.slice(0, sibling.path.lastIndexOf("/"));
  const stem = (course ?? "").split(/[,(]/)[0].trim().toLowerCase();
  const match = stem && topLevelFolders.find((name) => name.toLowerCase() === stem);
  return match ? `${root}/${match}/${NOTES_FOLDER}` : `${root}/${NOTES_FOLDER}`;
}
