import { describe, expect, it } from "vitest";
import { makeScriptedDriver, usageFromResult } from "./session.js";

describe("usageFromResult", () => {
  it("reads the SDK result's snake_case usage fields", () => {
    // The SDK `result.usage` is the Anthropic Usage shape (snake_case), not camelCase.
    const usage = usageFromResult({
      type: "result",
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 5000,
        output_tokens: 800,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1000,
      },
    });
    expect(usage).toEqual({
      inputTokens: 5000,
      outputTokens: 800,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 1000,
      costUSD: 0.0123,
    });
  });

  it("defaults missing fields to zero", () => {
    expect(usageFromResult({ type: "result" })).toMatchObject({ inputTokens: 0, costUSD: 0 });
  });
});

describe("SessionDriver (scripted)", () => {
  it("runs one scripted side effect per turn, in order", async () => {
    const log: string[] = [];
    const driver = makeScriptedDriver([() => log.push("turn-1"), () => log.push("turn-2")]);
    await driver.sendTurn("step 1");
    await driver.sendTurn("step 2");
    expect(log).toEqual(["turn-1", "turn-2"]);
    await driver.close();
  });

  it("awaits async turn functions", async () => {
    const log: string[] = [];
    const driver = makeScriptedDriver([
      async () => {
        await Promise.resolve();
        log.push("done");
      },
    ]);
    await driver.sendTurn("x");
    expect(log).toEqual(["done"]);
  });

  it("returns zero usage once scripted turns are exhausted", async () => {
    const driver = makeScriptedDriver([]);
    await expect(driver.sendTurn("x")).resolves.toMatchObject({ inputTokens: 0, outputTokens: 0 });
    await driver.close();
  });
});
