import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Worker } from "bullmq";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { AUDIT_QUEUE_NAME, closeAuditQueue, closeRetentionQueue, type AuditJobData } from "../lib/queue.js";
import { env } from "../lib/env.js";
import { runAudit } from "../services/auditAgent.js";
import type { LLMClient } from "../services/llm.js";

const ADMIN_KEY = "dev-admin-key";

function fakeLLM(): LLMClient {
  return {
    async generateJSON() {
      return JSON.stringify({ fixes: ["Add structured data", "Improve page speed"], reasoning: "Test fixture." });
    },
  };
}

function fakeFetch(): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    if (String(url).includes("pagespeedonline")) {
      return new Response(
        JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.6 }, accessibility: { score: 0.7 } } } }),
        { status: 200 }
      );
    }
    return new Response("<html><body>test</body></html>", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Slice 4: admin audit endpoints", () => {
  let app: FastifyInstance;
  let worker: Worker<AuditJobData>;

  beforeAll(async () => {
    await connectMongo();
    app = await buildServer();
    await app.ready();

    // Test-only worker: processes with injected fakes instead of the real
    // Gemini/fetch calls agentWorker.ts's production processor would use.
    worker = new Worker<AuditJobData>(
      AUDIT_QUEUE_NAME,
      async (job) => {
        const decision = await runAudit(job.data.tenantId, job.data.url, fakeLLM(), fakeFetch());
        return decision._id?.toString();
      },
      { connection: { url: env.redisUrl } }
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
    await closeAuditQueue();
    await closeRetentionQueue();
    await disconnectMongo();
  });

  beforeEach(async () => {
    await getDb().collection("agent_decisions").deleteMany({});
  });

  it("rejects without a valid admin key", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/audit/run", payload: { url: "https://example.com" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid url", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/audit/run",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { url: "not-a-url" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("returns 404 for an unknown job id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/audit/does-not-exist/status",
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it("enqueues a crawl job and the status endpoint reflects completion with the decision", async () => {
    const enqueueRes = await app.inject({
      method: "POST",
      url: "/admin/audit/run",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { url: "https://example-restaurant.com" },
    });
    expect(enqueueRes.statusCode).toBe(200);
    const { jobId } = enqueueRes.json();
    expect(jobId).toBeTruthy();

    // Poll briefly for the worker to finish (real async job processing).
    let statusBody: { state: string; decision?: { status: string; payload: { pageSpeedScore: number; fixes: string[] } } } = {
      state: "unknown",
    };
    for (let i = 0; i < 50; i++) {
      const statusRes = await app.inject({
        method: "GET",
        url: `/admin/audit/${jobId}/status`,
        headers: { "x-admin-key": ADMIN_KEY },
      });
      statusBody = statusRes.json();
      if (statusBody.state === "completed") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(statusBody.state).toBe("completed");
    expect(statusBody.decision?.status).toBe("completed");
    expect(statusBody.decision?.payload.pageSpeedScore).toBe(60);
    expect(statusBody.decision?.payload.fixes.length).toBeGreaterThan(0);
  });
});
