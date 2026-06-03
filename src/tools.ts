import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserHarness } from "./browser.js";

export interface StepReport {
  satisfied: boolean;
  summary: string;
}

type ToolText = { content: [{ type: "text"; text: string }] };
type ToolImage = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
};
type ToolHandler = (a: Record<string, unknown>) => Promise<ToolText | ToolImage>;

export interface ArgusTools {
  server: ReturnType<typeof createSdkMcpServer>;
  toolNames: string[];
  handlers: Record<string, ToolHandler>;
  toolCallCount: () => number;
  resetToolCallCount: () => void;
  takeReport: () => StepReport | null;
}

const text = (t: string): ToolText => ({ content: [{ type: "text", text: t }] });
const SERVER_NAME = "argus";

/** Browser actions that just delegate to `harness.callTool` and return its text. */
const BROWSER_ACTIONS = [
  "navigate",
  "snapshot",
  "click",
  "fill",
  "press",
  "select",
  "hover",
  "scroll",
  "go_back",
  "go_forward",
  "get_text",
  "screenshot",
  "wait_for",
] as const;

export interface ArgusToolsOptions {
  /** Max number of `view` (vision) images the model may request this run. Default 8. */
  maxImages?: number;
}

export function buildArgusTools(harness: BrowserHarness, opts: ArgusToolsOptions = {}): ArgusTools {
  let toolCalls = 0;
  let report: StepReport | null = null;
  let imagesUsed = 0;
  const maxImages = opts.maxImages ?? 8;

  const browserHandler =
    (name: string): ToolHandler =>
    async (args) => {
      toolCalls++;
      return text(await harness.callTool(name, args));
    };

  const handlers: Record<string, ToolHandler> = {};
  for (const name of BROWSER_ACTIONS) handlers[name] = browserHandler(name);

  handlers.view = async (): Promise<ToolImage> => {
    toolCalls++;
    if (imagesUsed >= maxImages) {
      return { content: [{ type: "text", text: `image budget exhausted (${maxImages} used)` }] };
    }
    imagesUsed++;
    const img = await harness.viewImage();
    return {
      content: [
        { type: "text", text: `screenshot (${imagesUsed}/${maxImages})` },
        { type: "image", data: img.base64, mimeType: img.mime },
      ],
    };
  };

  handlers.report_step = async (args): Promise<ToolText> => {
    report = {
      satisfied: Boolean(args["satisfied"]),
      summary: String(args["summary"] ?? "(no summary)"),
    };
    return text("recorded");
  };

  const argusTools = [
    tool("navigate", "Navigate the browser to a URL.", { url: z.string().describe("Absolute URL to open.") }, handlers.navigate),
    tool(
      "snapshot",
      "Return a compact accessibility tree of the current page. Each interactive element has a stable ref like `[ref=e12]`; pass that ref to click/fill/etc. Prefer this over get_text.",
      {},
      handlers.snapshot,
    ),
    tool(
      "click",
      "Click an element. `target` may be an element ref from the latest snapshot (e.g. `e12`), a CSS selector, a button/link name, or visible text.",
      { target: z.string() },
      handlers.click,
    ),
    tool(
      "fill",
      "Type into an input. `target` may be an element ref (e.g. `e12`), a CSS selector, the input's placeholder, or its label.",
      { target: z.string(), value: z.string() },
      handlers.fill,
    ),
    tool(
      "press",
      "Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown) on the focused element.",
      { key: z.string() },
      handlers.press,
    ),
    tool(
      "select",
      "Select an option in a <select>. `target` is a ref/selector; `value` is the option label or value.",
      { target: z.string(), value: z.string() },
      handlers.select,
    ),
    tool("hover", "Hover the pointer over an element (`target`: ref/selector/name).", { target: z.string() }, handlers.hover),
    tool(
      "scroll",
      "Scroll the page. `direction` is up|down (default down); `amount` in pixels (default 600).",
      { direction: z.string().optional(), amount: z.number().optional() },
      handlers.scroll,
    ),
    tool("go_back", "Navigate back in browser history.", {}, handlers.go_back),
    tool("go_forward", "Navigate forward in browser history.", {}, handlers.go_forward),
    tool("get_text", "Return the visible text of the current page (truncated). Prefer `snapshot`.", {}, handlers.get_text),
    tool(
      "screenshot",
      "Save a full-page screenshot to disk as evidence (you do NOT see it). Use `view` to actually look at the page.",
      { label: z.string().describe("Short label for the shot.") },
      handlers.screenshot,
    ),
    tool(
      "view",
      "Look at the current page: returns a downscaled screenshot you can actually see. Use for visual/UI checks. Limited per run.",
      {},
      handlers.view,
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
    resetToolCallCount: () => {
      toolCalls = 0;
    },
    takeReport: () => {
      const r = report;
      report = null;
      return r;
    },
  };
}
