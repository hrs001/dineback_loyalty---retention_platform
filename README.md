# Loop

Event-driven order, loyalty & retention platform for independent restaurants — a portfolio project built for the Owner.com Senior Backend Engineer application.

**Status: Slices 0-4 shipped and verified.** One order flows end-to-end: storefront/marketplace API → Mongo outbox transaction → Change Stream → loyalty ledger → retention-agent decision → audit log, pushed live to the dashboard over WebSocket. Marketplace webhooks are idempotent and signature-verified; failures get a real retry + dead-letter queue with an admin replay endpoint. The loyalty balance is a materialized, atomically-updated view over the append-only ledger — proven correct under concurrent same-millisecond writes (see the Slice 2 concurrency test), never a naive read-modify-write. The retention agent makes a real, structured-output LLM call (Gemini, free tier) grounded in each customer's order history, with a guardrail computed server-side (never trusted from the model), a human-approval queue for anything above the threshold, a repair-then-skip retry on malformed output, and an 18-scenario eval (`npm run eval`) scored on decision plausibility, not exact-match. The storefront audit agent (subsystem D) reuses that same guardrailed-agent plumbing: an async crawl job wraps PageSpeed Insights for real page-speed/accessibility signals, scores structured-data and menu completeness from the raw HTML, then has Gemini write a grounded audit + 2-3 fixes — with a status endpoint the dashboard polls, and a GridFS artifact pointer (not the collection itself) for the raw Lighthouse JSON per Locked Contract #4.

**LLM provider note:** Anthropic's Claude API has no persistent free tier, so this project uses Google Gemini's free tier for the retention agent instead — see the design doc's Open Questions for the tradeoff (Gemini vs. Groq vs. cheap-but-not-free Claude Haiku vs. self-hosted Ollama).

## The problem

Independent restaurants run orders through multiple channels at once — their own site, marketplace apps, phone, walk-in — and those orders need to land reliably in a kitchen system without duplication, loss, or delay. Every completed order is also a signal: it should update a loyalty balance correctly under concurrent writes, and it should feed a system that knows *this specific customer* hasn't ordered in three weeks and might respond to a win-back offer. Loop is: **reliable, idempotent, event-driven order processing that feeds correctness-critical financial state (loyalty) and intelligent, autonomous customer engagement (retention) — multi-tenant, at scale.**

See `docs/Loop - Vertical-Slice Design Doc.md` for the full design history — three review passes (office-hours, eng-review, ceo-review), all locked decisions, and why the plan looks the way it does.

## Architecture

```
  storefront ─┐
  marketplace ─┼─▶ [API: Fastify] ──▶ Order + outbox txn (Mongo, same txn)
              ─┘        │
                        │                              Change Stream (tails outbox)
                        │                                        │
                        ▼                                        ▼
              [Admin API: /admin/replay]              [Consumer process]
              (API-key gated, tenantId                          │
               derived from auth)                                ▼
                        │                          agent_decisions (tagged: retention | audit)
                        ▼                                        │
              [Agent worker: retention + audit] ◀── BullMQ ──────┘
                                                   (batched per-tenant queries)
                        │
                        ▼
              [Next.js dashboard] ◀── WebSocket live feed (Slice 2)
```

## Running it

```bash
docker compose up --build
```
API on `http://localhost:8000`, dashboard on `http://localhost:3000`.

### Local dev (no Docker for the app processes)
```bash
docker compose up -d mongo redis   # infra only
npm install
cd api && cp .env.example .env     # add a free GEMINI_API_KEY — see note below
npm run dev                              # API
npm run build && node dist/consumer.js         # consumer, separate process
npm run build && node dist/agentWorker.js      # agent worker (retention + audit), separate process
cd ../dashboard && npm run dev     # dashboard
```

**Local-dev Mongo note:** the replica set (needed for transactions + Change Streams) advertises its member as `mongo:27017`, the Docker-internal hostname. Containers resolve this fine on the Docker network. For **host-side** processes (running `api`/`consumer` directly, not via `docker compose up`), either add `127.0.0.1 mongo` to `/etc/hosts`, or use `MONGO_URI=mongodb://localhost:27017/loop?directConnection=true` (skips replica-set topology discovery — works for a single-node local replica set).

