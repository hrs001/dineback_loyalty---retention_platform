import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { connectMongo } from "./lib/mongo.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerMarketplaceRoutes } from "./routes/marketplace.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerEvalRoutes } from "./routes/eval.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { recordWebhookOutcome } from "./services/metrics.js";
import type { LLMClient } from "./services/llm.js";

export interface BuildServerOptions {
  /** Test-only override for /admin/replay's retention-decision LLM call. */
  llm?: LLMClient;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: env.logLevel,
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true } },
    },
  });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Marketplace webhook signatures are computed over the RAW body — capture
  // it before Fastify's default parser JSON.parses it, so the raw bytes
  // used for HMAC verification are exactly what the sender signed.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.get("/health", async () => ({ status: "ok" }));

  // Slice 5 "webhook success rate" metric: every ingestion delivery attempt
  // (storefront POST /orders, marketplace webhook), 2xx/3xx counted as a
  // success. In-memory and process-lifetime — see services/metrics.ts.
  app.addHook("onResponse", async (req, reply) => {
    const isIngestionRoute =
      req.method === "POST" && (req.url === "/orders" || req.url.startsWith("/webhooks/marketplace/"));
    if (isIngestionRoute) recordWebhookOutcome(reply.statusCode < 400);
  });

  registerOrderRoutes(app);
  registerMarketplaceRoutes(app);
  registerAdminRoutes(app, opts.llm);
  registerEvalRoutes(app);
  registerMetricsRoutes(app);

  return app;
}

async function main() {
  await connectMongo();
  const app = await buildServer();
  await app.listen({ port: env.port, host: "0.0.0.0" });
  logger.info({ port: env.port }, "loop api listening");
}

// Only auto-start when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, "fatal startup error");
    process.exit(1);
  });
}
