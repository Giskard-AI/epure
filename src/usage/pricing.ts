import type { ModelTokenCounts, TokenCounts } from "./token-usage.js";

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
