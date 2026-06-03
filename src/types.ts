/**
 * Shared types for the Argus pipeline.
 *
 * The pipeline is linear:
 *   config -> TargetManager -> BrowserHarness -> AgentLoop -> VerdictSynthesizer -> Reporter
 * These types are the interfaces that flow between those units.
 */

/** A single console message captured from the page, tagged with the step it occurred during. */
export interface ConsoleEntry {
  step: number;
  type: string; // 'error' | 'warning' | 'log' | ...
  text: string;
  timestamp: number;
}

/** A single network request/response captured from the page. */
export interface NetworkEntry {
  step: number;
  method: string;
  url: string;
  status: number | null; // null if the request failed before a response
  failure: string | null;
  durationMs: number | null;
  timestamp: number;
}

/** A screenshot artifact saved to disk. */
export interface ScreenshotEntry {
  step: number;
  label: string;
  path: string; // relative to the run directory
  timestamp: number;
}

/** Outcome of executing one natural-language step via the agent loop. */
export interface StepResult {
  index: number;
  instruction: string;
  /** What the agent concluded: did the step succeed from the user's point of view? */
  satisfied: boolean;
  /** Agent's short narration of what it did / observed. */
  summary: string;
  /** Number of browser tool calls the agent made for this step. */
  toolCalls: number;
}

/** Everything the verdict synthesizer needs to reason over. */
export interface EvidenceSummary {
  steps: StepResult[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  screenshots: ScreenshotEntry[];
  /** Unified diff of the change under test (base...ref), or null if unavailable. */
  diff: string | null;
  /** Token/cost usage accumulated while driving the steps, if measured. */
  usage?: UsageSummary;
}

/** Token/cost usage for a single model turn, read off the SDK `result` message. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** May be 0 under subscription auth; token counts are the reliable metric. */
  costUSD: number;
}

/** Accumulated usage across a whole run (steps or a crawl). */
export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  /** Number of model turns/pages that contributed. */
  turns: number;
}

export const ZERO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0,
};

/** Fold a turn's usage into a running summary. Pure. */
export function addUsage(summary: UsageSummary, turn: TurnUsage): UsageSummary {
  return {
    inputTokens: summary.inputTokens + turn.inputTokens,
    outputTokens: summary.outputTokens + turn.outputTokens,
    cacheReadInputTokens: summary.cacheReadInputTokens + turn.cacheReadInputTokens,
    cacheCreationInputTokens: summary.cacheCreationInputTokens + turn.cacheCreationInputTokens,
    costUSD: summary.costUSD + turn.costUSD,
    turns: summary.turns + 1,
  };
}

export const EMPTY_USAGE_SUMMARY: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0,
  turns: 0,
};

/** Cache hit-rate over cached-eligible input tokens (read / (read + creation)). 0 when none. */
export function cacheHitRate(summary: UsageSummary): number {
  const denom = summary.cacheReadInputTokens + summary.cacheCreationInputTokens;
  return denom === 0 ? 0 : summary.cacheReadInputTokens / denom;
}

/** A problem the crawl/steps surfaced, tied to evidence. */
export interface Finding {
  severity: "high" | "medium" | "low";
  category:
    | "login"
    | "console"
    | "network"
    | "visual"
    | "broken-link"
    | "broken-image"
    | "flow";
  /** URL of the page the finding occurred on. */
  page: string;
  message: string;
  /** Free-form supporting evidence lines (console text, request line, etc.). */
  evidence?: string[];
  /** Relative path to a saved screenshot, if one was captured. */
  screenshot?: string;
}

/** A single page the crawl visited. */
export interface PageVisit {
  url: string;
  title: string;
  /** Page-signature (title + structure hash) used to dedupe templated pages. */
  signature: string;
  depth: number;
  findingCount: number;
}

/** Result of an autonomous crawl. */
export interface CrawlResult {
  baseUrl: string;
  pages: PageVisit[];
  findings: Finding[];
  usage: UsageSummary;
  /** True if the crawl stopped because a budget was hit rather than exhausting the frontier. */
  budgetExhausted: boolean;
}

/** Per-step verdict produced by the synthesizer. */
export interface StepVerdict {
  index: number;
  instruction: string;
  pass: boolean;
  reason: string;
}

/** Final structured verdict for a run. */
export interface Verdict {
  pass: boolean;
  steps: StepVerdict[];
  /** Present only when pass === false. */
  rootCause: string | null;
  /** Files/lines from the diff the root cause points at, if any. */
  diffCitations: string[];
  summary: string;
}
