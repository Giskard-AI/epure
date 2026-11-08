import {
  addTokenCounts,
  EPIC_USAGE_SCOPE,
  NO_TOKENS,
  totalTokensByModel,
  type ModelTokenCounts,
  type TokenCounts,
  type TokenUsageRecord
} from "./token-usage.js";

/** USD per million tokens of one `<provider>/<model>`, as read from the provider's price page. */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  // Absent: cached input bills at the input price.
  readonly cachedInputPerMTok?: number | undefined;
  readonly source: string;
  readonly read_on: string;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

// `output_tokens` already counts thinking tokens, so they bill at the output price.
export function costUsd(counts: TokenCounts, price: ModelPricing): number {
  const uncached = counts.input_tokens - counts.cached_input_tokens;
  const cachedPrice = price.cachedInputPerMTok ?? price.inputPerMTok;
  return (
    (uncached * price.inputPerMTok + counts.cached_input_tokens * cachedPrice + counts.output_tokens * price.outputPerMTok) /
    1e6
  );
}

/** null as soon as one model has no price: a partial sum would read as the full cost. */
export function costOfModels(models: ModelTokenCounts, pricing: PricingTable | undefined): number | null {
  let total = 0;
  for (const [model, counts] of Object.entries(models)) {
    const price = pricing?.[model];
    if (!price) {
      return null;
    }
    total += costUsd(counts, price);
  }
  return total;
}

const count = (n: number): string => n.toLocaleString("en-US");
const usd = (n: number): string => (n > 0 && n < 0.01 ? "< $0.01" : `$${n.toFixed(2)}`);

/** One line of tokens (and cost when every model has a price), or undefined when nothing was spent. */
export function formatTokenUsage(models: ModelTokenCounts, pricing: PricingTable | undefined): string | undefined {
  const t = Object.values(models).reduce(addTokenCounts, NO_TOKENS);
  if (t.requests === 0) {
    return undefined;
  }
  const cost = costOfModels(models, pricing);
  return [
    `${count(t.input_tokens)} input tokens (${count(t.cached_input_tokens)} cached)`,
    `${count(t.output_tokens)} output (${count(t.thinking_tokens)} thinking)`,
    `${count(t.requests)} ${t.requests === 1 ? "request" : "requests"}`,
    ...(t.usage_unavailable ? [`${count(t.usage_unavailable)} without usage data`] : []),
    ...(cost === null ? [] : [usd(cost)])
  ].join(" · ");
}

/** Appended to a finished ticket's summary line. */
export function formatTicketUsageSuffix(
  record: TokenUsageRecord | undefined,
  ticket: number,
  pricing: PricingTable | undefined
): string {
  const line = formatTokenUsage(totalTokensByModel(record ?? {}, String(ticket)), pricing);
  return line ? ` — LLM usage: ${line}` : "";
}

/** The feature PR body's section: the epic total so far. */
export function formatEpicUsageSection(
  record: TokenUsageRecord | undefined,
  pricing: PricingTable | undefined
): string[] {
  const line = formatTokenUsage(totalTokensByModel(record ?? {}), pricing);
  return line ? ["", "## LLM Usage", `- **Epic total**: ${line}`] : [];
}

/** `/epure status`: the epic total, then planning and integration, then each ticket. */
export function formatStatusUsageLines(
  record: TokenUsageRecord | undefined,
  pricing: PricingTable | undefined
): string[] {
  const total = totalTokensByModel(record ?? {});
  const totalLine = formatTokenUsage(total, pricing);
  if (!totalLine) {
    return [];
  }
  const scopes = Object.keys(record ?? {}).sort((a, b) =>
    a === EPIC_USAGE_SCOPE ? -1 : b === EPIC_USAGE_SCOPE ? 1 : Number(a) - Number(b)
  );
  const scopeLines = scopes.flatMap((scope) => {
    const line = formatTokenUsage(totalTokensByModel(record ?? {}, scope), pricing);
    const label = scope === EPIC_USAGE_SCOPE ? "Planning & integration" : `#${scope}`;
    return line ? [`  - ${label}: ${line}`] : [];
  });
  const priced = Object.keys(total)
    .filter((model) => pricing?.[model])
    .map((model) => `\`${model}\` read on ${pricing![model]!.read_on} (${pricing![model]!.source})`);
  return [
    `- **LLM Usage**: ${totalLine}`,
    ...scopeLines,
    ...(priced.length > 0 ? [`  - Prices from \`.github/agents.yml\`: ${priced.join("; ")}`] : [])
  ];
}
