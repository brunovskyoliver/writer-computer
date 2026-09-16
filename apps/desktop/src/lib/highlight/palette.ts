/**
 * The one colour table for the highlight feature (FR-014, Constitution III).
 * The bar's swatches, the `#rrggbb` written into the document, and the
 * detector that reads a colour back out all iterate this — adding a colour
 * edits this file and nothing else.
 *
 * Literal hex, not a CSS variable: the file must render the same colour in
 * Obsidian and on GitHub, where Writer's theme variables do not exist. The
 * palette is tuned for adequacy on both themes rather than maximum contrast
 * on either (research R6).
 */

export interface PaletteColour {
  /** Stable id for the command palette. Never written to the document. */
  id: string;
  /** Shown in the bar; read by screen readers. */
  name: string;
  /** Lowercase #rrggbb. This is what lands in the file. */
  hex: `#${string}`;
}

export const HIGHLIGHT_PALETTE: readonly PaletteColour[] = [
  { id: "amber", name: "Amber", hex: "#e0a000" },
  { id: "red", name: "Red", hex: "#cf222e" },
  { id: "pink", name: "Pink", hex: "#db61a2" },
  { id: "green", name: "Green", hex: "#22863a" },
  { id: "blue", name: "Blue", hex: "#0969da" },
  { id: "purple", name: "Purple", hex: "#8250df" },
];
