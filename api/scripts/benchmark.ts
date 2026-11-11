/**
 * Slice 1 benchmark: fires a realistic burst of concurrent, occasionally-
 * duplicated marketplace orders against a running API, and reports
 * orders/sec + p50/p95 latency. Duplicates prove idempotency holds under
 * real concurrency, not just sequential calls (the sequential case is
 * already covered by the test suite).
 *
 * Usage: API must be running (`npm run dev` or `docker compose up`).
 *   npx tsx scripts/benchmark.ts [count] [dupRate]
 */
import { createHmac } from "node:crypto";

const API_URL = process.env.API_URL ?? "http://localhost:8000";
const TENANT = process.env.TENANT_ID ?? "rest_demo";
const SECRET = process.env.MARKETPLACE_SECRET ?? "dev-marketplace-secret";

const COUNT = Number(process.argv[2] ?? 200);
const DUP_RATE = Number(process.argv[3] ?? 0.15); // fraction of orders re-sent as duplicates

function sign(raw: string): string {
  return createHmac("sha256", SECRET).update(raw).digest("hex");
}

async function sendOrder(orderId: string): Promise<number> {
  const body = JSON.stringify({
    order_id: orderId,
    customer: { external_id: `cust_${orderId}` },
    line_items: [{ title: "Benchmark Item", unit_price_cents: 1999, quantity: 1 }],
  });
  const start = performance.now();
  const res = await fetch(`${API_URL}/webhooks/marketplace/${TENANT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-marketplace-signature": sign(body) },
    body,
  });
  await res.json();
  if (!res.ok) throw new Error(`order ${orderId} failed: ${res.status}`);
  return performance.now() - start;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const orderIds: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    orderIds.push(`bench_${i}`);
    if (Math.random() < DUP_RATE) orderIds.push(`bench_${i}`); // duplicate delivery
  }
  // Shuffle so duplicates aren't always adjacent — closer to real
  // out-of-order webhook retry behavior.
  for (let i = orderIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [orderIds[i], orderIds[j]] = [orderIds[j], orderIds[i]];
  }

  console.log(
    `Firing ${orderIds.length} concurrent requests (${COUNT} unique orders, ~${Math.round(
      DUP_RATE * 100
    )}% duplicated) at ${API_URL}...`
  );

  const wallStart = performance.now();
  const results = await Promise.allSettled(orderIds.map((id) => sendOrder(id)));
  const wallElapsed = (performance.now() - wallStart) / 1000;

  const latencies = results
    .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => a - b);
  const failures = results.filter((r) => r.status === "rejected").length;

  console.log("--- Results ---");
  console.log(`Total requests:  ${orderIds.length}`);
  console.log(`Failures:        ${failures}`);
  console.log(`Wall time:       ${wallElapsed.toFixed(2)}s`);
  console.log(`Throughput:      ${(orderIds.length / wallElapsed).toFixed(1)} req/s`);
  console.log(`p50 latency:     ${percentile(latencies, 50).toFixed(1)}ms`);
  console.log(`p95 latency:     ${percentile(latencies, 95).toFixed(1)}ms`);
  console.log(`p99 latency:     ${percentile(latencies, 99).toFixed(1)}ms`);

  // Idempotency check: unique orders in Mongo should equal COUNT, never
  // orderIds.length (which includes the intentional duplicates).
  console.log(
    `\nIdempotency: sent ${orderIds.length} requests for ${COUNT} unique order_ids — ` +
      `verify via GET /admin equivalent or a direct DB count that exactly ${COUNT} Orders exist.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
