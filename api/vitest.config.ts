import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    // These are integration tests against one real, shared Mongo instance
    // (no per-file DB isolation) — files clearing overlapping collections in
    // beforeEach race each other if run in parallel workers.
    fileParallelism: false,
  },
});
