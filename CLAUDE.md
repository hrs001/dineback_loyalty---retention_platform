# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Event-driven order/loyalty/retention portfolio project (Owner.com application) — Fastify + TypeScript API, native MongoDB driver (transactions + Change Streams, no ORM), BullMQ/Redis for agent job scheduling, Next.js dashboard. See `README.md` for the architecture diagram and `docs/Loop - Vertical-Slice Design Doc.md` for the full design history and every locked decision (schemas, guardrail thresholds, tenant-isolation model, why the build is sequenced the way it is).

## Commands

### Run everything (Docker Compose)
```bash
docker compose up --build
```
API on `http://localhost:8000`, dashboard on `http://localhost:3000`.

### API dev (no Docker for the app process — infra still needs `docker compose up -d mongo redis`)
```bash
cd api && npm run dev          # tsx watch, API only
node dist/consumer.js          # consumer is a SEPARATE process, not part of the API
```

### Tests
```bash
cd api && npm test             # vitest — requires a running Mongo replica set (see README's local-dev Mongo note)
```

### Dashboard dev
```bash
cd dashboard && npm run dev
```

## Architecture

- **`api/src/server.ts`** — the API process (Fastify). Owns HTTP routes only. Never spawns or manages the consumer process (Locked Contract #8 in the design doc: a process supervisor was considered and explicitly cut after outside-voice review — the failure-recovery demo is a terminal `kill` command against the consumer, not an in-app button).
- **`api/src/consumer.ts`** — the Consumer process entrypoint, run separately (`node dist/consumer.js` or its own Compose service). Tails `outbox_events` via a Mongo Change Stream (`api/src/services/consumer.ts`) — never a polling worker (Locked Contract #2).
- **`api/src/services/orderIngestion.ts`** — writes `Order` + `OutboxEvent` in one Mongo transaction (`withTransaction` in `api/src/lib/mongo.ts`). This is the outbox pattern the whole reliability story rests on — see the T6 test (`api/src/test/slice0.e2e.test.ts`) for the atomicity proof.
- **`api/src/services/tenantAuth.ts`** — Locked Contract #9. `tenantId` is ALWAYS derived server-side from the request's auth context: a storefront API key (`resolveTenantFromStorefrontKey`), a per-tenant HMAC webhook secret for marketplace (`verifyMarketplaceWebhook` — tenantId arrives in the URL path but is only trusted once the signature verifies against THAT tenant's secret), or a per-tenant admin key (`resolveTenantFromAdminKey`, Locked Contract #3 — NOT one global admin key). **Never read `req.body.tenantId` or any client-supplied tenant field anywhere in this codebase.**
- **`api/src/routes/marketplace.ts`** — `POST /webhooks/marketplace/:tenantId`. Normalizes the marketplace's own payload shape (`order_id`/`customer.external_id`/`line_items[].unit_price_cents`) into the canonical `Order`. Idempotent: `createOrder` catches the unique-index violation on `{tenantId, channel, externalOrderId}` and returns the already-persisted order instead of erroring.
- **`api/src/routes/admin.ts`** — `POST /admin/replay`, API-key gated. Reprocesses every unreplayed row in `dead_letter_events` for the caller's tenant through the same `processOutboxEvent` the consumer uses. Also hosts `POST /admin/retention/seed-stale` and `POST /admin/retention/seed-approval` (demo-only, see `demoSeed.ts` below) and the approval-queue endpoints (`GET /admin/retention/pending`, `POST /admin/retention/:id/approve|reject`).
- **`api/src/services/demoSeed.ts`** — demo-only fixture data for the retention agent's batch sweep, which otherwise only fires on a 24h schedule. Inserts backdated `Order` rows directly, intentionally bypassing `createOrder`'s outbox transaction — these are fixture history, not live orders moving through the pipeline, so there's nothing for the consumer to process. `seedHighValueLapsedCustomer` is biased toward tripping the approval guardrail but is NOT a guarantee — real-world testing found Gemini converges on exactly 15% (the boundary, not over it) even at $500+ spend and 150-210 day gaps, since nothing in the prompt tells the model where the threshold sits (Contract #10).
- **`api/src/routes/orders.ts`** — `POST /orders` (storefront ingestion), `GET /orders` + `GET /orders/feed/ws` (all of the caller's tenant's orders, live via a Change Stream watch on the `orders` collection — backs the dashboard's order thread table), and the existing per-order `GET /orders/:id/thread` + its WS variant. All tenant-scoped through `resolveTenantFromStorefrontKey`/`resolveTenantFromStorefrontKeyQuery` — never a client-supplied tenant.
- **`api/src/services/consumer.ts`** — on a processing failure, retries once, then calls `sendToDeadLetter` (`api/src/services/dlq.ts`) instead of dropping the event. A genuinely malformed event (missing required fields) is logged and skipped, never retried or DLQ'd — there's nothing a retry fixes there.
- **`api/src/models/types.ts`** — canonical types for `Order`, `OutboxEvent`, `LoyaltyLedgerEntry` (append-only — no update/delete path exists on purpose), `DeadLetterEvent`, and `AgentDecision` (a tagged union on `agentType: 'retention' | 'audit'` — the retention agent and the future audit agent share infrastructure but never assume identical payload shapes; see Locked Contract #4).
- **`api/src/services/retentionAgent.ts`** — Slice 3: real structured-output decisions via Gemini (`api/src/services/llm.ts`, chosen for its free tier — see the design doc's Open Questions for the provider tradeoff). `computeRequiresApproval` enforces Locked Contract #1's guardrail server-side — never trust `requiresApproval` from the model itself (Contract #10). `decideForCustomer` implements Contract #5's one-repair-prompt-retry-then-skip. `runRetentionBatch` implements Contract #6's one-query-per-tenant + concurrency-capped sweep, scheduled via BullMQ (`api/src/agentWorker.ts`, its own process — never run inside the API or Consumer). The daily send-cap (Contract #1) is enforced by an atomic reserve/release against `retention_send_counters`, the same pattern as the loyalty balance's `$inc`. `npm run eval` (Locked Contract #7) is a manual, real-API script — deliberately not part of `npm test`. `recordRetentionDecision` (the consumer's per-order path) writes `orderId` on the decision and is idempotent against a retry via a partial-unique `{tenantId, orderId, agentType}` index, same catch-the-duplicate-key pattern as `appendEarnEntry`; `runRetentionBatch`'s decisions never set `orderId` (no single triggering order) and aren't subject to that index. `getDecisionForOrder` (not `getLatestDecisionForCustomer`) is what the dashboard's per-order thread must use — the customer-scoped lookup shows the wrong order's decision once a customer has placed more than one order.
- **`api/src/services/auditAgent.ts`** — Slice 3, subsystem D: `crawlSignals` wraps PageSpeed Insights (real `pageSpeedScore`/`mobileUsabilityScore`) plus this project's own HTML heuristics (`structuredDataScore`/`menuCompletenessScore` — documented as heuristics, never oversold as Lighthouse metrics). `generateAuditWriteup` reuses Contract #5's repair-retry-then-skip to turn those signals into Gemini-written fixes. `runAudit` writes the `agent_decisions` row and a GridFS artifact pointer (bucket `audit_artifacts`) — never inline the raw crawl JSON into the decision doc (Locked Contract #4). Runs as an async BullMQ job on the `audit-agent` queue in `api/src/agentWorker.ts`, with `POST /admin/audit/run` + `GET /admin/audit/:jobId/status`.
- **`api/scripts/benchmark.ts`** — fires a concurrent, intentionally-duplicated burst at the marketplace webhook and reports throughput/latency. Real numbers published in `README.md`.
- **`api/src/services/metrics.ts`** — Slice 5: the design doc's 2 required metrics. `recordWebhookOutcome`/`getWebhookStats` is an in-memory, process-lifetime counter (documented as a shortcut in README's "what I'd do differently at 10x"); `getEventLagStats` is real, computed from `outbox_events.createdAt`→`processedAt`. Exposed at `GET /metrics` (`api/src/routes/metrics.ts`, admin-key gated) and on the dashboard's KPI row.

## Key constraints to preserve when touching this code

- Every query touching `Order`/`loyalty_ledger`/`agent_decisions` must be scoped by a server-derived `tenantId` (`tenantAuth.ts`) — never a client-supplied one, even as a fallback.
- The Order + OutboxEvent write must stay inside a single Mongo transaction. Don't split it into two writes "for simplicity" — that's the bug the outbox pattern exists to prevent.
- `loyalty_ledger` is append-only. Never add an update or delete path to it, even for corrections — write a compensating entry instead.
- The consumer process must never crash on a malformed outbox event — log and skip (see the Error & Rescue Map in the design doc).
- `startConsumer` runs a startup backlog sweep (`outbox_events` with `processed: false` and `createdAt < startedAt`) before its live change-stream listener attaches — a plain `.watch()` only sees inserts after it starts, so without this sweep a restart after a crash would never resume an already-written, unprocessed event. Don't remove this sweep or "simplify" it back to a bare `.watch()`.
- `appendEarnEntry` must stay idempotent per order (unique `{tenantId, orderId, type}` index on `loyalty_ledger`, duplicate-key error treated as "already recorded"). This is load-bearing for the backlog sweep above: a kill landing after the ledger write but before the LLM call completes means a restart legitimately reprocesses the same order, and without this the retry would double the customer's points. Verified live in Slice 5 — see README's Observability section.
- Don't build a process supervisor for the demo-control flow — that was proposed and explicitly reversed after outside-voice review (design doc, Locked Contract #8).
- `requiresApproval` on a retention decision must always be recomputed server-side from `offerType`/`offerValue` — never read or trust a `requiresApproval` claim from the LLM's own output (Locked Contract #10).
- The dashboard's per-order thread must try `getDecisionForOrder` (by `orderId`) FIRST, only falling back to `getLatestDecisionForCustomer` (by `customerId`) when no order-scoped decision exists — never the customer-scoped lookup alone, which would show the wrong order's decision once a customer has more than one order-triggered decision. The fallback exists for orders with no order-scoped decision at all (e.g. `demoSeed.ts`'s backdated fixture orders, whose only decision comes from the customer-scoped batch sweep) — it must never override a real per-order decision once one exists.
- The agent worker (`api/src/agentWorker.ts`, hosts both the retention and audit BullMQ workers) is its own process, same separation-of-processes principle as the Consumer — never fold it into the API or Consumer process.
- `docker-compose.yml` only forwards env vars a service explicitly lists under its own `environment:` block — setting a key in `api/.env` does NOT make it visible to a container. Hit live: `PAGESPEED_API_KEY` was set in `.env` but missing from `agent-worker`'s `environment:`, so every audit crawl silently fell back to PageSpeed Insights' keyless quota and 429'd. Check `docker-compose.yml` directly when adding a new env-configured feature, don't assume `.env` is enough.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
