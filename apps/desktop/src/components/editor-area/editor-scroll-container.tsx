import type { CSSProperties, ReactNode, Ref } from "react";

const FADE_DISTANCE = 120;
const SCROLLBAR_GUTTER = "18px";
const FADE_MASK_VERTICAL = `linear-gradient(to bottom, transparent min(5%, 40px), black min(15%, 120px), black calc(100% - min(15%, 120px)), transparent)`;
const FADE_MASK_GUTTER = `linear-gradient(to right, black ${SCROLLBAR_GUTTER}, transparent ${SCROLLBAR_GUTTER}, transparent calc(100% - ${SCROLLBAR_GUTTER}), black calc(100% - ${SCROLLBAR_GUTTER}))`;
const FADE_MASK = `${FADE_MASK_VERTICAL}, ${FADE_MASK_GUTTER}`;

// Vertical inset to keep the caret and active search match clear of both
// the FADE_MASK_VERTICAL gradient and the ProgressiveBlur overlay.
export const EDITOR_SAFE_SCROLL_MARGIN = FADE_DISTANCE + 20;
export const EDITOR_SCROLLBAR_GUTTER = SCROLLBAR_GUTTER;

function ProgressiveBlur({ position }: { position: "top" | "bottom" }) {
  const isTop = position === "top";

  const topFade = `linear-gradient(to bottom, black 40%, transparent 80%)`;
  const bottomFade = `linear-gradient(to top, black 20%, transparent 60%)`;
  // Horizontal styles below mirror SCROLLBAR_GUTTER (18px).
  // The overlay stops a blur radius short of the pane's edge: WebKit samples
  // the backdrop a few pixels past the element, so an overlay flush with the
  // edge smears whatever sits beyond it — a pane divider — into a glow.
  return (
    <div
      className="pointer-events-none absolute z-10 left-[18px] right-[18px] [backdrop-filter:blur(3px)] [-webkit-backdrop-filter:blur(3px)]"
      style={{
        [isTop ? "top" : "bottom"]: 3,
        height: `min(${FADE_DISTANCE}px, 30%)`,
        maskImage: isTop ? topFade : bottomFade,
        WebkitMaskImage: isTop ? topFade : bottomFade,
      }}
    />
  );
}

interface EditorScrollContainerProps {
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export function EditorScrollContainer({ ref, children }: EditorScrollContainerProps) {
  return (
    <div
      className="relative h-full"
      style={{ "--writer-editor-bottom-space": `${EDITOR_SAFE_SCROLL_MARGIN}px` } as CSSProperties}
    >
      <div
        ref={ref}
        className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]"
        style={{
          maskImage: FADE_MASK,
          WebkitMaskImage: FADE_MASK,
          maskComposite: "add",
          WebkitMaskComposite: "source-over",
          borderTop: "12px solid transparent",
          borderBottom: "12px solid transparent",
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
      <ProgressiveBlur position="top" />
      <ProgressiveBlur position="bottom" />
    </div>
  );
}
