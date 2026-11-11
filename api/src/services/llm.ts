import { GoogleGenAI } from "@google/genai";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * Provider-agnostic seam (Slice 3): the retention agent depends on this
 * interface, not on Gemini directly, so a repair-prompt retry (Locked
 * Contract #5) and the eval script (Locked Contract #7) can inject a fake
 * client instead of hitting a real, billable/rate-limited API in tests.
 */
export interface LLMClient {
  /** Returns the raw text response — the caller parses/validates it. */
  generateJSON(prompt: string, schema: object): Promise<string>;
}

const MAX_ERROR_SUMMARY_LENGTH = 200;

/**
 * Turns a raw provider error (the Gemini SDK's thrown Error.message is
 * often the full HTTP error body — nested JSON, quota metric names, help
 * URLs) into a short, human-readable line. Both retentionAgent.ts and
 * auditAgent.ts interpolate this into a decision's user-facing `reasoning`
 * field on the repair-retry-then-skip failure path (Locked Contract #5) —
 * without this, that field renders a multi-hundred-character JSON blob
 * verbatim wherever a decision's reasoning is displayed.
 */
export function summarizeLLMError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: number; status?: string; message?: string } };
    const err = parsed?.error;
    if (err?.status === "RESOURCE_EXHAUSTED" || err?.code === 429) {
      return "Gemini free-tier rate limit reached. Try again in a moment.";
    }
    if (err?.message) {
      return err.message.split("\n")[0].slice(0, MAX_ERROR_SUMMARY_LENGTH);
    }
  } catch {
    // not JSON — fall through to plain-text truncation below
  }
  return raw.length > MAX_ERROR_SUMMARY_LENGTH ? `${raw.slice(0, MAX_ERROR_SUMMARY_LENGTH)}…` : raw;
}

/**
 * Free-tier Gemini call (chosen over Claude/Groq/local Ollama for this
 * slice — see the design doc's Open Questions). `responseSchema` +
 * `responseMimeType: "application/json"` constrains the output shape
 * server-side; Contract #5's repair-retry still exists for the rare case
 * the constrained output doesn't satisfy our own zod schema (e.g. a value
 * out of range that JSON Schema's `enum`/`type` alone didn't catch).
 */
export function createGeminiClient(): LLMClient {
  let ai: GoogleGenAI | undefined;

  // The key check is deferred to call time (not construction time) so a
  // missing key surfaces through decideForCustomer's existing Contract #5
  // retry-then-skip path — a normal per-decision failure, not a hard crash
  // of whatever process happened to construct this client at startup.
  return {
    async generateJSON(prompt: string, schema: object): Promise<string> {
      if (!env.geminiApiKey) {
        throw new Error(
          "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey"
        );
      }
      ai ??= new GoogleGenAI({ apiKey: env.geminiApiKey });
      const startedAt = Date.now();
      logger.info({ model: env.geminiModel }, "llm-call-start");
      let response;
      try {
        response = await ai.models.generateContent({
          model: env.geminiModel,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        });
      } catch (err) {
        logger.info({ model: env.geminiModel, latencyMs: Date.now() - startedAt, ok: false }, "llm-call-end");
        throw err;
      }
      const text = response.text;
      logger.info({ model: env.geminiModel, latencyMs: Date.now() - startedAt, ok: !!text }, "llm-call-end");
      if (!text) throw new Error("Gemini returned an empty response");
      return text;
    },
  };
}
