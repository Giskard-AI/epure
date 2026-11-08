import { costOfModels, type PricingTable } from "./pricing.js";
import {
  addTokenCounts,
  EPIC_USAGE_SCOPE,
  NO_TOKENS,
  totalTokensByModel,
  type ModelTokenCounts,
  type TokenUsageRecord
} from "./token-usage.js";

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
