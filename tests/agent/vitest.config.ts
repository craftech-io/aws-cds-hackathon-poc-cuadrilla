// Agent scenarios only (`agent-test run`): one file at a time, because the local model serializes turns
// anyway and the AWS fakes of a world are global to the process. Outside the root vitest.config.ts, so
// `npm test` and CI never run them.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/agent/**/*.agent.test.ts"],
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
  },
});
