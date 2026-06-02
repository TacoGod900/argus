#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("argus")
  .description(
    "An AI agent that verifies software changes by running them: launches the app, " +
      "drives real user flows in a browser, watches console + network, and reports " +
      "PASS/FAIL with a root-cause pointer into the diff.",
  )
  .version("0.1.0");

program
  .command("run")
  .description("Run a verification: launch the target app and execute the test steps against it.")
  .requiredOption("-c, --config <path>", "path to the target's argus.config.yaml")
  .requiredOption("-s, --steps <path>", "path to the natural-language steps file")
  .option("-o, --out <dir>", "directory to write run artifacts into", "runs")
  .option("-r, --ref <ref>", "git ref/branch to check out (overrides config)")
  .option("--headed", "run the browser with a visible window (good for demos)", false)
  .action(async (opts) => {
    // Lazily import so `argus --help` and `--version` work without the full pipeline/deps.
    const { runVerification } = await import("./pipeline.js");
    try {
      const verdict = await runVerification({
        configPath: opts.config,
        stepsPath: opts.steps,
        outDir: opts.out,
        ref: opts.ref,
        headed: opts.headed,
      });
      process.exitCode = verdict.pass ? 0 : 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/x-api-key|authentication_error|ANTHROPIC_API_KEY|not logged in|unauthor/i.test(msg)) {
        console.error(
          "\nArgus needs Claude access. Either log in with a Claude Pro/Max plan via Claude Code " +
            "(with ANTHROPIC_API_KEY unset), or set ANTHROPIC_API_KEY to use the API. Then try again.",
        );
      } else {
        console.error(`\nArgus run failed: ${msg}`);
      }
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
