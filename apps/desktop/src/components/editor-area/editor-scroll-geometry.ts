/** Defaults match the roomy editor's fade. Compact chrome supplies smaller CSS insets. */
export const EDITOR_SAFE_SCROLL_MARGIN = 140;

/** Read afresh: hidden panes have no geometry and resize can change either inset. */
export function editorScrollInsets(scroller: HTMLElement): { top: number; bottom: number } {
  const style = getComputedStyle(scroller);
  const inset = (property: string) => {
    const value = Number.parseFloat(style.getPropertyValue(property));
    const requested = Number.isFinite(value) ? value : EDITOR_SAFE_SCROLL_MARGIN;
    return Math.max(0, Math.min(requested, scroller.clientHeight / 3));
  };
  return { top: inset("--editor-safe-top"), bottom: inset("--editor-safe-bottom") };
}
