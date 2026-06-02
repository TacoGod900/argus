import Anthropic from "@anthropic-ai/sdk";
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

/** JSON Schema handed to the API for structured output. */
const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          pass: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["index", "pass", "reason"],
        additionalProperties: false,
      },
    },
    root_cause: { type: ["string", "null"] },
    diff_citations: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["pass", "steps", "root_cause", "diff_citations", "summary"],
  additionalProperties: false,
} as const;

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
  client?: Anthropic;
}

/** Call Claude to synthesize the final verdict from the evidence + diff. */
export async function synthesizeVerdict(
  summary: EvidenceSummary,
  opts: VerdictOptions = {},
): Promise<Verdict> {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.ARGUS_MODEL ?? DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: VERDICT_JSON_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildVerdictPrompt(summary) }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return parseVerdict(text, summary);
}
