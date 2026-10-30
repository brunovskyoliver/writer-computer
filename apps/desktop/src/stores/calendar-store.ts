import { create } from "zustand";
import {
  lessonFolder,
  lessonKind,
  lessonsInProgress,
  lessonNoteContent,
  lessonNoteName,
  lessonTopic,
  localDate,
  localTime,
} from "@/lib/calendar";
import { getFileName } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import type { CalendarEvent } from "@/lib/tauri";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const REFRESH_MS = 60 * 60 * 1000;

interface CalendarState {
  root: string | null;
  fetchedAt: number;
  configured: boolean;
  events: CalendarEvent[];
  /** Last successful fetch of a configured feed. */
  syncedAt: number;
  /** Fetch now. `quiet` stays silent on success; failures always show. */
  refresh: (quiet?: boolean) => Promise<void>;
  /** The palette's refresh: no timer runs, so an idle window makes no requests. */
  refreshIfStale: () => void;
  /** Open the occurrence's note, creating it only if no note records it. */
  openLesson: (event: CalendarEvent) => Promise<void>;
  /** Create notes for lessons running now, without taking focus. */
  createCurrentLessons: () => Promise<void>;
}

/** Tried this session, so a note you delete during a lesson stays deleted. */
const attemptedLessons = new Set<string>();

async function createLessonNote(root: string, event: CalendarEvent, notes: tauri.CalendarNote[]) {
  const entries = await tauri.readDirectory(root);
  const folders = entries.filter((entry) => entry.is_dir).map((entry) => entry.name);
  const folder = lessonFolder(event.summary, root, notes, folders);
  const name = lessonNoteName(
    localDate(new Date(event.start)),
    lessonKind(event.summary),
    lessonTopic(event.description),
  );
  let path = `${folder}/${name}`;
  if (await tauri.fileExists(path)) {
    path = `${path.slice(0, -3)} ${localTime(event.start).replace(":", ".")}.md`;
  }
  // Exclusive create: a file already at this path is reported, never replaced.
  await tauri.createFile(path, lessonNoteContent(event));
  return path;
}

export const useCalendarStore = create<CalendarState>((set, get) => ({
  root: null,
  fetchedAt: 0,
  configured: false,
  events: [],
  syncedAt: 0,

  refresh: async (quiet = false) => {
    const root = useWorkspaceStore.getState().root;
    if (!root) return;
    set({ root, fetchedAt: Date.now() });
    try {
      const feed = await tauri.fetchCalendar();
      if (useWorkspaceStore.getState().root !== root) return;
      set({
        configured: feed !== null,
        events: feed?.events ?? [],
        syncedAt: feed ? Date.now() : 0,
      });
      if (feed?.skipped) {
        showEditorNotice(`${feed.skipped} calendar event(s) could not be read and were skipped.`);
      } else if (feed && !quiet) {
        showEditorNotice(`Calendar refreshed: ${feed.events.length} events.`);
      }
    } catch (error) {
      if (useWorkspaceStore.getState().root !== root) return;
      showEditorNotice(error instanceof Error ? error.message : String(error));
    }
  },

  refreshIfStale: () => {
    const root = useWorkspaceStore.getState().root;
    const { root: fetchedRoot, fetchedAt, refresh } = get();
    if (!root) return;
    if (root !== fetchedRoot) set({ events: [], configured: false, fetchedAt: 0, syncedAt: 0 });
    else if (Date.now() - fetchedAt < REFRESH_MS) return;
    void refresh(true);
  },

  openLesson: async (event) => {
    const root = useWorkspaceStore.getState().root;
    if (!root) return;
    const notes = await tauri.findCalendarNotes();
    const existing = notes.find((note) => note.occurrence === event.occurrence_key);
    if (existing) {
      await useEditorStore.getState().openFile(existing.path);
      return;
    }
    const path = await createLessonNote(root, event, notes);
    await useEditorStore.getState().openFile(path);
  },

  createCurrentLessons: async () => {
    const root = useWorkspaceStore.getState().root;
    if (!root) return;
    const pending = lessonsInProgress(get().events, new Date()).filter(
      (event) => !attemptedLessons.has(`${root}::${event.occurrence_key}`),
    );
    if (pending.length === 0) return;
    const notes = await tauri.findCalendarNotes();
    for (const event of pending) {
      attemptedLessons.add(`${root}::${event.occurrence_key}`);
      if (notes.some((note) => note.occurrence === event.occurrence_key)) continue;
      const path = await createLessonNote(root, event, notes);
      showEditorNotice(`Created lesson note: ${getFileName(path)}`);
    }
  },
}));
