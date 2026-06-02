import type { BrowserHarness } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";
import type { StepResult } from "./types.js";
import { buildArgusTools, type ArgusTools } from "./tools.js";
import { makeSdkDriver, type SessionDriver } from "./session.js";

/** Default model. Override with ARGUS_MODEL. Per the claude-api skill, default to Opus 4.8. */
const DEFAULT_MODEL = "claude-opus-4-8";
/** Safety cap on browser tool calls per step, so a confused agent can't loop forever. */
const MAX_TOOL_CALLS_PER_STEP = 25;
/** How many times to prod the agent to call report_step before giving up on a step. */
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
  /** Test seam: inject a tools double. Production builds one from the harness. */
  _tools?: ArgusTools;
  /** Test seam: inject a driver double. Production builds an SDK-backed one. */
  _driver?: SessionDriver;
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
      // Budget enough turns for the tool calls plus the nudges across a single step.
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

      await driver.sendTurn(
        `Step ${stepNum} of ${steps.length}: ${instruction}\n\n` +
          `The app under test is at ${opts.baseUrl}.\n` +
          `Current browser state:\n${snapshot}\n\n` +
          `Carry out this step, then call report_step.`,
      );

      let report = tools.takeReport();
      let nudges = 0;
      while (!report && nudges < MAX_NUDGES) {
        nudges++;
        await driver.sendTurn(
          "You haven't concluded this step. Call report_step now with your verdict.",
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

  return results;
}
