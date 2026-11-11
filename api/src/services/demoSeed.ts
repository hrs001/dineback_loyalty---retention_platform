import { randomUUID } from "node:crypto";
import { getDb } from "../lib/mongo.js";
import type { Order } from "../models/types.js";

/**
 * Demo-only fixture data for exercising the retention agent's batch sweep
 * without waiting on its real 24h schedule. Intentionally bypasses the
 * outbox transaction (createOrder in orderIngestion.ts) — these orders are
 * backdated history for a customer, never live orders moving through the
 * ingestion pipeline, so there is no outbox event to write and nothing for
 * the consumer to process.
 */

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function staleOrder(tenantId: string, customerId: string, amount: number, ageDays: number): Order {
  return {
    _id: randomUUID(),
    tenantId,
    customerId,
    channel: "storefront",
    items: [{ name: "Jollof Rice", price: amount, qty: 1 }],
    amount,
    status: "routed",
    createdAt: daysAgo(ageDays),
  };
}

/**
 * Seeds 3 customers with a plausible win-back gap (30/45/60+90 days since
 * their last order) — enough for the LLM to have a real signal to reason
 * about, not so extreme it always maxes out the offer.
 */
export async function seedStaleOrders(tenantId: string): Promise<number> {
  const suffix = randomUUID().slice(0, 8);
  const orders: Order[] = [
    staleOrder(tenantId, `cust_stale_demo_${suffix}_a`, 18, 30),
    staleOrder(tenantId, `cust_stale_demo_${suffix}_b`, 22, 45),
    staleOrder(tenantId, `cust_stale_demo_${suffix}_c`, 60, 90),
    staleOrder(tenantId, `cust_stale_demo_${suffix}_c`, 30, 60),
  ];
  await getDb().collection<Order>("orders").insertMany(orders);
  return orders.length;
}

/**
 * Seeds one customer with a long lapse and a history of large orders —
 * biased hard toward the LLM recommending an offer that trips Locked
 * Contract #1's guardrail (>15% percent_off or >$10 free_item), so the
 * approval queue has something real to show. Not a guarantee: the LLM
 * still decides offerType/offerValue itself, never the guardrail outcome.
 */
export async function seedHighValueLapsedCustomer(tenantId: string): Promise<number> {
  const suffix = randomUUID().slice(0, 8);
  const customerId = `cust_stale_demo_approval_${suffix}`;
  const orders: Order[] = [
    staleOrder(tenantId, customerId, 165, 210),
    staleOrder(tenantId, customerId, 190, 180),
    staleOrder(tenantId, customerId, 155, 150),
  ];
  await getDb().collection<Order>("orders").insertMany(orders);
  return orders.length;
}
