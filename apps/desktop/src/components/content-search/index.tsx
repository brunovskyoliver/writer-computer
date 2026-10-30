import { useEffect, useRef, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "cmdk";
import {
  useCloseCommandPalette,
  useCommandPaletteIntent,
  useCommandPaletteSearch,
  useIsCommandPaletteOpen,
  useSetCommandPaletteSearch,
  useRestoreFocus,
} from "@/hooks/use-command-palette";
import { openSearchMatch } from "@/hooks/editor-api";
import { getFileName, getParentDir } from "@/lib/paths";
import type { SearchMatch } from "@/types/fs";
import { useContentSearch } from "./use-content-search";

/** `match_ranges` are code-point `[start, len]` pairs — the same space
 *  `Array.from` iterates. */
function HighlightedRanges({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const chars = Array.from(text);
  const marked = chars.map(() => false);
  for (const [start, len] of ranges) {
    for (let i = start; i < start + len && i < chars.length; i++) marked[i] = true;
  }
  return (
    <span>
      {chars.map((char, i) => (
        <span key={i} className={marked[i] ? "text-link font-semibold" : undefined}>
          {char}
        </span>
      ))}
    </span>
  );
}

function locationLabel(match: SearchMatch) {
  return match.kind === "pdf" ? `Page ${match.page}` : `L${match.line_number}`;
}

function matchValue(match: SearchMatch, index: number) {
  return `${match.path}§${index}`;
}

export function ContentSearchPalette() {
  const isOpen = useIsCommandPaletteOpen();
  const intent = useCommandPaletteIntent();
  const close = useCloseCommandPalette();
  const search = useCommandPaletteSearch();
  const setSearch = useSetCommandPaletteSearch();

  const active = isOpen && intent === "content-search";
  useRestoreFocus(active);
  const trimmed = search.trim();
  // The hook only scans while this intent actually owns the shared search
  // field — typing in the `Cmd+P` palette must not start a workspace walk.
  const scan = useContentSearch(active ? search : "");
  const matches = scan.matches;

  const listRef = useRef<HTMLDivElement>(null);
  const values = matches.map(matchValue);
  const [selectedValue, setSelectedValue] = useState("");

  // Snap selection + scroll to the first item when the query changes or a
  // re-sorted batch shifts the first row — the same rule the `Cmd+P` palette
  // follows for async results.
  const firstValue = values[0] ?? "";
  /* eslint-disable react-doctor/no-derived-state */
  useEffect(() => {
    setSelectedValue(firstValue);
    listRef.current?.scrollTo({ top: 0 });
  }, [search, firstValue]);
  /* eslint-enable react-doctor/no-derived-state */

  // The preview tracks cmdk `value`, which arrow keys and pointer hover both
  // drive (research R6) — no extra wiring for either navigation mode.
  const selectedIndex = values.indexOf(selectedValue);
  const preview = selectedIndex === -1 ? null : matches[selectedIndex]!;

  function handleSelect(match: SearchMatch) {
    openSearchMatch(match, trimmed);
    close();
  }

  const heading =
    scan.state === "scanning" ? "Searching..." : scan.truncated ? "Results (truncated)" : "Results";

  return (
    <CommandDialog
      open={active}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      label="Content Search"
      shouldFilter={false}
      value={selectedValue}
      onValueChange={setSelectedValue}
      contentClassName="content-search-dialog"
    >
      <CommandInput
        placeholder="Search in files (including PDFs)..."
        value={search}
        onValueChange={setSearch}
      />
      <div className="content-search-body">
        <CommandList ref={listRef}>
          {matches.length === 0 && (
            <CommandEmpty>
              {!trimmed
                ? "Type to search inside every file in the workspace."
                : scan.state === "scanning"
                  ? "Searching..."
                  : "No results found."}
            </CommandEmpty>
          )}
          {matches.length > 0 && (
            <CommandGroup heading={heading}>
              {matches.map((match, i) => {
                const value = values[i]!;
                const dir = getParentDir(match.relative_path);
                return (
                  <CommandItem key={value} value={value} onSelect={() => handleSelect(match)}>
                    <div className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate">{getFileName(match.path)}</span>
                        <span className="shrink-0 text-[11px] text-text-muted">
                          {locationLabel(match)}
                        </span>
                      </span>
                      <span className="truncate text-[13px] text-text-muted">
                        {dir && dir !== "." ? `${dir} — ` : ""}
                        <HighlightedRanges text={match.line_text} ranges={match.match_ranges} />
                      </span>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
        {matches.length > 0 && (
          <div className="content-search-preview">
            {preview ? (
              <>
                <div className="content-search-preview-header">
                  {getFileName(preview.path)} · {locationLabel(preview)}
                </div>
                <PreviewContext match={preview} />
              </>
            ) : null}
          </div>
        )}
      </div>
    </CommandDialog>
  );
}

function PreviewContext({ match }: { match: SearchMatch }) {
  // The matched line inside `context`: text matches carry `line_number`; for
  // PDFs it is the context row whose text is `line_text` (context is built
  // from the same extracted lines the matcher searched).
  const pdfMatchRow =
    match.kind === "pdf" ? match.context.findIndex((c) => c.text === match.line_text) : -1;
  return (
    <div className="content-search-preview-lines">
      {match.context.map((line, i) => {
        const isMatch =
          match.kind === "pdf" ? i === pdfMatchRow : line.line_number === match.line_number;
        return (
          <div
            key={`${line.line_number}-${i}`}
            className={
              isMatch ? "content-search-preview-line is-match" : "content-search-preview-line"
            }
          >
            <span className="content-search-preview-lineno">{line.line_number}</span>
            <span className="content-search-preview-text">
              {isMatch ? (
                <HighlightedRanges text={line.text} ranges={match.match_ranges} />
              ) : (
                line.text
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
