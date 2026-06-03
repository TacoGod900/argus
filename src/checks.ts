import { isFailedRequest } from "./evidence.js";
import type { ConsoleEntry, Finding, NetworkEntry } from "./types.js";

/** Everything a page contributed, already filtered to that page. */
export interface PageEvidence {
  url: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  brokenImages: string[];
  screenshot?: string;
}

/**
 * Deterministic, zero-token checks over a single page's captured evidence. These run in code
 * (not the model) and produce Findings directly; only a short summary of them is later shown to
 * the model. Pure — unit-tested.
 */
export function runChecks(page: PageEvidence): Finding[] {
  const findings: Finding[] = [];

  for (const c of page.console) {
    if (c.type === "error") {
      findings.push({
        severity: "high",
        category: "console",
        page: page.url,
        message: `Console error: ${c.text}`,
        screenshot: page.screenshot,
      });
    } else if (c.type === "warning") {
      findings.push({
        severity: "low",
        category: "console",
        page: page.url,
        message: `Console warning: ${c.text}`,
        screenshot: page.screenshot,
      });
    }
  }

  for (const n of page.network) {
    if (!isFailedRequest(n)) continue;
    const status = n.failure ? `FAILED (${n.failure})` : String(n.status);
    const severe = n.failure !== null || (n.status !== null && n.status >= 500);
    findings.push({
      severity: severe ? "high" : "medium",
      category: "network",
      page: page.url,
      message: `${n.method} ${n.url} -> ${status}`,
      screenshot: page.screenshot,
    });
  }

  for (const src of page.brokenImages) {
    findings.push({
      severity: "medium",
      category: "broken-image",
      page: page.url,
      message: `Broken image: ${src}`,
      screenshot: page.screenshot,
    });
  }

  return findings;
}

/** A compact one-line-per-finding digest for inclusion in the model prompt. */
export function summarizeChecks(findings: Finding[]): string {
  if (findings.length === 0) return "No deterministic issues detected on this page.";
  return findings
    .slice(0, 30)
    .map((f) => `- [${f.severity}/${f.category}] ${f.message}`)
    .join("\n");
}
