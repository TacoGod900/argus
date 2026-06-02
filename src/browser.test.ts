import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserHarness } from "./browser.js";
import { EvidenceCollector, isFailedRequest } from "./evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "../test/fixtures/app-server.mjs");
const PORT = 4601;
const base = `http://localhost:${PORT}`;

let server: ChildProcess;

beforeAll(async () => {
  server = spawn("node", [serverPath], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  // wait for ready
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("fixture app-server did not start");
}, 20_000);

afterAll(() => {
  server?.kill();
});

describe("BrowserHarness", () => {
  it("drives the page and captures console errors, network, and a screenshot", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "argus-run-"));
    const collector = new EvidenceCollector(runDir);
    const harness = await BrowserHarness.launch(collector, { headless: true });

    try {
      collector.setStep(1);
      const nav = await harness.callTool("navigate", { url: base });
      expect(nav).toContain("status 200");

      await harness.callTool("fill", { target: "Email", value: "demo@example.com" });
      const click = await harness.callTool("click", { target: "Sign up" });
      expect(click).toContain("clicked");

      // give the click's fetch time to fail
      await harness.callTool("wait_for", { ms: 500 });

      const shot = await harness.callTool("screenshot", { label: "after click" });
      expect(shot).toContain("saved screenshot");

      const text = await harness.callTool("get_text", {});
      expect(text).toContain("Fixture App");
    } finally {
      await harness.close();
    }

    // console error captured
    const consoleErrors = collector.getConsole().filter((c) => c.type === "error");
    expect(consoleErrors.some((c) => c.text.includes("demo console error"))).toBe(true);

    // failed/404 network captured
    const failed = collector.getNetwork().filter(isFailedRequest);
    expect(failed.some((n) => n.url.includes("/api/missing"))).toBe(true);

    // screenshot written to disk
    const files = await readdir(runDir);
    expect(files.some((f) => f.endsWith(".png"))).toBe(true);
  }, 40_000);
});
