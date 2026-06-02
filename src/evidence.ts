import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConsoleEntry,
  EvidenceSummary,
  NetworkEntry,
  ScreenshotEntry,
  StepResult,
} from "./types.js";

/**
 * Accumulates evidence captured while the agent drives the app, tagged by the step
 * during which it occurred. Screenshots are written to disk; console/network are held
 * in memory and summarized for the verdict synthesizer.
 */
export class EvidenceCollector {
  private step = 0;
  private readonly console: ConsoleEntry[] = [];
  private readonly network: NetworkEntry[] = [];
  private readonly screenshots: ScreenshotEntry[] = [];
  private shotCount = 0;

  constructor(private readonly runDir: string) {}

  /** Set the step index that subsequent captures are attributed to. */
  setStep(index: number): void {
    this.step = index;
  }

  addConsole(type: string, text: string): void {
    this.console.push({ step: this.step, type, text, timestamp: Date.now() });
  }

  addNetwork(entry: Omit<NetworkEntry, "step" | "timestamp">): void {
    this.network.push({ ...entry, step: this.step, timestamp: Date.now() });
  }

  /** Persist a screenshot PNG and record it. Returns the recorded entry. */
  async saveScreenshot(label: string, png: Buffer): Promise<ScreenshotEntry> {
    await mkdir(this.runDir, { recursive: true });
    const safe = label.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40);
    const file = `shot-${String(++this.shotCount).padStart(2, "0")}-step${this.step}-${safe}.png`;
    await writeFile(join(this.runDir, file), png);
    const entry: ScreenshotEntry = {
      step: this.step,
      label,
      path: file,
      timestamp: Date.now(),
    };
    this.screenshots.push(entry);
    return entry;
  }

  getConsole(): ConsoleEntry[] {
    return this.console;
  }

  getNetwork(): NetworkEntry[] {
    return this.network;
  }

  getScreenshots(): ScreenshotEntry[] {
    return this.screenshots;
  }
}

/** Assemble the full evidence bundle for the verdict synthesizer. */
export function buildEvidenceSummary(
  collector: EvidenceCollector,
  steps: StepResult[],
  diff: string | null,
): EvidenceSummary {
  return {
    steps,
    console: collector.getConsole(),
    network: collector.getNetwork(),
    screenshots: collector.getScreenshots(),
    diff,
  };
}

/** Network statuses >= 400 (or outright failures) are the interesting ones. */
export function isFailedRequest(entry: NetworkEntry): boolean {
  return entry.failure !== null || (entry.status !== null && entry.status >= 400);
}

/**
 * Render evidence into a compact, deterministic text block for the LLM prompt.
 * Pure function — unit-tested. Truncates noisy network logs to the notable entries.
 */
export function renderEvidenceForPrompt(summary: EvidenceSummary): string {
  const lines: string[] = [];

  lines.push("## Step outcomes");
  for (const s of summary.steps) {
    lines.push(
      `- Step ${s.index} [${s.satisfied ? "agent: ok" : "agent: blocked"}] "${s.instruction}" — ${s.summary}`,
    );
  }

  const consoleErrors = summary.console.filter(
    (c) => c.type === "error" || c.type === "warning",
  );
  lines.push("");
  lines.push(`## Console errors/warnings (${consoleErrors.length})`);
  if (consoleErrors.length === 0) lines.push("- none");
  for (const c of consoleErrors.slice(0, 50)) {
    lines.push(`- [step ${c.step}] ${c.type}: ${c.text}`);
  }

  const failed = summary.network.filter(isFailedRequest);
  lines.push("");
  lines.push(`## Failed / error network requests (${failed.length})`);
  if (failed.length === 0) lines.push("- none");
  for (const n of failed.slice(0, 50)) {
    const status = n.failure ? `FAILED (${n.failure})` : String(n.status);
    lines.push(`- [step ${n.step}] ${n.method} ${n.url} -> ${status}`);
  }

  lines.push("");
  lines.push(`## Total network requests observed: ${summary.network.length}`);

  return lines.join("\n");
}
