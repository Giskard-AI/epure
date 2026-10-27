import { redactSecrets } from "../auth/issue-command-gate.js";
import { parseRetryAfterSeconds } from "../llm/errors.js";

export type LlmResilienceStatus =
  | "completed"
  | "suspended_transient_api_exhausted"
  | "suspended_llm_quota_or_auth"
  | "rejected_fallback_provider";

export type LlmResilienceErrorCode =
  | "NONE"
  | "TRANSIENT_API_RETRIES_EXHAUSTED"
  | "LLM_QUOTA_EXHAUSTED"
  | "LLM_AUTH_INVALID"
  | "FALLBACK_PROVIDER_SWITCH_FORBIDDEN";

export interface LlmProviderResponse {
  readonly status: number;
  readonly errorType?: string | undefined;
  readonly body: string;
  readonly retryAfterHeader?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
}

export interface LlmResiliencePolicy {
  readonly primaryProvider: string;
  readonly fallbackProvider?: string | undefined;
  readonly maxTransientApiRetries: number;
  readonly transientBackoffSeconds: readonly number[];
  readonly initialCodeFixAttemptsUsed: number;
  readonly maxRateLimitWaits?: number | undefined;
  readonly rateLimitFallbackSeconds?: readonly number[] | undefined;
}

export interface ExecuteLlmCallWithResilienceInput {
  readonly policy: LlmResiliencePolicy;
  readonly invokePrimaryProvider: () => Promise<LlmProviderResponse>;
  readonly sleepFn?: ((seconds: number) => Promise<void>) | undefined;
}

export interface LlmResilienceResult {
  readonly status: LlmResilienceStatus;
  readonly error_code: LlmResilienceErrorCode;
  readonly error_message: string;
  readonly response_body: string;
  readonly transient_retries_used: number;
  readonly rate_limit_waits_used?: number | undefined;
  readonly code_fix_attempts_used: number;
  readonly provider_switched: boolean;
  readonly internal_cost_accounting_enabled: false;
  readonly diagnostic_markdown: string;
}

const DEFAULT_RATE_LIMIT_FALLBACK_SECONDS: readonly number[] = [
  15, 30, 60, 120
];
const MAX_RATE_LIMIT_WAIT_SECONDS = 300;
const DEFAULT_MAX_RATE_LIMIT_WAITS = 10;

function isQuotaExhausted(resp: LlmProviderResponse): boolean {
  const errType = (resp.errorType ?? "").toLowerCase();
  const body = resp.body.toLowerCase();
  return (
    resp.status === 402 ||
    errType.includes("insufficient_quota") ||
    errType.includes("billing") ||
    errType.includes("quota_exceeded") ||
    body.includes("exceeded your current quota") ||
    body.includes("insufficient_quota")
  );
}

function isAuthInvalid(resp: LlmProviderResponse): boolean {
  const errType = (resp.errorType ?? "").toLowerCase();
  return (
    resp.status === 401 ||
    resp.status === 403 ||
    errType.includes("invalid_api_key") ||
    errType.includes("authentication_error")
  );
}

function isRateLimitError(resp: LlmProviderResponse): boolean {
  if (isQuotaExhausted(resp) || isAuthInvalid(resp)) {
    return false;
  }
  return resp.status === 429;
}

function isTransientError(resp: LlmProviderResponse): boolean {
  if (isQuotaExhausted(resp) || isAuthInvalid(resp) || isRateLimitError(resp)) {
    return false;
  }
  return (
    resp.status === 408 ||
    resp.status === 500 ||
    resp.status === 502 ||
    resp.status === 503 ||
    resp.status === 504
  );
}

