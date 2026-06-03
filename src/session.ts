import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ZERO_USAGE, type TurnUsage } from "./types.js";

/**
 * Drives a single multi-turn agent session. One `sendTurn` sends one user message and
 * resolves when that turn's assistant response is complete (any tool calls it made having
 * been auto-executed by the SDK via the MCP handlers in between). It returns the turn's
 * token/cost usage, read off the SDK `result` message.
 *
 * This hides all Agent SDK streaming/message details from the orchestration logic so the
 * agent loop stays unit-testable with `makeScriptedDriver`.
 */
export interface SessionDriver {
  sendTurn(prompt: string): Promise<TurnUsage>;
  close(): Promise<void>;
}

/**
 * Test seam: each scripted function runs in place of a real model turn. The i-th `sendTurn`
 * call runs `turns[i]`. Used by the agent loop's unit tests.
 */
export function makeScriptedDriver(turns: Array<() => void | Promise<void>>): SessionDriver {
  let i = 0;
  return {
    async sendTurn() {
      const fn = turns[i++];
      if (fn) await fn();
      return { ...ZERO_USAGE };
    },
    async close() {},
  };
}

export interface SdkDriverConfig {
  /**
   * Custom system prompt. Pass a `string[]` containing `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
   * to split a cacheable static prefix from the dynamic suffix.
   */
  systemPrompt: string | string[];
  model: string;
  allowedTools: string[];
  /** The MCP server object from `buildArgusTools().server`. */
  mcpServer: Options["mcpServers"] extends Record<string, infer V> | undefined ? V : never;
  maxTurns: number;
}

/**
 * Read the per-turn usage off an SDK `result` message; tolerate missing fields.
 * Note: `result.usage` is the Anthropic `Usage` shape with **snake_case** keys
 * (`input_tokens`, `cache_read_input_tokens`, …) — not the camelCase `modelUsage` shape.
 */
export function usageFromResult(value: unknown): TurnUsage {
  const r = value as {
    usage?: Partial<Record<string, number>>;
    total_cost_usd?: number;
  };
  const u = r.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    costUSD: r.total_cost_usd ?? 0,
  };
}

function userMessage(content: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/**
 * Real driver: one streaming-input session. We push one user message per turn and consume
 * the message stream until that turn's terminating `result` message (verified empirically:
 * in streaming-input mode the SDK emits one `result` per turn).
 */
export function makeSdkDriver(cfg: SdkDriverConfig): SessionDriver {
  // Manually-driven async generator feeding the SDK's streaming-input prompt.
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const options: Options = {
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    mcpServers: { argus: cfg.mcpServer },
    allowedTools: cfg.allowedTools,
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: cfg.maxTurns,
  };

  const stream = query({ prompt: input(), options })[Symbol.asyncIterator]();

  return {
    async sendTurn(prompt: string) {
      pending.push(userMessage(prompt));
      wake?.();
      wake = null;
      // Consume until this turn's `result` terminator (or the stream ends).
      while (true) {
        const { value, done } = await stream.next();
        if (done) return { ...ZERO_USAGE };
        if ((value as { type?: string }).type === "result") return usageFromResult(value);
      }
    },
    async close() {
      closed = true;
      wake?.();
      wake = null;
      await stream.return?.(undefined);
    },
  };
}
