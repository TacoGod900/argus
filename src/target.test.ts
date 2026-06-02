import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchTarget, waitForReady } from "./target.js";
import type { TargetConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = resolve(repoRoot, "test/fixtures/hello-server.mjs");

const PORT = 4599;

function helloConfig(): TargetConfig {
  return {
    repo: repoRoot,
    start: `node "${serverPath}"`,
    baseUrl: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    readyCheck: {
      url: `http://localhost:${PORT}`,
      expectStatus: 200,
      timeoutMs: 15_000,
      intervalMs: 250,
    },
  };
}

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (stop) await stop();
  stop = null;
});

describe("waitForReady", () => {
  it("throws when the app never comes up", async () => {
    await expect(
      waitForReady({
        ...helloConfig(),
        readyCheck: {
          url: "http://localhost:4600",
          expectStatus: 200,
          timeoutMs: 600,
          intervalMs: 200,
        },
      }),
    ).rejects.toThrow(/did not become ready/);
  });
});

describe("launchTarget", () => {
  it("starts a hello-world server and reports ready, then stops it", async () => {
    const target = await launchTarget(helloConfig());
    stop = target.stop;

    const res = await fetch(target.baseUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from fixture");

    await target.stop();
    stop = null;

    // After stop, the port should no longer answer.
    await expect(fetch(target.baseUrl)).rejects.toBeDefined();
  }, 30_000);
});
