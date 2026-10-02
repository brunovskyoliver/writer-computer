# Obsidian Image Embed Spec

## Summary

Support Obsidian's `![[filename.ext]]` wiki-style embed syntax for inline images. The `[[]]` is a wiki-link, the `!` prefix turns it into an embed, and the editor should render the image inline rather than as a link.

## Goals

- Parse `![[file.png]]`, `![[folder/file.jpg]]`, and similar forms.
- Resolve the target like a wiki-link target (workspace-relative, basename match).
- Render the image inline.
- Keep the source text editable round-trip; no markdown conversion on save.
- Support common image formats: PNG, JPG, JPEG, GIF, WEBP, SVG.

## Non-Goals

- PDF or other file embeds in this spec (covered by `inline-media-preview-spec.md`).
- Aliasing (`![[file|alt]]`).
- Sizing modifiers (`![[file|400]]`) in v1.
- Editing the image inline.

## Resolution Rules

Reuse the existing wiki-link resolver (already shipped for `[[Doc]]` navigation):

- Strip outer `![[ ]]`.
- Normalize slashes.
- If the target contains `/`, treat as workspace-relative path.
- Otherwise resolve the basename against the workspace media index.
- The basename match is case-insensitive.

## UX Decisions

- Inline embeds render at natural width up to the body content width.
- A small gap separates the image from surrounding text.
- Right-clicking opens the editor context menu (which already provides "Reveal in Finder" via the editor context menu spec).
- Unresolved embeds render as a small inline placeholder showing the original `![[...]]` text.

## Editor Integration

- Recognize `![[...]]` in the wiki-link decorator (`wiki-link-extension.ts`) — the
  regex there must capture the `!` prefix anyway to stop rendering embeds as a
  link widget with a stray literal `!`. Embeds outside code render as an
  `ImageEmbedWidget` replace decoration; caret inside unfolds to raw source.
- Round-trip is free: decorations never touch the buffer, so the source text
  is preserved on save. (This is a CodeMirror codebase; the original
  ProseMirror node/serializer language in this spec predates the editor.)

## Implementation Notes (as shipped)

- Resolution ships in `lib/wiki-links.ts` (`parseWikiImageEmbedTarget`,
  `resolveWikiImage`): path targets probe workspace-relative then
  note-relative; bare basenames probe note dir and workspace root, then fall
  back to the `find_file_by_name` Rust command — an on-demand gitignore-aware
  walk with case-insensitive basename match, shortest path winning on
  duplicates. There is no persistent media index. `resolveWikiImageEmbed`
  owns the positive cache per (workspace, note, target), shared by inline
  rendering and drawing-open actions. It retains at most 256 recently used
  resolutions, with at most 8,192 UTF-16 characters in each serialized key
  plus resolved path. Oversized entries still resolve without caching.
- Editor reset clears the cache; a lookup started before reset cannot
  repopulate it. Misses and errors remain uncached. Positive hits retain the
  existing policy of re-probing after eviction or reset, so filesystem
  changes can leave a hit stale until then.
- Compact windows (no workspace) resolve note-relative only.
- Rendered embeds reuse `.cm-image` styling and the shared image
  height-stability cache (`attachStableImageHeight` in `fold/image.ts`).
- Non-image embeds (`![[Some Note]]`, PDFs) keep plain wiki-link rendering
  over the `[[...]]` part with the `!` left as source text.

## Acceptance Criteria

- Typing `![[diagram.png]]` in a document renders the image inline.
- Round-tripping the document through save and reload preserves the original `![[...]]` text.
- Unresolved embeds render a placeholder, not an empty box.
- Embeds inside code blocks are not rendered.
