import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TargetConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface LaunchedTarget {
  baseUrl: string;
  /** Unified diff base...ref, or null if it couldn't be computed. */
  diff: string | null;
  /** Stop the app process and clean up. Safe to call more than once. */
  stop: () => Promise<void>;
}

/** Run a git command in the repo, returning stdout (trimmed). Throws on failure. */
async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Try to compute the unified diff between base and ref. Returns null on any failure. */
export async function computeDiff(
  repoDir: string,
  base: string | undefined,
  ref: string | undefined,
): Promise<string | null> {
  if (!base) return null;
  const target = ref ?? "HEAD";
  try {
    // Three-dot diff: changes on `target` since it diverged from `base`.
    return await git(repoDir, ["diff", `${base}...${target}`]);
  } catch {
    try {
      return await git(repoDir, ["diff", base, target]);
    } catch {
      return null;
    }
  }
}

/** Poll readyCheck.url until it returns the expected status or the timeout elapses. */
export async function waitForReady(cfg: TargetConfig): Promise<void> {
  const { url, expectStatus, timeoutMs, intervalMs } = cfg.readyCheck;
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === expectStatus) return;
      lastErr = `got status ${res.status}, want ${expectStatus}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`app did not become ready at ${url} within ${timeoutMs}ms (last: ${lastErr})`);
}

/** Run a one-shot shell command in the repo, inheriting stdio. Throws on non-zero exit. */
function runCommand(command: string, cwd: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command failed (exit ${code}): ${command}`));
    });
  });
}

/**
 * Check out the repo at the requested ref, install deps, start the app, and wait until
 * it is ready. Returns the base URL, the diff, and a stop() to tear everything down.
 *
 * NOTE: `repo` is treated as an already-present local directory. Cloning remote URLs is a
 * v1.x concern; for the demo we clone the fork manually and point `repo` at it.
 */
export async function launchTarget(cfg: TargetConfig): Promise<LaunchedTarget> {
  const repoDir = cfg.repo;

  if (cfg.ref) {
    await git(repoDir, ["checkout", cfg.ref]);
  }

  if (cfg.install) {
    await runCommand(cfg.install, repoDir, cfg.env);
  }

  const diff = await computeDiff(repoDir, cfg.base, cfg.ref);

  const child: ChildProcess = spawn(cfg.start, {
    cwd: repoDir,
    env: { ...process.env, ...cfg.env },
    shell: true,
    stdio: "inherit",
    // New process group so we can kill the whole tree (dev servers spawn children).
    detached: process.platform !== "win32",
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.pid == null || child.exitCode !== null) return;
    if (process.platform === "win32") {
      // Kill the whole tree on Windows.
      await execFileAsync("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => {});
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  };

  try {
    await waitForReady(cfg);
  } catch (err) {
    await stop();
    throw err;
  }

  return { baseUrl: cfg.baseUrl, diff, stop };
}
