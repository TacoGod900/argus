import { describe, expect, it } from "vitest";
import { makeScriptedDriver } from "./session.js";

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

  it("is a no-op once scripted turns are exhausted", async () => {
    const driver = makeScriptedDriver([]);
    await expect(driver.sendTurn("x")).resolves.toBeUndefined();
    await driver.close();
  });
});
