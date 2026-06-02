# Design: Move Argus onto the Claude Agent SDK

**Date:** 2026-06-02
**Status:** Approved (pending spec review)

## Problem

Argus currently calls Claude through the raw Anthropic API (`@anthropic-ai/sdk`,
`client.messages.create`) in `src/agent.ts` and `src/verdict.ts`. Every run consumes
metered API credits. The user wants to run Argus on their existing Claude Pro/Max
subscription ("normal usage") for testing, **without paying per-token** — but only if
the result still runs unchanged against the API later (e.g. for deployment).

Reusing the subscription OAuth token against the raw Messages API is unsupported and
against Anthropic's usage terms, so that path is rejected.

## Key insight

The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) is auth-agnostic by design:

- Logged into Claude Code (Pro/Max) and **no** `ANTHROPIC_API_KEY` set → uses the
  subscription.
- `ANTHROPIC_API_KEY` set → the *identical* code bills the API.

So building Argus's model layer on the Agent SDK makes "works the exact same way through
the API later" the default property, not an extra effort. We chose **full replacement**
(one code path) over a dual backend (two paths that can drift).

## Hard gate (Plan step 0)

Before rewriting anything, a ~10-line throwaway `query()` smoke test must confirm a
subscription-auth call returns successfully. We are confident the SDK runs on API keys;
we are only *fairly* confident Anthropic permits a custom SDK app to run on subscription
auth. **If the smoke test fails, stop — the refactor is pointless.** If the pinned model
id `claude-opus-4-8` is rejected on subscription, fall back to an alias (e.g. `opus`) via
`ARGUS_MODEL`.

## Architecture

### 1. Auth & model layer
No new code. Document the auth behavior. `ARGUS_MODEL` continues to select the model
(default `claude-opus-4-8`, overridable).

### 2. New seam: `ModelRunner`
Dropping `messages.create` removes today's test seam (tests inject a fake Anthropic
client). Replace it with one thin interface:

```ts
interface ModelRunner {
  run(opts: {
    systemPrompt: string;
    prompt: /* string | AsyncIterable for multi-turn */;
    tools: /* MCP tool set */;
    maxTurns: number;
  }): AsyncIterable<SDKMessage>;
}
```

- `SdkModelRunner` — real implementation wrapping `query()` from the Agent SDK.
- Fake runner (tests) — yields scripted `SDKMessage`s. The three existing `agent.test.ts`
  cases (tool-then-report, failure verdict, never-reports) port to this shape.

This is the **only** new abstraction.

### 3. `agent.ts` rewrite
- Browser tools (`navigate/click/fill/get_text/screenshot/wait_for`) become an
  **in-process MCP server** via `createSdkMcpServer` + `tool()`. Each handler delegates to
  the existing `BrowserHarness.callTool`. `BrowserHarness` is **unchanged**; only how
  tools are advertised changes.
- `report_step` becomes an MCP tool whose handler captures the step verdict.
- The manual `while(true)` loop, `MAX_TOOL_CALLS_PER_STEP`, and nudge logic are replaced
  by the SDK loop with `maxTurns`. We keep **one continuous session across all steps**
  (steps fed as sequential turns via streaming input) so page context carries over exactly
  like today.
- Built-in tools (file/bash) disabled — only our MCP tools allowed; `settingSources: []`
  so any CLAUDE.md is ignored.
- End-of-step auto-screenshot behavior preserved.

### 4. `verdict.ts` rewrite
- `output_config.json_schema` has no direct Agent SDK equivalent, so the verdict becomes a
  **single forced `submit_verdict` tool call** whose `input_schema` is the existing
  `VERDICT_JSON_SCHEMA`. The handler receives exactly the JSON shape `parseVerdict`
  expects.
- `VerdictPayloadSchema`, `parseVerdict`, and `buildVerdictPrompt` stay **untouched** and
  unit-tested as-is. Only the transport changes.

### 5. `cli.ts` + README
- `cli.ts`'s API-key error hint also mentions subscription login.
- README documents both run modes (subscription now / API later).

## Out of scope (YAGNI)
- No dual backend.
- No new CLI flags.
- No retry / streaming-UI work.
- `@anthropic-ai/sdk` direct usage removed once nothing references it (types permitting).

## Testing
- Each plan step is TDD; tests green before moving on.
- Pure logic (`parseVerdict`, `buildVerdictPrompt`, evidence rendering) keeps existing
  unit tests unchanged.
- Agent/verdict transport tested via the fake `ModelRunner`.

## Plan ordering
0. Agent SDK subscription smoke test — **hard gate**.
1. `ModelRunner` interface + fake.
2. `agent.ts` rewrite.
3. `verdict.ts` rewrite.
4. `cli.ts` + README.
