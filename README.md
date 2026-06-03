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

By default a **cheap model drives** (Sonnet 4.6) and **Opus only synthesizes** the verdict — set in
the config's `models` block. `ARGUS_MODEL` overrides the drive model. The run report prints a token /
cache-hit-rate / cost line so you can tune the subscription-vs-API tradeoff.

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

## Autonomous crawl (pre-launch site sweep)

Point Argus at a whole site — a live URL or a launched repo — and let it walk the site on its own,
flagging login/UI/console/network/broken-flow issues with screenshots, within a budget:

```bash
# Just a URL (no git):
npm run argus -- crawl --url https://staging.my-app.com --max-pages 25 --scope "focus on the signup and playback flows"

# With credentials (read from env), for authenticated areas:
ARGUS_LOGIN_URL=https://staging.my-app.com/login ARGUS_USERNAME=demo@x.com ARGUS_PASSWORD=secret \
  npm run argus -- crawl --url https://staging.my-app.com --creds-from-env
```

How it stays cheap and reliable:

- **Perception is the accessibility tree, not pixels.** The model reads a compact role+name tree where
  each element has a stable `[ref=eNN]` it acts on — far cheaper and more reliable than screenshots or
  HTML. On-demand `view` returns a downscaled screenshot the model actually sees, capped by an image
  budget, for visual checks.
- **The engine owns the crawl state.** The frontier / visited-set / findings live in code
  (`src/crawl.ts`); each page is analysed by a *fresh, bounded* model turn, so token cost stays flat
  regardless of site size. Templated pages (e.g. 500 product pages) are sampled by page-signature, not
  re-crawled.
- **Deterministic checks cost zero tokens.** Console errors, 4xx/5xx, broken images run in code
  (`src/checks.ts`); only short summaries reach the model.
- **Hard budgets + a denylist** (`--max-pages`, depth/tokens/wall-clock, and `/logout`,`/admin`,…) keep
  cost and blast-radius bounded. The crawl report lists findings by severity, a site map, and a cost
  dashboard.

A `crawl`-mode config (or `mode: url`) replaces `repo`/`start` requirements; see `src/config.ts` for
the `models`, `vision`, `auth`, and `crawl` blocks.

## How it works

- **`src/config.ts`** — declarative per-target config (`repo`, `ref`/`base`, `start`, `baseUrl`,
  `readyCheck`). Keeps Argus app-agnostic.
- **`src/target.ts`** — checks out the ref, runs the start command, polls until ready, computes the
  `base...ref` diff, tears the app down afterward.
- **`src/browser.ts`** — Playwright wrapper. Perception is `ariaSnapshot()` (the accessibility tree
  with `[ref=eNN]` refs); actions are ref-first (`navigate/click/fill/press/select/hover/scroll/back`),
  plus a `view()` that returns a downscaled screenshot as image content the model can see. Passively
  captures console + network into the evidence buffer.
- **`src/tools.ts` / `src/session.ts`** — expose the browser actions + `view` + a `report_step` control
  tool as an in-process MCP server, and drive one continuous Claude Agent SDK session across the steps.
  The static system prompt + tool defs sit behind a cache boundary; per-turn token/cache usage is read
  off the SDK `result` message.
- **`src/crawl.ts` / `src/checks.ts`** — the autonomous crawl engine (engine-owns-state frontier,
  per-page bounded model turns, login handling, budgets) and the zero-token deterministic checks.
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
