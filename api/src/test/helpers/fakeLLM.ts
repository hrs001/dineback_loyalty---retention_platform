import type { LLMClient } from "../../services/llm.js";

/**
 * A fast, deterministic stand-in for the real Gemini client — used by
 * tests whose focus is the outbox/DLQ/ledger machinery, not the retention
 * agent's LLM call itself (that's covered by slice3.retentionAgent.test.ts).
 * Test speed and determinism must never depend on whether GEMINI_API_KEY
 * happens to be configured in the environment running the suite.
 */
export function fakeLLM(): LLMClient {
  return {
    async generateJSON() {
      return JSON.stringify({
        action: "skip",
        tone: "casual",
        offerType: "none",
        offerValue: 0,
        reasoning: "fake LLM client used by tests unrelated to the retention agent itself.",
      });
    },
  };
}
