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
/** Cap the a11y snapshot so a huge page can't blow the context budget. */
const MAX_SNAPSHOT = 12_000;
/** Image returned to the model by `view()`, downscaled to keep tokens bounded. */
export interface ViewImage {
  base64: string;
  mime: "image/png";
}

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
    const refOrTarget =
      "Either an element ref from the latest snapshot (e.g. `e12`), a CSS selector, " +
      "a button/link name, or visible text.";
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
        name: "snapshot",
        description:
          "Return a compact accessibility tree of the current page. Each interactive element " +
          "has a stable ref like `[ref=e12]`; pass that ref to click/fill/etc. Prefer this over get_text.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "click",
        description: `Click an element. \`target\`: ${refOrTarget}`,
        input_schema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
      {
        name: "fill",
        description: `Type into an input. \`target\`: ${refOrTarget}`,
        input_schema: {
          type: "object",
          properties: { target: { type: "string" }, value: { type: "string" } },
          required: ["target", "value"],
        },
      },
      {
        name: "press",
        description: "Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown). Targets the focused element.",
        input_schema: {
          type: "object",
          properties: { key: { type: "string", description: "Key name, Playwright syntax." } },
          required: ["key"],
        },
      },
      {
        name: "select",
        description: `Select an option in a <select>. \`target\`: ${refOrTarget}; \`value\` is the option label or value.`,
        input_schema: {
          type: "object",
          properties: { target: { type: "string" }, value: { type: "string" } },
          required: ["target", "value"],
        },
      },
      {
        name: "hover",
        description: `Hover the pointer over an element. \`target\`: ${refOrTarget}`,
        input_schema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
      {
        name: "scroll",
        description: "Scroll the page. `direction` is up|down (default down); `amount` in pixels (default 600).",
        input_schema: {
          type: "object",
          properties: {
            direction: { type: "string", description: "up or down" },
            amount: { type: "number" },
          },
        },
      },
      {
        name: "go_back",
        description: "Navigate back in browser history.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "go_forward",
        description: "Navigate forward in browser history.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "get_text",
        description: "Return the visible text of the current page (truncated). Prefer `snapshot` for structure.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "screenshot",
        description: "Save a full-page screenshot to disk as evidence (the model does not see it). Use `view` to actually look.",
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
        case "snapshot":
          return await this.ariaSnapshot();
        case "click":
          return await this.click(String(input.target));
        case "fill":
          return await this.fill(String(input.target), String(input.value));
        case "press":
          return await this.press(String(input.key));
        case "select":
          return await this.select(String(input.target), String(input.value));
        case "hover":
          return await this.hover(String(input.target));
        case "scroll":
          return await this.scroll(
            input.direction === undefined ? undefined : String(input.direction),
            input.amount === undefined ? undefined : Number(input.amount),
          );
        case "go_back":
          return await this.goBack();
        case "go_forward":
          return await this.goForward();
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

  /**
   * Compact accessibility-tree snapshot with stable element refs (`[ref=eNN]`), the
   * playwright-mcp technique. Each interactive element gets a ref the agent passes back to
   * click/fill/etc, resolved via the `aria-ref=` selector engine.
   *
   * Uses `page._snapshotForAI()` (internal, but stable and what playwright-mcp depends on);
   * falls back to the public `ariaSnapshot({ mode: "ai" })` if it is ever removed.
   */
  async ariaSnapshot(): Promise<string> {
    const url = this.page.url();
    let title = "";
    let tree = "";
    try {
      title = await this.page.title();
      const pageAny = this.page as unknown as {
        _snapshotForAI?: () => Promise<string>;
      };
      if (typeof pageAny._snapshotForAI === "function") {
        tree = await pageAny._snapshotForAI();
      } else {
        tree = await this.page.locator("body").ariaSnapshot({ mode: "ai" } as never);
      }
    } catch {
      /* page may be mid-navigation */
    }
    if (tree.length > MAX_SNAPSHOT) tree = `${tree.slice(0, MAX_SNAPSHOT)}\n… (snapshot truncated)`;
    return `url: ${url}\ntitle: ${title}\n${tree}`;
  }

  /** Back-compat alias kept for callers/tests that expect a `snapshot()` string. */
  async snapshot(): Promise<string> {
    return this.ariaSnapshot();
  }

  /**
   * Downscaled viewport screenshot returned to the model as image content (via the `view` tool).
   * Kept separate from the disk-only `screenshot()` evidence path and capped by an image budget
   * in the tools layer.
   */
  async viewImage(): Promise<ViewImage> {
    const png = await this.page.screenshot({ fullPage: false, scale: "css" });
    return { base64: png.toString("base64"), mime: "image/png" };
  }

  /** Same-origin links discovered on the current page. Pure data for the crawl frontier. */
  async collectLinks(): Promise<string[]> {
    const origin = new URL(this.page.url()).origin;
    const hrefs = await this.page
      .evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href),
      )
      .catch(() => [] as string[]);
    const seen = new Set<string>();
    for (const h of hrefs) {
      try {
        const u = new URL(h);
        if (u.origin === origin) {
          u.hash = "";
          seen.add(u.href);
        }
      } catch {
        /* skip non-absolute / malformed */
      }
    }
    return [...seen];
  }

  /** URLs of images that failed to load (naturalWidth === 0). For deterministic checks. */
  async findBrokenImages(): Promise<string[]> {
    return this.page
      .evaluate(() =>
        Array.from(document.images)
          .filter((img) => img.complete && img.naturalWidth === 0)
          .map((img) => img.currentSrc || img.src),
      )
      .catch(() => [] as string[]);
  }

  /** Current page URL — used by the crawl engine. */
  url(): string {
    return this.page.url();
  }

  /** Current page title — used by the crawl engine. */
  async title(): Promise<string> {
    return this.page.title().catch(() => "");
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
  }

  // --- tool implementations -------------------------------------------------

  private async navigate(url: string): Promise<string> {
    const res = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const title = await this.page.title().catch(() => "");
    return `navigated to ${this.page.url()} (status ${res?.status() ?? "?"}), title "${title}"`;
  }

  private async click(target: string): Promise<string> {
    const loc = await this.resolve(target);
    await loc.click({ timeout: 10_000 });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    return `clicked "${target}". now at ${this.page.url()}`;
  }

  private async fill(target: string, value: string): Promise<string> {
    const loc = await this.resolve(target, { input: true });
    await loc.fill(value, { timeout: 10_000 });
    return `filled "${target}" with "${value}"`;
  }

  private async press(key: string): Promise<string> {
    await this.page.keyboard.press(key);
    await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    return `pressed "${key}". now at ${this.page.url()}`;
  }

  private async select(target: string, value: string): Promise<string> {
    const loc = await this.resolve(target, { input: true });
    const chosen = await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
    return `selected ${JSON.stringify(chosen)} in "${target}"`;
  }

  private async hover(target: string): Promise<string> {
    const loc = await this.resolve(target);
    await loc.hover({ timeout: 10_000 });
    return `hovered "${target}"`;
  }

  private async scroll(direction?: string, amount?: number): Promise<string> {
    const dy = (direction === "up" ? -1 : 1) * (amount ?? 600);
    await this.page.mouse.wheel(0, dy);
    await this.page.waitForTimeout(200);
    return `scrolled ${direction === "up" ? "up" : "down"} ${Math.abs(dy)}px`;
  }

  private async goBack(): Promise<string> {
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    return `went back. now at ${this.page.url()}`;
  }

  private async goForward(): Promise<string> {
    await this.page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    return `went forward. now at ${this.page.url()}`;
  }

  private async getText(): Promise<string> {
    const text = await this.page.locator("body").innerText({ timeout: 5000 });
    return text.slice(0, MAX_TEXT);
  }

  private async screenshot(label: string): Promise<string> {
    const entry = await this.captureScreenshot(label);
    return `saved screenshot "${label}" -> ${entry}`;
  }

  /** Save a full-page screenshot as disk evidence and return its recorded path (structured). */
  async captureScreenshot(label: string): Promise<string> {
    const png = await this.page.screenshot({ fullPage: true });
    const entry = await this.collector.saveScreenshot(label, png);
    return entry.path;
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
   * Ref-first resolution: if `target` is an element ref from the latest a11y snapshot
   * (`e12` or `ref=e12`), resolve it via the `aria-ref=` selector engine for exact targeting.
   * Otherwise fall back to the heuristic `locate()` so plain names/text/selectors still work.
   */
  private async resolve(target: string, opts: { input?: boolean } = {}): Promise<Locator> {
    const refMatch = target.match(/^(?:ref=)?(e\d+)$/);
    if (refMatch) {
      const loc = this.page.locator(`aria-ref=${refMatch[1]}`);
      if ((await loc.count().catch(() => 0)) > 0) return loc.first();
      // Stale ref (page changed since the snapshot): fall through to the heuristic.
    }
    return this.locate(target, opts);
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
