import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserHarness } from "./browser.js";
import { CrawlSchema } from "./config.js";
import { canonicalizeUrl, crawl, pageSignature, type PageDriver } from "./crawl.js";
import { EvidenceCollector } from "./evidence.js";
import { ZERO_USAGE } from "./types.js";

describe("canonicalizeUrl", () => {
  it("strips hash, trailing slash, and sorts query", () => {
    expect(canonicalizeUrl("http://a/p/#frag")).toBe("http://a/p");
    expect(canonicalizeUrl("http://a/p?b=2&a=1")).toBe("http://a/p?a=1&b=2");
    expect(canonicalizeUrl("http://a/")).toBe("http://a/");
  });
});

describe("default denylist anchoring", () => {
  it("blocks /admin and /logout segments but not innocent lookalikes", () => {
    const denylist = CrawlSchema.parse({}).denylist.map((p) => new RegExp(p, "i"));
    const blocked = (u: string) => denylist.some((re) => re.test(u));
    expect(blocked("http://app/admin/users")).toBe(true);
    expect(blocked("http://app/logout")).toBe(true);
    expect(blocked("http://app/administrator-guide")).toBe(false);
    expect(blocked("http://app/products/deleted-items-faq")).toBe(false);
  });
});

describe("pageSignature", () => {
  it("collapses templated pages (same shape, different names) to one signature", () => {
    const a = `- heading "Product 1" [ref=e1]\n- button "Buy" [ref=e2]`;
    const b = `- heading "Product 2" [ref=e3]\n- button "Buy" [ref=e4]`;
    expect(pageSignature("Product", a)).toBe(pageSignature("Product", b));
  });
  it("differs for structurally different pages", () => {
    const a = `- heading "Home" [ref=e1]`;
    const b = `- heading "Home" [ref=e1]\n- textbox "Email" [ref=e2]`;
    expect(pageSignature("Home", a)).not.toBe(pageSignature("Home", b));
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "../test/fixtures/site-server.mjs");
const PORT = 4610;
const base = `http://localhost:${PORT}`;

let server: ChildProcess;
beforeAll(async () => {
  server = spawn("node", [serverPath], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("site-server did not start");
}, 20_000);
afterAll(() => server?.kill());

// Scripted driver: expand every candidate, report no extra findings (deterministic checks carry the test).
const expandAllDriver: PageDriver = async (ctx) => ({
  decision: { findings: [], expand: ctx.candidates },
  usage: { ...ZERO_USAGE, inputTokens: 10, outputTokens: 5 },
});

describe("crawl (engine, scripted driver)", () => {
  it("walks the site, samples templated pages, and finds planted issues; respects budgets/denylist", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "argus-crawl-"));
    const collector = new EvidenceCollector(runDir);
    const harness = await BrowserHarness.launch(collector, { headless: true });
    try {
      const cfg = CrawlSchema.parse({ maxPages: 20, maxDepth: 3 });
      const result = await crawl(harness, collector, { baseUrl: base, cfg, driver: expandAllDriver });

      const visited = result.pages.map((p) => p.url);
      // Reached the main pages.
      expect(visited.some((u) => u.endsWith("/catalog"))).toBe(true);
      expect(visited.some((u) => u.endsWith("/about"))).toBe(true);

      // Templated product pages are sampled: at most one product page is fully recorded.
      const productPages = visited.filter((u) => u.includes("/product/"));
      expect(productPages.length).toBeLessThanOrEqual(1);

      // Denylist kept /logout out.
      expect(visited.some((u) => u.includes("/logout"))).toBe(false);

      // Planted bugs surfaced by deterministic checks.
      expect(result.findings.some((f) => f.category === "console" && /boom/.test(f.message))).toBe(true);
      expect(result.findings.some((f) => f.category === "broken-image")).toBe(true);

      // Usage was accumulated from the (scripted) driver turns.
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("stops at the page budget and flags budgetExhausted", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "argus-crawl-"));
    const collector = new EvidenceCollector(runDir);
    const harness = await BrowserHarness.launch(collector, { headless: true });
    try {
      const cfg = CrawlSchema.parse({ maxPages: 2 });
      const result = await crawl(harness, collector, { baseUrl: base, cfg, driver: expandAllDriver });
      expect(result.pages.length).toBe(2);
      expect(result.budgetExhausted).toBe(true);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("logs in and reaches the authed account page", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "argus-crawl-"));
    const collector = new EvidenceCollector(runDir);
    const harness = await BrowserHarness.launch(collector, { headless: true });
    try {
      const cfg = CrawlSchema.parse({ maxPages: 12 });
      const result = await crawl(harness, collector, {
        baseUrl: base,
        cfg,
        driver: expandAllDriver,
        auth: {
          loginUrl: `${base}/login`,
          username: "demo@example.com",
          password: "hunter2",
          usernameSelector: "Email",
          passwordSelector: "Password",
          submitSelector: "Sign in",
        },
      });
      // No login finding (login succeeded) and we saw the authed account page content.
      expect(result.findings.some((f) => f.category === "login")).toBe(false);
      expect(result.pages.some((p) => p.url.endsWith("/account") && p.title === "Account")).toBe(true);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("reports a high-severity finding when login fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "argus-crawl-"));
    const collector = new EvidenceCollector(runDir);
    const harness = await BrowserHarness.launch(collector, { headless: true });
    try {
      const cfg = CrawlSchema.parse({ maxPages: 3 });
      const result = await crawl(harness, collector, {
        baseUrl: base,
        cfg,
        driver: expandAllDriver,
        auth: {
          loginUrl: `${base}/login`,
          username: "demo@example.com",
          password: "wrong",
          usernameSelector: "Email",
          passwordSelector: "Password",
          submitSelector: "Sign in",
        },
      });
      const login = result.findings.find((f) => f.category === "login");
      expect(login?.severity).toBe("high");
    } finally {
      await harness.close();
    }
  }, 60_000);
});
