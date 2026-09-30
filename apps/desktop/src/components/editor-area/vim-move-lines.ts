/**
 * Visual-mode `J` / `K`: move the selected lines down / up one line and keep
 * them selected — Neovim's `vnoremap J :m '>+1<CR>gv` / `K :m '<-2<CR>gv`
 * from the user's config. The library has no `:move`, so this is an action
 * of its own. The re-indent (`=`) of that mapping is left out on purpose:
 * prose and LaTeX have no indent engine to trust.
 *
 * `moveLineBlock` is the pure half; the action only reads the visual
 * selection, applies the edit and shifts the selection with it.
 */

/** Line numbers are 0-based, as in the library's CM5-style API. */
export type LineBlockEdit = {
  /** First and last line replaced: the block plus the line it swaps with. */
  fromLine: number;
  toLine: number;
  text: string;
};

/**
 * The edit that moves lines `first..last` one line in `dir`, or null at the
 * document's edge (Neovim leaves the text alone there too).
 */
export function moveLineBlock(
  lineCount: number,
  getLine: (line: number) => string,
  first: number,
  last: number,
  dir: 1 | -1,
): LineBlockEdit | null {
  if (dir === 1 && last >= lineCount - 1) return null;
  if (dir === -1 && first <= 0) return null;

  const block: string[] = [];
  for (let line = first; line <= last; line += 1) block.push(getLine(line));
  if (dir === 1) {
    return { fromLine: first, toLine: last + 1, text: [getLine(last + 1), ...block].join("\n") };
  }
  return { fromLine: first - 1, toLine: last, text: [...block, getLine(first - 1)].join("\n") };
}

type Pos = { line: number; ch: number };

/** The slice of the library's editor adapter this uses. */
interface VimCm {
  lineCount(): number;
  getLine(line: number): string;
  replaceRange(text: string, from: Pos, to?: Pos): void;
  setSelection(anchor: Pos, head: Pos): void;
}

interface VimState {
  visualMode: boolean;
  visualLine: boolean;
  visualBlock: boolean;
  sel: { anchor: Pos; head: Pos };
}

interface VimRegistry {
  defineAction(
    name: string,
    fn: (cm: VimCm, args: { down?: boolean }, vim: VimState) => void,
  ): void;
  mapCommand(
    keys: string,
    type: string,
    name: string,
    args: unknown,
    extra: { context?: string },
  ): void;
}

/** The editor selection the library draws for a visual selection — its
 *  `makeCmSelection` for line and character modes. */
function cmSelection(cm: VimCm, vim: VimState): { anchor: Pos; head: Pos } {
  const { anchor, head } = vim.sel;
  const forward = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch);
  if (vim.visualLine) {
    return forward
      ? {
          anchor: { line: anchor.line, ch: 0 },
          head: { line: head.line, ch: cm.getLine(head.line).length },
        }
      : {
          anchor: { line: anchor.line, ch: cm.getLine(anchor.line).length },
          head: { line: head.line, ch: 0 },
        };
  }
  // Character mode: the inclusive end becomes an exclusive editor position.
  return forward
    ? { anchor, head: { line: head.line, ch: head.ch + 1 } }
    : { anchor: { line: anchor.line, ch: anchor.ch + 1 }, head };
}

let registered = false;

export function registerVimMoveLines(vim: VimRegistry) {
  if (registered) return;
  registered = true;

  vim.defineAction("writerMoveLines", (cm, args, state) => {
    // Block mode selects columns, not lines; `J`/`K` there would surprise.
    if (!state.visualMode || state.visualBlock) return;
    const dir = args.down ? 1 : -1;
    const { anchor, head } = state.sel;
    const first = Math.min(anchor.line, head.line);
    const last = Math.max(anchor.line, head.line);
    const edit = moveLineBlock(cm.lineCount(), (line) => cm.getLine(line), first, last, dir);
    if (!edit) return;

    cm.replaceRange(
      edit.text,
      { line: edit.fromLine, ch: 0 },
      { line: edit.toLine, ch: cm.getLine(edit.toLine).length },
    );
    state.sel = {
      anchor: { line: anchor.line + dir, ch: anchor.ch },
      head: { line: head.line + dir, ch: head.ch },
    };
    const selection = cmSelection(cm, state);
    cm.setSelection(selection.anchor, selection.head);
  });

  vim.mapCommand("J", "action", "writerMoveLines", { down: true }, { context: "visual" });
  vim.mapCommand("K", "action", "writerMoveLines", { down: false }, { context: "visual" });
}
