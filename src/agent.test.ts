import { describe, expect, it } from "vitest";
import { runSteps } from "./agent.js";
import type { BrowserHarness } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";
import type { ArgusTools, StepReport } from "./tools.js";
import type { SessionDriver } from "./session.js";

function fakeHarness() {
  const toolLog: string[] = [];
  const harness = {
    async snapshot() {
      return "url: about:blank";
    },
    async callTool(name: string, input: Record<string, unknown>) {
      toolLog.push(`${name}:${JSON.stringify(input)}`);
      return `ok(${name})`;
    },
  } as unknown as BrowserHarness;
  return { harness, toolLog };
}

const collector = { setStep() {} } as unknown as EvidenceCollector;

/**
 * Build a tools double + a driver double that act together: each scripted entry is the
 * report the model "records" during that turn (null = the agent never called report_step).
 */
function fakeToolsAndDriver(scriptPerTurn: Array<StepReport | null>) {
  let report: StepReport | null = null;
  let turn = 0;
  const tools = {
    server: {},
    toolNames: ["mcp__argus__report_step"],
    handlers: {},
    toolCallCount: () => 1,
    resetToolCallCount: () => {},
    takeReport: () => {
      const r = report;
      report = null;
      return r;
    },
  } as unknown as ArgusTools;
  const driver: SessionDriver = {
    async sendTurn() {
      report = scriptPerTurn[turn++] ?? null;
      return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    },
    async close() {},
  };
  return { tools, driver };
}

describe("runSteps", () => {
  it("records the report verdict and auto-captures an end-of-step screenshot", async () => {
    const { harness, toolLog } = fakeHarness();
    const { tools, driver } = fakeToolsAndDriver([{ satisfied: true, summary: "logged in fine" }]);

    const { results } = await runSteps(["log in"], harness, collector, {
      baseUrl: "http://app",
      _tools: tools,
      _driver: driver,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ index: 1, satisfied: true, summary: "logged in fine" });
    expect(toolLog.some((t) => t.startsWith("screenshot:"))).toBe(true);
  });

  it("captures a failure verdict when the agent reports satisfied: false", async () => {
    const { harness } = fakeHarness();
    const { tools, driver } = fakeToolsAndDriver([{ satisfied: false, summary: "login returned 401" }]);

    const { results } = await runSteps(["log in"], harness, collector, {
      baseUrl: "http://app",
      _tools: tools,
      _driver: driver,
    });

    expect(results[0].satisfied).toBe(false);
    expect(results[0].summary).toContain("401");
  });

  it("nudges then marks the step blocked when no report arrives", async () => {
    const { harness } = fakeHarness();
    const { tools, driver } = fakeToolsAndDriver([null, null, null]); // never reports

    const { results } = await runSteps(["do a thing"], harness, collector, {
      baseUrl: "http://app",
      _tools: tools,
      _driver: driver,
    });

    expect(results[0].satisfied).toBe(false);
    expect(results[0].summary).toMatch(/without calling report_step/);
  });
});
