import { describe, expect, it } from "vitest";
import { buildArgusTools } from "./tools.js";
import type { BrowserHarness } from "./browser.js";

function fakeHarness() {
  const calls: string[] = [];
  const harness = {
    async callTool(name: string, input: Record<string, unknown>) {
      calls.push(`${name}:${JSON.stringify(input)}`);
      return `ok(${name})`;
    },
  } as unknown as BrowserHarness;
  return { harness, calls };
}

describe("buildArgusTools", () => {
  it("exposes the browser tools plus view + report_step, namespaced for the SDK", () => {
    const { harness } = fakeHarness();
    const built = buildArgusTools(harness);
    expect(built.toolNames).toEqual([
      "mcp__argus__navigate",
      "mcp__argus__snapshot",
      "mcp__argus__click",
      "mcp__argus__fill",
      "mcp__argus__press",
      "mcp__argus__select",
      "mcp__argus__hover",
      "mcp__argus__scroll",
      "mcp__argus__go_back",
      "mcp__argus__go_forward",
      "mcp__argus__get_text",
      "mcp__argus__screenshot",
      "mcp__argus__view",
      "mcp__argus__wait_for",
      "mcp__argus__report_step",
    ]);
  });

  it("a browser tool handler delegates to harness.callTool and returns its text", async () => {
    const { harness, calls } = fakeHarness();
    const built = buildArgusTools(harness);
    const res = await built.handlers.navigate({ url: "http://app/login" });
    expect(calls).toContain('navigate:{"url":"http://app/login"}');
    expect(res.content[0]).toMatchObject({ type: "text", text: "ok(navigate)" });
    expect(built.toolCallCount()).toBe(1);
  });

  it("report_step records the verdict and does not count as a browser tool call", async () => {
    const { harness } = fakeHarness();
    const built = buildArgusTools(harness);
    await built.handlers.report_step({ satisfied: false, summary: "login returned 401" });
    expect(built.takeReport()).toEqual({ satisfied: false, summary: "login returned 401" });
    expect(built.toolCallCount()).toBe(0);
  });

  it("resetToolCallCount resets the browser tool counter to zero", async () => {
    const { harness } = fakeHarness();
    const built = buildArgusTools(harness);
    await built.handlers.navigate({ url: "http://x" });
    expect(built.toolCallCount()).toBe(1);
    built.resetToolCallCount();
    expect(built.toolCallCount()).toBe(0);
  });
});
