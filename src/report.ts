import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFailedRequest } from "./evidence.js";
import type { EvidenceSummary, Verdict } from "./types.js";

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
