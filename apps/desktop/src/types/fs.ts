export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_markdown: boolean;
  modified_at: number;
  title: string | null;
}

export interface FileContent {
  path: string;
  content: string;
  modified_at: number;
}

export interface WriteResult {
  path: string;
  modified_at: number;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  file_count: number;
  epoch: number;
}

export interface SearchResult {
  path: string;
  filename: string;
  relative_path: string;
  score: number;
  match_indices: number[];
}

export interface ContextLine {
  line_number: number;
  text: string;
}

/** One content-search hit. `kind` discriminates the location fields:
 *  `line_number` is set for text files, `page` for PDFs. `match_ranges` are
 *  `[char_start, len]` pairs within `line_text`, document order,
 *  non-overlapping. */
export interface SearchMatch {
  path: string;
  relative_path: string;
  modified_at: number;
  kind: "text" | "pdf";
  line_number: number | null;
  page: number | null;
  line_text: string;
  match_ranges: [number, number][];
  context: ContextLine[];
}

/** A `.pdf` in the corpus — the frontend's extraction queue entry. */
export interface PdfCandidate {
  path: string;
  modified_at: number;
}

/** The `content_search` channel payload (serde-tagged). */
export type ContentSearchEvent =
  | { type: "matches"; matches: SearchMatch[] }
  | { type: "pdf"; candidate: PdfCandidate }
  | { type: "done"; truncated: boolean };

export interface IndexStats {
  file_count: number;
  duration_ms: number;
}
