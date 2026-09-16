/**
 * The non-schema half of the MCP server setting: live status with the
 * bind-error detail when startup fails (FR-004/FR-005), and the connection
 * snippet — or, when `cli_status` reports `writer` missing from PATH, a
 * pointer to the existing Install CLI menu action instead (FR-008a).
 * The toggle itself is schema-driven (`mcp.enabled`); this is the extras
 * block under it.
 */

import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useMcpStatus } from "./use-mcp-status";

/** Paste-ready client config: `writer mcp` bridges stdio to the socket. */
const CONNECT_SNIPPET = JSON.stringify(
  { mcpServers: { writer: { command: "writer", args: ["mcp"] } } },
  null,
  2,
);

export function McpSection() {
  const { status, cliInstalled } = useMcpStatus();
  const [copied, setCopied] = useState(false);

  // Before the first mcp_status reply there is nothing true to say.
  if (!status) return null;

  return (
    <div className="mt-3 px-4">
      {status.state === "failed" ? (
        <p role="alert" className="text-[12px] text-[var(--text-error)]">
          Could not start the MCP server{status.error ? `: ${status.error}` : ""}
        </p>
      ) : (
        <p className="text-[12px] text-[var(--text-muted)]">
          {status.state === "running" ? "Server running" : "Server off"}
        </p>
      )}

      {status.state === "running" && (
        <p className="mt-1 font-mono text-[12px] break-all text-[var(--text-muted)]">
          {status.socket_path}
        </p>
      )}

      {cliInstalled === false ? (
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--text-muted)]">
          The <span className="font-mono">writer</span> command is not on PATH yet. Install it from
          the Writer menu (&quot;Install &apos;writer&apos; Command Line Tool…&quot;), then point
          your agent&apos;s MCP config at <span className="font-mono">writer mcp</span>.
        </p>
      ) : (
        <>
          <p className="mt-3 text-[12px] text-[var(--text-muted)]">
            Add Writer to an MCP client (Claude Code, Codex, …):
          </p>
          <pre className="mt-1 overflow-x-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-subtle)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {CONNECT_SNIPPET}
          </pre>
          <button
            type="button"
            onClick={() => {
              void writeText(CONNECT_SNIPPET);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="mt-2 rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-subtle)]"
          >
            {copied ? "Copied" : "Copy connection config"}
          </button>
        </>
      )}
    </div>
  );
}
