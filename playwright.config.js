import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:8767",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "python server.py",
    url: "http://127.0.0.1:8767/healthz",
    timeout: 15_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      FLOODLENS_HOST: "127.0.0.1",
      FLOODLENS_PORT: "8767",
      FLOODLENS_FIXTURE_DIR: "tests/fixtures",
    },
  },
});
