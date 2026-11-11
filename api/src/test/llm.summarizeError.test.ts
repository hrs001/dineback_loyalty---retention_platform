// Regression: ISSUE-001 — retentionAgent.ts and auditAgent.ts interpolated
// the raw Gemini API error (nested JSON, quota metric names, help URLs)
// straight into a decision's user-facing `reasoning` field on the
// repair-retry-then-skip failure path.
// Found by /qa on 2026-09-04
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-04.md
import { describe, expect, it } from "vitest";
import { summarizeLLMError } from "../services/llm.js";

describe("summarizeLLMError — never leak a raw provider error blob into user-facing text", () => {
  it("gives a short, human-readable message for a rate-limit (429/RESOURCE_EXHAUSTED) error", () => {
    const raw = JSON.stringify({
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 500, model: gemini-3.5-flash-lite\nPlease retry in 42.753794155s.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.Help" }],
      },
    });

    const summary = summarizeLLMError(raw);

    expect(summary).toBe("Gemini free-tier rate limit reached. Try again in a moment.");
    expect(summary.length).toBeLessThan(100);
  });

  it("extracts just the first line of the message for other structured provider errors", () => {
    const raw = JSON.stringify({
      error: {
        code: 500,
        message: "Internal error occurred.\nSome very long stack-trace-shaped continuation nobody needs to see.",
        status: "INTERNAL",
      },
    });

    const summary = summarizeLLMError(raw);

    expect(summary).toBe("Internal error occurred.");
  });

  it("truncates a long plain (non-JSON) error string instead of passing it through whole", () => {
    const raw = "x".repeat(500);

    const summary = summarizeLLMError(raw);

    expect(summary.length).toBeLessThanOrEqual(201);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("passes short plain error strings through unchanged", () => {
    expect(summarizeLLMError("GEMINI_API_KEY is not set")).toBe("GEMINI_API_KEY is not set");
  });

  it("never throws on malformed input", () => {
    expect(() => summarizeLLMError("{not valid json")).not.toThrow();
    expect(() => summarizeLLMError("")).not.toThrow();
  });
});
