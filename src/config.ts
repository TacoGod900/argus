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

/** Which models drive vs synthesize. Cheap model drives; Opus synthesizes the verdict. */
export const ModelsSchema = z.object({
  drive: z.string().default("claude-sonnet-4-6"),
  synthesize: z.string().default("claude-opus-4-8"),
});

/** Vision/image budget. */
export const VisionSchema = z.object({
  /** Max number of `view` (vision) screenshots the model may request per run. */
  maxImages: z.number().int().nonnegative().default(8),
});

/**
 * Credentials + selectors for an authenticated crawl. Secrets are redacted in all logs/reports.
 * Refs/selectors are optional — when omitted the driver locates fields heuristically by label.
 */
export const AuthSchema = z.object({
  loginUrl: z.string().url().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  usernameSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
});

/** Budgets + safety rails for an autonomous crawl. */
export const CrawlSchema = z.object({
  maxPages: z.number().int().positive().default(25),
  maxActionsPerPage: z.number().int().positive().default(12),
  maxDepth: z.number().int().nonnegative().default(4),
  maxTokens: z.number().int().positive().default(2_000_000),
  maxWallClockMs: z.number().int().positive().default(600_000),
  /** Natural-language scope/goal hints for what to focus the crawl on. */
  scope: z.string().optional(),
  /**
   * Regexes (as strings); any link whose URL matches is never visited. Defaults are anchored on a
   * path-segment boundary (`\b`) so `/admin` blocks `/admin/users` but not `/administrator-guide`.
   */
  denylist: z.array(z.string()).default(["/logout\\b", "/signout\\b", "/admin\\b", "/delete\\b"]),
});

export const TargetConfigSchema = z
  .object({
    /** "url" = point at a live/deployed app; "repo" = launch a local repo (default). */
    mode: z.enum(["url", "repo"]).default("repo"),
    /** Local path or git URL of the repo under test. Required in repo mode. */
    repo: z.string().min(1).optional(),
    /** Git ref/branch to check out. If omitted, the repo's current state is used as-is. */
    ref: z.string().optional(),
    /** Base ref to diff against for root-cause analysis (e.g. "main"). */
    base: z.string().optional(),
    /** Shell command to install dependencies (run in the repo root). Optional. */
    install: z.string().optional(),
    /** Shell command that starts the app (long-running). Required in repo mode. */
    start: z.string().min(1).optional(),
    /** Base URL the app serves on; the agent starts here. */
    baseUrl: z.string().url(),
    /** How to know the app is ready before driving it. */
    readyCheck: ReadyCheckSchema,
    /** Extra environment variables for the install/start commands. */
    env: z.record(z.string(), z.string()).default({}),
    /** Model tiering. */
    models: ModelsSchema.prefault({}),
    /** Vision/image budget. */
    vision: VisionSchema.prefault({}),
    /** Optional credentials for an authenticated crawl. */
    auth: AuthSchema.optional(),
    /** Crawl budgets + safety. */
    crawl: CrawlSchema.prefault({}),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mode === "repo") {
      if (!cfg.repo) ctx.addIssue({ code: "custom", message: "repo is required in repo mode", path: ["repo"] });
      if (!cfg.start) ctx.addIssue({ code: "custom", message: "start is required in repo mode", path: ["start"] });
    }
  });

export type ReadyCheck = z.infer<typeof ReadyCheckSchema>;
export type Models = z.infer<typeof ModelsSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type CrawlConfig = z.infer<typeof CrawlSchema>;
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
