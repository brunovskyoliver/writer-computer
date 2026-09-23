import { useCallback, type MouseEvent } from "react";
import { useFileStats } from "@/hooks/use-tabs";
import { useBooleanSetting, useSetSetting } from "@/hooks/use-settings";
import { useIsCompactFileMode } from "@/hooks/use-workspace";
import {
  FOOTER_METRICS,
  showFooterContextMenu,
  type FooterMetricSettingKey,
} from "./footer-context-menu";
import { registerVimDialogHost, useVimFooterModel, type VimFooterModel } from "./vim-store";

function FooterMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[var(--text-muted)]">{value.toLocaleString()}</span>
      <span>{label}</span>
    </div>
  );
}

/** Mode label plus the host the Vim library's `:` / `/` prompts and messages
 *  are moved into (see `vim-mode.ts`). The host stays mounted whenever Vim is
 *  on for the tab, and it is registered under that tab's id — with split
 *  panes each visible footer has its own host, so a prompt always lands in
 *  the pane it was opened from. */
function VimStatus({ model, tabId }: { model: VimFooterModel; tabId: string }) {
  const hostRef = useCallback(
    (el: HTMLDivElement | null) => registerVimDialogHost(tabId, el),
    [tabId],
  );
  return (
    <>
      <span data-vim-mode={model.label} className="shrink-0 whitespace-pre">
        {model.label}
        {model.pending ? ` ${model.pending}` : null}
        {model.recording ? ` recording @${model.recording}` : null}
      </span>
      <div ref={hostRef} data-vim-dialog-host className="flex min-w-0 flex-1 items-center" />
    </>
  );
}

export function DocumentFooter({ filePath, tabId }: { filePath: string; tabId: string }) {
  const stats = useFileStats(filePath);
  const setSetting = useSetSetting();
  const isCompact = useIsCompactFileMode();
  const vim = useVimFooterModel(tabId);
  const visibility: Record<FooterMetricSettingKey, boolean> = {
    "statusbar.show-words": useBooleanSetting("statusbar.show-words"),
    "statusbar.show-characters": useBooleanSetting("statusbar.show-characters"),
    "statusbar.show-paragraphs": useBooleanSetting("statusbar.show-paragraphs"),
  };
  // Compact windows carry no document chrome; only Vim state, which the user
  // needs to read the editor, gets a footer there.
  const visibleMetrics = isCompact
    ? []
    : FOOTER_METRICS.filter((metric) => visibility[metric.settingKey]);

  if (visibleMetrics.length === 0 && !vim) return null;

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (isCompact) return;
    event.preventDefault();
    void showFooterContextMenu({
      visibility,
      onToggle: (key, visible) => {
        void setSetting(key, visible);
      },
    });
  };

  return (
    <div
      data-document-footer
      onContextMenu={handleContextMenu}
      className="flex absolute bottom-0 w-full z-10 h-11 shrink-0 items-center justify-end gap-5 px-6 text-[13px] leading-[1.15] text-[var(--text-muted)] md:px-8"
    >
      {vim ? <VimStatus model={vim} tabId={tabId} /> : null}
      {visibleMetrics.map((metric) => (
        <FooterMetric
          key={metric.settingKey}
          label={metric.footerLabel}
          value={stats[metric.statKey]}
        />
      ))}
    </div>
  );
}
