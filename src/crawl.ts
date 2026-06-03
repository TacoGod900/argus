import { createHash } from "node:crypto";
import { query, tool, createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BrowserHarness } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";
import type { AuthConfig, CrawlConfig, Models } from "./config.js";
import { runChecks, summarizeChecks, type PageEvidence } from "./checks.js";
import { usageFromResult } from "./session.js";
import {
  addUsage,
  EMPTY_USAGE_SUMMARY,
  ZERO_USAGE,
  type CrawlResult,
  type Finding,
  type PageVisit,
  type TurnUsage,
  type UsageSummary,
} from "./types.js";

const FINDING_CATEGORIES = [
  "login",
  "console",
  "network",
  "visual",
  "broken-link",
  "broken-image",
  "flow",
] as const;

/** What the per-page model turn returns: extra findings + which candidate links to expand. */
export interface PageDecision {
  findings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string }>;
  expand: string[];
}

/** Context handed to the page driver for one page. */
export interface PageContext {
  url: string;
  title: string;
  snapshot: string;
  scope?: string;
  candidates: string[];
  remainingPages: number;
  checkSummary: string;
}

/**
 * Decides, per page, what's wrong and where to go next. Production wraps a cheap-model `query()`;
 * tests inject a scripted function. Returns the decision plus the turn's usage.
 */
export type PageDriver = (ctx: PageContext) => Promise<{ decision: PageDecision; usage: TurnUsage }>;

/** Strip volatile bits so the same logical page isn't re-crawled under different URLs. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    u.searchParams.sort();
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * Signature of a page's *shape* (title + the roles in its a11y tree), so templated pages
 * (e.g. many product pages) collapse to one signature and are sampled, not exhaustively crawled.
 */
