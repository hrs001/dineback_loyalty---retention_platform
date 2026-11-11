import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo } from "../lib/mongo.js";

const RESULTS_PATH = fileURLToPath(new URL("../../eval-results.json", import.meta.url));
const BACKUP_PATH = `${RESULTS_PATH}.test-backup`;

describe("Slice 3: GET /eval-results (scorecard, Locked Contract #7)", () => {
  let app: FastifyInstance;
  let hadRealResults = false;

  beforeAll(async () => {
    await connectMongo();
    app = await buildServer();
    await app.ready();

    // A real `npm run eval` result may already exist on disk — preserve it
    // rather than destroying a developer's published eval run.
    if (existsSync(RESULTS_PATH)) {
      hadRealResults = true;
      renameSync(RESULTS_PATH, BACKUP_PATH);
    }
  });

  afterAll(async () => {
    if (hadRealResults) renameSync(BACKUP_PATH, RESULTS_PATH);
    await app.close();
    await disconnectMongo();
  });

  afterEach(() => {
    if (existsSync(RESULTS_PATH)) unlinkSync(RESULTS_PATH);
  });

  it("returns ranAt: null (not a 404 or blank panel) when no eval has run yet", async () => {
    const res = await app.inject({ method: "GET", url: "/eval-results" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ranAt).toBeNull();
  });

  it("returns the last written eval summary when one exists", async () => {
    writeFileSync(RESULTS_PATH, JSON.stringify({ ranAt: "2026-01-01T00:00:00.000Z", total: 18, passed: 16, passRate: 0.89 }));

    const res = await app.inject({ method: "GET", url: "/eval-results" });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(18);
    expect(res.json().passed).toBe(16);
  });
});
