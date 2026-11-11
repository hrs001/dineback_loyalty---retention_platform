import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import {
  appendEarnEntry,
  getBalance,
  getMaterializedBalance,
  reconcileBalance,
} from "../services/loyaltyLedger.js";
import type { Order } from "../models/types.js";

const TENANT = "rest_demo";

function fakeOrder(overrides: Partial<Order> = {}): Order {
  return {
    _id: `order_${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT,
    customerId: "cust_ledger_1",
    channel: "storefront",
    items: [{ name: "Item", price: 10, qty: 1 }],
    amount: 10,
    status: "received",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("Slice 2: materialized loyalty balance", () => {
  beforeAll(async () => {
    await connectMongo();
  });

  afterAll(async () => {
    await disconnectMongo();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.collection("loyalty_ledger").deleteMany({});
    await db.collection("loyalty_balances").deleteMany({});
  });

  it("updates the materialized balance atomically when an earn entry is appended", async () => {
    const order = fakeOrder({ amount: 25, items: [{ name: "Item", price: 25, qty: 1 }] });
    await appendEarnEntry(order);

    const materialized = await getMaterializedBalance(TENANT, order.customerId);
    expect(materialized).toBe(25);
  });

  it("two orders completing in the same millisecond both land correctly — no lost update", async () => {
    const customerId = "cust_concurrent_1";
    const orders = Array.from({ length: 25 }, () =>
      fakeOrder({ customerId, amount: 10, items: [{ name: "Item", price: 10, qty: 1 }] })
    );

    // Fire every earn write concurrently to simulate same-millisecond completion.
    await Promise.all(orders.map((order) => appendEarnEntry(order)));

    const resummed = await getBalance(TENANT, customerId);
    const materialized = await getMaterializedBalance(TENANT, customerId);

    expect(resummed).toBe(250); // 25 orders * 10 points, none lost to a race
    expect(materialized).toBe(resummed); // materialized view matches the ledger exactly
  });

  it("reconcileBalance corrects drift between the materialized view and the ledger", async () => {
    const customerId = "cust_drift_1";
    await appendEarnEntry(fakeOrder({ customerId, amount: 40, items: [{ name: "Item", price: 40, qty: 1 }] }));

    // Simulate drift — a value written by some means other than an atomic
    // ledger-append (e.g. a bad migration) that no longer matches the ledger.
    const db = getDb();
    await db
      .collection("loyalty_balances")
      .updateOne({ tenantId: TENANT, customerId }, { $set: { balance: 999 } });

    await reconcileBalance(TENANT, customerId);

    const resummed = await getBalance(TENANT, customerId);
    const materialized = await getMaterializedBalance(TENANT, customerId);
    expect(materialized).toBe(resummed);
    expect(materialized).toBe(40);
  });
});