export function pageSignature(title: string, snapshot: string): string {
  const roles = snapshot
    .split("\n")
    // Drop the volatile header lines (`url:`/`title:`) that ariaSnapshot prepends, then
    // blank out element refs and visible-text names so only the structural shape remains.
    .filter((l) => !/^\s*(url|title):/i.test(l))
    .map((l) => l.trim().replace(/\[ref=e\d+\]/g, "").replace(/"[^"]*"/g, '""'))
    .join("\n");
  return createHash("sha1").update(`${title}\n${roles}`).digest("hex").slice(0, 16);
}

interface FrontierItem {
  url: string;
  depth: number;
}

export interface CrawlOptions {
  baseUrl: string;
  cfg: CrawlConfig;
  auth?: AuthConfig;
  /** Test seam: inject a page driver. Production builds an SDK-backed one from `models.drive`. */
  driver?: PageDriver;
  /** Drive/synthesize models (only `drive` is used here). */
  models?: Models;
}

/**
 * Engine-owns-state crawl: the frontier, visited set, and findings live here in code, and each
 * page is analysed by a *fresh* bounded model turn, so token cost stays flat regardless of site
 * size. Deterministic checks run in code; only short summaries reach the model.
 */
export async function crawl(
  harness: BrowserHarness,
  collector: EvidenceCollector,
  opts: CrawlOptions,
): Promise<CrawlResult> {
  const { baseUrl, cfg } = opts;
  const driver = opts.driver ?? makeSdkPageDriver(opts.models?.drive ?? "claude-sonnet-4-6");
  const denylist = cfg.denylist.map((p) => new RegExp(p, "i"));
  const origin = new URL(baseUrl).origin;

  const visited = new Set<string>();
  const signatures = new Set<string>();
  const findings: Finding[] = [];
  const pages: PageVisit[] = [];
  let usage: UsageSummary = { ...EMPTY_USAGE_SUMMARY };
  const deadline = Date.now() + cfg.maxWallClockMs;

  const blocked = (url: string): boolean => denylist.some((re) => re.test(url));
  const inScope = (url: string): boolean => {
    try {
      return new URL(url).origin === origin && !blocked(url);
    } catch {
      return false;
    }
  };

  // Authenticate once if configured; the browser context keeps the session for the whole crawl.
  if (opts.auth?.loginUrl) {
    const loginFinding = await login(harness, collector, opts.auth);
    if (loginFinding) findings.push(loginFinding);
  }

  const frontier: FrontierItem[] = [{ url: canonicalizeUrl(baseUrl), depth: 0 }];
  let budgetExhausted = false;
  let visits = 0;

  // Enqueue a chosen subset of a page's candidate links, enforcing depth + dedupe.
  const enqueue = (depth: number, candidates: string[], chosen: string[]) => {
    if (depth >= cfg.maxDepth) return;
    const allow = new Set(candidates);
    for (const url of chosen) {
      if (allow.has(url) && !visited.has(url)) frontier.push({ url, depth: depth + 1 });
    }
  };

  while (frontier.length > 0) {
    // maxPages bounds page *visits* (navigations), so the cap is a true ceiling even when many
    // pages are sampled-out duplicates. maxTokens / wall-clock are the other hard rails.
    if (
      visits >= cfg.maxPages ||
      usage.inputTokens + usage.outputTokens >= cfg.maxTokens ||
      Date.now() > deadline
    ) {
      budgetExhausted = true;
      break;
    }

    const item = frontier.shift()!;
    const canonical = canonicalizeUrl(item.url);
    if (visited.has(canonical) || !inScope(canonical)) continue;
    visited.add(canonical);

    visits++;
    collector.setStep(visits);
    const consoleStart = collector.getConsole().length;
    const networkStart = collector.getNetwork().length;

    await harness.callTool("navigate", { url: canonical });
    const snapshot = await harness.ariaSnapshot();
    const title = await harness.title();
    const currentUrl = harness.url();

    // Candidate links for the frontier (same-origin, not denylisted, not visited).
    const links = (await harness.collectLinks())
      .map(canonicalizeUrl)
      .filter((u) => inScope(u) && !visited.has(u));
    const candidates = [...new Set(links)];

    // Sample templated pages: once we've seen this shape, skip the checks/model/recording — but
    // still enqueue its onward links so coverage reachable only through it isn't silently pruned.
    const signature = pageSignature(title, snapshot);
    if (signatures.has(signature)) {
      enqueue(item.depth, candidates, candidates);
      continue;
    }
    signatures.add(signature);

    // Per-page deterministic checks (zero model tokens). Screenshot path comes back structured.
    const shot = await harness.captureScreenshot(`page-${visits}`).catch(() => undefined);
    const brokenImages = await harness.findBrokenImages();
    const pageEvidence: PageEvidence = {
      url: currentUrl,
      console: collector.getConsole().slice(consoleStart),
      network: collector.getNetwork().slice(networkStart),
      brokenImages,
      screenshot: shot,
    };
    const pageFindings = runChecks(pageEvidence);
    findings.push(...pageFindings);

    const res = await driver({
      url: currentUrl,
      title,
      snapshot,
      scope: cfg.scope,
      candidates,
      remainingPages: cfg.maxPages - visits,
      checkSummary: summarizeChecks(pageFindings),
    });
    const decision = res.decision;
    usage = addUsage(usage, res.usage);

    // Fold in model-reported findings (validated against the candidate set for expansion).
    for (const f of decision.findings) {
      findings.push({
        severity: f.severity,
        category: normalizeCategory(f.category),
        page: currentUrl,
        message: f.message,
        screenshot: shot,
      });
    }

    pages.push({
      url: currentUrl,
      title,
      signature,
      depth: item.depth,
      findingCount: pageFindings.length + decision.findings.length,
    });

    // Enqueue the model's chosen links (∩ candidates); if it expressed no preference, expand all.
    // Engine still enforces scope, denylist, depth, and dedupe.
    const chosen = decision.expand.length > 0 ? decision.expand.map(canonicalizeUrl) : candidates;
    enqueue(item.depth, candidates, chosen);
  }

  return { baseUrl, pages, findings, usage, budgetExhausted };
}

function normalizeCategory(c: string): Finding["category"] {
  const found = FINDING_CATEGORIES.find((k) => k === c);
  return (found ?? "flow") as Finding["category"];
}

/**
 * Log in once. Uses provided selectors, else locates fields heuristically (by label/placeholder).
 * Returns a high-severity Finding if login appears to have failed; null on apparent success.
 */
async function login(
  harness: BrowserHarness,
  collector: EvidenceCollector,
  auth: AuthConfig,
): Promise<Finding | null> {
  collector.setStep(0);
  const netStart = collector.getNetwork().length;
  await harness.callTool("navigate", { url: auth.loginUrl! });
  if (auth.username !== undefined) {
    await harness.callTool("fill", { target: auth.usernameSelector ?? "Email", value: auth.username });
  }
  if (auth.password !== undefined) {
    await harness.callTool("fill", {
      target: auth.passwordSelector ?? "Password",
      value: auth.password,
    });
  }
  await harness.callTool("click", { target: auth.submitSelector ?? "Sign in" });
  await harness.callTool("wait_for", { ms: 800 });

  const stillOnLogin = canonicalizeUrl(harness.url()) === canonicalizeUrl(auth.loginUrl!);
  const had401 = collector
    .getNetwork()
    .slice(netStart)
    .some((n) => n.status === 401 || n.status === 403);
  if (stillOnLogin || had401) {
    return {
      severity: "high",
      category: "login",
      page: harness.url(),
      message: had401
        ? "Login failed: server returned 401/403 after submitting credentials."
        : "Login appears to have failed: still on the login page after submitting credentials.",
    };
  }
  return null;
}

const PageDecisionSchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        category: z.string(),
        message: z.string(),
      }),
    )
    .default([]),
  expand: z.array(z.string()).default([]),
});

