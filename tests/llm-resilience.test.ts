import { describe, expect, it } from "vitest";
import {
  executeLlmCallWithResilience,
  type LlmProviderResponse,
  type LlmResiliencePolicy
} from "../src/harness/llm-resilience.js";

describe("Ticket 25 (#26) — LLM rate-limit backoff & quota/auth suspension without fallback", () => {
  const DEFAULT_POLICY: LlmResiliencePolicy = {
    primaryProvider: "openai",
    maxTransientApiRetries: 4,
    transientBackoffSeconds: [5, 15, 45, 120],
    initialCodeFixAttemptsUsed: 1
  };

  it.each([
    {
      id: "transient-429-rate-limit-waits-without-consuming-transient-retries-or-code-fix-attempts",
      responses: [
        {
          status: 429,
          errorType: "rate_limit_exceeded",
          body: "Rate limit, please retry after 20s"
        },
        { status: 503, errorType: "server_overloaded", body: "Overloaded" },
        { status: 200, body: '{"result":"ok"}' }
      ] satisfies readonly LlmProviderResponse[],
      fallbackProviderConfigured: undefined,
      expectedStatus: "completed",
      expectedErrorCode: "NONE",
      expectedTransientRetriesUsed: 1,
      expectedRateLimitWaitsUsed: 1,
      expectedBackoffSleeps: [20, 5],
      expectedCodeFixAttemptsUsed: 1
    },
    {
      id: "transient-retries-exhausted-suspends-without-consuming-code-fix-attempts",
      responses: [
        { status: 429, errorType: "rate_limit_exceeded", body: "Rate limit 1" },
        { status: 502, errorType: "bad_gateway", body: "Bad gateway 1" },
        { status: 504, errorType: "gateway_timeout", body: "Timeout 2" },
        { status: 503, errorType: "service_unavailable", body: "Down 3" },
        { status: 500, errorType: "internal_error", body: "Down 4" },
        { status: 503, errorType: "service_unavailable", body: "Still down 5" }
      ] satisfies readonly LlmProviderResponse[],
      fallbackProviderConfigured: undefined,
      expectedStatus: "suspended_transient_api_exhausted",
      expectedErrorCode: "TRANSIENT_API_RETRIES_EXHAUSTED",
      expectedTransientRetriesUsed: 4,
      expectedRateLimitWaitsUsed: 1,
      expectedBackoffSleeps: [15, 5, 15, 45, 120],
      expectedCodeFixAttemptsUsed: 1
    },
    {
      id: "insufficient-quota-immediately-suspends-with-zero-retries",
      responses: [
        {
          status: 429,
          errorType: "insufficient_quota",
          body: "You exceeded your current quota, please check your plan and billing details."
        }
      ] satisfies readonly LlmProviderResponse[],
      fallbackProviderConfigured: undefined,
      expectedStatus: "suspended_llm_quota_or_auth",
      expectedErrorCode: "LLM_QUOTA_EXHAUSTED",
      expectedTransientRetriesUsed: 0,
      expectedRateLimitWaitsUsed: 0,
      expectedBackoffSleeps: [],
      expectedCodeFixAttemptsUsed: 1
    },
    {
      id: "invalid-api-key-401-immediately-suspends-with-zero-retries",
      responses: [
        {
          status: 401,
          errorType: "invalid_api_key",
          body: "Incorrect API key provided."
        }
      ] satisfies readonly LlmProviderResponse[],
      fallbackProviderConfigured: undefined,
      expectedStatus: "suspended_llm_quota_or_auth",
      expectedErrorCode: "LLM_AUTH_INVALID",
      expectedTransientRetriesUsed: 0,
      expectedRateLimitWaitsUsed: 0,
      expectedBackoffSleeps: [],
      expectedCodeFixAttemptsUsed: 1
    },
    {
      id: "forbids-automatic-fallback-to-secondary-llm-provider",
      responses: [
        {
          status: 429,
          errorType: "insufficient_quota",
          body: "Quota exceeded"
        }
      ] satisfies readonly LlmProviderResponse[],
      fallbackProviderConfigured: "anthropic",
      expectedStatus: "rejected_fallback_provider",
      expectedErrorCode: "FALLBACK_PROVIDER_SWITCH_FORBIDDEN",
      expectedTransientRetriesUsed: 0,
      expectedRateLimitWaitsUsed: 0,
      expectedBackoffSleeps: [],
      expectedCodeFixAttemptsUsed: 1
    }
  ])(
    "executeLlmCallWithResilience [$id]: enforces bounded backoff, quota suspension, and no provider fallback",
    async ({
      responses,
      fallbackProviderConfigured,
      expectedStatus,
      expectedErrorCode,
      expectedTransientRetriesUsed,
      expectedRateLimitWaitsUsed,
      expectedBackoffSleeps,
      expectedCodeFixAttemptsUsed
    }) => {
      const recordedSleeps: number[] = [];
      let callIndex = 0;

      const result = await executeLlmCallWithResilience({
        policy: {
          ...DEFAULT_POLICY,
          fallbackProvider: fallbackProviderConfigured
        },
        sleepFn: async (seconds) => {
          recordedSleeps.push(seconds);
        },
        invokePrimaryProvider: async () => {
          const item =
            responses[Math.min(callIndex, responses.length - 1)] ?? {
              status: 500,
              body: "Unexpected"
            };
          callIndex += 1;
          return item;
        }
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.transient_retries_used).toBe(expectedTransientRetriesUsed);
      expect(result.rate_limit_waits_used).toBe(expectedRateLimitWaitsUsed);
      expect(recordedSleeps).toEqual(expectedBackoffSleeps);
      expect(result.code_fix_attempts_used).toBe(expectedCodeFixAttemptsUsed);
      expect(result.provider_switched).toBe(false);
      expect(result.internal_cost_accounting_enabled).toBe(false);
    }
  );
});
