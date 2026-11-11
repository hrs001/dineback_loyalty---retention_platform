import { MongoServerError } from "mongodb";
import { getDb } from "../lib/mongo.js";
import type { LoyaltyBalance, LoyaltyLedgerEntry, Order } from "../models/types.js";

const DUPLICATE_KEY_ERROR = 11000;

/**
 * Append-only write — no update/delete path exists for this collection by
 * design (design doc §B). One "earn" row per completed order; 1 point per
 * dollar is a placeholder ratio, revisit once real order data exists.
 *
 * Also applies the same delta to the materialized `loyalty_balances` view
 * (Slice 2) via an atomic $inc, so two orders completing in the same
 * millisecond both land correctly instead of racing on a read-modify-write.
 *
 * Idempotent per order (Slice 5 fix): Contract #5's retry-once and the
 * consumer's startup backlog sweep can both legitimately reprocess the
 * same still-`processed: false` outbox event — e.g. a kill -9 that lands
 * after this write succeeds but before the LLM call finishes. Without
 * this, a restart would double the customer's points. The unique
 * `{tenantId, orderId, type}` index (lib/mongo.ts) turns the second
 * attempt's insert into a duplicate-key error, caught here and treated as
 * "already recorded" — the balance delta is applied exactly once either way.
 */
export async function appendEarnEntry(order: Order): Promise<LoyaltyLedgerEntry> {
  const entry: LoyaltyLedgerEntry = {
    tenantId: order.tenantId,
    customerId: order.customerId,
    orderId: order._id,
    type: "earn",
    points: Math.round(order.amount),
    createdAt: new Date(),
  };
  const db = getDb();
  const ledger = db.collection<LoyaltyLedgerEntry>("loyalty_ledger");

  try {
    await ledger.insertOne(entry);
  } catch (err) {
    if (err instanceof MongoServerError && err.code === DUPLICATE_KEY_ERROR) {
      const existing = await ledger.findOne({ tenantId: order.tenantId, orderId: order._id, type: "earn" });
      if (existing) return existing;
    }
    throw err;
  }

  await applyBalanceDelta(order.tenantId, order.customerId, entry.points);
  return entry;
}

/**
 * Atomic upsert against the materialized balance view — $inc is applied
 * server-side by Mongo, so concurrent callers for the same
 * {tenantId, customerId} never lose an update to a race (unlike a
 * find-then-write read-modify-write cycle).
 */
async function applyBalanceDelta(
  tenantId: string,
  customerId: string,
  delta: number
): Promise<void> {
  const db = getDb();
  await db.collection<LoyaltyBalance>("loyalty_balances").updateOne(
    { tenantId, customerId },
    { $inc: { balance: delta }, $setOnInsert: { lastReconciledAt: new Date() } },
    { upsert: true }
  );
}

/**
 * Fast-read path for the materialized view. Never the source of truth —
 * `getBalance` (resumming the ledger) is. Returns 0 for a customer with no
 * balance doc yet rather than treating "no earns" as an error.
 */
export async function getMaterializedBalance(
  tenantId: string,
  customerId: string
): Promise<number> {
  const db = getDb();
  const doc = await db
    .collection<LoyaltyBalance>("loyalty_balances")
    .findOne({ tenantId, customerId });
  return doc?.balance ?? 0;
}

/**
 * Recomputes the materialized balance from the ledger (the source of truth)
 * and overwrites the cached view — the "periodically reconciled" half of
 * the Slice 2 contract, catching drift the atomic $inc path wouldn't (e.g.
 * a bad migration writing the balance doc directly).
 */
export async function reconcileBalance(tenantId: string, customerId: string): Promise<number> {
  const balance = await getBalance(tenantId, customerId);
  const db = getDb();
  await db.collection<LoyaltyBalance>("loyalty_balances").updateOne(
    { tenantId, customerId },
    { $set: { balance, lastReconciledAt: new Date() } },
    { upsert: true }
  );
  return balance;
}

/** Balance is always a derived sum — never a stored, mutable field. */
export async function getBalance(tenantId: string, customerId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .collection<LoyaltyLedgerEntry>("loyalty_ledger")
    .find({ tenantId, customerId })
    .toArray();
  return rows.reduce((sum, row) => sum + (row.type === "earn" ? row.points : -row.points), 0);
}

export async function getLedgerForOrder(
  tenantId: string,
  orderId: string
): Promise<LoyaltyLedgerEntry[]> {
  const db = getDb();
  return db
    .collection<LoyaltyLedgerEntry>("loyalty_ledger")
    .find({ tenantId, orderId })
    .toArray();
}
