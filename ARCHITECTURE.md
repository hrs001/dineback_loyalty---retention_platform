# ARCHITECTURE.md

Full technical architecture. For the condensed version, see `ARCHITECTURE-ESSENTIALS.md`. For the *why* behind every decision here, see `docs/Loop - Vertical-Slice Design Doc.md` — this file describes the *what*, that file has the review history and rejected alternatives.

## System diagram

```
  storefront ─┐
  marketplace ─┼─▶ [API process: Fastify] ──▶ Order + outbox txn (Mongo, same txn)
              ─┘        │
                        │                                          Change Stream (Mongo, tails outbox)
                        │                                                        │
                        ▼                                                        ▼
              [Admin API: /admin/replay,                              scoring: decide()/audit crawl
               approval-queue]                                                  │
              (API-key gated, tenantId                                          ▼
               derived from auth — Contract #9)                    agent_decisions (tagged union: C/D)
                        │                                                        │
                        ▼                                                        │
              [Retention agent worker]◀── BullMQ ──────────────────────────────┘
              [Audit agent worker]         (batched per-tenant queries,
              (LLM calls, Contract #10       concurrency cap, Contract #6)
               prompt-injection posture)
                        │
                        ▼
              [Next.js dashboard] ◀── WebSocket live feed (Slice 2)
```

