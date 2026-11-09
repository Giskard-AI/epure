import type { ProviderKind } from "./types.js";

export const LLM_USAGE_LOG_PREFIX = "epure-llm-usage";

export interface LLMTokenUsage {
  readonly provider: ProviderKind;
  readonly model: string;
  // Every prompt token, cached ones included.
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  // Every billed output token, thinking included.
  readonly output_tokens: number;
  readonly thinking_tokens: number;
}

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
  if (provider === "google") {
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
      thinking_tokens: 0
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
