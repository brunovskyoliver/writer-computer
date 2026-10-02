# Unregister failed MCP handshakes

Status: Complete.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 20.

## Plan

Read MCP bridge/registry/pending cleanup, handshake tests, app state and MCP connection contract. serve_connection returns early on handshake failure, skipping fail_pending_for_conn (which also removes the connection task). Successful and failed handshakes must both reach that existing epilogue.

Replace the early-return handshake with an if-let serving block followed by unconditional cleanup. Hold the existing MCP registry lock across connection-id allocation, task spawn and insertion; cleanup uses the same lock, so a task finishing immediately cannot unregister before its handle is inserted. Check enabled under that lock before registering: listener cancellation is deferred, so an accepted stream can otherwise register after a settings disable drains the registry. Keep serving and all awaits outside the lock. Stop remains responsible for aborted-task cleanup. This is one connection-lifecycle fix, not a new tool or protocol change.

Rust, Systems and QA approved the core plan and independently identified the deferred-cancellation disable race. They also review the implementation. Use existing matching/mismatched/unrecognized handshake tests, add a disconnected-peer boundary regression and test the real pending/connection cleanup helper with two connections and multiple pending calls. Assert that only the target is removed, its pending receivers fail, unrelated receivers remain pending, and repeated cleanup is harmless. A full serve_connection test requires a Tauri AppHandle; document that integration gap if the current harness cannot provide one. Update the owning connection contract, worksheet and changelog. Run cargo test, clippy and fmt checks before commit.

## Report

Rejected handshakes, handshake I/O failures and normal serving exits now reach fail_pending_for_conn, which removes the task record and fails only that connection's pending calls. The accept loop holds the registry mutex through its enabled check, ID allocation, spawn and insertion, preventing cleanup before registration and rejecting streams racing a settings disable. Spawn does not poll inline; every await stays outside the mutex. Stop still drains and aborts tasks directly.

Added EOF and acknowledgement-write failure handshake regressions, plus targeted cleanup with two connections and multiple pending calls. Unrelated calls remain pending, and repeated cleanup is harmless. All 276 Rust tests pass; QA independently ran all 22 MCP tests. Cargo clippy succeeds with nine existing warnings outside the changed paths, cargo fmt --check and git diff --check pass. Rust/Tauri, Systems and QA approved plan and implementation. Updated the bridge contract and MCP guide.

The tests exercise handshake failures and cleanup separately. Full serve_connection and forced accept/disable races require a real Tauri AppHandle and remain an integration coverage gap; inspection verifies the call path and lock scope. No implementation remains for this ticket.
