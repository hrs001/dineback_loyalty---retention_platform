# PRD: Loop

**Owner:** Femi Meduna
**Purpose:** Portfolio project for the Owner.com Senior Backend Engineer application
**Deadline:** September 4, 2026, end of day

## 1. Problem statement

Independent restaurants run orders through multiple channels at once — their own site, marketplace apps (DoorDash/UberEats-style), phone, walk-in — and those orders need to land reliably in a kitchen system without duplication, loss, or delay, even when a webhook fires twice, a POS is briefly offline, or three channels report the same order. Every completed order is also a signal: it should update a loyalty balance correctly under concurrent writes, and it should feed a system that knows *this specific customer* hasn't ordered in three weeks and might respond to a win-back offer sent tomorrow instead of a generic blast sent to everyone.

The backend engineering problem underneath: **reliable, idempotent, event-driven order processing that feeds correctness-critical financial state (loyalty) and intelligent, autonomous customer engagement (retention) — multi-tenant, at scale.**

## 2. Why this project, for this employer

Owner.com is an AI-native operating system for independent restaurants. The JD separates frontend from backend explicitly and asks for distributed-systems experience and systems running at scale — this is a role about data integrity and reliability under real operational load, not UI polish. Owner's own public "AI rebuild" writeup describes internal and customer-facing agents that *take action* (an agent predicting a lead's payment volume before a human talks to them, an internal agent doing ~90% of builder coordination). A portfolio project with a real agentic component — a backend service that autonomously decides and acts, with guardrails and an eval proving the decisions are good — reads as unusually on-target for this specific role.

## 3. Target audience for this artifact

Two readers, different time budgets:
1. **A recruiter/hiring manager** skimming the README for ~90 seconds — needs the problem statement, an architecture diagram, honest metrics, and (ideally) a recorded demo GIF.
2. **A live interviewer** walking through the failure-recovery flow and asking follow-up questions — needs the system to actually survive `kill -9` on the consumer process, live, without prep.

## 4. Scope — core subsystems

| Subsystem | What it demonstrates | Priority |
|---|---|---|
| A. Multi-channel order ingestion | Outbox pattern, idempotency, DLQ + replay, benchmark | Table stakes (commodity pattern, confirmed via landscape search) |
| B. Loyalty ledger | Append-only transaction log, concurrent-write correctness, multi-tenant indexing | Table stakes |
| C. Retention agent | Bounded, structured-output LLM decisions with guardrails **and a golden-set eval** | **The differentiator** |
| D. Storefront audit agent | Reuses C's infrastructure (job queue, decision log, tenant model) for platform coherence | Secondary — demonstrates the platform reads as one system, not four demos |

Full contract-level detail (schemas, thresholds, sequencing rationale) lives in `docs/Loop - Vertical-Slice Design Doc.md` — the output of three review passes (office-hours, eng-review, ceo-review), each of which caught and fixed a real gap (see that doc's Locked Contracts and Cross-Model Tension sections).

## 5. Explicitly out of scope

- Full RBAC (a per-tenant API key is the accepted scope for this build).
- The brief's lighter alternate (menu/catalog sync) — considered and explicitly rejected in favor of the full four-subsystem platform.
- A process supervisor for the demo-control flow — proposed, then reversed after review found it added untested risk to the highest-stakes demo moment for a problem that didn't need solving (a terminal `kill` command already met the bar).
- Active prompt-injection filtering — the numeric guardrails (enforced on the LLM's *output*, not its input) are the accepted backstop.
- Load-testing the "thousands of tenants" claim — Slice 2 proves correct index *shape*, not scale under real load.

## 6. Success criteria

- Every slice boundary is independently demoable and recordable — never "coming soon" in the README.
- The failure-recovery demo (kill the consumer mid-processing, show nothing lost) is real, not simulated, from Slice 1 on.
- The retention agent's guardrails are backed by a published eval by Slice 3 — not just schema-conformance checks.
- README carries the problem statement in plain language, an architecture diagram, published benchmark numbers, and a "what I'd do differently at 10x scale" section.

## 7. Constraints

- Solo build, ~12–18 real hours against a deadline of Sept 4 EOD. The design doc's own effort estimate (human-unassisted: 21–27hrs; CC-assisted code generation alone: ~4hrs; realistic working-session estimate: ~10–16hrs) is tight but not impossible — see the design doc's Vertical-slice roadmap for the unit-corrected numbers.
- Stack is locked to match Owner's own JD: TypeScript everywhere, Node.js (Fastify), MongoDB, Redis + BullMQ, Next.js dashboard, AWS deploy target.
