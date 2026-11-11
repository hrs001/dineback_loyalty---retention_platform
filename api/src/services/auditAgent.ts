import { z } from "zod";
import { GridFSBucket, ObjectId } from "mongodb";
import { getDb } from "../lib/mongo.js";
import { logger } from "../lib/logger.js";
import type { AgentDecision, AuditDecisionPayload } from "../models/types.js";
import { createGeminiClient, summarizeLLMError, type LLMClient } from "./llm.js";
import { env } from "../lib/env.js";

/**
 * Slice 4 (subsystem D) — reuses C's guardrailed-agent plumbing (structured
 * output, repair-retry-then-skip, agent_decisions log) rather than being a
 * separate one-off script. Tooling locked to wrapping PageSpeed Insights
 * (which itself wraps Lighthouse) — the design doc's "safer default" over
 * running headless Chrome ourselves.
 */
export type CrawlSignals = Omit<AuditDecisionPayload, "fixes" | "artifactRef">;

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

interface PsiResponse {
  lighthouseResult: {
    categories: {
      performance: { score: number };
      accessibility: { score: number };
    };
  };
}

function toScore(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * `structuredDataScore`/`menuCompletenessScore` aren't Lighthouse metrics —
 * they're restaurant-domain signals scored from the raw HTML. This is a
 * heuristic, not a certified check; documented as such rather than
 * overclaiming precision it doesn't have.
 */
function scoreStructuredData(html: string): number {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length === 0) return 0;
  for (const [, body] of scripts) {
    try {
      const json = JSON.parse(body);
      const type = String(json["@type"] ?? "").toLowerCase();
      if (type.includes("restaurant") || type.includes("menu") || type.includes("foodestablishment")) return 100;
    } catch {
      // malformed JSON-LD — keep checking other blocks
    }
  }
  return 50; // some structured data present, just not restaurant-typed
}

function scoreMenuCompleteness(html: string): number {
  const hasMenuLink = /<a[^>]+href=["'][^"']*menu[^"']*["']/i.test(html) || /menu/i.test(html);
  const imageCount = [...html.matchAll(/<img\b/gi)].length;
  let score = 0;
  if (hasMenuLink) score += 50;
  score += Math.min(imageCount * 10, 50);
  return score;
}

/**
 * `fetchImpl` defaults to the global `fetch` for production; tests inject a
 * fake so this never makes a real network call in `npm test` — the same
 * discipline as `LLMClient` injection for the retention agent.
 */
export async function crawlSignals(url: string, fetchImpl: typeof fetch = fetch): Promise<CrawlSignals> {
  const psiUrl = new URL(PSI_ENDPOINT);
  psiUrl.searchParams.set("url", url);
  psiUrl.searchParams.append("category", "performance");
  psiUrl.searchParams.append("category", "accessibility");
  if (env.pagespeedApiKey) psiUrl.searchParams.set("key", env.pagespeedApiKey);

  const [psiRes, pageRes] = await Promise.all([fetchImpl(psiUrl.toString()), fetchImpl(url)]);

  if (!psiRes.ok) throw new Error(`PageSpeed Insights request failed: ${psiRes.status}`);
  if (!pageRes.ok) throw new Error(`Crawl target returned ${pageRes.status}`);

  const psi = (await psiRes.json()) as PsiResponse;
  const html = await pageRes.text();

  return {
    pageSpeedScore: toScore(psi.lighthouseResult.categories.performance.score),
    mobileUsabilityScore: toScore(psi.lighthouseResult.categories.accessibility.score),
    structuredDataScore: scoreStructuredData(html),
    menuCompletenessScore: scoreMenuCompleteness(html),
  };
}

const WriteupSchema = z.object({
  fixes: z.array(z.string().min(1)).min(2).max(3),
  reasoning: z.string().min(1),
});

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    fixes: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 },
    reasoning: { type: "string" },
  },
  required: ["fixes", "reasoning"],
};

export type WriteupResult =
  | { ok: true; fixes: string[]; reasoning: string }
  | { ok: false; error: string };

