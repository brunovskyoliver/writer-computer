# Tab chrome and file path

Every pane keeps its tabs visible in their existing order, with horizontal scrolling when they overflow. Hover never hides or expands tabs.

New tabs enter from the right. Removed tabs shrink toward their right neighbor, or left when closing the last tab. Closing takes effect immediately in document state; only inert presentation remains during the exit. Preserve drag/reorder, pane focus and native context menus. Respect reduced motion. Use rounded tabs, a subtle strip background, and an opaque contrasting active surface derived from theme colors.

Under each strip, show the active Markdown file's workspace-relative path, centered, with muted directories and a brighter filename. Omit the extension. The row belongs to the pane chrome outside the document scroller so it stays fixed while the document scrolls. Truncate long paths with the complete extension-free path in the tooltip. With no workspace, show the filename. Other page kinds do not show this row. Ordinary file tabs also omit their extension; frontmatter titles remain intact.

## Folder navigation

The path font tracks 90% of the editor font-size setting. Each workspace-relative folder is a keyboard-accessible button that opens the sidebar, expands its ancestors, scrolls to its row and focuses it. The focused folder uses the current theme accent for its highlight. Paths outside the workspace have no folder actions. Keep filename extensions hidden and preserve document state.
