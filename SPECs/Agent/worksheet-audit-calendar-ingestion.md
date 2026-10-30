# AUD-06: calendar ingestion design

Status: design only. No code, no feed request, no vault change. Evidence comes from reading the Course Workspaces
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

## Proposed Writer design

1. **Feed secret.** Store the URL in the app data directory, outside the vault, with `0600` permissions and keyed by
   workspace root. Rust does all fetching: the webview CSP already blocks it, and the frontend only learns whether a URL
   is set. Never log it or put it in an error. Keychain storage would need a new dependency; add it if file permissions
   prove insufficient.
2. **Fetch.** `reqwest` is already a dependency. Convert `webcal` to `https`, refuse plain `http`, set a timeout and a
   body cap, and report 401/403 as an expired link. Refresh on the configured interval, not each minute.
3. **Parse.** Rust, one pure function with fixture tests. All 55 stored events have distinct UIDs, which suggests the
   feed lists single events, but raw feed text isn't stored. Recurring events must fail with a visible count rather than
   be skipped until a real feed sample settles whether RRULE expansion is needed.
4. **Identity.** `calendar-occurrence` in note frontmatter is the only duplicate check, found by scanning the vault's
   notes. Renames and moves then keep working, and existing SDU notes are recognized with no migration or map import.
5. **Course mapping.** Derive the course from the text before `-` in `SUMMARY`, dropping lesson type and room, and
   store a user-editable course-to-folder mapping in the workspace. Keep room in `location`. The summary format is
   observed from one institution's feed, so an event that doesn't match goes to an "unmapped" list instead of guessing.
6. **Note creation.** Keep the existing frontmatter keys so Obsidian and Writer read the same notes. Use the workspace
   timezone for `lesson-date`, unescape descriptions, and write through the existing exclusive-create path (AUD-10) so
   an existing file is never replaced. Create notes only on explicit action or while a lesson runs, and never edit an
   existing note when the feed changes.
7. **Surface.** Palette commands "Today's Lessons" and "Refresh Calendar", plus a notice for each created note. Layout
   switching stays independent of the calendar. No background timer runs without a configured feed.

## Coexistence

Running this next to the plugin could create notes twice in the window before Obsidian's vault scan catches up.
Frontmatter scanning handles notes already on disk, not a simultaneous create. Writer's creation should stay off by
default until the plugin is disabled.

## Open before implementation

- One real feed response is needed for parser fixtures and the RRULE question. It would be saved with the token removed
  and personal details synthesized.
- Assignments and resources aren't in the feed. Getting them would need a separate itslearning API with its own
  authentication, which is out of scope here.