export async function executeLlmCallWithResilience(
  input: ExecuteLlmCallWithResilienceInput
): Promise<LlmResilienceResult> {
  const { policy } = input;
  const codeFixAttemptsUsed = policy.initialCodeFixAttemptsUsed;

  // ADR-0012: Strictly forbid automatic fallback/switching to a secondary LLM provider
  if (
    typeof policy.fallbackProvider === "string" &&
    policy.fallbackProvider.trim().length > 0 &&
    policy.fallbackProvider.trim().toLowerCase() !==
      policy.primaryProvider.trim().toLowerCase()
  ) {
    const msg = `Automatic fallback from primary LLM provider '${policy.primaryProvider}' to '${policy.fallbackProvider}' is forbidden (ADR-0012).`;
    return {
      status: "rejected_fallback_provider",
      error_code: "FALLBACK_PROVIDER_SWITCH_FORBIDDEN",
      error_message: msg,
      response_body: "",
      transient_retries_used: 0,
      rate_limit_waits_used: 0,
      code_fix_attempts_used: codeFixAttemptsUsed,
      provider_switched: false,
      internal_cost_accounting_enabled: false,
      diagnostic_markdown: `### EPURE LLM Policy Violation (\`FALLBACK_PROVIDER_SWITCH_FORBIDDEN\`)\n- ${msg}`
    };
  }

  const sleep =
    input.sleepFn ??
    (async (seconds: number) => {
      await new Promise((resolve) => setTimeout(resolve, seconds * 10));
    });

  const maxRateLimitWaits =
    policy.maxRateLimitWaits ?? DEFAULT_MAX_RATE_LIMIT_WAITS;
  const rateLimitFallback =
    policy.rateLimitFallbackSeconds ?? DEFAULT_RATE_LIMIT_FALLBACK_SECONDS;

  let transientRetriesUsed = 0;
  let rateLimitWaitsUsed = 0;

  while (true) {
    const resp = await input.invokePrimaryProvider();

    if (resp.status >= 200 && resp.status < 300) {
      return {
        status: "completed",
        error_code: "NONE",
        error_message: "",
        response_body: redactSecrets(resp.body),
        transient_retries_used: transientRetriesUsed,
        rate_limit_waits_used: rateLimitWaitsUsed,
        code_fix_attempts_used: codeFixAttemptsUsed,
        provider_switched: false,
        internal_cost_accounting_enabled: false,
        diagnostic_markdown: `### EPURE LLM Call Succeeded\n- **Provider**: \`${policy.primaryProvider}\`\n- **Transient Retries Used**: \`${transientRetriesUsed}\`\n- **Rate-Limit Waits Used**: \`${rateLimitWaitsUsed}\``
      };
    }

    if (isQuotaExhausted(resp)) {
      const msg = redactSecrets(
        `LLM provider '${policy.primaryProvider}' reported quota/billing exhaustion (${resp.status}). Suspending ticket without fallback.`
      );
      return {
        status: "suspended_llm_quota_or_auth",
        error_code: "LLM_QUOTA_EXHAUSTED",
        error_message: msg,
        response_body: "",
        transient_retries_used: transientRetriesUsed,
        rate_limit_waits_used: rateLimitWaitsUsed,
        code_fix_attempts_used: codeFixAttemptsUsed,
        provider_switched: false,
        internal_cost_accounting_enabled: false,
        diagnostic_markdown: `### EPURE Ticket Suspended (\`LLM_QUOTA_EXHAUSTED\`)\n- ${msg}`
      };
    }

    if (isAuthInvalid(resp)) {
      const msg = redactSecrets(
        `LLM provider '${policy.primaryProvider}' rejected API credentials (${resp.status}). Suspending ticket without retry.`
      );
      return {
        status: "suspended_llm_quota_or_auth",
        error_code: "LLM_AUTH_INVALID",
        error_message: msg,
        response_body: "",
        transient_retries_used: transientRetriesUsed,
        rate_limit_waits_used: rateLimitWaitsUsed,
        code_fix_attempts_used: codeFixAttemptsUsed,
        provider_switched: false,
        internal_cost_accounting_enabled: false,
        diagnostic_markdown: `### EPURE Ticket Suspended (\`LLM_AUTH_INVALID\`)\n- ${msg}`
      };
    }

    if (isRateLimitError(resp) && rateLimitWaitsUsed < maxRateLimitWaits) {
      const extractedSec =
        resp.retryAfterSeconds ??
        parseRetryAfterSeconds(resp.retryAfterHeader, resp.body);
      const waitSec =
        extractedSec !== undefined
          ? Math.min(Math.max(extractedSec, 1), MAX_RATE_LIMIT_WAIT_SECONDS)
          : (rateLimitFallback[rateLimitWaitsUsed] ??
            rateLimitFallback[rateLimitFallback.length - 1] ??
            120);
      rateLimitWaitsUsed += 1;
      await sleep(waitSec);
      continue;
    }

    if (
      isTransientError(resp) &&
      transientRetriesUsed < policy.maxTransientApiRetries
    ) {
      const backoffSec =
        policy.transientBackoffSeconds[transientRetriesUsed] ??
        policy.transientBackoffSeconds[
          policy.transientBackoffSeconds.length - 1
        ] ??
        120;
      transientRetriesUsed += 1;
      await sleep(backoffSec);
      continue;
    }

    const msg = redactSecrets(
      `Transient LLM/API retries exhausted (${transientRetriesUsed}/${policy.maxTransientApiRetries}) on provider '${policy.primaryProvider}'. Code-fix budget preserved (${codeFixAttemptsUsed}).`
    );
    return {
      status: "suspended_transient_api_exhausted",
      error_code: "TRANSIENT_API_RETRIES_EXHAUSTED",
      error_message: msg,
      response_body: "",
      transient_retries_used: transientRetriesUsed,
      rate_limit_waits_used: rateLimitWaitsUsed,
      code_fix_attempts_used: codeFixAttemptsUsed,
      provider_switched: false,
      internal_cost_accounting_enabled: false,
      diagnostic_markdown: `### EPURE Ticket Suspended (\`TRANSIENT_API_RETRIES_EXHAUSTED\`)\n- ${msg}`
    };
  }
}
