# ARCHITECTURE-ESSENTIALS.md

Quick reference. Full detail: `ARCHITECTURE.md`. Rationale/history: `docs/Loop - Vertical-Slice Design Doc.md`.

## The one-sentence version

Orders come in through an outbox-pattern transaction, a Change Stream–driven consumer processes them into an append-only loyalty ledger and a guardrailed retention-agent decision, and everything is tenant-scoped from the server side, never the client.

## Processes (run separately, never merge)

| Process | Entrypoint | Does |
|---|---|---|
| API | `api/src/server.ts` | HTTP routes only. Never manages the consumer or the agent worker. |
| Consumer | `api/src/consumer.ts` | Tails `outbox_events` via Change Stream. Writes ledger + a real per-order retention decision. |
| Agent worker | `api/src/agentWorker.ts` | Hosts both BullMQ workers: retention's scheduled per-tenant sweep (Slice 3, Contract #6, manual trigger `POST /admin/retention/run`) and the audit crawl job (Slice 4, `POST /admin/audit/run`). |
| Dashboard | `dashboard/` (Next.js) | `/orders/feed/ws` live all-orders table + `/orders/:id/thread/ws` per-order detail (Slice 2), eval scorecard + approval queue (Slice 3), audit trigger + status (Slice 4). Single page — see `DESIGN.md`. |

## The 8 rules that must never break

1. **Order + OutboxEvent write in one transaction.** Never split it — that's the whole point of the outbox pattern.
2. **`tenantId` is always server-derived** (`tenantAuth.ts`), never read from a client body/param.
3. **`loyalty_ledger` is append-only.** No update, no delete. Ever.
4. **The consumer never crashes on bad input.** Log and skip, per the Error & Rescue Map.
5. **No process supervisor for the demo.** A terminal `kill` command is the accepted, reviewed failure-recovery demo mechanism.
6. **`loyalty_balances` is a cache, never the source of truth.** Always re-derivable by resumming `loyalty_ledger`; updated via atomic `$inc`, corrected via `reconcileBalance`.
7. **`requiresApproval` is always computed server-side** (`computeRequiresApproval` in `retentionAgent.ts`), never trusted from the LLM's own output — Locked Contract #10's guardrail posture.
8. **The audit agent's artifact store is a pointer, not the collection.** `agent_decisions.payload.artifactRef` names a GridFS file (bucket `audit_artifacts`); it never inlines the raw crawl JSON into the decision doc.

## Collections

`orders` · `outbox_events` · `loyalty_ledger` (append-only) · `loyalty_balances` (materialized, Slice 2) · `agent_decisions` (tagged union: `retention` | `audit`) · `retention_send_counters` (Slice 3 daily send-cap, atomic reserve/release) · `audit_artifacts.{files,chunks}` (Slice 4 GridFS bucket)

## Current build status

Slices 0-5 shipped: storefront + marketplace channels, materialized/reconciled loyalty balance proven correct under concurrent writes, live WebSocket dashboard feed, a real Gemini-backed retention agent (guardrails, human-approval queue, repair-then-skip on malformed output, daily send-cap, 18-scenario eval), a real audit agent (PageSpeed Insights + HTML heuristics, Gemini-written fixes, async job/status endpoint, GridFS artifact pointer), and Slice 5 polish: 2 observability metrics (`GET /metrics`), the named pino log points, and a genuinely-reproduced failure-recovery demo that surfaced and fixed 2 real bugs (consumer restart never resumed a backlog; the fix for that then double-processed a partially-completed order — see README's Observability section and `appendEarnEntry`'s idempotency comment). Only the POS channel (cut, not deferred) and a live AWS deploy (optional per the design doc, not done) remain. Don't assume anything beyond this exists — check `README.md`'s status line before referencing a feature.
