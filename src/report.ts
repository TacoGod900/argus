import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFailedRequest, renderUsageLine } from "./evidence.js";
import type { CrawlResult, EvidenceSummary, Finding, Verdict } from "./types.js";

const SEVERITY_ORDER: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };

/** Render the full markdown report. Pure — unit-tested. */
export function renderMarkdownReport(summary: EvidenceSummary, verdict: Verdict): string {
  const lines: string[] = [];
  const badge = verdict.pass ? "✅ PASS" : "❌ FAIL";

  lines.push(`# Argus verification report — ${badge}`);
  lines.push("");
  lines.push(verdict.summary);
  lines.push("");

  if (!verdict.pass && verdict.rootCause) {
    lines.push("## Root cause");
    lines.push(verdict.rootCause);
    if (verdict.diffCitations.length > 0) {
      lines.push("");
      lines.push("**Implicated by the diff:**");
      for (const c of verdict.diffCitations) lines.push(`- \`${c}\``);
    }
    lines.push("");
  }

  lines.push("## Steps");
  for (const s of verdict.steps) {
    lines.push(`### ${s.pass ? "✅" : "❌"} Step ${s.index}: ${s.instruction}`);
    lines.push(s.reason);
    const shots = summary.screenshots.filter((sh) => sh.step === s.index);
    for (const sh of shots) lines.push(`- screenshot: \`${sh.path}\` (${sh.label})`);
    lines.push("");
  }

  const consoleErrors = summary.console.filter((c) => c.type === "error" || c.type === "warning");
  lines.push(`## Console errors/warnings (${consoleErrors.length})`);
  if (consoleErrors.length === 0) lines.push("- none");
  for (const c of consoleErrors) lines.push(`- [step ${c.step}] ${c.type}: ${c.text}`);
  lines.push("");

  const failed = summary.network.filter(isFailedRequest);
  lines.push(`## Failed / error network requests (${failed.length})`);
  if (failed.length === 0) lines.push("- none");
  for (const n of failed) {
    const status = n.failure ? `FAILED (${n.failure})` : String(n.status);
    lines.push(`- [step ${n.step}] ${n.method} ${n.url} -> ${status}`);
  }
  lines.push("");

  if (summary.usage) {
    lines.push("## Cost");
    lines.push(renderUsageLine(summary.usage));
    lines.push("");
  }

  return lines.join("\n");
}

/** Render a concise terminal summary. Pure — unit-tested. `color` toggles ANSI codes. */
export function renderTerminalSummary(verdict: Verdict, color = false): string {
  const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const lines: string[] = [];

  lines.push(verdict.pass ? green("VERDICT: PASS") : red("VERDICT: FAIL"));
  for (const s of verdict.steps) {
    const mark = s.pass ? green("PASS") : red("FAIL");
    lines.push(`  [${mark}] Step ${s.index}: ${s.instruction}`);
  }
  if (!verdict.pass && verdict.rootCause) {
    lines.push("");
    lines.push(`Root cause: ${verdict.rootCause}`);
  }
  return lines.join("\n");
}

/** Render a crawl report: findings by severity, site map, and a cost dashboard. Pure. */
export function renderCrawlReport(result: CrawlResult, verdictSummary?: string): string {
  const lines: string[] = [];
  const high = result.findings.filter((f) => f.severity === "high").length;
  const badge = high > 0 ? `❌ ${high} high-severity issue(s)` : "✅ no high-severity issues";

  lines.push(`# Argus crawl report — ${badge}`);
  lines.push("");
  lines.push(`Crawled **${result.baseUrl}** — ${result.pages.length} page(s), ${result.findings.length} finding(s).`);
  if (result.budgetExhausted) lines.push("");
  if (result.budgetExhausted) lines.push("> ⚠️ Stopped on a budget limit; the site may not be fully covered.");
  lines.push("");

  if (verdictSummary) {
    lines.push("## Summary");
    lines.push(verdictSummary);
    lines.push("");
  }

  const sorted = [...result.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  lines.push(`## Findings (${result.findings.length})`);
  if (sorted.length === 0) lines.push("- none");
  for (const f of sorted) {
    lines.push(`### [${f.severity.toUpperCase()} · ${f.category}] ${f.message}`);
    lines.push(`- page: ${f.page}`);
    if (f.screenshot) lines.push(`- screenshot: \`${f.screenshot}\``);
    if (f.evidence?.length) for (const e of f.evidence) lines.push(`- ${e}`);
    lines.push("");
  }

  lines.push("## Site map");
  for (const p of result.pages) {
    lines.push(`- ${"  ".repeat(p.depth)}${p.url} — "${p.title}" (${p.findingCount} finding(s))`);
  }
  lines.push("");

  lines.push("## Cost");
  lines.push(renderUsageLine(result.usage));
  lines.push("");

  return lines.join("\n");
}

/** Concise terminal summary for a crawl. */
export function renderCrawlTerminalSummary(result: CrawlResult, color = false): string {
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const counts = { high: 0, medium: 0, low: 0 } as Record<Finding["severity"], number>;
  for (const f of result.findings) counts[f.severity]++;
  const lines: string[] = [];
  lines.push(
    counts.high > 0
      ? red(`CRAWL: ${counts.high} high, ${counts.medium} medium, ${counts.low} low`)
      : green(`CRAWL: clean (0 high, ${counts.medium} medium, ${counts.low} low)`),
  );
  lines.push(`  ${result.pages.length} page(s) visited${result.budgetExhausted ? " (budget hit)" : ""}`);
  return lines.join("\n");
}

/** Write a crawl report into the run directory. Returns its path. */
export async function writeCrawlReport(
  runDir: string,
  result: CrawlResult,
  verdictSummary?: string,
): Promise<string> {
  const path = join(runDir, "crawl-report.md");
  await writeFile(path, renderCrawlReport(result, verdictSummary), "utf8");
  return path;
}

/** Write the markdown report into the run directory. Returns its path. */
export async function writeReport(
  runDir: string,
  summary: EvidenceSummary,
  verdict: Verdict,
): Promise<string> {
  const path = join(runDir, "report.md");
  await writeFile(path, renderMarkdownReport(summary, verdict), "utf8");
  return path;
}
