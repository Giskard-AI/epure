import { describe, expect, it } from "vitest";
import { costOfModels, costUsd, type ModelPricing } from "../src/usage/pricing.js";
import type { TokenCounts, TokenUsageRecord } from "../src/usage/token-usage.js";
import {
  formatEpicUsageSection,
  formatPrUsageSection,
  formatStatusUsageLines,
  formatTicketUsageSuffix,
  formatTokenUsage,
  replacePrUsageSection
} from "../src/usage/usage-report.js";

const tokens = (input: number, cached: number, output: number, thinking = 0, requests = 1): TokenCounts => ({
  requests,
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  thinking_tokens: thinking
});

const PRICE: ModelPricing = {
  inputPerMTok: 2,
  cachedInputPerMTok: 0.5,
  outputPerMTok: 8,
  source: "https://example.test/pricing",
  read_on: "2026-11-08"
};

describe("costUsd", () => {
  it.each([
    { id: "uncached-input-and-output", counts: tokens(1_000_000, 0, 1_000_000), price: PRICE, expected: 10 },
    { id: "cached-input-bills-at-the-cached-price", counts: tokens(1_000_000, 400_000, 0), price: PRICE, expected: 1.4 },
    {
      id: "cached-input-bills-at-the-input-price-without-a-cached-price",
      counts: tokens(1_000_000, 400_000, 0),
      price: { ...PRICE, cachedInputPerMTok: undefined },
      expected: 2
    },
    { id: "thinking-tokens-inside-output-bill-as-output", counts: tokens(0, 0, 500_000, 400_000), price: PRICE, expected: 4 }
  ])("$id", ({ counts, price, expected }) => {
    expect(costUsd(counts, price)).toBeCloseTo(expected, 10);
  });
});

describe("costOfModels", () => {
  it.each([
    { id: "every-model-priced-sums-them", pricing: { "a/x": PRICE, "b/y": PRICE }, expected: 18 },
    { id: "one-model-without-a-price-gives-no-cost", pricing: { "a/x": PRICE }, expected: null },
    { id: "no-pricing-table-gives-no-cost", pricing: undefined, expected: null }
  ])("$id", ({ pricing, expected }) => {
    const models = { "a/x": tokens(1_000_000, 0, 1_000_000), "b/y": tokens(0, 0, 1_000_000) };
    expect(costOfModels(models, pricing)).toBe(expected);
  });
});

describe("formatTokenUsage", () => {
  it.each([
    { id: "nothing-spent-gives-no-line", models: {}, pricing: undefined, expected: undefined },
    {
      id: "tokens-only-without-a-price",
      models: { "a/x": tokens(12_345, 2_000, 678, 100, 3) },
      pricing: undefined,
      expected: "12,345 input tokens (2,000 cached) · 678 output (100 thinking) · 3 requests"
    },
    {
      id: "cost-appended-when-every-model-is-priced",
      models: { "a/x": tokens(1_000_000, 0, 1_000_000, 0, 2) },
      pricing: { "a/x": PRICE },
      expected: "1,000,000 input tokens (0 cached) · 1,000,000 output (0 thinking) · 2 requests · $10.00"
    },
    {
      id: "a-cost-under-a-cent-is-not-rounded-to-zero",
      models: { "a/x": tokens(100, 0, 100) },
      pricing: { "a/x": PRICE },
      expected: "100 input tokens (0 cached) · 100 output (0 thinking) · 1 request · < $0.01"
    },
    {
      id: "requests-without-usage-data-are-counted-not-hidden",
      models: { "a/x": { ...tokens(10, 0, 5, 0, 3), usage_unavailable: 2 } },
      pricing: undefined,
      expected: "10 input tokens (0 cached) · 5 output (0 thinking) · 3 requests · 2 without usage data"
    },
    {
      id: "cost-with-requests-without-usage-data-is-a-lower-bound",
      models: { "a/x": { ...tokens(1_000_000, 0, 1_000_000, 0, 3), usage_unavailable: 1 } },
      pricing: { "a/x": PRICE },
      expected: "1,000,000 input tokens (0 cached) · 1,000,000 output (0 thinking) · 3 requests · 1 without usage data · ≥ $10.00"
    }
  ])("$id", ({ models, pricing, expected }) => {
    expect(formatTokenUsage(models, pricing)).toBe(expected);
  });
});

const RECORD: TokenUsageRecord = {
  epic: { plan: { "a/x": tokens(100, 0, 10) } },
  "12": { implementation: { "a/x": tokens(200, 0, 20) }, review: { "a/x": tokens(300, 0, 30) } }
};

describe("formatTicketUsageSuffix", () => {
  it.each([
    {
      id: "ticket-with-usage-sums-its-phases",
      ticket: 12,
      expected: " — LLM usage: 500 input tokens (0 cached) · 50 output (0 thinking) · 2 requests"
    },
    { id: "ticket-without-usage-adds-nothing", ticket: 13, expected: "" }
  ])("$id", ({ ticket, expected }) => {
    expect(formatTicketUsageSuffix(RECORD, ticket, undefined)).toBe(expected);
  });
});

describe("formatEpicUsageSection", () => {
  it.each([
    {
      id: "epic-total-sums-planning-and-every-ticket",
      record: RECORD,
      expected: ["", "## LLM Usage", "- **Epic total**: 600 input tokens (0 cached) · 60 output (0 thinking) · 3 requests"]
    },
    { id: "no-usage-recorded-adds-no-section", record: undefined, expected: [] }
  ])("$id", ({ record, expected }) => {
    expect(formatEpicUsageSection(record, undefined)).toEqual(expected);
  });
});

describe("replacePrUsageSection", () => {
  const section = formatPrUsageSection(RECORD, undefined);

  it.each([
    {
      id: "section-between-the-markers-is-replaced-and-the-rest-kept",
      body: "## Summary\nhuman edit\n\n<!-- epure-llm-usage:start -->\n## LLM Usage\n- **Epic total**: old\n<!-- epure-llm-usage:end -->\n\n## Governance",
      expected: `## Summary\nhuman edit\n\n${section}\n\n## Governance`
    },
    {
      id: "body-without-the-markers-gets-the-section-appended",
      body: "## Summary",
      expected: `## Summary\n\n${section}`
    },
    {
      id: "start-marker-without-an-end-marker-gets-the-section-appended",
      body: "## Summary\n<!-- epure-llm-usage:start -->",
      expected: `## Summary\n<!-- epure-llm-usage:start -->\n\n${section}`
    }
  ])("$id", ({ body, expected }) => {
    expect(replacePrUsageSection(body, section)).toBe(expected);
  });
});

describe("formatStatusUsageLines", () => {
  it.each([
    {
      id: "price-source-shown-with-a-cost",
      pricing: { "a/x": PRICE },
      expectedPriceLine: true
    },
    {
      id: "no-price-source-when-no-line-shows-a-cost",
      pricing: { "b/y": PRICE },
      expectedPriceLine: false
    }
  ])("$id", ({ pricing, expectedPriceLine }) => {
    const lines = formatStatusUsageLines(RECORD, pricing);

    expect(lines.some((line) => line.includes("Prices from"))).toBe(expectedPriceLine);
  });
});
