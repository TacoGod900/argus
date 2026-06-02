import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runSteps } from "./agent.js";
import type { BrowserHarness, ToolDef } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";

/** Build a fake Anthropic client that returns a scripted queue of responses. */
function fakeClient(responses: Array<{ content: unknown[] }>): {
  client: Anthropic;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const queue = [...responses];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        const next = queue.shift();
        if (!next) throw new Error("fakeClient: ran out of scripted responses");
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function toolUse(id: string, name: string, input: unknown) {
  return { type: "tool_use", id, name, input };
}

/** Minimal harness stub — records tool calls, returns canned strings. */
function fakeHarness(): { harness: BrowserHarness; toolLog: string[] } {
  const toolLog: string[] = [];
  const harness = {
    getToolDefs(): ToolDef[] {
      return [
        {
          name: "navigate",
          description: "go",
          input_schema: { type: "object", properties: { url: { type: "string" } } },
        },
      ];
    },
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

describe("runSteps", () => {
  it("executes browser tools then records the agent's report verdict", async () => {
    const { client, calls } = fakeClient([
      // turn 1: navigate
      { content: [toolUse("t1", "navigate", { url: "http://app/login" })] },
      // turn 2: conclude
      { content: [toolUse("t2", "report_step", { satisfied: true, summary: "logged in fine" })] },
    ]);
    const { harness, toolLog } = fakeHarness();

    const results = await runSteps(["log in"], harness, collector, {
      baseUrl: "http://app",
      client,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ index: 1, satisfied: true, summary: "logged in fine" });
    expect(results[0].toolCalls).toBe(1);
    // navigate ran, plus the auto end-of-step screenshot
    expect(toolLog).toContain('navigate:{"url":"http://app/login"}');
    expect(toolLog.some((t) => t.startsWith("screenshot:"))).toBe(true);
    // adaptive thinking + caching wired into the request
    expect(calls[0].thinking).toEqual({ type: "adaptive" });
    expect(Array.isArray(calls[0].system)).toBe(true);
  });

  it("captures a failure verdict when the agent reports satisfied: false", async () => {
    const { client } = fakeClient([
      { content: [toolUse("t1", "report_step", { satisfied: false, summary: "login returned 401" })] },
    ]);
    const { harness } = fakeHarness();

    const results = await runSteps(["log in"], harness, collector, {
      baseUrl: "http://app",
      client,
    });

    expect(results[0].satisfied).toBe(false);
    expect(results[0].summary).toContain("401");
  });

  it("nudges then marks the step blocked if the agent never reports", async () => {
    const { client } = fakeClient([
      { content: [{ type: "text", text: "I think I'm done." }] },
      { content: [{ type: "text", text: "Still chatting." }] },
      { content: [{ type: "text", text: "And again." }] },
    ]);
    const { harness } = fakeHarness();

    const results = await runSteps(["do a thing"], harness, collector, {
      baseUrl: "http://app",
      client,
    });

    expect(results[0].satisfied).toBe(false);
    expect(results[0].summary).toMatch(/without calling report_step/);
  });
});
