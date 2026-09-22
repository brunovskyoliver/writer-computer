import { useBooleanSetting, useSetting } from "@/hooks/use-settings";
import { useAiStatus } from "./use-ai-status";

/**
 * The non-schema half of the AI section: live endpoint and index status
 * under the generated `ai.*` controls, plus a Refresh that re-probes both
 * endpoints. Hidden while AI is off — the schema fields alone carry the
 * "disabled" state, and `ai_status` would report all false anyway.
 */
export function AiSection() {
  const enabled = useBooleanSetting("ai.enabled", false);
  const chatEndpoint = useSetting("ai.chat-endpoint");
  const embedEndpoint = useSetting("ai.embed-endpoint");
  const { status, refresh } = useAiStatus();

  if (!enabled || !status?.enabled) return null;

  const endpointLine = (configured: boolean, ok: boolean) =>
    !configured ? "not configured" : ok ? "reachable" : "unreachable";

  return (
    <div className="mt-3 px-4">
      <p className="text-[12px] text-[var(--text-muted)]">
        Chat model: {endpointLine(Boolean(chatEndpoint), status.chat_ok)}
      </p>
      <p className="mt-1 text-[12px] text-[var(--text-muted)]">
        Embeddings: {endpointLine(Boolean(embedEndpoint), status.embed_ok)}
      </p>
      <p className="mt-1 text-[12px] text-[var(--text-muted)]">
        {status.indexed} notes indexed
        {status.pending > 0 ? `, ${status.pending} pending` : ""}
      </p>
      <button
        type="button"
        onClick={refresh}
        className="mt-2 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        Refresh
      </button>
    </div>
  );
}
