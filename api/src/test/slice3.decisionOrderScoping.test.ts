import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { createOrder } from "../services/orderIngestion.js";
import { getDecisionForOrder, recordRetentionDecision } from "../services/retentionAgent.js";
import type { AgentDecision } from "../models/types.js";
import type { LLMClient } from "../services/llm.js";

const TENANT = "rest_demo";
const STOREFRONT_KEY = "dev-storefront-key";

function llmReturningReasoning(reasoning: string): LLMClient {
  return {
    async generateJSON() {
      return JSON.stringify({
        action: "skip",
        tone: "casual",
        offerType: "none",
        offerValue: 0,
        reasoning,
      });
    },
  };
}

describe("Slice 3: retention decisions are scoped to the triggering order, not just the customer", () => {
  beforeAll(async () => {
    await connectMongo();
  });

  afterAll(async () => {
    await disconnectMongo();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.collection("orders").deleteMany({});
    await db.collection("agent_decisions").deleteMany({});
  });

  it("records the triggering order's id on the decision", async () => {
    const order = await createOrder({
      tenantId: TENANT,
      customerId: "cust_scope_1",
      channel: "storefront",
      items: [{ name: "Item", price: 10, qty: 1 }],
    });

    await recordRetentionDecision(order, llmReturningReasoning("first order"));

    const decision = await getDecisionForOrder(TENANT, order._id);
    expect(decision).not.toBeNull();
    expect(decision?.reasoning).toBe("first order");
  });

  it("returns each order's own decision when a customer has multiple orders", async () => {
    const orderA = await createOrder({
      tenantId: TENANT,
      customerId: "cust_scope_2",
      channel: "storefront",
      items: [{ name: "Item", price: 10, qty: 1 }],
    });
    const orderB = await createOrder({
      tenantId: TENANT,
      customerId: "cust_scope_2",
      channel: "storefront",
      items: [{ name: "Item", price: 15, qty: 1 }],
    });

    await recordRetentionDecision(orderA, llmReturningReasoning("decision for order A"));
    await recordRetentionDecision(orderB, llmReturningReasoning("decision for order B"));

    const decisionA = await getDecisionForOrder(TENANT, orderA._id);
    const decisionB = await getDecisionForOrder(TENANT, orderB._id);

    expect(decisionA?.reasoning).toBe("decision for order A");
    expect(decisionB?.reasoning).toBe("decision for order B");
  });

  it("is idempotent — recording twice for the same order never creates a second row", async () => {
    const order = await createOrder({
      tenantId: TENANT,
      customerId: "cust_scope_3",
      channel: "storefront",
      items: [{ name: "Item", price: 10, qty: 1 }],
    });

    await recordRetentionDecision(order, llmReturningReasoning("only decision"));
    await recordRetentionDecision(order, llmReturningReasoning("a retried duplicate call"));

    const count = await getDb()
      .collection("agent_decisions")
      .countDocuments({ tenantId: TENANT, orderId: order._id, agentType: "retention" });
    expect(count).toBe(1);

    const decision = await getDecisionForOrder(TENANT, order._id);
    expect(decision?.reasoning).toBe("only decision");
  });
});

describe("GET /orders/:id/thread falls back to the customer's latest decision when the order has none of its own", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await connectMongo();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnectMongo();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.collection("orders").deleteMany({});
    await db.collection("agent_decisions").deleteMany({});
  });

  it("shows the batch sweep's decision for a seeded/backdated order that never went through the consumer", async () => {
    const order = await createOrder({
      tenantId: TENANT,
      customerId: "cust_fallback_1",
      channel: "storefront",
      items: [{ name: "Item", price: 20, qty: 1 }],
    });

    // A batch-sweep decision (runRetentionBatch) never sets orderId —
    // it evaluates a customer's whole history, not one triggering order.
    const batchDecision: AgentDecision = {
      tenantId: TENANT,
      agentType: "retention",
      timestamp: new Date(),
      payload: {
        customerId: "cust_fallback_1",
        action: "send",
        tone: "casual",
        offerType: "percent_off",
        offerValue: 15,
        requiresApproval: false,
      },
      reasoning: "batch sweep win-back decision",
      status: "completed",
    };
    await getDb().collection<AgentDecision>("agent_decisions").insertOne(batchDecision);

    const res = await app.inject({
      method: "GET",
      url: `/orders/${order._id}/thread`,
      headers: { "x-storefront-key": STOREFRONT_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().decision?.reasoning).toBe("batch sweep win-back decision");
  });

  it("still prefers each order's own decision over the fallback when both exist", async () => {
    const orderA = await createOrder({
      tenantId: TENANT,
      customerId: "cust_fallback_2",
      channel: "storefront",
      items: [{ name: "Item", price: 10, qty: 1 }],
    });
    const orderB = await createOrder({
      tenantId: TENANT,
      customerId: "cust_fallback_2",
      channel: "storefront",
      items: [{ name: "Item", price: 15, qty: 1 }],
    });

    await recordRetentionDecision(orderA, llmReturningReasoning("decision for order A"));
    await recordRetentionDecision(orderB, llmReturningReasoning("decision for order B"));

    const resA = await app.inject({
      method: "GET",
      url: `/orders/${orderA._id}/thread`,
      headers: { "x-storefront-key": STOREFRONT_KEY },
    });
    const resB = await app.inject({
      method: "GET",
      url: `/orders/${orderB._id}/thread`,
      headers: { "x-storefront-key": STOREFRONT_KEY },
    });

    expect(resA.json().decision?.reasoning).toBe("decision for order A");
    expect(resB.json().decision?.reasoning).toBe("decision for order B");
  });
});
