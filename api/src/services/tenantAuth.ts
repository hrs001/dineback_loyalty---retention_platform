import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { env } from "../lib/env.js";

/**
 * Locked Contract #9 (tenant isolation). tenantId is ALWAYS derived
 * server-side from the request's auth context — a storefront API key here,
 * a webhook signature in Slice 1, the admin API key for admin routes —
 * NEVER trusted from a client-supplied body/query param, even if present.
 *
 * This is the one function every tenant-scoped route calls to get its
 * tenantId. Nothing else in the codebase should read `req.body.tenantId`.
 */
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function lookupStorefrontKey(key: unknown): string {
  if (typeof key !== "string") {
    throw new UnauthorizedError("missing storefront key");
  }
  const tenantId = env.storefrontKeys.get(key);
  if (!tenantId) {
    throw new UnauthorizedError("invalid storefront key");
  }
  return tenantId;
}

export function resolveTenantFromStorefrontKey(req: FastifyRequest): string {
  return lookupStorefrontKey(req.headers["x-storefront-key"]);
}

/**
 * WebSocket variant (Slice 2 live feed). Browsers can't set custom headers
 * on the WS handshake, so the same storefront key travels as a query param
 * instead — the lookup is identical to the header path (still a
 * server-resolved tenantId, never a client-supplied one; only the transport
 * differs), which is why this delegates to the same `lookupStorefrontKey`.
 */
export function resolveTenantFromStorefrontKeyQuery(req: FastifyRequest): string {
  const query = req.query as Record<string, unknown>;
  return lookupStorefrontKey(query?.key);
}

/**
 * Marketplace webhook auth (Slice 1). tenantId arrives in the URL path but
 * is NOT trusted on its own — see the comment on MARKETPLACE_WEBHOOK_SECRETS
 * in env.ts. It only becomes the resolved tenant once the HMAC-SHA256
 * signature over the raw request body verifies against THAT tenantId's
 * secret. Constant-time comparison to avoid a timing side-channel.
 */
export function verifyMarketplaceWebhook(
  tenantId: string,
  rawBody: string,
  signatureHeader: unknown
): void {
  if (typeof signatureHeader !== "string" || !signatureHeader) {
    throw new UnauthorizedError("missing x-marketplace-signature header");
  }
  const secret = env.marketplaceSecrets.get(tenantId);
  if (!secret) {
    throw new UnauthorizedError("unknown tenant");
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signatureHeader, "hex");
  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw new UnauthorizedError("invalid signature");
  }
}

/** Locked Contract #3: a PER-TENANT admin key, not one global key. */
export function resolveTenantFromAdminKey(req: FastifyRequest): string {
  const key = req.headers["x-admin-key"];
  if (typeof key !== "string") {
    throw new UnauthorizedError("missing x-admin-key header");
  }
  const tenantId = env.adminKeys.get(key);
  if (!tenantId) {
    throw new UnauthorizedError("invalid admin key");
  }
  return tenantId;
}
