import Anthropic from "@anthropic-ai/sdk";
import type { BrowserHarness, ToolDef } from "./browser.js";
import type { EvidenceCollector } from "./evidence.js";
import type { StepResult } from "./types.js";

/** Default model. Override with ARGUS_MODEL. Per the claude-api skill, default to Opus 4.8. */
const DEFAULT_MODEL = "claude-opus-4-8";
/** Safety cap on browser tool calls per step, so a confused agent can't loop forever. */
const MAX_TOOL_CALLS_PER_STEP = 25;
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are Argus, an AI engineer that verifies software changes by actually using the app like a real user.

You drive a real web browser through natural-language test steps. For each step:
- Use the browser tools (navigate, click, fill, get_text, screenshot, wait_for) to carry it out.
- Observe the result. A step is only "satisfied" if the app behaved correctly from a user's point of view (e.g. login actually logged you in, not just that you clicked a button).
- Take a screenshot when you reach a meaningful state (especially on success or when something looks wrong) so there is visual evidence.
- When you are done with the current step, call report_step with whether it was satisfied and a one-sentence summary of what happened.

Be efficient: don't re-navigate or re-read the page unnecessarily. If something fails (an error appears, a button does nothing, a page 500s), do not pretend it worked — report satisfied: false and describe what you observed. You only control one step at a time; the next step's instruction arrives after you call report_step.`;

/** The tool the agent calls to conclude the current step. */
const REPORT_STEP_TOOL: ToolDef = {
  name: "report_step",
  description: "Conclude the current step. Call exactly once when the step is finished.",
  input_schema: {
    type: "object",
    properties: {
      satisfied: {
        type: "boolean",
        description: "True only if the app behaved correctly for this step from a user's perspective.",
      },
      summary: { type: "string", description: "One sentence: what you did and what you observed." },
    },
    required: ["satisfied", "summary"],
  },
};

type MessageParam = Anthropic.MessageParam;

export interface AgentOptions {
  baseUrl: string;
  model?: string;
  /** Inject a client (for testing). Defaults to a real Anthropic client from env. */
  client?: Anthropic;
}

/**
 * Drive the browser through the natural-language steps using Claude's tool-use loop.
 * Keeps one conversation across all steps so page context carries over.
 */
export async function runSteps(
  steps: string[],
  harness: BrowserHarness,
  collector: EvidenceCollector,
  opts: AgentOptions,
): Promise<StepResult[]> {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.ARGUS_MODEL ?? DEFAULT_MODEL;
  const tools = [...harness.getToolDefs(), REPORT_STEP_TOOL];

  const messages: MessageParam[] = [];
  const results: StepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const stepNum = i + 1;
    collector.setStep(stepNum);
    const instruction = steps[i];

    const snapshot = await harness.snapshot();
    messages.push({
      role: "user",
      content:
        `Step ${stepNum} of ${steps.length}: ${instruction}\n\n` +
        `The app under test is at ${opts.baseUrl}.\n` +
        `Current browser state:\n${snapshot}\n\n` +
        `Carry out this step, then call report_step.`,
    });

    const result = await runOneStep(client, model, tools, harness, messages, stepNum, instruction);
    // Auto-capture an end-of-step screenshot as guaranteed evidence.
    await harness.callTool("screenshot", { label: `step-${stepNum}-end` }).catch(() => {});
    results.push(result);
  }

  return results;
}

async function runOneStep(
  client: Anthropic,
  model: string,
  tools: ToolDef[],
  harness: BrowserHarness,
  messages: MessageParam[],
  stepNum: number,
  instruction: string,
): Promise<StepResult> {
  let toolCalls = 0;
  let nudges = 0;

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: tools as Anthropic.Tool[],
      messages,
    });

    // Preserve the full assistant turn (including thinking blocks) for the next request.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Agent stopped without concluding. Nudge once or twice, then give up.
      if (nudges < 2) {
        nudges++;
        messages.push({
          role: "user",
          content: "You haven't concluded this step. Call report_step now with your verdict.",
        });
        continue;
      }
      return {
        index: stepNum,
        instruction,
        satisfied: false,
        summary: "Agent ended the step without calling report_step.",
        toolCalls,
      };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let report: StepResult | null = null;

    for (const tu of toolUses) {
      if (tu.name === "report_step") {
        const input = tu.input as { satisfied?: boolean; summary?: string };
        report = {
          index: stepNum,
          instruction,
          satisfied: Boolean(input.satisfied),
          summary: input.summary ?? "(no summary)",
          toolCalls,
        };
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "recorded" });
        continue;
      }

      toolCalls++;
      const out =
        toolCalls > MAX_TOOL_CALLS_PER_STEP
          ? "ERROR: tool-call budget for this step exhausted. Call report_step with your best verdict."
          : await harness.callTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }

    messages.push({ role: "user", content: toolResults });

    if (report) return report;
  }
}
