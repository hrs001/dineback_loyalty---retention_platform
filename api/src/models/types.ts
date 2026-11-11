/**
 * Canonical Order model — Locked Contract (design doc "Next Steps #1").
 * Slice 0 only ever writes channel: 'storefront'; 'marketplace'/'pos' arrive
 * in Slice 1 once the per-channel payload normalization is speced.
 */
export interface OrderItem {
  name: string;
  price: number;
  qty: number;
}

export interface Order {
  _id: string; // order id (uuid), also used as the idempotency key
  tenantId: string; // ALWAYS server-derived — Locked Contract #9
  customerId: string;
  channel: "storefront" | "marketplace" | "pos";
  /**
   * The channel's own order id (Slice 1). Combined with tenantId + channel,
   * this is the idempotency key that makes duplicate webhook delivery safe —
   * a unique index on {tenantId, channel, externalOrderId} rejects the
   * second insert instead of creating a duplicate order.
   */
  externalOrderId?: string;
  items: OrderItem[];
  amount: number;
  status: "received" | "routed";
  createdAt: Date;
}

/**
 * Outbox event — written in the SAME Mongo transaction as the Order
 * (Locked Contract: outbox pattern). The Consumer process tails this
 * collection via a Change Stream (Locked Contract #2) rather than polling.
 */
export interface OutboxEvent {
  _id?: import("mongodb").ObjectId;
  orderId: string;
  tenantId: string;
  type: "order.completed";
  payload: Order;
  createdAt: Date;
  processed: boolean;
  /** Slice 5 observability: set when the consumer marks it processed — createdAt→processedAt is the real "event lag" metric. */
  processedAt?: Date;
}

/**
 * Dead-letter queue (Slice 1) — a malformed or repeatedly-failing outbox
 * event lands here instead of being silently dropped. `/admin/replay`
 * reprocesses entries from this collection.
 */
export interface DeadLetterEvent {
  _id?: import("mongodb").ObjectId;
  originalEventId: string; // stringified ObjectId of the source OutboxEvent
  tenantId: string;
  payload: Order;
  error: string;
  failedAt: Date;
  replayed: boolean;
}

/**
 * Append-only loyalty ledger entry (design doc §B: "points as an append-only
 * transaction log, not a mutable balance field"). Balance is always a
 * derived sum over these rows — there is intentionally no update/delete path.
 */
export interface LoyaltyLedgerEntry {
  _id?: import("mongodb").ObjectId;
  tenantId: string;
  customerId: string;
  orderId: string;
  type: "earn" | "redeem";
  points: number;
  createdAt: Date;
}

/**
 * Materialized balance view (Slice 2). ALWAYS derivable by resumming
 * `loyalty_ledger` for {tenantId, customerId} — this collection is a cache
 * for fast reads, never the source of truth. Kept current via atomic $inc
 * on every ledger append (safe under concurrent writes — see Slice 2
 * concurrency test) and periodically reconciled against the ledger to
 * catch any drift.
 */
export interface LoyaltyBalance {
  _id?: import("mongodb").ObjectId;
  tenantId: string;
  customerId: string;
  balance: number;
  lastReconciledAt: Date;
}

/** Locked Contract #1 — retention agent structured output. */
export interface RetentionDecisionPayload {
  customerId: string;
  action: "send" | "skip";
  tone: "casual" | "appreciative" | "urgency";
  offerType: "percent_off" | "free_item" | "none";
  offerValue: number;
  requiresApproval: boolean;
}

/** Locked Contract #4 (D's artifactRef) — storefront audit agent output. */
export interface AuditDecisionPayload {
  pageSpeedScore: number;
  structuredDataScore: number;
  menuCompletenessScore: number;
  mobileUsabilityScore: number;
  fixes: string[];
  artifactRef?: string; // S3/GridFS pointer to screenshot/Lighthouse report
}

/**
 * Shared agent-decision log (Locked Contract #4) — a tagged union so C and D
 * share infrastructure (queue, tenant model, log table) without ever
 * assuming their payload shapes are identical.
 */
export type AgentDecision =
  | {
      _id?: import("mongodb").ObjectId;
      tenantId: string;
      agentType: "retention";
      /**
       * Set when this decision was triggered by one specific order (the
       * consumer's per-order path). Absent for the scheduled batch sweep's
       * decisions (runRetentionBatch), which evaluate a customer's whole
       * order history on a cadence, not one triggering order.
       */
      orderId?: string;
      timestamp: Date;
      payload: RetentionDecisionPayload;
      reasoning: string;
      /**
       * Slice 3: `pending_approval` when the guardrail (Locked Contract #1)
       * flags `payload.requiresApproval` — the admin approval-queue action
       * (Locked Contract #3) transitions it to `completed` or `rejected`.
       * Never sent while pending; nothing else transitions this field.
       */
      status: "completed" | "failed" | "pending_approval" | "rejected";
    }
  | {
      _id?: import("mongodb").ObjectId;
      tenantId: string;
      agentType: "audit";
      timestamp: Date;
      payload: AuditDecisionPayload;
      reasoning: string;
      status: "completed" | "failed";
    };
