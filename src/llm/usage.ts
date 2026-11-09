import {
  bindToUsageContext,
  recordTokenUsage,
  type LLMRequestUsage,
  type LLMTokenUsage,
  type RecordUsageOptions
} from "../usage/token-usage.js";
import type { ProviderKind } from "./types.js";

export const LLM_USAGE_LOG_PREFIX = "epure-llm-usage";

type Counts = Readonly<Record<string, unknown>>;

function count(source: Counts | undefined, key: string): number {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asCounts(value: unknown): Counts | undefined {
  return value && typeof value === "object" ? (value as Counts) : undefined;
}

export function extractLLMTokenUsage(
  provider: ProviderKind,
  model: string,
  body: unknown
): LLMTokenUsage | null {
  const root = asCounts(body);
  if (provider === "google" || provider === "vertex") {
    const u = asCounts(root?.usageMetadata);
    if (!u) {
      return null;
    }
    const thinking = count(u, "thoughtsTokenCount");
    return {
      provider,
      model,
      input_tokens: count(u, "promptTokenCount") + count(u, "toolUsePromptTokenCount"),
      cached_input_tokens: count(u, "cachedContentTokenCount"),
      output_tokens: count(u, "candidatesTokenCount") + thinking,
      thinking_tokens: thinking
    };
  }
  const u = asCounts(root?.usage);
  if (!u) {
    return null;
  }
  if (provider === "anthropic") {
    const cacheRead = count(u, "cache_read_input_tokens");
    return {
      provider,
      model,
      input_tokens: count(u, "input_tokens") + cacheRead + count(u, "cache_creation_input_tokens"),
      cached_input_tokens: cacheRead,
      output_tokens: count(u, "output_tokens"),
      thinking_tokens: count(asCounts(u.output_tokens_details), "thinking_tokens")
    };
  }
  // The Responses API names them input/output tokens, chat completions prompt/completion tokens.
  if ("input_tokens" in u) {
    return {
      provider,
      model,
      input_tokens: count(u, "input_tokens"),
      cached_input_tokens: count(asCounts(u.input_tokens_details), "cached_tokens"),
      output_tokens: count(u, "output_tokens"),
      thinking_tokens: count(asCounts(u.output_tokens_details), "reasoning_tokens")
    };
  }
  return {
    provider,
    model,
    input_tokens: count(u, "prompt_tokens"),
    cached_input_tokens: count(asCounts(u.prompt_tokens_details), "cached_tokens"),
    output_tokens: count(u, "completion_tokens"),
    thinking_tokens: count(asCounts(u.completion_tokens_details), "reasoning_tokens")
  };
}

export function formatLLMUsageLogLine(usage: LLMTokenUsage): string {
  return `${LLM_USAGE_LOG_PREFIX} ${JSON.stringify(usage)}`;
}

/**
 * The one channel for LLM usage: the job-log line and the run's ledger. `LLMClient` and the sandbox
 * proxy call it per response; an engine that bypasses both calls it once per session with its counts,
 * or with `unavailable: true` when it has none.
 */
export function reportLLMUsage(usage: LLMRequestUsage, options?: RecordUsageOptions): void {
  if (!("unavailable" in usage)) {
    process.stdout.write(`${formatLLMUsageLogLine(usage)}\n`);
  }
  recordTokenUsage(usage, options);
}

/** reportLLMUsage bound to the caller's attribution, for callbacks that run outside it (a proxy's server). */
export function usageReporter(options?: RecordUsageOptions): (usage: LLMRequestUsage) => void {
  const inCallerContext = bindToUsageContext();
  return (usage) => inCallerContext(() => reportLLMUsage(usage, options));
}
