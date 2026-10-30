import type { CalendarEvent } from "@/lib/tauri";

// ponytail: fixed folder name from the SDU convention; a setting when another vault needs one.
const NOTES_FOLDER = "Own notes";
const MAX_TOPIC_LENGTH = 60;

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

/** Lessons running now. Events with no recognizable course, like parties, get no note. */
export function lessonsInProgress(events: CalendarEvent[], now: Date) {
  return events.filter(
    (event) =>
      courseName(event.summary) !== null &&
      new Date(event.start) <= now &&
      now < new Date(event.end),
  );
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

function safeName(text: string) {
  return text
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "…: MATH1-SC-B-E26 - Lessons - Room" -> "Lesson"; the type sits just before the room. */
export function lessonKind(summary: string) {
  const rest = summary.slice(summary.indexOf("):") + 2).trim();
  const parts = rest.split(" - ");
  const kind = (parts.length >= 2 ? parts[parts.length - 2] : parts[0]).trim();
  return safeName(kind.replace(/^Lessons$/i, "Lesson")) || "Lesson";
}

/** The first sentence after the room-and-teacher line, cut at a word boundary. */
export function lessonTopic(description: string) {
  const paragraphs = description
    .replace(/\\r|\r/g, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const sentence = (paragraphs[1] ?? "").split(/\.\s|\.$|Homework|\n/)[0];
  const topic = safeName(sentence.replace(/^In this module we\s+/i, ""));
  if (topic.length <= MAX_TOPIC_LENGTH) return topic;
  const cut = topic.slice(0, MAX_TOPIC_LENGTH);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "");
}

export function lessonNoteName(date: string, kind: string, topic: string) {
  return `${date} ${kind}${topic ? ` - ${topic}` : ""}.md`;
}

export interface CourseNote {
  path: string;
  course: string | null;
}

/**
 * The course's folder: where most of its notes already sit inside a top-level
 * folder, then a top-level folder with its name, then a new one. Notes in the
 * root `Own notes` don't vote, or one misplaced note would pull the rest along.
 * Events with no recognizable course go to the root `Own notes`.
 */
export function lessonFolder(
  summary: string,
  root: string,
  notes: CourseNote[],
  topLevelFolders: string[],
) {
  const course = courseName(summary);
  if (!course) return `${root}/${NOTES_FOLDER}`;
  const votes = new Map<string, number>();
  for (const note of notes) {
    if (!note.course || courseName(note.course) !== course) continue;
    const folder = note.path.slice(0, note.path.lastIndexOf("/"));
    const inCourseFolder = folder.startsWith(`${root}/`) && folder !== `${root}/${NOTES_FOLDER}`;
    if (inCourseFolder) votes.set(folder, (votes.get(folder) ?? 0) + 1);
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) return best;
  const stem = safeName(course.split(/[,(]/)[0]);
  const match = topLevelFolders.find((name) => name.toLowerCase() === stem.toLowerCase());
  return `${root}/${match ?? stem}/${NOTES_FOLDER}`;
}

export interface LessonFile extends CourseNote {
  content: string;
}

export interface LessonMove {
  from: string;
  to: string;
}

function frontmatterValue(content: string, key: string) {
  const value = content.match(new RegExp(`^${key}: *(.*)$`, "m"))?.[1].trim();
  return value?.replace(/^"|"$/g, "") ?? null;
}

/**
 * Moves that put calendar notes in their course folder under the standard name.
 * A note you renamed keeps its name, and one anywhere under the course's
 * top-level folder stays put, so this is safe to repeat.
 */
export function planLessonMoves(
  files: LessonFile[],
  root: string,
  topLevelFolders: string[],
  existingPaths: ReadonlySet<string>,
): LessonMove[] {
  const moves: LessonMove[] = [];
  const taken = new Set(existingPaths);
  for (const file of files) {
    const course = file.course && courseName(file.course);
    if (!file.course || !course) continue;
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const folder = file.path.slice(0, -name.length - 1);
    const target = lessonFolder(file.course, root, files, topLevelFolders);
    const topLevel = (path: string) => path.slice(root.length + 1).split("/")[0];
    const placed = folder !== `${root}/${NOTES_FOLDER}` && topLevel(folder) === topLevel(target);
    const generated = name.startsWith(safeName(course));
    if (placed && !generated) continue;

    const date = frontmatterValue(file.content, "lesson-date");
    const start = frontmatterValue(file.content, "lesson-start");
    if (!date || !start) continue;
    const body = file.content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    const newName = generated
      ? lessonNoteName(date, lessonKind(file.course), lessonTopic(body))
      : name;
    const newFolder = placed ? folder : target;
    let to = `${newFolder}/${newName}`;
    // Two lessons of one course on one day stay apart by start time.
    if (to !== file.path && taken.has(to)) {
      to = `${to.slice(0, -3)} ${localTime(start).replace(":", ".")}.md`;
    }
    if (to === file.path || taken.has(to)) continue;
    taken.add(to);
    moves.push({ from: file.path, to });
  }
  return moves;
}
