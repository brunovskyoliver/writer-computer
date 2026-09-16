# Contract: The Palette

One table, one file: `apps/desktop/src/lib/highlight/palette.ts`. It is the source for the bar's
swatches, for the `#rrggbb` written into the document, and for the detector that reads a colour
back out. **Adding, removing or retuning a colour edits this file and nothing else** (FR-014,
Constitution III).

```ts
export interface PaletteColour {
  /** Stable id for the command palette. Never written to the document. */
  id: string;
  /** Shown in the bar; read by screen readers. */
  name: string;
  /** Lowercase #rrggbb. This is what lands in the file. */
  hex: `#${string}`;
}

export const HIGHLIGHT_PALETTE: readonly PaletteColour[] = [
  /* six entries */
];
```

## Rules the table must satisfy

Each is asserted by a test over the whole table, not left to review (Constitution III: "we will
remember" is not enforcement).

1. Every `hex` matches `/^#[0-9a-f]{6}$/`.
2. Every `id` is unique.
3. Every `hex` clears the contrast threshold against **both** the light and the dark editor
   background (SC-006). A colour that passes on one theme only does not go in the table.

## Why literal hex and not a CSS variable

The file must render the same colour in Obsidian and on GitHub, where Writer's theme variables do
not exist (Constitution I). The trade this forces — the palette is tuned for adequacy on both
themes rather than maximum contrast on either — is accepted by the spec and recorded in research R6.

## Size

Six entries. That is a starting number chosen for the derivation-tracking use case, not a
constraint the design depends on: nothing outside this file counts them, and every consumer
iterates the table.
