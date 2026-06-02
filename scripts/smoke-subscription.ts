import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "ANTHROPIC_API_KEY is set — this will use API billing, not the subscription. Unset it to test subscription auth.",
    );
  }
  const q = query({
    prompt: "Reply with exactly the word: PONG",
    options: {
      model: process.env.ARGUS_MODEL ?? "claude-opus-4-8",
      maxTurns: 1,
      settingSources: [],
    },
  });
  for await (const msg of q) {
    const type = (msg as { type: string }).type;
    console.log("MSG:", type);
    if (type === "result") {
      console.log("RESULT:", JSON.stringify(msg));
    }
  }
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
