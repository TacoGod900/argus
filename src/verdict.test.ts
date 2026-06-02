import { describe, expect, it } from "vitest";
import { buildVerdictPrompt, parseVerdict } from "./verdict.js";
import type { EvidenceSummary } from "./types.js";

const summary: EvidenceSummary = {
  steps: [
    { index: 1, instruction: "sign up", satisfied: true, summary: "ok", toolCalls: 4 },
    { index: 2, instruction: "log in", satisfied: false, summary: "blocked", toolCalls: 6 },
  ],
  console: [],
  network: [
    { step: 2, method: "POST", url: "http://app/api/login", status: 401, failure: null, durationMs: 20, timestamp: 0 },
  ],
  screenshots: [],
  diff: "--- a/src/auth.js\n+++ b/src/auth.js\n- if (hash === stored)\n+ if (hash !== stored)",
};

describe("buildVerdictPrompt", () => {
  it("includes the evidence and the diff", () => {
    const p = buildVerdictPrompt(summary);
    expect(p).toContain("POST http://app/api/login -> 401");
    expect(p).toContain("src/auth.js");
    expect(p).toContain("```diff");
  });

  it("notes when no diff is available", () => {
    const p = buildVerdictPrompt({ ...summary, diff: null });
    expect(p).toContain("no diff available");
  });
});

describe("parseVerdict", () => {
  it("maps a failing payload, joins instructions, and keeps root cause", () => {
    const payload = JSON.stringify({
      pass: false,
      steps: [
        { index: 1, pass: true, reason: "account created" },
        { index: 2, pass: false, reason: "login returned 401" },
      ],
      root_cause: "src/auth.js: password comparison inverted (=== changed to !==)",
      diff_citations: ["src/auth.js"],
      summary: "Login is broken by the auth diff.",
    });

    const v = parseVerdict(payload, summary);
    expect(v.pass).toBe(false);
    expect(v.steps[1]).toMatchObject({ index: 2, instruction: "log in", pass: false });
    expect(v.rootCause).toContain("inverted");
    expect(v.diffCitations).toEqual(["src/auth.js"]);
  });

  it("drops root cause when the run passes", () => {
    const payload = JSON.stringify({
      pass: true,
      steps: [
        { index: 1, pass: true, reason: "ok" },
        { index: 2, pass: true, reason: "ok" },
      ],
      root_cause: "should be ignored",
      diff_citations: [],
      summary: "All good.",
    });

    const v = parseVerdict(payload, summary);
    expect(v.pass).toBe(true);
    expect(v.rootCause).toBeNull();
  });

  it("throws on a malformed payload", () => {
    expect(() => parseVerdict('{"pass": "yes"}', summary)).toThrow();
  });
});