const PAGE_SYSTEM_PROMPT = `You are Argus's crawl analyst. For each page you are given its URL, title, an accessibility-tree snapshot, the results of automatic checks, and a list of candidate links discovered on the page.

Your job, in ONE call to report_page:
1. findings: report UI/flow problems a human would care about that the automatic checks did NOT already catch — e.g. a broken-looking layout described in the tree, an error message, a dead-end flow, a login wall where there shouldn't be one. Do not repeat the automatic check findings. Use category one of: login, console, network, visual, broken-link, broken-image, flow.
2. expand: choose which candidate links are worth visiting next given the scope/goal and remaining budget. Return a subset of the provided candidates (exact URLs). If everything is worth visiting, return them all; if the scope is narrow, return only the relevant ones.

Be concise and do not invent issues. Reply only by calling report_page.`;

/** Production page driver: one bounded cheap-model turn, forcing a single report_page call. */
export function makeSdkPageDriver(model: string): PageDriver {
  return async (ctx) => {
    let captured: PageDecision | null = null;
    const server = createSdkMcpServer({
      name: "crawl",
      version: "0.1.0",
      tools: [
        tool(
          "report_page",
          "Report findings for this page and which candidate links to expand. Call exactly once.",
          PageDecisionSchema.shape,
          async (args) => {
            captured = PageDecisionSchema.parse(args);
            return { content: [{ type: "text", text: "recorded" }] };
          },
        ),
      ],
    });

    const prompt =
      `Scope/goal: ${ctx.scope ?? "(none given — general pre-launch sweep)"}\n` +
      `Remaining page budget: ${ctx.remainingPages}\n\n` +
      `URL: ${ctx.url}\nTitle: ${ctx.title}\n\n` +
      `Automatic checks:\n${ctx.checkSummary}\n\n` +
      `Accessibility snapshot:\n${ctx.snapshot}\n\n` +
      `Candidate links:\n${ctx.candidates.map((c) => `- ${c}`).join("\n") || "- (none)"}`;

    const options: Options = {
      model,
      systemPrompt: PAGE_SYSTEM_PROMPT,
      mcpServers: { crawl: server },
      allowedTools: ["mcp__crawl__report_page"],
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 2,
    };

    let usage: TurnUsage = { ...ZERO_USAGE };
    for await (const msg of query({ prompt, options })) {
      if ((msg as { type?: string }).type === "result") usage = usageFromResult(msg);
    }

    // If the model never reported (maxTurns/parse failure), don't silently fan out to ALL
    // candidates — stay conservative and expand nothing for this page.
    return { decision: captured ?? { findings: [], expand: [] }, usage };
  };
}
