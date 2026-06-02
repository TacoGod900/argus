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
