# AUD-06: calendar ingestion design

Status: built. No vault file was changed. Evidence comes from reading the Course Workspaces
source and `data.json` in `~/Documents/Obsidian/SDU`, with the feed URL redacted.

## What the plugin does today

itslearning is reached only through one private webcal feed. Each refresh replaces a stored event list. A one-minute
check creates a lesson note while a lesson is in progress in the active workspace. Notes carry `course`, `lesson-date`,
`lesson-start`, `lesson-end`, `calendar-uid`, `calendar-occurrence`, `workspace` and optional `location`.

## Confirmed defects to leave behind

| Defect                                                                                                                       | Evidence                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The refresh setting is ignored: `autoRefreshMinutes` is only tested for `> 0`, then the feed is fetched every 60 seconds     | `main.ts:144-151`; stored value is 60                                                                |
| Course identity includes the room, so one course splits into several keys and a workspace bound to one misses the rest       | 55 stored events give 11 course keys for 3 workspaces                                                |
| Duplicate protection depends on a map in `data.json`, not the notes, so losing the map or switching tools creates duplicates | 17 map entries, 16 notes with `calendar-occurrence`, 1 map target missing                            |
| The map key repeats the UID and includes the workspace ID, so one lesson can get a note per workspace                        | `lesson-note-creator.ts:7`                                                                           |
| Feed escapes reach note bodies as literal `\r`                                                                               | 17 of 55 stored descriptions; visible in lesson notes                                                |
| `lesson-date` is the UTC date, so a lesson just after local midnight lands on the previous day                               | `start.slice(0, 10)`                                                                                 |
| The private feed URL sits in `data.json` in the vault's git repo, not ignored                                                | Currently untracked and the repo has no remote, so it isn't exposed yet; one `git add -A` commits it |

The stored list was last refreshed on 2026-10-05, so it is not a current picture of the feed.

## Feed sample

One read-only request, approved by Oliver on 2026-10-30, returned 47 events: all single UTC times with unique UIDs, no
`RRULE`, `EXDATE`, `VTIMEZONE` or `LOCATION`. The response is served as `text/html`, so the parser checks for
`BEGIN:VCALENDAR` instead of the content type. Summaries read `Course, (E26): type - room`, and some course names contain
colons. The raw response was deleted; tests use synthetic values in the same shape.

## Built

- **Secret:** `calendar_feeds.json` in app data, `0600`, keyed by workspace root. Rust does all fetching. The frontend
  can set or remove the link but never reads it, and errors strip the URL.
- **Fetch:** HTTPS only, 30-second timeout, 5 MB cap. No timer: the palette refreshes when the data is over an hour old,
  and `Refresh Calendar` forces it.
- **Parse:** a small hand-written parser. Recurring, cancelled, all-day and floating-time events are counted and
  reported, not guessed.
- **Identity:** `calendar-occurrence` in note frontmatter is the only duplicate check. There is no map to import.
- **Course:** `^(.+?, \([^)]*\)):`. A summary that doesn't match keeps its full text and goes to the default folder.
- **Folder:** a note of the same course decides, then a top-level folder named after the course, then `Own notes`.
- **Notes:** created only when you pick a `Lesson:` palette command, through exclusive create. Same frontmatter keys as
  the plugin, except `workspace` and `location` unless the feed has one. Existing notes are never edited.

Because Writer never creates notes on its own, it can run beside the plugin. If both act on one lesson within the same
moment a duplicate is possible, but the plugin's check doesn't read notes, so it can also create one after Writer has.

## Verification

Native audit build, disposable vault, synthetic feed on loopback (`calendar-native.json` and `calendar-*.png` in
`~/agent-runs/2026-10-29-writer-audit/`): 13 of 13 checks. They cover link rejection without echoing it, `0600` storage,
no link in the vault or UI, listing today's lessons, reusing a renamed plugin-style note, folder selection and no
duplicate on repeat. One earlier run failed to find a second lesson in the palette; it didn't recur and the cause is
unknown.

The Rust parser also ran offline on the saved real response: 47 events, 0 skipped, no escapes left, and 3 occurrences
match existing SDU notes, so plugin notes are recognized. Only counts were recorded.

## Sorting and naming

The plugin matches a workspace name to a folder, and "Math" doesn't match "Mathematics for Science 1", so 10 math notes
landed in the root `Own notes`. Its date suffix appears only on a filename collision.

`planLessonMoves` handles notes with `calendar-occurrence`. Folder: most notes of that course inside a course folder
(root `Own notes` doesn't vote), then a top-level folder with the course's name, then a new one. Name:
`YYYY-MM-DD Kind - Topic.md`, with the start time added on a same-day collision. Only names still starting with the
course name are rewritten, and notes already under the course's top-level folder stay there. `<note>-assets` moves too.

Checked on an rsync copy of SDU without PDFs, `.obsidian` or `.git` (`organize-native.json`): 16 notes moved, 7 asset
files moved with links rewritten, no files lost, binaries identical, a second run did nothing. A later launch moved a new
stray note without being asked and left a renamed one alone. The first asset attempt failed in native testing because
`read_directory` doesn't list those folders; the mock-free run caught it.

Run on the real vault on 2026-10-30, with Oliver's approval and Obsidian closed. A full backup was verified first
(`~/agent-runs/2026-10-30-sdu-backup/SDU`, with `moves.txt` beside it). 16 notes and 7 asset files moved. File count stayed
5,908 outside `.git`, no other file changed, and only 3 notes differ in content: 6 image-link lines, all resolving.

Not sorted: notes without calendar frontmatter, Excalidraw drawings named after lessons, `boom.md` and loose images.
The plugin keeps writing to the wrong folder while enabled; Writer corrects its notes only when Writer runs.

## Automatic mode

Added at Oliver's request on 2026-10-30. A saved calendar link is the opt-in: each sync sorts lesson notes, and a one-minute
check creates a note for a running lesson without taking focus. Events with no recognizable course get no note. A note
deleted during a lesson isn't recreated until the app restarts. Fetching stays hourly.

Checked on a vault copy with a loopback feed and no interaction: a stray note sorted, a running lesson got a note, a
party event got none, and a relaunch made no duplicate. Writer's HTTPS fetch then ran against the real feed from the
real vault: 47 events, and the vault's file list didn't change.

## Limits

- Only today's lessons are listed, and the list updates when the palette opens.
- Assignments and resources aren't in the feed; getting them needs a separate authenticated itslearning API.
- `Own notes` is a fixed folder name.
