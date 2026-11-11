import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlSignals, generateAuditWriteup, runAudit } from "../services/auditAgent.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import type { LLMClient } from "../services/llm.js";

const TENANT = "rest_demo";

function fakePsiResponse(scores: { performance: number; accessibility: number }) {
  return {
    lighthouseResult: {
      categories: {
        performance: { score: scores.performance },
        accessibility: { score: scores.accessibility },
      },
    },
  };
}

function fakeFetch(psiScores: { performance: number; accessibility: number }, html: string): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes("pagespeedonline")) {
      return new Response(JSON.stringify(fakePsiResponse(psiScores)), { status: 200 });
    }
    return new Response(html, { status: 200 });
  }) as unknown as typeof fetch;
}

function llmReturning(response: string): LLMClient {
  return { generateJSON: vi.fn().mockResolvedValue(response) };
}

describe("Slice 4: crawlSignals (PageSpeed Insights + structured-data/menu heuristics)", () => {
  it("maps PSI performance/accessibility categories to pageSpeedScore/mobileUsabilityScore (0-100)", async () => {
    const fetchImpl = fakeFetch({ performance: 0.87, accessibility: 0.92 }, "<html></html>");
    const signals = await crawlSignals("https://example-restaurant.com", fetchImpl);

    expect(signals.pageSpeedScore).toBe(87);
    expect(signals.mobileUsabilityScore).toBe(92);
  });

  it("scores structured data 100 when a Restaurant/Menu JSON-LD block is present", async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Restaurant",
      name: "Test Place",
    })}</script></head></html>`;
    const fetchImpl = fakeFetch({ performance: 0.5, accessibility: 0.5 }, html);
    const signals = await crawlSignals("https://example-restaurant.com", fetchImpl);
    expect(signals.structuredDataScore).toBe(100);
  });

  it("scores structured data 0 when no JSON-LD is present at all", async () => {
    const fetchImpl = fakeFetch({ performance: 0.5, accessibility: 0.5 }, "<html><body>no structured data here</body></html>");
    const signals = await crawlSignals("https://example-restaurant.com", fetchImpl);
    expect(signals.structuredDataScore).toBe(0);
  });

  it("scores menu completeness higher when a menu link and photos are present", async () => {
    const richHtml = `<html><body>
      <a href="/menu">Our Menu</a>
      <img src="1.jpg"/><img src="2.jpg"/><img src="3.jpg"/><img src="4.jpg"/>
    </body></html>`;
    const sparseHtml = `<html><body>Welcome</body></html>`;

    const rich = await crawlSignals("https://a.com", fakeFetch({ performance: 0.5, accessibility: 0.5 }, richHtml));
    const sparse = await crawlSignals("https://b.com", fakeFetch({ performance: 0.5, accessibility: 0.5 }, sparseHtml));

    expect(rich.menuCompletenessScore).toBeGreaterThan(sparse.menuCompletenessScore);
  });

  it("propagates a clear error when the crawl target is unreachable — never silently returns fake scores", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    await expect(crawlSignals("https://does-not-resolve.invalid", fetchImpl)).rejects.toThrow();
  });
});

describe("Slice 4: generateAuditWriteup (reuses Contract #5's repair-retry-then-skip)", () => {
  const signals = { pageSpeedScore: 40, mobileUsabilityScore: 60, structuredDataScore: 0, menuCompletenessScore: 30 };

  it("returns 2-3 grounded fixes and reasoning on a valid structured response", async () => {
    const llm = llmReturning(
      JSON.stringify({
        fixes: ["Add Restaurant JSON-LD structured data", "Compress hero images to improve load time"],
        reasoning: "Page speed and structured data are the weakest signals.",
      })
    );
    const result = await generateAuditWriteup(signals, llm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fixes.length).toBeGreaterThanOrEqual(2);
      expect(result.fixes.length).toBeLessThanOrEqual(3);
    }
  });

  it("retries once on malformed output, then fails closed rather than throwing", async () => {
    const llm = llmReturning("not json");
    (llm.generateJSON as ReturnType<typeof vi.fn>).mockResolvedValueOnce("not json").mockResolvedValueOnce("still not json");
    const result = await generateAuditWriteup(signals, llm);
    expect(result.ok).toBe(false);
  });
});

describe("Slice 4: runAudit orchestration (reuses C's agent_decisions + artifact-pointer pattern)", () => {
  beforeAll(async () => {
    await connectMongo();
  });

  afterAll(async () => {
    await disconnectMongo();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.collection("agent_decisions").deleteMany({});
    await db.collection("audit_artifacts.files").deleteMany({});
    await db.collection("audit_artifacts.chunks").deleteMany({});
  });

  it("writes a completed decision with real signals, LLM fixes, and a GridFS artifactRef", async () => {
    const fetchImpl = fakeFetch({ performance: 0.7, accessibility: 0.8 }, "<html><body><a href='/menu'>Menu</a></body></html>");
    const llm = llmReturning(JSON.stringify({ fixes: ["Add structured data", "Add more menu photos"], reasoning: "Missing structured data is the top gap." }));

    const decision = await runAudit(TENANT, "https://example-restaurant.com", llm, fetchImpl);

    expect(decision.agentType).toBe("audit");
    expect(decision.status).toBe("completed");
    if (decision.agentType === "audit") {
      expect(decision.payload.pageSpeedScore).toBe(70);
      expect(decision.payload.fixes.length).toBeGreaterThanOrEqual(2);
      expect(decision.payload.artifactRef).toMatch(/^gridfs:/);
    }
  });

  it("crawl failure (unreachable target) lands a failed decision — never throws, never fakes scores", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const llm = llmReturning("unused");

    const decision = await runAudit(TENANT, "https://does-not-resolve.invalid", llm, fetchImpl);

    expect(decision.status).toBe("failed");
    expect(decision.reasoning).toMatch(/crawl/i);
  });

  it("LLM failure after repair retry still persists the real crawl signals, with empty fixes and status failed", async () => {
    const fetchImpl = fakeFetch({ performance: 0.4, accessibility: 0.4 }, "<html></html>");
    const llm: LLMClient = { generateJSON: vi.fn().mockResolvedValue("not json") };

    const decision = await runAudit(TENANT, "https://example-restaurant.com", llm, fetchImpl);

    expect(decision.status).toBe("failed");
    if (decision.agentType === "audit") {
      expect(decision.payload.pageSpeedScore).toBe(40); // real signal preserved even though the writeup failed
      expect(decision.payload.fixes).toHaveLength(0);
    }
  });
});
