import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { createOrder } from "../services/orderIngestion.js";
import {
  approveDecision,
  listPendingApprovals,
  rejectDecision,
  runRetentionBatch,
} from "../services/retentionAgent.js";
import type { LLMClient } from "../services/llm.js";
import type { AgentDecision } from "../models/types.js";

const TENANT = "rest_demo";

function llmAlwaysSending(offerValue = 5): LLMClient {
  return {
    async generateJSON() {
      return JSON.stringify({
        action: "send",
        tone: "casual",
        offerType: "free_item",
        offerValue,
        reasoning: "Regular customer check-in.",
      });
    },
  };
}

describe("Slice 3: scheduled batch sweep (Locked Contract #6)", () => {
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
    await db.collection("retention_send_counters").deleteMany({});
  });

  it("processes one decision per customer with orders in the tenant", async () => {
    await createOrder({
      tenantId: TENANT,
      customerId: "cust_batch_1",
      channel: "storefront",
      items: [{ name: "Item", price: 10, qty: 1 }],
    });
    await createOrder({
      tenantId: TENANT,
      customerId: "cust_batch_2",
      channel: "storefront",
      items: [{ name: "Item", price: 10, qty: 1 }],
    });

    const result = await runRetentionBatch(TENANT, llmAlwaysSending(), 50);

    expect(result.processed).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.skippedCap).toBe(0);

    const decisions = await getDb()
      .collection<AgentDecision>("agent_decisions")
      .find({ tenantId: TENANT, agentType: "retention" })
      .toArray();
    expect(decisions).toHaveLength(2);
  });

  it("stops sending once the daily cap is reached — no lost overshoot under concurrency", async () => {
    for (let i = 0; i < 8; i++) {
      await createOrder({
        tenantId: TENANT,
        customerId: `cust_cap_${i}`,
        channel: "storefront",
        items: [{ name: "Item", price: 10, qty: 1 }],
      });
    }

    const result = await runRetentionBatch(TENANT, llmAlwaysSending(), 3);

    expect(result.processed).toBe(8);
    expect(result.sent).toBe(3); // exactly the cap, never more
    expect(result.skippedCap).toBe(5);
  });

  it("a decision above the guardrail threshold lands pending_approval, not completed", async () => {
    await createOrder({
      tenantId: TENANT,
      customerId: "cust_approval_1",
      channel: "storefront",
      items: [{ name: "Item", price: 10, qty: 1 }],
    });

    await runRetentionBatch(TENANT, llmAlwaysSending(50), 50); // $50 free_item > $10 threshold

    const pending = await listPendingApprovals(TENANT);
    expect(pending).toHaveLength(1);
    expect(pending[0].payload.customerId).toBe("cust_approval_1");
  });
});

describe("Slice 3: approval queue transitions (Locked Contract #3)", () => {
  beforeAll(async () => {
    await connectMongo();
  });

  afterAll(async () => {
    await disconnectMongo();
  });

  beforeEach(async () => {
    await getDb().collection("agent_decisions").deleteMany({});
  });

  async function insertPending(): Promise<string> {
    const decision: AgentDecision = {
      tenantId: TENANT,
      agentType: "retention",
      timestamp: new Date(),
      payload: {
        customerId: "cust_x",
        action: "send",
        tone: "urgency",
        offerType: "percent_off",
        offerValue: 30,
        requiresApproval: true,
      },
      reasoning: "test fixture",
      status: "pending_approval",
    };
    const { insertedId } = await getDb().collection<AgentDecision>("agent_decisions").insertOne(decision);
    return String(insertedId);
  }

  it("approve transitions pending_approval -> completed", async () => {
    const id = await insertPending();
    const ok = await approveDecision(TENANT, id);
    expect(ok).toBe(true);

    const pending = await listPendingApprovals(TENANT);
    expect(pending).toHaveLength(0);
  });

  it("reject transitions pending_approval -> rejected", async () => {
    const id = await insertPending();
    const ok = await rejectDecision(TENANT, id);
    expect(ok).toBe(true);
  });

  it("approving twice is a no-op the second time (already left pending_approval)", async () => {
    const id = await insertPending();
    await approveDecision(TENANT, id);
    const second = await approveDecision(TENANT, id);
    expect(second).toBe(false);
  });
});
