import type { TokenCounts } from "./token-usage.js";

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
