import type { ChangeStreamInsertDocument } from "mongodb";
import { getDb } from "../lib/mongo.js";
import { logger } from "../lib/logger.js";
import type { OutboxEvent, Order } from "../models/types.js";
import { appendEarnEntry } from "./loyaltyLedger.js";
import { recordRetentionDecision } from "./retentionAgent.js";
import { sendToDeadLetter } from "./dlq.js";
import { createGeminiClient, type LLMClient } from "./llm.js";

/**
 * Tails the outbox collection via a Change Stream (Locked Contract #2 —
 * push-based, not a polling worker). Runs as its own process (see
 * `src/consumer.ts` entrypoint and System Architecture in the design doc) —
 * this is what proves the outbox pattern actually does something, not just
 * that events get written.
 *
 * Error handling matches the design doc's Error & Rescue Map:
 *  - malformed event → log + skip, never crash the loop (not retried —
 *    there's nothing a retry would fix)
 *  - a processing failure (ledger/decision write throws) → retry once,
 *    then send to the dead-letter queue instead of silently dropping it —
 *    `/admin/replay` (Slice 1) reprocesses from there
 *  - stream disconnects → the driver auto-reconnects using the stored
 *    resume token; we don't need to hand-roll backoff for MVP scope
 */
async function processOnce(order: Order, llm: LLMClient): Promise<void> {
  const db = getDb();
  await appendEarnEntry(order);
  await recordRetentionDecision(order, llm);
  await db
    .collection<Order>("orders")
    .updateOne({ _id: order._id, tenantId: order.tenantId }, { $set: { status: "routed" } });
}

/**
 * `llm` defaults to a real Gemini client so production callers (the
 * Consumer's change-stream handler, `/admin/replay`) need no wiring — but
 * accepting it as a parameter lets tests inject a fast fake instead of
 * making real, network-latency-bound LLM calls on every run (Contract #5's
 * retry-then-skip already means a failing/slow LLM call would otherwise
 * make this path slow or flaky depending on whether GEMINI_API_KEY happens
 * to be set, which a test's speed and determinism must never depend on).
 */
export async function processOutboxEvent(
  event: OutboxEvent,
  llm: LLMClient = createGeminiClient()
): Promise<void> {
  const db = getDb();
  const order = event.payload as Order;

  if (!order || !order._id || !order.tenantId || !order.customerId) {
    logger.warn({ eventId: event._id }, "malformed outbox event — skipping");
    return;
  }

  try {
    await processOnce(order, llm);
  } catch (firstErr) {
    logger.warn({ err: firstErr, orderId: order._id }, "processing failed — retrying once");
    try {
      await processOnce(order, llm);
    } catch (secondErr) {
      logger.error(
        { err: secondErr, orderId: order._id },
        "processing failed twice — sending to dead-letter queue"
      );
      await sendToDeadLetter(event, order, secondErr);
      return;
    }
  }

  const processedAt = new Date();
  if (event._id) {
    await db
      .collection<OutboxEvent>("outbox_events")
      .updateOne({ _id: event._id }, { $set: { processed: true, processedAt } });
  }
  logger.info(
    { orderId: order._id, lagMs: processedAt.getTime() - new Date(event.createdAt).getTime() },
    "outbox event processed"
  );
}

export async function startConsumer(llm: LLMClient = createGeminiClient()) {
  const db = getDb();
  const collection = db.collection<OutboxEvent>("outbox_events");

  // Captured BEFORE watch() — see the backlog sweep below for why the
  // boundary being conservative (slightly early) is the safer choice here.
  const startedAt = new Date();

  const changeStream = collection.watch([{ $match: { operationType: "insert" } }], {
    fullDocument: "updateLookup",
  });

  logger.info("consumer: watching outbox_events change stream");

  changeStream.on("change", (change) => {
    const insert = change as ChangeStreamInsertDocument<OutboxEvent>;
    logger.info({ orderId: insert.fullDocument.orderId }, "change-stream event received");
    void processOutboxEvent(insert.fullDocument, llm);
  });

  changeStream.on("error", (err) => {
    logger.error({ err }, "change stream error — driver will attempt to resume");
  });

  /**
   * Startup catch-up sweep. A plain change stream (no persisted resume
   * token) only ever sees NEW inserts from the moment `watch()` is called
   * — an outbox event written before a crash but never marked processed
   * would otherwise sit in Mongo forever, untouched by every future
   * restart. This is the actual mechanism behind the "kill the consumer
   * mid-processing, restart, confirm nothing was lost" demo: the event
   * that was mid-flight when killed is still `processed: false` in Mongo,
   * and this sweep is what picks it back up.
   *
   * `createdAt < startedAt` (a boundary captured before watch() even
   * starts, so it can only be too early, never too late) guarantees zero
   * overlap with the live stream above, which only fires for documents
   * inserted after the stream actually started — nothing here is ever
   * double-processed. The tradeoff: a real event inserted in the
   * few-millisecond gap between `startedAt` and the stream actually
   * starting could theoretically be missed by both paths. Acceptable at
   * demo scale (no concurrent traffic during a process restart); a real
   * production system would persist the change stream's resume token
   * instead and eliminate the gap entirely (see the README's "what I'd do
   * differently at 10x" section).
   */
  const backlog = await collection.find({ processed: false, createdAt: { $lt: startedAt } }).toArray();
  if (backlog.length > 0) {
    logger.warn({ count: backlog.length }, "consumer startup: unprocessed backlog found — catching up");
    for (const event of backlog) {
      await processOutboxEvent(event, llm);
    }
  }

  return changeStream;
}
