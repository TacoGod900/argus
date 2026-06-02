# Agent SDK Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Argus's model calls from the raw Anthropic API (`@anthropic-ai/sdk`) onto the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) so one code path runs on a Claude Pro/Max subscription now and on an API key later, unchanged.

**Architecture:** The Agent SDK manages the tool-use loop internally and invokes tools through an in-process MCP server. Argus's browser actions and the `report_step`/`submit_verdict` control tools become MCP tools whose handlers delegate to the existing `BrowserHarness`. A small `SessionDriver` seam hides the SDK's streaming/session details from the orchestration logic so it stays unit-testable with a fake (mirroring today's injected-client tests). Pure logic (`parseVerdict`, `buildVerdictPrompt`, evidence/report) is untouched.

**Tech Stack:** TypeScript (ESM, NodeNext), `@anthropic-ai/claude-agent-sdk`, Zod, Playwright, Vitest, tsx.

---

## Reference: existing files this plan touches

- `src/agent.ts` — current manual `messages.create` loop. **Rewritten.**
- `src/verdict.ts` — current structured-output call. Transport **rewritten**; `parseVerdict`/`buildVerdictPrompt`/`VerdictPayloadSchema`/`VERDICT_JSON_SCHEMA` **kept**.
- `src/browser.ts` — `BrowserHarness` with `getToolDefs()`/`callTool()`/`snapshot()`. **Unchanged** (we stop calling `getToolDefs`; `callTool`/`snapshot` reused).
- `src/agent.test.ts` — injected-fake-client tests. **Ported** to fake `SessionDriver`.
- `src/verdict.test.ts` — pure tests for `parseVerdict`/`buildVerdictPrompt`. **Kept as-is**, plus one new transport test.
- `src/pipeline.ts` — calls `runSteps(...)` and `synthesizeVerdict(...)`. Signatures preserved, so **unchanged**.
- `src/cli.ts` — API-key error hint. **Tweaked**.
- `src/types.ts` — `StepResult`, `Verdict`, `EvidenceSummary`. **Unchanged.**

## File structure after this plan

- `src/tools.ts` — **NEW.** Builds the in-process MCP server: 6 browser tools + `report_step`, each handler delegating to `BrowserHarness`/recording a result. Pure wiring, independently testable.
- `src/session.ts` — **NEW.** `SessionDriver` interface + `SdkSessionDriver` (wraps the SDK streaming session) + `makeSdkDriver` factory.
- `src/agent.ts` — orchestration only: per-step turns via a `SessionDriver`, nudge/blocked handling, end-of-step screenshot.
- `src/verdict.ts` — transport via a forced `submit_verdict` MCP tool; pure helpers unchanged.
- `scripts/smoke-subscription.ts` — **NEW.** Throwaway gate to confirm subscription auth works.

---

## Task 0: Setup, install, and subscription smoke test (HARD GATE)

**Files:**
- Create: `scripts/smoke-subscription.ts`
- Modify: `package.json` (dependency)

- [ ] **Step 1: Initialize git (repo is not yet under version control) and snapshot current state**

This project is not a git repo, but the plan relies on per-task commits.

```bash
cd /c/Users/techb/argus
git init
git add -A
git commit -m "chore: snapshot before Agent SDK migration"
```

Expected: a first commit succeeds. (`.gitignore` already excludes `node_modules`/`runs`.)

- [ ] **Step 2: Install the Agent SDK**

```bash
npm install @anthropic-ai/claude-agent-sdk
```

Expected: `@anthropic-ai/claude-agent-sdk` added to `package.json` dependencies; install succeeds.

- [ ] **Step 3: Write the smoke test script**

This also pins down the *actual* exported API surface of the installed SDK version, which later tasks rely on.

```ts
// scripts/smoke-subscription.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY is set — this will use API billing, not the subscription. Unset it to test subscription auth.");
  }
  const q = query({
    prompt: "Reply with exactly the word: PONG",
    options: { model: process.env.ARGUS_MODEL ?? "claude-opus-4-8", maxTurns: 1, settingSources: [] },
  });
  for await (const msg of q) {
    console.log(JSON.stringify({ type: (msg as { type: string }).type }));
    if ((msg as { type: string }).type === "result") {
      console.log("RESULT:", JSON.stringify(msg));
    }
  }
}

main().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });
```

- [ ] **Step 4: Run the smoke test — HARD GATE**

Ensure you are logged into Claude Code with a Pro/Max plan and `ANTHROPIC_API_KEY` is **unset** in this shell.

```bash
npx tsx scripts/smoke-subscription.ts
```

Expected: streamed messages ending in a `result` message containing "PONG", with **no** API-key error.

- If it errors with auth/permission problems on subscription, **STOP and report back** — the migration premise has failed. Possible fallback before stopping: retry with `ARGUS_MODEL=claude-sonnet-4-6` or `ARGUS_MODEL=opus` in case the pinned model id is the problem.
- Note the message `type` values you observe (especially what marks the end of a turn — likely `result`). Tasks 2–4 reference these; reconcile the code below against what you actually see and against the installed `.d.ts` types in `node_modules/@anthropic-ai/claude-agent-sdk`.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-subscription.ts package.json package-lock.json
git commit -m "chore: add Agent SDK + subscription smoke test"
```

---

## Task 1: Browser + control tools as an in-process MCP server

**Files:**
- Create: `src/tools.ts`
- Test: `src/tools.test.ts`

The `tool()` helper takes a Zod shape; the existing browser tools use JSON Schema. We hand-translate the 6 browser schemas to Zod and delegate execution to `BrowserHarness.callTool`. `report_step` records its result into a shared ref the orchestrator reads.

- [ ] **Step 1: Write the failing test**

```ts
// src/tools.test.ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildArgusTools } from "./tools.js";
import type { BrowserHarness } from "./browser.js";

function fakeHarness() {
  const calls: string[] = [];
  const harness = {
    async callTool(name: string, input: Record<string, unknown>) {
      calls.push(`${name}:${JSON.stringify(input)}`);
      return `ok(${name})`;
    },
  } as unknown as BrowserHarness;
  return { harness, calls };
}

describe("buildArgusTools", () => {
  it("exposes the six browser tools plus report_step, namespaced for the SDK", () => {
    const { harness } = fakeHarness();
    const built = buildArgusTools(harness);
    expect(built.toolNames).toEqual([
      "mcp__argus__navigate",
      "mcp__argus__click",
      "mcp__argus__fill",
      "mcp__argus__get_text",
      "mcp__argus__screenshot",
      "mcp__argus__wait_for",
      "mcp__argus__report_step",
    ]);
  });

  it("a browser tool handler delegates to harness.callTool and returns its text", async () => {
    const { harness, calls } = fakeHarness();
    const built = buildArgusTools(harness);
    const res = await built.handlers.navigate({ url: "http://app/login" });
    expect(calls).toContain('navigate:{"url":"http://app/login"}');
    expect(res.content[0]).toMatchObject({ type: "text", text: "ok(navigate)" });
    expect(built.toolCallCount()).toBe(1);
  });

  it("report_step records the verdict and does not count as a browser tool call", async () => {
    const { harness } = fakeHarness();
    const built = buildArgusTools(harness);
    await built.handlers.report_step({ satisfied: false, summary: "login returned 401" });
    expect(built.takeReport()).toEqual({ satisfied: false, summary: "login returned 401" });
    expect(built.toolCallCount()).toBe(0);
  });
}); 
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools.test.ts`
Expected: FAIL — `buildArgusTools` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools.ts
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserHarness } from "./browser.js";

export interface StepReport {
  satisfied: boolean;
  summary: string;
}

/** A built tool set: the MCP server to hand the SDK, the allowed tool names, and test seams. */
export interface ArgusTools {
  server: ReturnType<typeof createSdkMcpServer>;
  toolNames: string[];
  /** Direct handler access for unit tests (the SDK calls these internally at runtime). */
  handlers: {
    navigate: (a: Record<string, unknown>) => Promise<ToolText>;
    click: (a: Record<string, unknown>) => Promise<ToolText>;
    fill: (a: Record<string, unknown>) => Promise<ToolText>;
    get_text: (a: Record<string, unknown>) => Promise<ToolText>;
    screenshot: (a: Record<string, unknown>) => Promise<ToolText>;
    wait_for: (a: Record<string, unknown>) => Promise<ToolText>;
    report_step: (a: Record<string, unknown>) => Promise<ToolText>;
  };
  toolCallCount: () => number;
  resetToolCallCount: () => void;
  takeReport: () => StepReport | null;
}

type ToolText = { content: [{ type: "text"; text: string }] };
const text = (t: string): ToolText => ({ content: [{ type: "text", text: t }] });

const SERVER_NAME = "argus";

export function buildArgusTools(harness: BrowserHarness): ArgusTools {
  let toolCalls = 0;
  let report: StepReport | null = null;

  const browserHandler =
    (name: string) =>
    async (args: Record<string, unknown>): Promise<ToolText> => {
      toolCalls++;
      return text(await harness.callTool(name, args ?? {}));
    };

  const handlers = {
    navigate: browserHandler("navigate"),
    click: browserHandler("click"),
    fill: browserHandler("fill"),
    get_text: browserHandler("get_text"),
    screenshot: browserHandler("screenshot"),
    wait_for: browserHandler("wait_for"),
    report_step: async (args: Record<string, unknown>): Promise<ToolText> => {
      report = {
        satisfied: Boolean((args as { satisfied?: unknown }).satisfied),
        summary: String((args as { summary?: unknown }).summary ?? "(no summary)"),
      };
      return text("recorded");
    },
  };

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.1.0",
    tools: [
      tool("navigate", "Navigate the browser to a URL.", { url: z.string().describe("Absolute URL to open.") }, handlers.navigate),
      tool("click", "Click an element. `target` may be a CSS selector, a button/link name, or visible text.", { target: z.string() }, handlers.click),
      tool("fill", "Type into an input. `target` may be a CSS selector, the input's placeholder, or its label.", { target: z.string(), value: z.string() }, handlers.fill),
      tool("get_text", "Return the visible text of the current page (truncated).", {}, handlers.get_text),
      tool("screenshot", "Capture a screenshot of the current page as evidence.", { label: z.string().describe("Short label for the shot.") }, handlers.screenshot),
      tool("wait_for", "Wait for some text to appear, or just wait a number of milliseconds.", { text: z.string().optional(), ms: z.number().optional() }, handlers.wait_for),
      tool("report_step", "Conclude the current step. Call exactly once when the step is finished.", { satisfied: z.boolean().describe("True only if the app behaved correctly for this step from a user's perspective."), summary: z.string().describe("One sentence: what you did and what you observed.") }, handlers.report_step),
    ],
  });

  const toolNames = ["navigate", "click", "fill", "get_text", "screenshot", "wait_for", "report_step"].map(
    (n) => `mcp__${SERVER_NAME}__${n}`,
  );

  return {
    server,
    toolNames,
    handlers,
    toolCallCount: () => toolCalls,
    resetToolCallCount: () => { toolCalls = 0; },
    takeReport: () => { const r = report; report = null; return r; },
  };
}
```

> Reconcile the `tool()` / `createSdkMcpServer()` argument shapes against the installed `.d.ts` (observed in Task 0). If `tool()` expects a full `z.object(...)` rather than a raw shape, wrap the schema objects accordingly; the handler bodies stay the same.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat: browser + control tools as in-process MCP server"
```

---

## Task 2: SessionDriver seam (fake + SDK implementation)

**Files:**
- Create: `src/session.ts`
- Test: `src/session.test.ts`

`SessionDriver.sendTurn(prompt)` sends one user message and resolves when the assistant's turn ends (tools auto-execute via the MCP handlers during the turn). This hides all SDK streaming/message shapes from the orchestrator.

- [ ] **Step 1: Write the failing test (fake driver + interface contract)**

```ts
// src/session.test.ts
import { describe, expect, it } from "vitest";
import { makeScriptedDriver } from "./session.js";

describe("SessionDriver (scripted/fake)", () => {
  it("runs a side effect per turn and resolves", async () => {
    const log: string[] = [];
    const driver = makeScriptedDriver([
      () => log.push("turn-1"),
      () => log.push("turn-2"),
    ]);
    await driver.sendTurn("step 1");
    await driver.sendTurn("step 2");
    expect(log).toEqual(["turn-1", "turn-2"]);
    await driver.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session.test.ts`
Expected: FAIL — `makeScriptedDriver` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/session.ts
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

/** Drives a single multi-turn agent session. One sendTurn = one user message run to completion. */
export interface SessionDriver {
  /** Send a user message and resolve when the assistant finishes that turn. */
  sendTurn(prompt: string): Promise<void>;
  /** End the session and release resources. */
  close(): Promise<void>;
}

/** Test seam: each scripted fn runs in place of a real model turn. */
export function makeScriptedDriver(turns: Array<() => void | Promise<void>>): SessionDriver {
  let i = 0;
  return {
    async sendTurn() {
      const fn = turns[i++];
      if (fn) await fn();
    },
    async close() {},
  };
}

export interface SdkDriverConfig {
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  // The MCP server object from buildArgusTools().server
  mcpServer: unknown;
  maxTurns: number;
}

/**
 * Real driver: a streaming-input session. We push one user message per turn and consume
 * the message stream until the turn's terminating message (observed in Task 0, expected `result`).
 */
export function makeSdkDriver(cfg: SdkDriverConfig): SessionDriver {
  // Manual async queue feeding the SDK's streaming-input prompt.
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  async function* input(): AsyncGenerator<unknown> {
    while (!ended) {
      if (queue.length === 0) await new Promise<void>((r) => (wake = r));
      while (queue.length) {
        const content = queue.shift()!;
        yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
      }
    }
  }

  const options: Options = {
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    mcpServers: { argus: cfg.mcpServer as never },
    allowedTools: cfg.allowedTools,
    settingSources: [],
    permissionMode: "bypassPermissions",
    maxTurns: cfg.maxTurns,
  } as Options;

  const stream = query({ prompt: input() as never, options })[Symbol.asyncIterator]();

  return {
    async sendTurn(prompt: string) {
      queue.push(prompt);
      wake?.(); wake = null;
      // Consume until this turn terminates.
      while (true) {
        const { value, done } = await stream.next();
        if (done) return;
        if ((value as { type?: string })?.type === "result") return;
      }
    },
    async close() {
      ended = true;
      wake?.(); wake = null;
      await stream.return?.(undefined);
    },
  };
}
```

> **SDK reconciliation (do this before trusting the code):** Using the values observed in Task 0, confirm (a) the streaming-input user-message shape, (b) that a per-turn terminator message exists and its `type` (the code assumes `result`), and (c) the `Options` field names (`mcpServers`, `allowedTools`, `settingSources`, `permissionMode`, `systemPrompt`). Fix the literals to match the installed `.d.ts`. The scripted driver and the orchestrator in Task 3 do not depend on these details.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If SDK types disagree with the field names above, fix per the reconciliation note.)

- [ ] **Step 6: Commit**

```bash
git add src/session.ts src/session.test.ts
git commit -m "feat: SessionDriver seam over the Agent SDK streaming session"
```

---

## Task 3: Rewrite agent.ts orchestration onto the driver

**Files:**
- Modify: `src/agent.ts` (full rewrite)
- Modify: `src/agent.test.ts` (port to scripted driver)

`runSteps` keeps its **public signature** (`steps, harness, collector, opts`) so `pipeline.ts` is untouched. It builds the tools, opens one session, and for each step: snapshot → `sendTurn` → read report (nudge up to twice if absent) → auto-screenshot.

- [ ] **Step 1: Rewrite the test first**

```ts
// src/agent.test.ts
import { describe, expect, it } from "vitest";
import { runSteps } from "./agent.js";
import type { BrowserHarness } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";
import type { ArgusTools } from "./tools.js";
import type { SessionDriver } from "./session.js";

function fakeHarness() {
  const toolLog: string[] = [];
  const harness = {
    async snapshot() { return "url: about:blank"; },
    async callTool(name: string, input: Record<string, unknown>) {
      toolLog.push(`${name}:${JSON.stringify(input)}`);
      return `ok(${name})`;
    },
  } as unknown as BrowserHarness;
  return { harness, toolLog };
}

const collector = { setStep() {} } as unknown as EvidenceCollector;

/** Inject a tools double and a driver double via the test-only opts. */
function fakeTools(scriptPerTurn: Array<{ satisfied: boolean; summary: string } | null>) {
  let report: { satisfied: boolean; summary: string } | null = null;
  let turn = 0;
  const tools = {
    server: {}, toolNames: ["mcp__argus__report_step"],
    handlers: {} as ArgusTools["handlers"],
    toolCallCount: () => 1,
    resetToolCallCount: () => {},
    takeReport: () => { const r = report; report = null; return r; },
  } as unknown as ArgusTools;
  const driver: SessionDriver = {
    async sendTurn() { report = scriptPerTurn[turn++] ?? null; },
    async close() {},
  };
  return { tools, driver };
}

describe("runSteps", () => {
  it("records the report verdict and auto-captures an end-of-step screenshot", async () => {
    const { harness, toolLog } = fakeHarness();
    const { tools, driver } = fakeTools([{ satisfied: true, summary: "logged in fine" }]);
    const results = await runSteps(["log in"], harness, collector, {
      baseUrl: "http://app",
      _tools: tools,
      _driver: driver,
    });
    expect(results[0]).toMatchObject({ index: 1, satisfied: true, summary: "logged in fine" });
    expect(toolLog.some((t) => t.startsWith("screenshot:"))).toBe(true);
  });

  it("captures a failure verdict", async () => {
    const { harness } = fakeHarness();
    const { tools, driver } = fakeTools([{ satisfied: false, summary: "login returned 401" }]);
    const results = await runSteps(["log in"], harness, collector, {
      baseUrl: "http://app", _tools: tools, _driver: driver,
    });
    expect(results[0].satisfied).toBe(false);
    expect(results[0].summary).toContain("401");
  });

  it("nudges then marks the step blocked when no report arrives", async () => {
    const { harness } = fakeHarness();
    const { tools, driver } = fakeTools([null, null, null]); // never reports
    const results = await runSteps(["do a thing"], harness, collector, {
      baseUrl: "http://app", _tools: tools, _driver: driver,
    });
    expect(results[0].satisfied).toBe(false);
    expect(results[0].summary).toMatch(/without calling report_step/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent.test.ts`
Expected: FAIL — new `opts` fields / rewritten `runSteps` not present.

- [ ] **Step 3: Rewrite `src/agent.ts`**

```ts
// src/agent.ts
import type { BrowserHarness } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";
import type { StepResult } from "./types.js";
import { buildArgusTools, type ArgusTools } from "./tools.js";
import { makeSdkDriver, type SessionDriver } from "./session.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_TOOL_CALLS_PER_STEP = 25;
const MAX_NUDGES = 2;

const SYSTEM_PROMPT = `You are Argus, an AI engineer that verifies software changes by actually using the app like a real user.

You drive a real web browser through natural-language test steps. For each step:
- Use the browser tools (navigate, click, fill, get_text, screenshot, wait_for) to carry it out.
- Observe the result. A step is only "satisfied" if the app behaved correctly from a user's point of view (e.g. login actually logged you in, not just that you clicked a button).
- Take a screenshot when you reach a meaningful state (especially on success or when something looks wrong) so there is visual evidence.
- When you are done with the current step, call report_step with whether it was satisfied and a one-sentence summary of what happened.

Be efficient: don't re-navigate or re-read the page unnecessarily. If something fails (an error appears, a button does nothing, a page 500s), do not pretend it worked — report satisfied: false and describe what you observed. You only control one step at a time; the next step's instruction arrives after you call report_step.`;

export interface AgentOptions {
  baseUrl: string;
  model?: string;
  /** Test seams. Production leaves these undefined. */
  _tools?: ArgusTools;
  _driver?: SessionDriver;
}

export async function runSteps(
  steps: string[],
  harness: BrowserHarness,
  collector: EvidenceCollector,
  opts: AgentOptions,
): Promise<StepResult[]> {
  const model = opts.model ?? process.env.ARGUS_MODEL ?? DEFAULT_MODEL;
  const tools = opts._tools ?? buildArgusTools(harness);
  const driver =
    opts._driver ??
    makeSdkDriver({
      systemPrompt: SYSTEM_PROMPT,
      model,
      allowedTools: tools.toolNames,
      mcpServer: tools.server,
      maxTurns: MAX_TOOL_CALLS_PER_STEP + MAX_NUDGES + 2,
    });

  const results: StepResult[] = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      const stepNum = i + 1;
      collector.setStep(stepNum);
      tools.resetToolCallCount();
      const instruction = steps[i];
      const snapshot = await harness.snapshot();

      const firstPrompt =
        `Step ${stepNum} of ${steps.length}: ${instruction}\n\n` +
        `The app under test is at ${opts.baseUrl}.\n` +
        `Current browser state:\n${snapshot}\n\n` +
        `Carry out this step, then call report_step.`;

      await driver.sendTurn(firstPrompt);
      let report = tools.takeReport();
      let nudges = 0;
      while (!report && nudges < MAX_NUDGES) {
        nudges++;
        await driver.sendTurn("You haven't concluded this step. Call report_step now with your verdict.");
        report = tools.takeReport();
      }

      results.push(
        report
          ? { index: stepNum, instruction, satisfied: report.satisfied, summary: report.summary, toolCalls: tools.toolCallCount() }
          : { index: stepNum, instruction, satisfied: false, summary: "Agent ended the step without calling report_step.", toolCalls: tools.toolCallCount() },
      );

      await harness.callTool("screenshot", { label: `step-${stepNum}-end` }).catch(() => {});
    }
  } finally {
    await driver.close();
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/agent.test.ts
git commit -m "feat: drive steps through the Agent SDK session"
```

---

## Task 4: Rewrite verdict.ts transport to a forced submit_verdict tool

**Files:**
- Modify: `src/verdict.ts` (replace `synthesizeVerdict` body; keep pure helpers + schemas)
- Modify: `src/verdict.test.ts` (add a transport test; keep existing pure tests)

The model is given exactly one tool, `submit_verdict`, whose Zod schema mirrors `VERDICT_JSON_SCHEMA`. Its handler captures the payload; we feed the captured JSON straight into the **unchanged** `parseVerdict`.

- [ ] **Step 1: Add the failing transport test**

```ts
// append to src/verdict.test.ts
import { synthesizeVerdict } from "./verdict.js";

describe("synthesizeVerdict (transport)", () => {
  it("parses the payload captured from the submit_verdict tool", async () => {
    const payload = {
      pass: false,
      steps: [
        { index: 1, pass: true, reason: "account created" },
        { index: 2, pass: false, reason: "login returned 401" },
      ],
      root_cause: "src/auth.js: comparison inverted",
      diff_citations: ["src/auth.js"],
      summary: "Login broken by the auth diff.",
    };
    const v = await synthesizeVerdict(summary, {
      _runVerdict: async (capture) => { capture(payload); },
    });
    expect(v.pass).toBe(false);
    expect(v.steps[1]).toMatchObject({ index: 2, instruction: "log in", pass: false });
    expect(v.rootCause).toContain("inverted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/verdict.test.ts`
Expected: FAIL — `synthesizeVerdict` does not accept `_runVerdict`.

- [ ] **Step 3: Rewrite `synthesizeVerdict` (keep everything above it)**

Replace the `import Anthropic ...` line and the `VerdictOptions`/`synthesizeVerdict` block at the bottom of `src/verdict.ts` with:

```ts
// at top of src/verdict.ts — replace the Anthropic import:
import { z } from "zod";
import { query, tool, createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";

// ... KEEP: VerdictPayloadSchema, VERDICT_JSON_SCHEMA, SYSTEM_PROMPT,
//          buildVerdictPrompt, parseVerdict (all unchanged) ...

const DEFAULT_MODEL = "claude-opus-4-8";

export interface VerdictOptions {
  model?: string;
  /** Test seam: receives a capture callback instead of calling the model. */
  _runVerdict?: (capture: (payload: unknown) => void, prompt: string) => Promise<void>;
}

/** Synthesize the final verdict: the model must call submit_verdict exactly once. */
export async function synthesizeVerdict(
  summary: EvidenceSummary,
  opts: VerdictOptions = {},
): Promise<Verdict> {
  const model = opts.model ?? process.env.ARGUS_MODEL ?? DEFAULT_MODEL;
  const prompt = buildVerdictPrompt(summary);

  let captured: unknown = null;
  const capture = (payload: unknown) => { captured = payload; };

  if (opts._runVerdict) {
    await opts._runVerdict(capture, prompt);
  } else {
    await runVerdictViaSdk(model, prompt, capture);
  }

  if (captured == null) throw new Error("verdict synthesis: model did not call submit_verdict");
  // parseVerdict expects a JSON string; re-serialize the captured object.
  return parseVerdict(JSON.stringify(captured), summary);
}

async function runVerdictViaSdk(
  model: string,
  prompt: string,
  capture: (payload: unknown) => void,
): Promise<void> {
  const server = createSdkMcpServer({
    name: "verdict",
    version: "0.1.0",
    tools: [
      tool(
        "submit_verdict",
        "Submit the final structured verdict. Call exactly once.",
        {
          pass: z.boolean(),
          steps: z.array(z.object({ index: z.number().int(), pass: z.boolean(), reason: z.string() })),
          root_cause: z.string().nullable(),
          diff_citations: z.array(z.string()),
          summary: z.string(),
        },
        async (args) => { capture(args); return { content: [{ type: "text", text: "recorded" }] }; },
      ),
    ],
  });

  const options: Options = {
    model,
    systemPrompt: `${SYSTEM_PROMPT}\n\nWhen you have decided, call submit_verdict with the structured result. Do not reply in prose.`,
    mcpServers: { verdict: server as never },
    allowedTools: ["mcp__verdict__submit_verdict"],
    settingSources: [],
    permissionMode: "bypassPermissions",
    maxTurns: 3,
  } as Options;

  for await (const _msg of query({ prompt, options })) {
    // handler captures the payload; nothing else to do.
  }
}
```

> Reconcile `Options`/`tool()` shapes with the installed `.d.ts` exactly as in Task 2. `VerdictPayloadSchema.parse` still validates the captured payload, so a malformed tool call throws — preserving the existing "throws on malformed payload" guarantee.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/verdict.test.ts`
Expected: PASS — existing pure tests plus the new transport test.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/verdict.ts src/verdict.test.ts
git commit -m "feat: synthesize verdict via forced submit_verdict tool"
```

---

## Task 5: CLI hint, README, dead-code sweep, full verification

**Files:**
- Modify: `src/cli.ts:37-40`
- Modify: `README.md` (Install + run sections)
- Modify: `package.json` (remove `@anthropic-ai/sdk` if unused)

- [ ] **Step 1: Update the CLI auth hint**

In `src/cli.ts`, replace the error-hint block so it mentions both auth modes:

```ts
      if (/x-api-key|authentication_error|ANTHROPIC_API_KEY|not logged in|unauthor/i.test(msg)) {
        console.error(
          "\nArgus needs Claude access. Either log in with a Claude Pro/Max plan via Claude Code " +
            "(no ANTHROPIC_API_KEY set), or set ANTHROPIC_API_KEY to use the API. Then try again.",
        );
      } else {
```

- [ ] **Step 2: Confirm `@anthropic-ai/sdk` is no longer imported**

Run: `npx grep -rn "@anthropic-ai/sdk" src` *(or use the editor search)*
Expected: no matches. If clean, remove it:

```bash
npm uninstall @anthropic-ai/sdk
```

If any match remains, convert it before uninstalling (no production file should import it after Tasks 3–4).

- [ ] **Step 3: Update README**

In `README.md`, change the Install section's API-key line to document both modes, and add a short note under the demo:

```markdown
## Auth: subscription or API key

Argus runs on the Claude Agent SDK, so it works two ways with the **same** command:

- **Claude Pro/Max subscription** (no per-token cost): log in with Claude Code and make sure
  `ANTHROPIC_API_KEY` is **unset**. Argus uses your subscription.
- **Anthropic API**: set `ANTHROPIC_API_KEY=sk-ant-...` and the identical run bills the API.

`ARGUS_MODEL` selects the model (default `claude-opus-4-8`).
```

- [ ] **Step 4: Full typecheck + test suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; **all** suites pass (config, steps, target, browser, evidence, report, tools, session, agent, verdict).

- [ ] **Step 5: End-to-end smoke against the demo app (subscription)**

With `ANTHROPIC_API_KEY` unset and logged into Claude Code:

```bash
npm run argus -- run -c examples/demo-app.config.yaml -s examples/signup-login.steps.md
```

Expected: a run completes and writes `runs/<timestamp>/report.md`; verdict is **FAIL** with the login step flagged and the `401` cited (same expectation as the README demo, now powered by the subscription). If the model/tooling behaves differently than the old API path, capture the report and note discrepancies — do not silently "fix" by loosening assertions.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts README.md package.json package-lock.json
git commit -m "docs: document subscription/API auth; drop raw Anthropic SDK"
```

---

## Self-review notes (already reconciled)

- **Spec coverage:** auth layer (Task 5 docs + smoke gate Task 0), `ModelRunner`/`SessionDriver` seam (Task 2), `agent.ts` rewrite incl. one continuous session / nudge / auto-screenshot / disabled built-ins via `allowedTools`+`settingSources` (Tasks 1–3), `verdict.ts` forced-tool transport with pure helpers intact (Task 4), CLI hint + README + dead-code (Task 5). All spec sections map to tasks.
- **Pipeline untouched:** `runSteps`/`synthesizeVerdict` public signatures preserved, so `pipeline.ts` needs no change.
- **Known integration risk (flagged inline):** exact Agent SDK `Options`/`tool()`/streaming-message shapes are version-dependent; Task 0 pins them and Tasks 2 & 4 carry explicit reconciliation notes. TypeScript (`npm run typecheck`) catches mismatches immediately.
- **Hard gate:** if Task 0 Step 4 fails on subscription auth, stop — the migration premise is invalid.
