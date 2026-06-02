import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { EvidenceCollector } from "./evidence.js";

/** A tool definition in the shape the Anthropic API expects. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const MAX_TEXT = 4000;

/**
 * Wraps a Playwright page. Two jobs:
 *  1. Expose a small set of browser tools the agent can call.
 *  2. Passively capture console messages and network traffic into the EvidenceCollector.
 */
export class BrowserHarness {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly collector: EvidenceCollector,
  ) {}

  static async launch(
    collector: EvidenceCollector,
    opts: { headless?: boolean } = {},
  ): Promise<BrowserHarness> {
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("console", (msg) => collector.addConsole(msg.type(), msg.text()));
    page.on("pageerror", (err) => collector.addConsole("error", err.message));
    page.on("requestfailed", (req) => {
      collector.addNetwork({
        method: req.method(),
        url: req.url(),
        status: null,
        failure: req.failure()?.errorText ?? "request failed",
        durationMs: null,
      });
    });
    page.on("response", (res) => {
      const req = res.request();
      const timing = req.timing();
      const durationMs =
        timing && timing.responseEnd > 0 ? Math.round(timing.responseEnd) : null;
      collector.addNetwork({
        method: req.method(),
        url: res.url(),
        status: res.status(),
        failure: null,
        durationMs,
      });
    });

    return new BrowserHarness(browser, page, collector);
  }

  /** Tool schemas advertised to the model. Static; safe to prompt-cache. */
  getToolDefs(): ToolDef[] {
    return [
      {
        name: "navigate",
        description: "Navigate the browser to a URL.",
        input_schema: {
          type: "object",
          properties: { url: { type: "string", description: "Absolute URL to open." } },
          required: ["url"],
        },
      },
      {
        name: "click",
        description:
          "Click an element. `target` may be a CSS selector, a button/link name, or visible text.",
        input_schema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
      {
        name: "fill",
        description:
          "Type into an input. `target` may be a CSS selector, the input's placeholder, or its label.",
        input_schema: {
          type: "object",
          properties: { target: { type: "string" }, value: { type: "string" } },
          required: ["target", "value"],
        },
      },
      {
        name: "get_text",
        description: "Return the visible text of the current page (truncated).",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "screenshot",
        description: "Capture a screenshot of the current page as evidence.",
        input_schema: {
          type: "object",
          properties: { label: { type: "string", description: "Short label for the shot." } },
          required: ["label"],
        },
      },
      {
        name: "wait_for",
        description: "Wait for some text to appear, or just wait a number of milliseconds.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Visible text to wait for." },
            ms: { type: "number", description: "Milliseconds to wait (default 1000)." },
          },
        },
      },
    ];
  }

  /** Execute a tool call by name. Returns a concise human/LLM-readable result string. */
  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "navigate":
          return await this.navigate(String(input.url));
        case "click":
          return await this.click(String(input.target));
        case "fill":
          return await this.fill(String(input.target), String(input.value));
        case "get_text":
          return await this.getText();
        case "screenshot":
          return await this.screenshot(String(input.label));
        case "wait_for":
          return await this.waitFor(
            input.text === undefined ? undefined : String(input.text),
            input.ms === undefined ? undefined : Number(input.ms),
          );
        default:
          return `ERROR: unknown tool "${name}"`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: ${msg.split("\n")[0]}`;
    }
  }

  /** Compact page state for the agent to reason over between steps. */
  async snapshot(): Promise<string> {
    const url = this.page.url();
    let title = "";
    let text = "";
    try {
      title = await this.page.title();
      text = (await this.page.locator("body").innerText({ timeout: 3000 })).slice(0, 1500);
    } catch {
      /* page may be mid-navigation */
    }
    return `url: ${url}\ntitle: ${title}\nvisible text (excerpt):\n${text}`;
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
  }

  // --- tool implementations -------------------------------------------------

  private async navigate(url: string): Promise<string> {
    const res = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const title = await this.page.title().catch(() => "");
    return `navigated to ${this.page.url()} (status ${res?.status() ?? "?"}), title "${title}"`;
  }

  private async click(target: string): Promise<string> {
    const loc = await this.locate(target);
    await loc.click({ timeout: 10_000 });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    return `clicked "${target}". now at ${this.page.url()}`;
  }

  private async fill(target: string, value: string): Promise<string> {
    const loc = await this.locate(target, { input: true });
    await loc.fill(value, { timeout: 10_000 });
    return `filled "${target}" with "${value}"`;
  }

  private async getText(): Promise<string> {
    const text = await this.page.locator("body").innerText({ timeout: 5000 });
    return text.slice(0, MAX_TEXT);
  }

  private async screenshot(label: string): Promise<string> {
    const png = await this.page.screenshot({ fullPage: true });
    const entry = await this.collector.saveScreenshot(label, png);
    return `saved screenshot "${label}" -> ${entry.path}`;
  }

  private async waitFor(text?: string, ms?: number): Promise<string> {
    if (text) {
      await this.page.getByText(text, { exact: false }).first().waitFor({
        state: "visible",
        timeout: ms ?? 10_000,
      });
      return `text "${text}" appeared`;
    }
    await this.page.waitForTimeout(ms ?? 1000);
    return `waited ${ms ?? 1000}ms`;
  }

  /**
   * Resolve a natural target string to a Playwright locator, trying several strategies
   * so the agent doesn't have to know the exact selector for arbitrary apps.
   */
  private async locate(target: string, opts: { input?: boolean } = {}): Promise<Locator> {
    const candidates: Locator[] = [];

    // 1. Treat as a CSS selector if it looks like one.
    if (/[#.\[\]>]|^[a-z]+$/i.test(target)) {
      candidates.push(this.page.locator(target));
    }

    if (opts.input) {
      candidates.push(this.page.getByLabel(target, { exact: false }));
      candidates.push(this.page.getByPlaceholder(target, { exact: false }));
      candidates.push(this.page.locator(`input[name="${target}" i], textarea[name="${target}" i]`));
    } else {
      candidates.push(this.page.getByRole("button", { name: target, exact: false }));
      candidates.push(this.page.getByRole("link", { name: target, exact: false }));
      candidates.push(this.page.getByText(target, { exact: false }));
    }

    for (const c of candidates) {
      if ((await c.count()) > 0) return c.first();
    }
    // Fall back to the first candidate so the caller gets a meaningful timeout error.
    return candidates[0] ?? this.page.locator(target);
  }
}
