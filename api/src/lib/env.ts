import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/**
 * TENANT_STOREFRONT_KEYS maps a storefront API key to a tenantId, e.g.
 * `key-abc:rest_1,key-def:rest_2`. This is the Slice 0 stand-in for a real
 * auth system — the point (Locked Contract #9) is that tenantId is ALWAYS
 * derived server-side from this lookup, never read from the request body.
 */
function parseStorefrontKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, tenantId] = pair.split(":");
    if (!key || !tenantId) continue;
    map.set(key, tenantId);
  }
  return map;
}

/**
 * MARKETPLACE_WEBHOOK_SECRETS maps tenantId to its per-tenant marketplace
 * webhook secret, e.g. `rest_1:secret-abc,rest_2:secret-def`. The route is
 * `/webhooks/marketplace/:tenantId` — tenantId in the URL is NOT trusted on
 * its own (that would violate Contract #9); it only becomes the resolved
 * tenant once the request's HMAC signature verifies against THAT tenantId's
 * secret. An attacker without the right secret cannot produce a valid
 * signature for someone else's tenantId, so this is authenticated, not
 * merely path-supplied.
 */
function parseMarketplaceSecrets(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [tenantId, secret] = pair.split(":");
    if (!tenantId || !secret) continue;
    map.set(tenantId, secret);
  }
  return map;
}

export const env = {
  port: Number(process.env.PORT ?? 8000),
  mongoUri: required("MONGO_URI", "mongodb://localhost:27017/loop?replicaSet=rs0"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  logLevel: process.env.LOG_LEVEL ?? "info",
  storefrontKeys: parseStorefrontKeys(
    process.env.TENANT_STOREFRONT_KEYS ?? "dev-storefront-key:rest_demo"
  ),
  marketplaceSecrets: parseMarketplaceSecrets(
    process.env.MARKETPLACE_WEBHOOK_SECRETS ?? "rest_demo:dev-marketplace-secret"
  ),
  // Locked Contract #3: per-tenant admin key, not one global key.
  adminKeys: parseStorefrontKeys(process.env.TENANT_ADMIN_KEYS ?? "dev-admin-key:rest_demo"),
  // Slice 3: free-tier Gemini call for the retention agent's structured
  // decision (Locked Contract #1). Get a key at https://aistudio.google.com/apikey.
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest",
  // Locked Contract #1: daily send-cap defaults to 50/tenant, configurable.
  retentionDailySendCap: Number(process.env.RETENTION_DAILY_SEND_CAP ?? 50),
  // "Scheduled via BullMQ" — how often the worker sweeps every known tenant.
  // Defaults to 24h; a demo triggers a run on demand via POST /admin/retention/run
  // instead of waiting for the interval.
  retentionScheduleIntervalMs: Number(
    process.env.RETENTION_SCHEDULE_INTERVAL_MS ?? 24 * 60 * 60 * 1000
  ),
  // Slice 4: optional — PageSpeed Insights works keyless, but its anonymous
  // quota is quite low (a handful of requests/minute) and a real deployment
  // will want a free key from https://console.cloud.google.com (enable the
  // "PageSpeed Insights API") for a much higher quota.
  pagespeedApiKey: process.env.PAGESPEED_API_KEY ?? "",
};

/**
 * Tenants known to this deployment — derived from the same key maps
 * tenantAuth.ts resolves auth against, never a separate hardcoded list.
 * Used only to seed the scheduled sweep (which tenants to iterate), not for
 * request-time auth.
 */
export function listKnownTenantIds(): string[] {
  return [...new Set([...env.storefrontKeys.values(), ...env.adminKeys.values()])];
}
