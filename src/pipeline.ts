import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runSteps } from "./agent.js";
import { BrowserHarness } from "./browser.js";
import { loadConfig } from "./config.js";
import { buildEvidenceSummary, EvidenceCollector } from "./evidence.js";
import { renderTerminalSummary, writeReport } from "./report.js";
import { loadSteps } from "./steps.js";
import { launchTarget } from "./target.js";
import type { Verdict } from "./types.js";
import { synthesizeVerdict } from "./verdict.js";

export interface RunOptions {
  configPath: string;
  stepsPath: string;
  outDir: string;
  ref?: string;
  /** Run the browser with a visible window (useful for the demo screen-recording). */
  headed?: boolean;
}

/** Orchestrate the full verification: config -> launch -> drive -> verdict -> report. */
export async function runVerification(opts: RunOptions): Promise<Verdict> {
  const config = await loadConfig(opts.configPath);
  if (opts.ref) config.ref = opts.ref;

  const steps = await loadSteps(opts.stepsPath);

  const runDir = join(opts.outDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(runDir, { recursive: true });
  console.log(`Argus run -> ${runDir}`);

  console.log(`Launching target (${config.repo}${config.ref ? ` @ ${config.ref}` : ""})...`);
  const target = await launchTarget(config);
  console.log(`App ready at ${target.baseUrl}`);

  const collector = new EvidenceCollector(runDir);
  const harness = await BrowserHarness.launch(collector, { headless: !opts.headed });

  try {
    console.log(`Driving ${steps.length} step(s)...`);
    const stepResults = await runSteps(steps, harness, collector, { baseUrl: target.baseUrl });

    const summary = buildEvidenceSummary(collector, stepResults, target.diff);
    console.log("Synthesizing verdict...");
    const verdict = await synthesizeVerdict(summary);

    const reportPath = await writeReport(runDir, summary, verdict);
    console.log("");
    console.log(renderTerminalSummary(verdict, true));
    console.log("");
    console.log(`Report: ${reportPath}`);

    return verdict;
  } finally {
    await harness.close();
    await target.stop();
  }
}
