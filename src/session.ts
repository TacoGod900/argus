import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Drives a single multi-turn agent session. One `sendTurn` sends one user message and
 * resolves when that turn's assistant response is complete (any tool calls it made having
 * been auto-executed by the SDK via the MCP handlers in between).
 *
 * This hides all Agent SDK streaming/message details from the orchestration logic so the
 * agent loop stays unit-testable with `makeScriptedDriver`.
 */
export interface SessionDriver {
  sendTurn(prompt: string): Promise<void>;
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
    },
    async close() {},
  };
}

export interface SdkDriverConfig {
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  /** The MCP server object from `buildArgusTools().server`. */
  mcpServer: Options["mcpServers"] extends Record<string, infer V> | undefined ? V : never;
  maxTurns: number;
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
        if (done) return;
        if ((value as { type?: string }).type === "result") return;
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
