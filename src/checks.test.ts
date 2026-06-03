import { describe, expect, it } from "vitest";
import { runChecks, summarizeChecks, type PageEvidence } from "./checks.js";
import type { ConsoleEntry, NetworkEntry } from "./types.js";

const consoleEntry = (type: string, text: string): ConsoleEntry => ({
  step: 1,
  type,
  text,
  timestamp: 0,
});
const net = (over: Partial<NetworkEntry>): NetworkEntry => ({
  step: 1,
  method: "GET",
  url: "http://app/x",
  status: 200,
  failure: null,
  durationMs: 1,
  timestamp: 0,
  ...over,
});

const base: PageEvidence = { url: "http://app/p", console: [], network: [], brokenImages: [] };

describe("runChecks", () => {
  it("flags console errors as high and warnings as low", () => {
    const findings = runChecks({
      ...base,
      console: [consoleEntry("error", "boom"), consoleEntry("warning", "meh"), consoleEntry("log", "ignored")],
    });
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.message.includes("boom"))?.severity).toBe("high");
    expect(findings.find((f) => f.message.includes("meh"))?.severity).toBe("low");
  });

  it("flags 5xx/failed as high and 4xx as medium, ignores 2xx", () => {
    const findings = runChecks({
      ...base,
      network: [
        net({ status: 500, url: "http://app/api/boom" }),
        net({ status: 404, url: "http://app/api/missing" }),
        net({ status: null, failure: "net::ERR", url: "http://app/api/down" }),
        net({ status: 200, url: "http://app/api/ok" }),
      ],
    });
    expect(findings.map((f) => f.severity).sort()).toEqual(["high", "high", "medium"]);
    expect(findings.every((f) => f.category === "network")).toBe(true);
  });

  it("flags broken images", () => {
    const findings = runChecks({ ...base, brokenImages: ["http://app/x.png"] });
    expect(findings[0]).toMatchObject({ category: "broken-image", severity: "medium" });
  });

  it("summarizes findings compactly", () => {
    const findings = runChecks({ ...base, brokenImages: ["http://app/x.png"] });
    expect(summarizeChecks(findings)).toContain("broken-image");
    expect(summarizeChecks([])).toMatch(/No deterministic issues/);
  });
});