**Gemini API key:** get a free one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and set `GEMINI_API_KEY` in `api/.env` (and pass it to `docker compose` via the `GEMINI_API_KEY` shell env var — see `docker-compose.yml`). Without a key, order ingestion and the dashboard still work end-to-end; every retention decision just lands as a logged `failed` row via Locked Contract #5's retry-then-skip path instead of a real decision.

### Tests
```bash
cd api && npm test
```
70 tests passing: outbox transaction atomicity (T6 — a simulated crash mid-transaction leaves neither document persisted), the full E2E thread, tenant isolation, marketplace payload normalization, idempotent duplicate delivery, signature rejection, DLQ + `/admin/replay`, the materialized-balance concurrency proof, the live WebSocket feed (both the per-order thread and the tenant-wide `GET /orders`/`GET /orders/feed/ws` list the dashboard's order table uses), the retention agent's guardrail/repair-retry/daily-cap/approval-queue logic (Locked Contracts #1/#3/#5/#6), the audit agent's crawl-signal scoring + async job/status endpoint, the two Slice 5 metrics, and the failure-recovery backlog-sweep + ledger-idempotency fix (see Observability below). Tests use fake LLM/fetch clients throughout — never a real network call, regardless of whether `GEMINI_API_KEY` happens to be set.

**Don't run `npm run dev:worker` against the same Redis instance while running tests** — Slice 4's admin test spins up its own short-lived BullMQ worker on the real `audit-agent` queue, and a concurrently-running dev worker will race it for jobs. Stop the dev worker first, or point one of them at a different Redis DB index.

### Retention agent batch sweep (demo)

The batch sweep (Locked Contract #6) runs on a 24h schedule per tenant — not something you'll naturally see fire during a demo. Two ways to trigger it on demand, both against a real Gemini call:

```bash
curl -X POST http://localhost:8000/admin/retention/run -H "x-admin-key: dev-admin-key"
```
Runs the sweep against whatever orders already exist. On a fresh dashboard with only just-placed orders, every customer looks "just ordered" (0 days since their last order) — not a win-back candidate.

To actually see a win-back decision, use the two demo-seed endpoints (also two buttons on the dashboard, next to "Place a demo order") that backdate order history and immediately trigger the sweep:
```bash
curl -X POST http://localhost:8000/admin/retention/seed-stale -H "x-admin-key: dev-admin-key"
curl -X POST http://localhost:8000/admin/retention/seed-approval -H "x-admin-key: dev-admin-key"
```
`seed-stale` backdates 3 customers 30/45/60+90 days — a real, plausible win-back gap. `seed-approval` seeds one customer with a much longer lapse (150-210 days) and a history of $150+ orders, biased toward the LLM recommending an offer big enough to trip Locked Contract #1's guardrail (>15% percent_off or >$10 free_item) — for exercising the dashboard's approve/reject buttons without waiting for a real customer to need one. **Not a guarantee**: live-tested at $510 total spend across 150-210 day gaps and Gemini still chose exactly 15% (the boundary, not over it) — the model appears to converge on "15% off" as a safe default regardless of how extreme the input, since nothing in the prompt tells it where the threshold sits (Locked Contract #10: the guardrail is enforced on the model's output, never leaked into its instructions). Re-running the seed (each click uses a fresh random customer) is the honest way to eventually see one cross — no synthetic decisions are inserted to force it.

**Seeded orders never went through the consumer** (they're inserted directly via `demoSeed.ts`, not `createOrder`), so their only decision comes from the batch sweep, which is customer-scoped, not order-scoped — the sweep evaluates a customer's whole history on a cadence, not one triggering order. Clicking a seeded order's row on the dashboard shows that decision via a fallback: `GET /orders/:id/thread` tries the order's own decision first and only falls back to "the customer's latest decision" when the order has none of its own, so it never masks a real per-order decision — a customer with two order-triggered decisions still sees each order's own, never the other's.

### Retention agent eval
```bash
cd api && GEMINI_API_KEY=... npm run eval
```
Runs 18 hand-written golden-set customer scenarios against the real Gemini call (Locked Contract #7) — 10 guardrail/boundary-flavored, 5 discretionary-judgment ("long-time customer, no urgency signal → should not pick urgency tone"), 3 prompt-injection resistance checks. Scored on decision *characteristics*, not exact-match; illustrative, not statistically rigorous. Deliberately not part of `npm test` — it makes real API calls and needs a key, matching the same "needs live infra, stays manual" boundary the CI setup below draws for the E2E tests. Writes `api/eval-results.json`, served at `GET /eval-results` and shown on the dashboard scorecard.

**Real published result (2026-09-03): 17/18 passed (94%).** The 1 failure was the Gemini API returning a transient `503 UNAVAILABLE` ("high demand") on that scenario after the repair-retry also hit it — not a plausibility failure of the agent's judgment. An earlier run against the non-lite `gemini-3.6-flash` model hit its free-tier daily quota after ~8 calls (20 requests/day) — switched the default model to `gemini-flash-lite-latest`, which has a much more workable free-tier quota for a project this size; see `api/eval-results.json` for the full per-scenario breakdown.

### Storefront audit agent
```bash
curl -X POST http://localhost:8000/admin/audit/run \
  -H "x-admin-key: dev-admin-key" -H "Content-Type: application/json" \
  -d '{"url": "https://a-restaurant-site.com"}'
curl http://localhost:8000/admin/audit/<jobId>/status -H "x-admin-key: dev-admin-key"
```
Async crawl job (subsystem D) — PageSpeed Insights supplies real `pageSpeedScore`/`mobileUsabilityScore` (performance/accessibility Lighthouse categories); `structuredDataScore`/`menuCompletenessScore` are heuristics scored from the raw HTML (JSON-LD `Restaurant`/`Menu` detection, menu-link + image-count), not Lighthouse metrics — disclosed as heuristics, not overclaimed as certified checks. Gemini then writes 2-3 grounded fixes from those real signals, reusing the retention agent's repair-retry-then-skip. The raw PSI JSON is stored in GridFS; `agent_decisions.payload.artifactRef` is a pointer to it (`gridfs:<id>`), never the artifact itself (Locked Contract #4). Also visible on the dashboard.

**Known limitation, disclosed honestly:** PageSpeed Insights works without an API key, but its anonymous quota is quite low and gets exhausted quickly under repeated testing (confirmed live: a `429` after a handful of calls in one session) — the crawl failure path (a `failed` agent_decisions row with a clear reasoning string, never a crash) is exactly what's designed for this. Set `PAGESPEED_API_KEY` (free from Google Cloud Console — enable the "PageSpeed Insights API" on the project the key belongs to, or it'll reject the key with a 401) for a much higher quota. Under Docker Compose, pass it the same way as `GEMINI_API_KEY` — as a shell env var, since the `agent-worker` service (where the audit job runs) only forwards what's explicitly listed in `docker-compose.yml`'s `environment:` block:
```bash
GEMINI_API_KEY=... PAGESPEED_API_KEY=... docker compose up -d agent-worker
```

### Benchmark
```bash
cd api && npm run benchmark [count] [dupRate]
```
Fires a concurrent, intentionally-duplicated burst of marketplace webhook deliveries and reports throughput + latency percentiles. **Real numbers from a local run** (M-series laptop, single API instance, no load balancer):

| Metric | Value |
|---|---|
| Requests | 235 (200 unique orders + 35 intentional duplicate deliveries, ~15% dup rate) |
| Failures | 0 |
| Throughput | 772.7 req/s |
| p50 latency | 174.6ms |
| p95 latency | 273.2ms |
| p99 latency | 275.3ms |
| **Idempotency** | **Verified: exactly 200 unique orders persisted from 235 requests** — duplicate webhook deliveries never create duplicate orders |

These are local-machine numbers, not a production load test — see `ARCHITECTURE.md`'s "what's deliberately not here" for scope boundaries.

**Channel scope:** storefront and marketplace only. POS is the same normalization pattern as marketplace (webhook → canonical `Order`) and was explicitly **cut, not deferred**, to fund Slice 3's eval work instead — see the design doc's roadmap.

## Observability

Pino structured logs at every point the design doc names: `outbox-write` (order accepted), `change-stream event received` (consumer picks it up), `llm-call-start`/`llm-call-end` (with latency), `guardrail-decision` (an offer crosses the approval threshold), and every DLQ/replay rescue action. Two metrics, gated behind the admin key like the other operational endpoints:

```bash
curl http://localhost:8000/metrics -H "x-admin-key: dev-admin-key"
```
```json
{
  "webhook": { "total": 12, "succeeded": 12, "successRate": 1 },
  "eventLag": { "sampleSize": 12, "avgLagMs": 850 }
}
```
Both are honest about their own limits rather than dressed up as a real metrics stack: `webhook` is an in-memory counter (resets on process restart, this API instance only); `eventLag` is real and persisted (`outbox_events.createdAt` → `processedAt`, averaged over the most recent events for the tenant) but a single-process average, not a percentile histogram. Both are also on the dashboard as KPI tiles, live.

### Failure-recovery demo

The claim: kill the consumer mid-processing, restart it, confirm nothing is lost *and nothing is double-processed*. This is real, not staged — reproduce it yourself:

```bash
# 1. Infra + API running, but NOT the consumer yet.
docker compose up -d mongo redis
cd api && npm run dev &

# 2. Place an order — it lands in Mongo as `received`, outbox event processed:false.
curl -s -X POST http://localhost:8000/orders \
  -H "x-storefront-key: dev-storefront-key" -H "Content-Type: application/json" \
  -d '{"customerId":"cust_demo","items":[{"name":"Suya Platter","price":18,"qty":1}]}'

# 3. Start the consumer, and kill -9 it the instant it starts the LLM call —
#    this reliably lands the kill mid-flight regardless of Gemini's latency.
npx tsx --env-file=.env src/consumer.ts > /tmp/consumer.log 2>&1 &
until grep -q "llm-call-start" /tmp/consumer.log; do sleep 0.02; done
pkill -9 -f "tsx.*consumer.ts"

# 4. Inspect state: the order is still "received", the outbox event is
#    still processed:false, and the ledger has its earn entry (that write
#    happens BEFORE the LLM call) — nothing was silently dropped.

# 5. Restart the consumer. It finds the unprocessed backlog on startup,
#    re-runs it, and finishes — WITHOUT duplicating the ledger entry, even
#    though the ledger write from step 3 already happened once.
npx tsx --env-file=.env src/consumer.ts
```
This exact sequence surfaced two real bugs while building this slice, both fixed and covered by `slice5.failureRecovery.test.ts`:
1. **Nothing resumed a killed consumer's backlog.** A plain `collection.watch()` only sees inserts *after* it starts — an event written before a crash sat `processed: false` forever on restart. Fixed with a startup catch-up sweep (`createdAt < startedAt`, so it can never overlap the live stream).
2. **The naive fix double-processed.** Once the backlog sweep existed, restarting after a kill that landed *after* the ledger write but *before* the LLM call finished silently doubled the customer's points. Fixed with a unique `{tenantId, orderId, type}` index on `loyalty_ledger` — `appendEarnEntry` now treats the resulting duplicate-key error as "already recorded," not a failure.

A third real bug in the same family, found via code review rather than a live kill test: `getLatestDecisionForCustomer` looked up a retention decision by customer only, sorted by latest timestamp — so a customer with two orders would show the *newer* order's decision on the *older* order's thread, and a retry couldn't be made idempotent because the decision had no `orderId` to key on at all. Fixed by adding `orderId` to `AgentDecision`'s retention variant, a `{tenantId, orderId, agentType}` partial-unique index (partial, not sparse — batch-sweep decisions have no `orderId` and must never collide on its absence), and a new `getDecisionForOrder` lookup — same idempotent-insert-catch pattern as `appendEarnEntry`. Covered by `slice3.decisionOrderScoping.test.ts`.

## Why this project

Reliability plumbing (outbox pattern, idempotent webhooks, DLQ) is now a commodity portfolio pattern — a landscape search during design confirmed several near-identical GitHub repos running the same stack. The differentiator here is the retention agent: bounded, structured-output decisions with real guardrails (send caps, human-approval queue, full audit log of *why*) **and a golden-set eval proving the decisions are actually good, not just well-formed** — the exact distinction Owner's own engineering leadership draws when they talk about their AI rebuild.

## What I'd do differently at 10x scale

Named honestly rather than glossed over — these are the specific places this build takes a shortcut that's fine at demo scale and wrong at real scale:

- **Change-stream resume tokens, not a `createdAt` boundary.** The consumer's startup backlog sweep (`createdAt < startedAt`) is correct but leaves a theoretical few-millisecond gap between capturing `startedAt` and the change stream actually starting. A real deployment persists the stream's resume token (e.g. in its own collection) and passes `resumeAfter` on every restart — zero gap, no clock-based reasoning at all.
- **In-memory webhook counters → a real metrics backend.** `GET /metrics`'s webhook success rate resets on every process restart and only reflects whichever API instance happens to answer the request. At scale this is Prometheus/CloudWatch with per-instance labels, not a module-level counter.
- **One admin API key per tenant, not RBAC.** Fine for a single operator; a multi-seat team needs real roles (who can replay vs. who can approve a retention send vs. who can read metrics).
- **Single API instance, no load balancer.** The benchmark numbers above are one process on one machine. Horizontal scaling changes the in-memory webhook counter's meaning entirely (see above) and needs the LLM/PSI rate limits budgeted per-instance, not globally.
- **The retention and audit workers share one process** (`agentWorker.ts`) because they share identical job-queue infrastructure at this scale. Past a certain load, these become separate scalable fleets — a crawl-heavy audit backlog shouldn't be able to starve retention's daily sweep.
- **No real load test.** The benchmark proves throughput/idempotency at ~200 concurrent orders on one machine; "thousands of tenants" is proven in index *shape* (tenantId-leading compound indexes throughout), never in an actual load test against that volume.
- **PageSpeed Insights' keyless quota and Gemini's non-lite free tier both proved too small for even light manual testing this session** (see the Storefront audit agent and Retention agent eval sections above) — a real deployment needs paid-tier keys for both, sized to actual traffic, not "whatever the free tier happens to allow today."

## What's built vs. planned

| Slice | What it proves | Status |
|---|---|---|
| 0. Walking skeleton | Order → outbox txn → ledger → canned agent decision → audit log, one proven E2E thread | **Shipped** |
| 1. Real ingestion | Marketplace channel, idempotency, signature verification, DLQ + replay, benchmark | **Shipped** |
| 2. Real ledger | Concurrent-write correctness, WebSocket live feed | **Shipped** |
| 3. Real retention agent | Real (Gemini) LLM call, guardrails, human-approval queue, eval | **Shipped** |
| 4. Real audit agent | Lighthouse-wrapped (PageSpeed Insights) storefront audit, async job + status endpoint, reuses C's plumbing | **Shipped** |
| 5. Polish & demo | README (problem statement, architecture, benchmarks, eval results, 10x section, POS-cut note), pino structured logging + 2 visible metrics, a genuinely reproduced failure-recovery demo (2 real bugs found and fixed in the process) | **Shipped** — live deploy not attempted, see below |

Full contract-by-contract detail: `docs/Loop - Vertical-Slice Design Doc.md`. Test coverage requirements: `docs/Loop - Test Plan.md`.

**Live deploy:** not done, but the config is ready. The design doc marks this "if time allows," and account setup/costs are a call for whoever's running this repo, not something to do silently — even the free-tier version below needs real signups. See `DEPLOY.md` for a free-tier runbook (Atlas + Upstash + Fly.io + Vercel) with `api/fly.toml` already written for the API/consumer/agent-worker split. A real AWS deploy (Fargate or a single EC2 box behind an ALB, per the brief's own suggestion) is also happy to do — just say the word.
