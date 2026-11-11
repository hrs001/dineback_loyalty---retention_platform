import { MongoClient, type Db, type ClientSession } from "mongodb";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type {
  Order,
  OutboxEvent,
  LoyaltyLedgerEntry,
  LoyaltyBalance,
  AgentDecision,
  DeadLetterEvent,
} from "../models/types.js";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(env.mongoUri);
  await client.connect();
  db = client.db();
  logger.info({ uri: env.mongoUri }, "mongo connected");
  await ensureIndexes(db);
  return db;
}

export async function disconnectMongo(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}

export function getDb(): Db {
  if (!db) throw new Error("Mongo not connected — call connectMongo() first");
  return db;
}

export function getClient(): MongoClient {
  if (!client) throw new Error("Mongo not connected — call connectMongo() first");
  return client;
}

/**
 * Locked Contract #9: every query touching Order/ledger/agent_decisions is
 * scoped by a server-derived tenantId. Indexes below assume restaurantId
 * (tenantId) as the leading key on every tenant-scoped collection, per the
 * "correctly shaped for thousands of tenants" requirement (Slice 2 contract).
 */
async function ensureIndexes(database: Db): Promise<void> {
  // `sparse` on a COMPOUND index only excludes a document when it's missing
  // ALL of the indexed fields — since tenantId/channel are always present,
  // a sparse compound index here included every storefront order anyway,
  // colliding on the second one. A partial index with an explicit
  // predicate is the correct tool for "unique only when externalOrderId
  // exists". Drop the old (broken) index by name if a prior run created it.
  await database
    .collection<Order>("orders")
    .dropIndex("tenantId_1_channel_1_externalOrderId_1")
    .catch(() => {
      /* didn't exist yet — fine */
    });
  await database.collection<Order>("orders").createIndexes([
    { key: { tenantId: 1, createdAt: -1 } },
    { key: { tenantId: 1, customerId: 1 } },
    // Idempotency (Slice 1): the second delivery of the same marketplace/pos
    // webhook hits a duplicate-key error instead of creating a second Order.
    // Storefront orders never set externalOrderId, so the partial filter
    // excludes them from this constraint entirely.
    {
      key: { tenantId: 1, channel: 1, externalOrderId: 1 },
      unique: true,
      partialFilterExpression: { externalOrderId: { $exists: true } },
    },
  ]);
  await database.collection<OutboxEvent>("outbox_events").createIndexes([
    { key: { processed: 1, createdAt: 1 } },
  ]);
  await database.collection<LoyaltyLedgerEntry>("loyalty_ledger").createIndexes([
    { key: { tenantId: 1, customerId: 1, createdAt: -1 } },
    // Unique (Slice 5 fix): a retry-once or a restarted consumer
    // reprocessing a still-unprocessed outbox event must never double this
    // order's earn entry — appendEarnEntry treats the resulting duplicate-
    // key error as "already recorded" and no-ops instead of throwing.
    { key: { tenantId: 1, orderId: 1, type: 1 }, unique: true },
  ]);
  // Materialized balance view (Slice 2) — one doc per {tenantId, customerId},
  // unique so the atomic $inc upsert in loyaltyLedger.ts can never fork into
  // two competing balance docs for the same customer.
  await database.collection<LoyaltyBalance>("loyalty_balances").createIndexes([
    { key: { tenantId: 1, customerId: 1 }, unique: true },
  ]);
  await database.collection<AgentDecision>("agent_decisions").createIndexes([
    { key: { tenantId: 1, agentType: 1, timestamp: -1 } },
    { key: { tenantId: 1, status: 1 } }, // Slice 3 approval-queue lookup
    // One retention decision per triggering order — prevents a retry (a
    // kill landing after the LLM call succeeds but before the consumer
    // finishes) from writing a second decision row for the same order.
    // Partial, not sparse: batch-sweep decisions have no orderId at all
    // and must never collide on it — see the externalOrderId lesson in
    // orderIngestion.ts for why partialFilterExpression, not sparse, is
    // the right tool here.
    {
      key: { tenantId: 1, orderId: 1, agentType: 1 },
      unique: true,
      partialFilterExpression: { orderId: { $exists: true } },
    },
  ]);
  // Slice 3 daily send-cap counter (Locked Contract #1). Unique so the
  // reserve-slot race in retentionAgent.ts's first-ever reservation of the
  // day can't fork into two competing counter docs for the same tenant+day
  // — a duplicate-key error there is exactly the retry signal it expects.
  await database.collection("retention_send_counters").createIndexes([
    { key: { tenantId: 1, date: 1 }, unique: true },
  ]);
  await database.collection<DeadLetterEvent>("dead_letter_events").createIndexes([
    { key: { tenantId: 1, replayed: 1, failedAt: -1 } },
  ]);
}

export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>
): Promise<T> {
  const session = getClient().startSession();
  const box: { value?: T } = {};
  try {
    await session.withTransaction(async () => {
      box.value = await fn(session);
    });
    return box.value as T;
  } finally {
    await session.endSession();
  }
}