function buildPrompt(signals: CrawlSignals): string {
  return [
    "You are a restaurant website audit assistant. Given these real, measured crawl signals (0-100 scale, not your own judgment) for a restaurant's website, write 2-3 concrete, prioritized fixes and a short reasoning paragraph.",
    JSON.stringify(signals),
    "Ground every fix in the signal data above — do not invent scores or claims about the site you weren't given.",
  ].join("\n\n");
}

function repairPrompt(original: string, error: string): string {
  return `${original}\n\nYour previous response could not be parsed (${error}). Reply again with ONLY valid JSON matching the required schema.`;
}

/** Reuses Contract #5's one-repair-prompt-retry-then-skip, same shape as the retention agent. */
export async function generateAuditWriteup(signals: CrawlSignals, llm: LLMClient): Promise<WriteupResult> {
  const prompt = buildPrompt(signals);
  let lastError = "unknown error";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await llm.generateJSON(attempt === 0 ? prompt : repairPrompt(prompt, lastError), RESPONSE_JSON_SCHEMA);
      const parsed = WriteupSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { ok: true, fixes: parsed.data.fixes, reasoning: parsed.data.reasoning };
      lastError = parsed.error.message;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Locked Contract #4: the artifact store is a pointer, not the collection
 * itself. GridFS (native to the Mongo already provisioned for this project)
 * is the "safer default" over standing up S3 for a portfolio demo.
 */
async function storeArtifact(filename: string, content: string): Promise<string> {
  const bucket = new GridFSBucket(getDb(), { bucketName: "audit_artifacts" });
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, { contentType: "application/json" });
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(`gridfs:${uploadStream.id.toString()}`));
    uploadStream.end(content);
  });
}

type AuditDecision = Extract<AgentDecision, { agentType: "audit" }>;

async function writeAuditDecision(
  tenantId: string,
  payload: AuditDecisionPayload,
  reasoning: string,
  status: AuditDecision["status"]
): Promise<AuditDecision> {
  const decision: AuditDecision = { tenantId, agentType: "audit", timestamp: new Date(), payload, reasoning, status };
  await getDb().collection<AgentDecision>("agent_decisions").insertOne(decision);
  return decision;
}

/**
 * Orchestrates the crawl + LLM writeup into one logged decision — the same
 * "objective signals in, LLM judgment grounded in them out" shape as the
 * retention agent, demonstrating platform-coherence (design doc's framing
 * for D) rather than a bounded-autonomy story of its own.
 */
export async function runAudit(
  tenantId: string,
  url: string,
  llm: LLMClient = createGeminiClient(),
  fetchImpl: typeof fetch = fetch
): Promise<AuditDecision> {
  let signals: CrawlSignals;
  let artifactRef: string | undefined;

  try {
    signals = await crawlSignals(url, fetchImpl);
    artifactRef = await storeArtifact(`audit-${Date.now()}.json`, JSON.stringify(signals));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ url, err }, "audit crawl failed");
    return writeAuditDecision(
      tenantId,
      { pageSpeedScore: 0, mobileUsabilityScore: 0, structuredDataScore: 0, menuCompletenessScore: 0, fixes: [] },
      `Crawl failed: ${message}`,
      "failed"
    );
  }

  const writeup = await generateAuditWriteup(signals, llm);
  if (!writeup.ok) {
    logger.error({ url, error: writeup.error }, "audit writeup failed after repair retry");
    return writeAuditDecision(
      tenantId,
      { ...signals, fixes: [], artifactRef },
      `LLM call failed after repair retry: ${summarizeLLMError(writeup.error)}`,
      "failed"
    );
  }

  return writeAuditDecision(tenantId, { ...signals, fixes: writeup.fixes, artifactRef }, writeup.reasoning, "completed");
}

export async function getAuditDecision(tenantId: string, decisionId: string): Promise<AuditDecision | null> {
  const db = getDb();
  const decision = await db
    .collection<AgentDecision>("agent_decisions")
    .findOne({ _id: new ObjectId(decisionId), tenantId, agentType: "audit" });
  return (decision as AuditDecision | null) ?? null;
}
