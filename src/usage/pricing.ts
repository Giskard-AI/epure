import type { ModelTokenCounts, TokenCounts } from "./token-usage.js";

/** USD per million tokens of one `<provider>/<model>`, as read from the provider's price page. */
export interface ModelPricing {
  readonly input_per_mtok: number;
  readonly output_per_mtok: number;
  // Absent: cached input bills at the input price.
  readonly cached_input_per_mtok?: number | undefined;
  readonly source: string;
  readonly read_on: string;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

// `output_tokens` already counts thinking tokens, so they bill at the output price.
export function costUsd(counts: TokenCounts, price: ModelPricing): number {
  const uncached = counts.input_tokens - counts.cached_input_tokens;
  const cachedPrice = price.cached_input_per_mtok ?? price.input_per_mtok;
  return (
    (uncached * price.input_per_mtok + counts.cached_input_tokens * cachedPrice + counts.output_tokens * price.output_per_mtok) /
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
