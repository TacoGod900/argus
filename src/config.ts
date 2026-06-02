import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Declarative description of a target app, so Argus stays app-agnostic.
 * One of these lives alongside (or points at) the repo under test.
 */
export const ReadyCheckSchema = z.object({
  /** URL to poll until the app is up (e.g. http://localhost:3000). */
  url: z.string().url(),
  /** HTTP status that means "ready". Defaults to 200. */
  expectStatus: z.number().int().default(200),
  /** Give up after this many milliseconds. Defaults to 60s. */
  timeoutMs: z.number().int().positive().default(60_000),
  /** Poll interval in milliseconds. Defaults to 1s. */
  intervalMs: z.number().int().positive().default(1_000),
});

export const TargetConfigSchema = z.object({
  /** Local path or git URL of the repo under test. */
  repo: z.string().min(1),
  /** Git ref/branch to check out. If omitted, the repo's current state is used as-is. */
  ref: z.string().optional(),
  /** Base ref to diff against for root-cause analysis (e.g. "main"). */
  base: z.string().optional(),
  /** Shell command to install dependencies (run in the repo root). Optional. */
  install: z.string().optional(),
  /** Shell command that starts the app (long-running). */
  start: z.string().min(1),
  /** Base URL the app serves on; the agent starts here. */
  baseUrl: z.string().url(),
  /** How to know the app is ready before driving it. */
  readyCheck: ReadyCheckSchema,
  /** Extra environment variables for the install/start commands. */
  env: z.record(z.string()).default({}),
});

export type ReadyCheck = z.infer<typeof ReadyCheckSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

/** Parse + validate a config from raw YAML text. Pure; easy to unit-test. */
export function parseConfig(yamlText: string): TargetConfig {
  const raw = parseYaml(yamlText);
  return TargetConfigSchema.parse(raw);
}

/** Load + validate a config from a file path. */
export async function loadConfig(path: string): Promise<TargetConfig> {
  const text = await readFile(path, "utf8");
  return parseConfig(text);
}
