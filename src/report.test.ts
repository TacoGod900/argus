import { describe, expect, it } from "vitest";
import {
  renderCrawlReport,
  renderCrawlTerminalSummary,
  renderMarkdownReport,
  renderTerminalSummary,
} from "./report.js";
import type { CrawlResult, EvidenceSummary, Verdict } from "./types.js";

const summary: EvidenceSummary = {
  steps: [
    { index: 1, instruction: "sign up", satisfied: true, summary: "ok", toolCalls: 4 },
    { index: 2, instruction: "log in", satisfied: false, summary: "blocked", toolCalls: 6 },
  ],
  console: [{ step: 2, type: "error", text: "Failed to load resource", timestamp: 0 }],
  network: [
    { step: 2, method: "POST", url: "http://app/api/login", status: 401, failure: null, durationMs: 20, timestamp: 0 },
    { step: 1, method: "GET", url: "http://app/", status: 200, failure: null, durationMs: 5, timestamp: 0 },
  ],
  screenshots: [{ step: 2, label: "login failed", path: "shot-02-step2-login.png", timestamp: 0 }],
  diff: null,
};

const failVerdict: Verdict = {
  pass: false,
  steps: [
    { index: 1, instruction: "sign up", pass: true, reason: "account created" },
    { index: 2, instruction: "log in", pass: false, reason: "login returned 401" },
  ],
  rootCause: "src/auth.js: password comparison inverted",
  diffCitations: ["src/auth.js"],
  summary: "Login is broken by the auth change.",
};

describe("renderMarkdownReport", () => {
  it("shows FAIL, root cause, per-step results, screenshots, and only failed requests", () => {
    const md = renderMarkdownReport(summary, failVerdict);
    expect(md).toContain("❌ FAIL");
    expect(md).toContain("## Root cause");
    expect(md).toContain("password comparison inverted");
    expect(md).toContain("`src/auth.js`");
    expect(md).toContain("Step 2: log in");
    expect(md).toContain("shot-02-step2-login.png");
    expect(md).toContain("POST http://app/api/login -> 401");
    // 2xx requests are not listed
    expect(md).not.toContain("GET http://app/ -> 200");
  });

  it("omits the root cause section when the run passes", () => {
    const pass: Verdict = {
      pass: true,
      steps: [{ index: 1, instruction: "sign up", pass: true, reason: "ok" }],
      rootCause: null,
      diffCitations: [],
      summary: "All good.",
    };
    const md = renderMarkdownReport({ ...summary, steps: [summary.steps[0]] }, pass);
    expect(md).toContain("✅ PASS");
    expect(md).not.toContain("## Root cause");
  });
});

describe("renderTerminalSummary", () => {
  it("renders a verdict line and per-step marks without ANSI by default", () => {
    const out = renderTerminalSummary(failVerdict);
    expect(out).toContain("VERDICT: FAIL");
    expect(out).toContain("Step 2: log in");
    expect(out).toContain("Root cause:");
    expect(out).not.toContain("\x1b[");
  });

  it("includes ANSI codes when color is enabled", () => {
    expect(renderTerminalSummary(failVerdict, true)).toContain("\x1b[31m");
  });
});

const crawlResult: CrawlResult = {
  baseUrl: "http://app",
  pages: [
    { url: "http://app/", title: "Home", signature: "a", depth: 0, findingCount: 0 },
    { url: "http://app/about", title: "About", signature: "b", depth: 1, findingCount: 1 },
  ],
  findings: [
    { severity: "low", category: "console", page: "http://app/about", message: "Console warning: x" },
    { severity: "high", category: "login", page: "http://app/login", message: "Login failed: 401" },
  ],
  usage: {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 800,
    cacheCreationInputTokens: 200,
    costUSD: 0,
    turns: 2,
  },
  budgetExhausted: true,
};

describe("renderCrawlReport", () => {
  it("orders findings by severity, lists the site map, and shows a cost line", () => {
    const md = renderCrawlReport(crawlResult);
    expect(md).toContain("1 high-severity issue(s)");
    // high-severity finding appears before the low-severity one
    expect(md.indexOf("Login failed")).toBeLessThan(md.indexOf("Console warning"));
    expect(md).toContain("## Site map");
    expect(md).toContain("http://app/about");
    expect(md).toContain("budget limit");
    expect(md).toContain("cache hit-rate 80%");
  });
});

describe("renderCrawlTerminalSummary", () => {
  it("summarizes severity counts and pages visited", () => {
    const out = renderCrawlTerminalSummary(crawlResult);
    expect(out).toContain("1 high");
    expect(out).toContain("2 page(s) visited");
    expect(out).toContain("budget hit");
  });
});
