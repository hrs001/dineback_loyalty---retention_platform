import { ObjectId } from "mongodb";
import { getDb } from "../lib/mongo.js";
import type { DeadLetterEvent, Order, OutboxEvent } from "../models/types.js";

export async function sendToDeadLetter(
  event: OutboxEvent,
  order: Order | undefined,
  error: unknown
): Promise<void> {
  const db = getDb();
  const entry: DeadLetterEvent = {
    originalEventId: String(event._id),
    tenantId: event.tenantId,
    payload: order ?? event.payload,
    error: error instanceof Error ? error.message : String(error),
    failedAt: new Date(),
    replayed: false,
  };
  await db.collection<DeadLetterEvent>("dead_letter_events").insertOne(entry);
}

export async function listUnreplayedDeadLetters(tenantId: string): Promise<DeadLetterEvent[]> {
  const db = getDb();
  return db
    .collection<DeadLetterEvent>("dead_letter_events")
    .find({ tenantId, replayed: false })
    .toArray();
}

export async function markReplayed(id: string): Promise<void> {
  const db = getDb();
  await db
    .collection<DeadLetterEvent>("dead_letter_events")
    .updateOne({ _id: new ObjectId(id) }, { $set: { replayed: true } });
}
