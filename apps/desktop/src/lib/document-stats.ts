export interface DocumentStats {
  words: number;
  characters: number;
  paragraphs: number;
}

// Block prefixes are stripped per line. `[ \t]` rather than `\s`: a `\s` at the
// line start swallowed the blank line before a list or heading, which merged
// paragraphs and under-counted them.
function normalizeDocumentContent(content: string) {
  return content
    .replace(/^[ \t]{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)[ \t]+/gm, "")
    .replace(/`+/g, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

export function getDocumentStats(content: string): DocumentStats {
  const normalized = normalizeDocumentContent(content);
  if (normalized === "") return { words: 0, characters: 0, paragraphs: 0 };

  let words = 1;
  let characters = normalized.length;
  let paragraphs = 1;
  // Normalization trims the edges, so every whitespace run separates words.
  // Count collapsed whitespace and code points without allocating another
  // document string or splitting the document into paragraphs.
  const boundaries = /(\s+)|[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
  let match: RegExpExecArray | null;
  while ((match = boundaries.exec(normalized)) !== null) {
    const whitespace = match[1];
    if (whitespace !== undefined) {
      words++;
      characters -= whitespace.length - 1;
      const newline = whitespace.indexOf("\n");
      if (newline !== -1 && whitespace.indexOf("\n", newline + 1) !== -1) paragraphs++;
    } else {
      // A surrogate pair occupies two UTF-16 units but one code point.
      characters--;
    }
  }

  return { words, characters, paragraphs };
}
