import { describe, expect, it } from "vitest";
import {
  buildEvidenceSummary,
  EvidenceCollector,
  isFailedRequest,
  renderEvidenceForPrompt,
} from "./evidence.js";
import type { StepResult } from "./types.js";

function collectorWithData(): EvidenceCollector {
  const c = new EvidenceCollector("runs/test-unused");
  c.setStep(1);
  c.addConsole("log", "app booted");
  c.addNetwork({ method: "GET", url: "http://x/", status: 200, failure: null, durationMs: 12 });
  c.setStep(3);
  c.addConsole("error", "Uncaught TypeError: cannot read foo");
  c.addNetwork({
    method: "POST",
    url: "http://x/api/login",
    status: 401,
    failure: null,
    durationMs: 30,
  });
  c.addNetwork({
    method: "GET",
    url: "http://x/img.png",
    status: null,
    failure: "net::ERR_FAILED",
    durationMs: null,
  });
  return c;
}

describe("isFailedRequest", () => {
  it("flags >=400 and outright failures, not 2xx", () => {
    expect(isFailedRequest({ step: 1, method: "GET", url: "u", status: 200, failure: null, durationMs: 1, timestamp: 0 })).toBe(false);
    expect(isFailedRequest({ step: 1, method: "GET", url: "u", status: 401, failure: null, durationMs: 1, timestamp: 0 })).toBe(true);
    expect(isFailedRequest({ step: 1, method: "GET", url: "u", status: null, failure: "x", durationMs: null, timestamp: 0 })).toBe(true);
  });
});

describe("renderEvidenceForPrompt", () => {
  const steps: StepResult[] = [
    { index: 1, instruction: "sign up", satisfied: true, summary: "created account", toolCalls: 4 },
    { index: 3, instruction: "log in", satisfied: false, summary: "login button did nothing", toolCalls: 6 },
  ];

  it("surfaces console errors and failed requests, tagged by step", () => {
    const summary = buildEvidenceSummary(collectorWithData(), steps, "diff text here");
    const out = renderEvidenceForPrompt(summary);

    expect(out).toContain("Step 1");
    expect(out).toContain("agent: blocked");
    expect(out).toContain("Uncaught TypeError");
    expect(out).toContain("POST http://x/api/login -> 401");
    expect(out).toContain("ERR_FAILED");
    // 2xx requests are not listed as failures
    expect(out).not.toContain("http://x/ -> 200");
    expect(out).toContain("Total network requests observed: 3");
  });

  it("reports 'none' when there are no errors", () => {
    const c = new EvidenceCollector("runs/test-unused");
    c.setStep(1);
    c.addNetwork({ method: "GET", url: "u", status: 200, failure: null, durationMs: 1 });
    const out = renderEvidenceForPrompt(buildEvidenceSummary(c, [], null));
    expect(out).toContain("Console errors/warnings (0)");
    expect(out).toContain("Failed / error network requests (0)");
  });
});
