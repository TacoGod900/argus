import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runSteps } from "./agent.js";
import { BrowserHarness } from "./browser.js";
import { loadConfig, TargetConfigSchema, type AuthConfig, type TargetConfig } from "./config.js";
import { crawl } from "./crawl.js";
import { buildEvidenceSummary, EvidenceCollector, renderUsageLine } from "./evidence.js";
import {
  renderCrawlTerminalSummary,
  renderTerminalSummary,
  writeCrawlReport,
  writeReport,
} from "./report.js";
import { loadSteps } from "./steps.js";
import { launchTarget } from "./target.js";
import type { CrawlResult, Verdict } from "./types.js";
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
    const { results: stepResults, usage } = await runSteps(steps, harness, collector, {
      baseUrl: target.baseUrl,
      model: config.models.drive,
      maxImages: config.vision.maxImages,
    });

    const summary = buildEvidenceSummary(collector, stepResults, target.diff, usage);
    console.log("Synthesizing verdict...");
    const verdict = await synthesizeVerdict(summary, { model: config.models.synthesize });

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

export interface CrawlRunOptions {
  /** Path to an argus.config.yaml, OR... */
  configPath?: string;
  /** ...a bare URL to crawl (url mode, no git). */
  url?: string;
  outDir: string;
  headed?: boolean;
  /** Flag overrides for the crawl budgets/scope/model. */
  maxPages?: number;
  scope?: string;
  driveModel?: string;
  /** Pull credentials from ARGUS_LOGIN_URL / ARGUS_USERNAME / ARGUS_PASSWORD. */
  credsFromEnv?: boolean;
}

/** Build a config for crawl mode: load a file, or synthesize a url-mode config from a bare URL. */
async function resolveCrawlConfig(opts: CrawlRunOptions): Promise<TargetConfig> {
  if (opts.configPath) return loadConfig(opts.configPath);
  if (!opts.url) throw new Error("crawl needs either --config or --url");
  return TargetConfigSchema.parse({
    mode: "url",
    baseUrl: opts.url,
    readyCheck: { url: opts.url },
  });
}

function authFromEnv(): AuthConfig | undefined {
  const loginUrl = process.env.ARGUS_LOGIN_URL;
  if (!loginUrl) return undefined;
  return {
    loginUrl,
    username: process.env.ARGUS_USERNAME,
    password: process.env.ARGUS_PASSWORD,
  };
}

/** Orchestrate an autonomous crawl: config -> launch -> crawl -> report. */
export async function runCrawl(opts: CrawlRunOptions): Promise<CrawlResult> {
  const config = await resolveCrawlConfig(opts);
  if (opts.maxPages !== undefined) config.crawl.maxPages = opts.maxPages;
  if (opts.scope) config.crawl.scope = opts.scope;
  if (opts.driveModel) config.models.drive = opts.driveModel;
  const auth = config.auth ?? (opts.credsFromEnv ? authFromEnv() : undefined);

  const runDir = join(opts.outDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(runDir, { recursive: true });
  console.log(`Argus crawl -> ${runDir}`);

  const target = await launchTarget(config);
  console.log(`Crawling ${target.baseUrl} (max ${config.crawl.maxPages} pages)...`);

  const collector = new EvidenceCollector(runDir);
  const harness = await BrowserHarness.launch(collector, { headless: !opts.headed });

  try {
    const result = await crawl(harness, collector, {
      baseUrl: target.baseUrl,
      cfg: config.crawl,
      auth,
      models: config.models,
    });

    const reportPath = await writeCrawlReport(runDir, result);
    console.log("");
    console.log(renderCrawlTerminalSummary(result, true));
    console.log(renderUsageLine(result.usage));
    console.log("");
    console.log(`Report: ${reportPath}`);
    return result;
  } finally {
    await harness.close();
    await target.stop();
  }
}
