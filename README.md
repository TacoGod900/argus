# Argus

**An AI engineer that verifies software changes by running them.**

Most "AI code review" reads the diff. Argus *runs the app*: it launches the target, drives real user
flows in a browser (signup, login, checkout…), watches the console and network, and reports a
**PASS/FAIL verdict with a root-cause pointer into the diff** — backed by screenshots and captured
evidence.

```
config ─▶ TargetManager ─▶ BrowserHarness ─▶ AgentLoop ─▶ VerdictSynthesizer ─▶ Reporter
         (launch the app)  (Playwright +     (Claude drives  (evidence + diff    (markdown +
                            evidence capture)  the UI per step) → PASS/FAIL+cause)  terminal)
```

## Install

```bash
npm install
npx playwright install chromium
```

## Auth: subscription or API key

Argus runs on the Claude Agent SDK, so the **same** command works two ways:

- **Claude Pro/Max subscription** (no per-token cost): log in with Claude Code and make sure
  `ANTHROPIC_API_KEY` is **unset**. Argus uses your subscription.
- **Anthropic API**: set `ANTHROPIC_API_KEY=sk-ant-...` (PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."`)
  and the identical run bills the API.

`ARGUS_MODEL` selects the model (default `claude-opus-4-8`).

## The 60-second demo

The repo ships a tiny zero-dependency signup/login app (`examples/demo-app`) as a git repo with two
branches: a clean `main` and a `bug/broken-login` branch that plants a realistic regression — the
login credential check is inverted, so valid credentials get a **401**.

Run Argus against the buggy branch:

```bash
npm run argus -- run -c examples/demo-app.config.yaml -s examples/signup-login.steps.md
```

Expected: **FAIL** — the login step is flagged, the captured network evidence shows the `401`, and the
root cause cites the inverted comparison in `server.js`. Artifacts (screenshots + `report.md`) land in
`runs/<timestamp>/`.

Now run the same flow against clean `main`:

```bash
npm run argus -- run -c examples/demo-app.config.yaml -s examples/signup-login.steps.md --ref main
```

Expected: **PASS** — all steps satisfied. Running it both ways proves Argus reacts to the actual
behavior, not a fixed answer.

## How it works

- **`src/config.ts`** — declarative per-target config (`repo`, `ref`/`base`, `start`, `baseUrl`,
  `readyCheck`). Keeps Argus app-agnostic.
- **`src/target.ts`** — checks out the ref, runs the start command, polls until ready, computes the
  `base...ref` diff, tears the app down afterward.
- **`src/browser.ts`** — Playwright wrapper exposing `navigate/click/fill/get_text/screenshot/wait_for`
  to the model, while passively capturing console + network into the evidence buffer.
- **`src/tools.ts` / `src/session.ts`** — expose the browser actions + a `report_step` control tool as
  an in-process MCP server, and drive one continuous Claude Agent SDK session across the steps.
- **`src/agent.ts`** — runs each step as one turn of that session: the agent drives the browser tools
  and concludes the step with a `report_step` verdict.
- **`src/verdict.ts`** — feeds the evidence + diff back to Claude and forces a single `submit_verdict`
  tool call to get per-step PASS/FAIL plus a root cause citing the diff.
- **`src/report.ts`** — renders `report.md` and the terminal summary.

## Verify your own app

Point a config at any locally-runnable app and write plain-English steps:

```yaml
# my-app.config.yaml
repo: ../my-app
base: main
ref: my-feature-branch
install: npm ci
start: npm run dev
baseUrl: http://localhost:3000
readyCheck:
  url: http://localhost:3000
```

```bash
npm run argus -- run -c my-app.config.yaml -s flows/checkout.steps.md
```

## Development

```bash
npm test          # unit + integration tests (vitest)
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/
```

## Scope (v1)

In: browser UI + console + network + screenshots; user-provided natural-language steps; CLI report +
artifacts. Deliberately **out**: DB/Redis/log inspection, auto-deriving tests from the diff,
multi-framework auto-detection, GitHub PR-comment posting, a web dashboard. Each is a clean follow-on
once the core evidence loop is proven.
