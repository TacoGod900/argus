import { query, tool, createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { renderEvidenceForPrompt } from "./evidence.js";
import type { EvidenceSummary, Verdict } from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-8";

/** Zod schema for the model's JSON payload (snake_case to match the prompt schema). */
const VerdictPayloadSchema = z.object({
  pass: z.boolean(),
  steps: z.array(
    z.object({
      index: z.number().int(),
      pass: z.boolean(),
      reason: z.string(),
    }),
  ),
  root_cause: z.string().nullable(),
  diff_citations: z.array(z.string()),
  summary: z.string(),
});

const SYSTEM_PROMPT = `You are Argus's verdict engine. You are given:
1. The outcome of each natural-language test step the agent ran against a live app.
2. Console errors and failed network requests captured while it ran.
3. The unified diff of the change under test (the PR).

Decide, per step, whether the app behaved correctly (pass) or not (fail). The overall verdict passes only if every step passes.

When a step fails, find the most likely root cause and, when the evidence points at the diff, cite the specific file and lines from the diff (e.g. "src/auth.js: the password comparison was inverted"). Be concrete and tie the failure to the observed evidence (a 401, a console TypeError, a missing element). If the diff does not obviously explain the failure, say so rather than inventing a cause.`;

/** Build the user prompt. Pure — easy to inspect/test. */
export function buildVerdictPrompt(summary: EvidenceSummary): string {
  const evidence = renderEvidenceForPrompt(summary);
  const diff = summary.diff?.trim()
    ? summary.diff
    : "(no diff available — judge from behavior alone)";
  return `# Evidence\n${evidence}\n\n# Change under test (unified diff)\n\`\`\`diff\n${diff}\n\`\`\``;
}

/**
 * Validate the model's JSON payload and map it onto our Verdict type, joining step
 * instructions back in by index. Pure — unit-tested against fixtures.
 */
export function parseVerdict(payloadText: string, summary: EvidenceSummary): Verdict {
  const payload = VerdictPayloadSchema.parse(JSON.parse(payloadText));
  const instructionByIndex = new Map(summary.steps.map((s) => [s.index, s.instruction]));

  return {
    pass: payload.pass,
    steps: payload.steps.map((s) => ({
      index: s.index,
      instruction: instructionByIndex.get(s.index) ?? `step ${s.index}`,
      pass: s.pass,
      reason: s.reason,
    })),
    rootCause: payload.pass ? null : payload.root_cause,
    diffCitations: payload.diff_citations,
    summary: payload.summary,
  };
}

export interface VerdictOptions {
  model?: string;
  /** Test seam: receives a capture callback instead of calling the model. */
  _runVerdict?: (capture: (payload: unknown) => void, prompt: string) => Promise<void>;
}

/**
 * Synthesize the final verdict from the evidence + diff. The model is given exactly one tool,
 * `submit_verdict`, whose schema mirrors the verdict payload, and must call it once. The
 * captured payload is validated and mapped by the (unchanged) pure `parseVerdict`.
 */
export async function synthesizeVerdict(
  summary: EvidenceSummary,
  opts: VerdictOptions = {},
): Promise<Verdict> {
  const model = opts.model ?? process.env.ARGUS_MODEL ?? DEFAULT_MODEL;
  const prompt = buildVerdictPrompt(summary);

  let captured: unknown = null;
  const capture = (payload: unknown) => {
    captured = payload;
  };

  if (opts._runVerdict) {
    await opts._runVerdict(capture, prompt);
  } else {
    await runVerdictViaSdk(model, prompt, capture);
  }

  if (captured == null) {
    throw new Error("verdict synthesis: model did not call submit_verdict");
  }
  // parseVerdict validates the payload (throwing on malformed shapes) and maps it onto Verdict.
  return parseVerdict(JSON.stringify(captured), summary);
}

/** Run the verdict turn through the Agent SDK, forcing a single submit_verdict tool call. */
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
        "Submit the final structured verdict. Call exactly once when you have decided.",
        VerdictPayloadSchema.shape,
        async (args) => {
          capture(args);
          return { content: [{ type: "text", text: "recorded" }] };
        },
      ),
    ],
  });

  const options: Options = {
    model,
    systemPrompt: `${SYSTEM_PROMPT}\n\nWhen you have decided, call submit_verdict with the structured result. Do not reply in prose.`,
    mcpServers: { verdict: server },
    allowedTools: ["mcp__verdict__submit_verdict"],
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 3,
  };

  for await (const _msg of query({ prompt, options })) {
    // The submit_verdict handler captures the payload; nothing else to do here.
  }
}
