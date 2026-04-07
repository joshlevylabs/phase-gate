/**
 * Anthropic client factory.
 * Uses Cortex API when CORTEX_API_URL + CORTEX_API_KEY are set,
 * otherwise falls back to direct Anthropic API via ANTHROPIC_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk";

export function getApiKey(): string {
  const key =
    process.env.ANTHROPIC_API_KEY ??
    process.env.CORTEX_API_KEY ??
    process.env.SONANCE_CORTEX_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY or CORTEX_API_KEY env var required");
  return key;
}

export function makeClient(apiKey: string): Anthropic {
  const baseURL =
    process.env.CORTEX_API_URL ??
    process.env.SONANCE_CORTEX_API_URL;
  return new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL: `${baseURL}/anthropic` } : {}),
  });
}
