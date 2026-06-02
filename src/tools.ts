import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserHarness } from "./browser.js";

export interface StepReport {
  satisfied: boolean;
  summary: string;
}

type ToolText = { content: [{ type: "text"; text: string }] };

export interface ArgusTools {
  server: ReturnType<typeof createSdkMcpServer>;
  toolNames: string[];
  handlers: {
    navigate: (a: Record<string, unknown>) => Promise<ToolText>;
    click: (a: Record<string, unknown>) => Promise<ToolText>;
    fill: (a: Record<string, unknown>) => Promise<ToolText>;
    get_text: (a: Record<string, unknown>) => Promise<ToolText>;
    screenshot: (a: Record<string, unknown>) => Promise<ToolText>;
    wait_for: (a: Record<string, unknown>) => Promise<ToolText>;
    report_step: (a: Record<string, unknown>) => Promise<ToolText>;
  };
  toolCallCount: () => number;
  resetToolCallCount: () => void;
  takeReport: () => StepReport | null;
}

const text = (t: string): ToolText => ({ content: [{ type: "text", text: t }] });
const SERVER_NAME = "argus";

export function buildArgusTools(harness: BrowserHarness): ArgusTools {
  let toolCalls = 0;
  let report: StepReport | null = null;

  const browserHandler =
    (name: string) =>
    async (args: Record<string, unknown>): Promise<ToolText> => {
      toolCalls++;
      return text(await harness.callTool(name, args));
    };

  const handlers = {
    navigate: browserHandler("navigate"),
    click: browserHandler("click"),
    fill: browserHandler("fill"),
    get_text: browserHandler("get_text"),
    screenshot: browserHandler("screenshot"),
    wait_for: browserHandler("wait_for"),
    report_step: async (args: Record<string, unknown>): Promise<ToolText> => {
      report = {
        satisfied: Boolean(args["satisfied"]),
        summary: String(args["summary"] ?? "(no summary)"),
      };
      return text("recorded");
    },
  };

  const argusTools = [
    tool(
      "navigate",
      "Navigate the browser to a URL.",
      { url: z.string().describe("Absolute URL to open.") },
      handlers.navigate,
    ),
    tool(
      "click",
      "Click an element. `target` may be a CSS selector, a button/link name, or visible text.",
      { target: z.string() },
      handlers.click,
    ),
    tool(
      "fill",
      "Type into an input. `target` may be a CSS selector, the input's placeholder, or its label.",
      { target: z.string(), value: z.string() },
      handlers.fill,
    ),
    tool(
      "get_text",
      "Return the visible text of the current page (truncated).",
      {},
      handlers.get_text,
    ),
    tool(
      "screenshot",
      "Capture a screenshot of the current page as evidence.",
      { label: z.string().describe("Short label for the shot.") },
      handlers.screenshot,
    ),
    tool(
      "wait_for",
      "Wait for some text to appear, or just wait a number of milliseconds.",
      { text: z.string().optional(), ms: z.number().optional() },
      handlers.wait_for,
    ),
    tool(
      "report_step",
      "Conclude the current step. Call exactly once when the step is finished.",
      {
        satisfied: z.boolean().describe("True only if the app behaved correctly for this step from a user's perspective."),
        summary: z.string().describe("One sentence: what you did and what you observed."),
      },
      handlers.report_step,
    ),
  ];

  const server = createSdkMcpServer({ name: SERVER_NAME, version: "0.1.0", tools: argusTools });

  const toolNames = argusTools.map((t) => `mcp__${SERVER_NAME}__${t.name}`);

  return {
    server,
    toolNames,
    handlers,
    toolCallCount: () => toolCalls,
    resetToolCallCount: () => { toolCalls = 0; },
    takeReport: () => { const r = report; report = null; return r; },
  };
}
