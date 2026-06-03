import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserHarness } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";
import { addUsage, EMPTY_USAGE_SUMMARY, type StepResult, type UsageSummary } from "./types.js";
import { buildArgusTools, type ArgusTools } from "./tools.js";
import { makeSdkDriver, type SessionDriver } from "./session.js";

/** Default drive model. Cheap model drives; Opus only synthesizes the verdict. */
const DEFAULT_DRIVE_MODEL = "claude-sonnet-4-6";
/** Safety cap on browser tool calls per step, so a confused agent can't loop forever. */
const MAX_TOOL_CALLS_PER_STEP = 25;
/** How many times to prod the agent to call report_step before giving up on a step. */
const MAX_NUDGES = 2;

/** Static, cacheable system-prompt prefix (no per-run data). */
const SYSTEM_PROMPT_STATIC = `You are Argus, an AI engineer that verifies software changes by actually using the app like a real user.

You drive a real web browser through natural-language test steps. For each step:
- Read the page with the \`snapshot\` tool: it returns an accessibility tree where each interactive element has a stable ref like \`[ref=e12]\`. Pass that ref to click/fill/select/hover for exact targeting (you may also pass a name or selector).
- Act with navigate, click, fill, press, select, hover, scroll, go_back/go_forward. Use \`view\` to actually see the page (a screenshot you can look at) when you need to judge a visual/UI issue — it is limited, so use it deliberately.
- Use \`screenshot\` to save disk evidence at meaningful states (you do not see those).
- A step is only "satisfied" if the app behaved correctly from a user's point of view (e.g. login actually logged you in, not just that you clicked a button).
- When you are done with the current step, call report_step with whether it was satisfied and a one-sentence summary.

Be efficient: don't re-snapshot or re-navigate unnecessarily. If something fails (an error appears, a button does nothing, a page 500s), do not pretend it worked — report satisfied: false and describe what you observed. You only control one step at a time; the next step's instruction arrives after you call report_step.`;

export interface AgentOptions {
  baseUrl: string;
  /** Drive model (cheap). Defaults to Sonnet; ARGUS_MODEL overrides. */
  model?: string;
  /** Per-run vision image budget passed through to the tools. */
  maxImages?: number;
  /** Test seam: inject a tools double. Production builds one from the harness. */
  _tools?: ArgusTools;
  /** Test seam: inject a driver double. Production builds an SDK-backed one. */
  _driver?: SessionDriver;
}

export interface StepRunResult {
  results: StepResult[];
  usage: UsageSummary;
}

/**
 * Drive the browser through the natural-language steps using one continuous Agent SDK session,
 * so page context carries over between steps. Each step is one turn: we send the instruction,
 * let the model drive the browser tools, and read the verdict it records via report_step.
 */
export async function runSteps(
  steps: string[],
  harness: BrowserHarness,
  collector: EvidenceCollector,
  opts: AgentOptions,
): Promise<StepRunResult> {
  const model = opts.model ?? process.env.ARGUS_MODEL ?? DEFAULT_DRIVE_MODEL;
  const tools = opts._tools ?? buildArgusTools(harness, { maxImages: opts.maxImages });
  const driver =
    opts._driver ??
    makeSdkDriver({
      // Cache the static prefix across turns; the dynamic suffix (base URL) follows the boundary.
      systemPrompt: [
        SYSTEM_PROMPT_STATIC,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        `The app under test is at ${opts.baseUrl}.`,
      ],
      model,
      allowedTools: tools.toolNames,
      mcpServer: tools.server,
      // Budget enough turns for the tool calls plus the nudges across a single step.
      maxTurns: MAX_TOOL_CALLS_PER_STEP + MAX_NUDGES + 2,
    });

  const results: StepResult[] = [];
  let usage: UsageSummary = { ...EMPTY_USAGE_SUMMARY };
  try {
    for (let i = 0; i < steps.length; i++) {
      const stepNum = i + 1;
      collector.setStep(stepNum);
      tools.resetToolCallCount();
      const instruction = steps[i];
      const snapshot = await harness.snapshot();

      usage = addUsage(
        usage,
        await driver.sendTurn(
          `Step ${stepNum} of ${steps.length}: ${instruction}\n\n` +
            `Current browser state:\n${snapshot}\n\n` +
            `Carry out this step, then call report_step.`,
        ),
      );

      let report = tools.takeReport();
      let nudges = 0;
      while (!report && nudges < MAX_NUDGES) {
        nudges++;
        usage = addUsage(
          usage,
          await driver.sendTurn(
            "You haven't concluded this step. Call report_step now with your verdict.",
          ),
        );
        report = tools.takeReport();
      }

      results.push(
        report
          ? {
              index: stepNum,
              instruction,
              satisfied: report.satisfied,
              summary: report.summary,
              toolCalls: tools.toolCallCount(),
            }
          : {
              index: stepNum,
              instruction,
              satisfied: false,
              summary: "Agent ended the step without calling report_step.",
              toolCalls: tools.toolCallCount(),
            },
      );

      // Auto-capture an end-of-step screenshot as guaranteed evidence.
      await harness.callTool("screenshot", { label: `step-${stepNum}-end` }).catch(() => {});
    }
  } finally {
    await driver.close();
  }

  return { results, usage };
}
