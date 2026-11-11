import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RESULTS_PATH = fileURLToPath(new URL("../../eval-results.json", import.meta.url));

/**
 * Serves the Slice 3 eval scorecard (Locked Contract #7, Selective
 * Expansion 3) — whatever `npm run eval` last wrote. Not tenant-scoped or
 * sensitive (aggregate pass-rate stats about the agent itself), so no auth.
 * Test Plan's "Eval scorecard empty state": no file yet -> `ranAt: null`,
 * never a 404 or a blank/broken panel.
 */
export function registerEvalRoutes(app: FastifyInstance): void {
  app.get("/eval-results", async (_req, reply) => {
    try {
      const raw = await readFile(RESULTS_PATH, "utf-8");
      return reply.send(JSON.parse(raw));
    } catch {
      return reply.send({ ranAt: null });
    }
  });
}