Failure-recovery demo: a terminal `kill` command on the consumer process — no in-app supervisor (see Locked Contract #8's reversal in the design doc).

## Data models

### `Order`
```ts
{
  _id: string;              // uuid, also the idempotency key
  tenantId: string;         // ALWAYS server-derived — Contract #9
  customerId: string;
  channel: "storefront" | "marketplace" | "pos";
  items: { name: string; price: number; qty: number }[];
  amount: number;
  status: "received" | "routed";
  createdAt: Date;
}
```

### `OutboxEvent`
Written in the **same Mongo transaction** as the `Order` — the outbox pattern. The Consumer process tails this via a Change Stream, not a poll.
```ts
{
  orderId: string;
  tenantId: string;
  type: "order.completed";
  payload: Order;
  createdAt: Date;
  processed: boolean;
}
```

### `LoyaltyLedgerEntry` (append-only)
No update/delete path exists on this collection, by design. Balance is always `SUM(earn) - SUM(redeem)` over these rows.
```ts
{
  tenantId: string;
  customerId: string;
  orderId: string;
  type: "earn" | "redeem";
  points: number;
  createdAt: Date;
}
```

### `LoyaltyBalance` (materialized, Slice 2)
A fast-read cache over the ledger — never the source of truth, always re-derivable by resumming `loyalty_ledger` for `{tenantId, customerId}`. Kept current by an atomic `$inc` upsert on every ledger append (so two orders completing in the same millisecond both land correctly, no lost update), and correctable by resumming the ledger via `reconcileBalance` if it ever drifts.
```ts
{
  tenantId: string;
  customerId: string;
  balance: number;
  lastReconciledAt: Date;
}
```

### `AgentDecision` (tagged union — Locked Contract #4)
One collection shared by the retention agent (C) and the future audit agent (D). Their `payload` shapes are never assumed identical, even though they share the collection, the tenant model, and (from Slice 3/4 on) the job queue.
```ts
type AgentDecision =
  | { tenantId; agentType: "retention"; orderId?: string; timestamp; payload: RetentionDecisionPayload; reasoning;
      status: "completed" | "failed" | "pending_approval" | "rejected" }   // Slice 3 approval queue
  | { tenantId; agentType: "audit";     timestamp; payload: AuditDecisionPayload;     reasoning; status };

interface RetentionDecisionPayload {   // Locked Contract #1
  customerId: string;
  action: "send" | "skip";
  tone: "casual" | "appreciative" | "urgency";
  offerType: "percent_off" | "free_item" | "none";
  offerValue: number;
  requiresApproval: boolean;           // true when offerValue > $10 or offerType 'percent_off' > 15%
}
```

`requiresApproval` is computed server-side from `offerType`/`offerValue` (`computeRequiresApproval` in `retentionAgent.ts`) — the model is never asked for it and its claim would never be trusted if it were (Locked Contract #10: guardrails enforced on the LLM's *output* data, not delegated to its judgment). A `pending_approval` decision moves to `completed`/`rejected` only via the admin approval-queue endpoints (`POST /admin/retention/:id/approve|reject`, Locked Contract #3).

`orderId` is set when a decision is triggered by one specific order (the consumer's per-order path, `recordRetentionDecision`) and absent for the scheduled batch sweep's decisions (`runRetentionBatch`, which evaluates a customer's whole history on a cadence, not one triggering order). A partial-unique index on `{tenantId, orderId, agentType}` (partial on `orderId` existing, not sparse — sparse would only exclude docs missing every indexed field) makes `recordRetentionDecision` idempotent per order, and `getDecisionForOrder` looks a decision up by its actual triggering order rather than "latest for this customer," which would otherwise show the wrong order's decision on a repeat customer's thread.

### `retention_send_counters` (Slice 3 daily send-cap)
One doc per `{tenantId, date}`, unique-indexed. `runRetentionBatch` reserves a slot with an atomic `findOneAndUpdate({count: {$lt: cap}}, {$inc: {count: 1}})` *before* calling the LLM (releasing it again if the decision turns out to be `skip`) — the same reserve-before-await shape as Slice 2's loyalty balance, so concurrent workers can never push the daily count past the cap.
```ts
{
  tenantId: string;
  date: string;      // YYYY-MM-DD, UTC
  count: number;
}

interface AuditDecisionPayload {
  pageSpeedScore: number;              // real: PageSpeed Insights performance category
  structuredDataScore: number;         // heuristic: JSON-LD Restaurant/Menu detection on raw HTML
  menuCompletenessScore: number;       // heuristic: menu link + image count on raw HTML
  mobileUsabilityScore: number;        // real: PageSpeed Insights accessibility category (proxy)
  fixes: string[];                     // Gemini-written, grounded in the signals above
  artifactRef?: string;                // GridFS pointer (bucket "audit_artifacts"), not the artifact itself
}
```

### Slice 4 audit pipeline (subsystem D)
`crawlSignals` (real, non-LLM) → `generateAuditWriteup` (Gemini, reuses Contract #5's repair-retry-then-skip) → `agent_decisions` row + a GridFS artifact pointer — the same "objective signals in, LLM judgment grounded in them out" shape as the retention agent, run as an async BullMQ job (`audit-agent` queue) with `POST /admin/audit/run` + `GET /admin/audit/:jobId/status`. `pageSpeedScore`/`mobileUsabilityScore` come from wrapping PageSpeed Insights (Locked Contract: tooling locked to Lighthouse/PSI, the "safer default" over self-hosting headless Chrome); `structuredDataScore`/`menuCompletenessScore` are this project's own heuristics over the crawled HTML, not Lighthouse metrics — documented as heuristics, not oversold as certified checks. PSI's keyless quota is low; `PAGESPEED_API_KEY` (optional) raises it.

## Tenant isolation (Locked Contract #9)

`tenantId` is **always** derived server-side from the request's auth context:
- Storefront channel → a per-tenant API key, mapped via `tenantAuth.ts`'s lookup (env-configured for Slice 0; will move to a `tenants` collection as channel count grows).
- Marketplace/POS channels (Slice 1) → webhook signature → tenant.
- Admin routes → the admin API key → tenant.

Every query touching `Order`/`loyalty_ledger`/`agent_decisions` uses only this server-derived value. A client-supplied `tenantId` in a request body is never read, let alone trusted — this closes the IDOR class by construction, not by per-endpoint discipline. Verified in `api/src/test/slice0.e2e.test.ts`.

## Outbox delivery (Locked Contract #2)

MongoDB Change Streams tail the `outbox_events` collection — push-based, not a polling worker. This requires a replica set even in local single-node dev (see README's local-dev Mongo note — this is the single most likely place to lose time on first setup, named explicitly so it isn't a surprise).

## Error & Rescue Map

| Codepath | Failure | Rescue | User sees |
|---|---|---|---|
| Outbox transaction write | Mongo txn abort | Retry once, then log + DLQ | Order resolves or fails visibly |
| Change Stream consumer | Stream disconnects | Auto-reconnect (driver default, resume token) | No visible gap if reconnect is quick |
| Change Stream consumer | Malformed event | Log + skip, never crash the loop | Silent to end user, visible in ops log |
| Webhook ingestion (Slice 1) | Invalid signature | 401, log attempt | Webhook sender sees 401 |
| LLM call (Slice 3) | Timeout / malformed output / provider outage | Retry (2x backoff), then repair-prompt retry, then skip-with-log | No retention message this run, auditable as `status:'failed'` |
| Admin API | Missing/invalid API key | 401, log attempt with source IP | Admin action rejected |

## Retention agent (Slice 3 — shipped)

Structured output via a real Gemini call (Locked Contract #1), retry-then-skip on failure (Contract #5), batched per-tenant queries + BullMQ concurrency cap to avoid N+1 and LLM rate-limit storms (Contract #6), an 18-scenario golden-set eval spanning guardrail boundaries, genuinely discretionary non-boundary decisions, and prompt-injection resistance (Contract #7, `npm run eval` — 17/18 passed on the published run, see README), prompt-injection posture where customer fields are data, never instructions, and guardrails are enforced on the LLM's *output* regardless of what it was told (Contract #10).

## Deployment

Target for a real deployment: AWS (Fargate or a single EC2 + ALB). No traditional DB migrations (additive Mongo schema). No feature flags (no live user base to protect). Rollback: git revert + redeploy. Environment parity: local dev and the deployed demo must run the same Mongo replica-set topology (Atlas M0 satisfies this on the free-tier path below same as AWS DocumentDB or a self-managed replica set would).

A free-tier deployment path is written up in `DEPLOY.md` — Atlas (M0, always a real replica set) + Upstash (Redis/BullMQ) + Fly.io (`api/fly.toml`, one app with three process groups for API/consumer/agent-worker, mirroring `docker-compose.yml`'s split) + Vercel (dashboard). Not run yet — needs real account signups, which is a call for whoever runs this repo.

## What's deliberately not here

Full RBAC, active prompt-injection filtering, a process supervisor for the demo-control flow, load-testing at real "thousands of tenants" scale. See `PRD.md` §5 for the full out-of-scope list and why each was cut, not just deferred silently.
