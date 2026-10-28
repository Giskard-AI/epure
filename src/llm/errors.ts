import type { ResponseSchemaSpec } from "./types.js";

export interface LLMErrorOptions {
  readonly status?: number | undefined;
  readonly provider: string;
  readonly reasonCode?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
  readonly cause?: unknown;
}

export class LLMError extends Error {
  readonly status?: number | undefined;
  readonly provider: string;
  readonly reasonCode?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;

  constructor(message: string, options: LLMErrorOptions | string) {
    const normalized: LLMErrorOptions =
      typeof options === "string" ? { provider: options } : options;
    super(message, normalized.cause ? { cause: normalized.cause } : undefined);
    this.name = "LLMError";
    this.provider = normalized.provider;
    this.status = normalized.status;
    this.reasonCode = normalized.reasonCode;
    this.retryAfterSeconds = normalized.retryAfterSeconds;
  }
}

export class AuthenticationError extends LLMError {
  constructor(
    message: string,
    options: Omit<LLMErrorOptions, "reasonCode"> | string
  ) {
    const normalized =
      typeof options === "string"
        ? { provider: options, status: 401 }
        : options;
    super(message, {
      ...normalized,
      reasonCode: "LLM_AUTH_INVALID"
    });
    this.name = "AuthenticationError";
  }
}

export class QuotaExhaustedError extends LLMError {
  constructor(
    message: string,
    options: Omit<LLMErrorOptions, "reasonCode"> | string
  ) {
    const normalized =
      typeof options === "string"
        ? { provider: options, status: 402 }
        : options;
    super(message, {
      ...normalized,
      reasonCode: "LLM_QUOTA_EXHAUSTED"
    });
    this.name = "QuotaExhaustedError";
  }
}

export class RateLimitError extends LLMError {
  constructor(
    message: string,
    options: Omit<LLMErrorOptions, "reasonCode"> | string
  ) {
    const normalized =
      typeof options === "string"
        ? { provider: options, status: 429 }
        : options;
    super(message, {
      ...normalized,
      status: normalized.status ?? 429,
      reasonCode: "RATE_LIMITED"
    });
    this.name = "RateLimitError";
  }
}

export class ServerError extends LLMError {
  constructor(
    message: string,
    options: Omit<LLMErrorOptions, "reasonCode"> | string
  ) {
    const normalized =
      typeof options === "string"
        ? { provider: options, status: 500 }
        : options;
    super(message, {
      ...normalized,
      status: normalized.status ?? 500,
      reasonCode: "SERVER_ERROR"
    });
    this.name = "ServerError";
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(
    message: string,
    options: Omit<LLMErrorOptions, "reasonCode"> | string
  ) {
    const normalized =
      typeof options === "string"
        ? { provider: options, status: 408 }
        : options;
    super(message, {
      ...normalized,
      status: normalized.status ?? 408,
      reasonCode: "TIMEOUT"
    });
    this.name = "LLMTimeoutError";
  }
}

export class BadRequestError extends LLMError {
  constructor(
    message: string,
    options: Omit<LLMErrorOptions, "reasonCode"> | string
  ) {
    const normalized =
      typeof options === "string"
        ? { provider: options, status: 400 }
        : options;
    super(message, {
      ...normalized,
      status: normalized.status ?? 400,
      reasonCode: "BAD_REQUEST"
    });
    this.name = "BadRequestError";
  }
}

export class StructuredOutputValidationError extends LLMError {
  readonly rawText?: string | undefined;

  constructor(
    message: string,
    options?:
      | (Omit<LLMErrorOptions, "reasonCode"> & {
          readonly rawText?: string | undefined;
        })
      | string
  ) {
    const normalized =
      typeof options === "string"
        ? { provider: "unknown", rawText: options }
        : (options ?? { provider: "unknown" });
    super(message, {
      ...normalized,
      reasonCode: "STRUCTURED_OUTPUT_INVALID"
    });
    this.name = "StructuredOutputValidationError";
    this.rawText = normalized.rawText;
  }
}

export function parseRetryAfterSeconds(
  headerVal?: string | null | undefined,
  bodyText?: string | undefined,
  nowMs: number = Date.now()
): number | undefined {
  if (headerVal) {
    const trimmed = headerVal.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number.parseFloat(trimmed);
      if (Number.isFinite(num) && num >= 0) {
        return Math.ceil(num);
      }
    }
    const parsedDateMs = Date.parse(trimmed);
    if (!Number.isNaN(parsedDateMs)) {
      return Math.max(0, Math.ceil((parsedDateMs - nowMs) / 1000));
    }
  }

  if (bodyText) {
    const jsonDelayMatch =
      /"(?:retryDelay|retry_delay|retryAfter|retry_after)"\s*:\s*"?(\d+(?:\.\d+)?)s?"?/i.exec(
        bodyText
      );
    if (jsonDelayMatch?.[1]) {
      const sec = Number.parseFloat(jsonDelayMatch[1]);
      if (Number.isFinite(sec) && sec >= 0) {
        return Math.ceil(sec);
      }
    }

    const proseDelayMatch =
      /(?:retry\s+after|try\s+again\s+in|retry\s+in)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\b/i.exec(
        bodyText
      );
    if (proseDelayMatch?.[1]) {
      const sec = Number.parseFloat(proseDelayMatch[1]);
      if (Number.isFinite(sec) && sec >= 0) {
        return Math.ceil(sec);
      }
    }
  }

  return undefined;
}

interface ParsedProviderErrorEnvelope {
  readonly code?: string | undefined;
  readonly type?: string | undefined;
  readonly status?: string | undefined;
  readonly errorInfoReason?: string | undefined;
  readonly hasRetryInfo: boolean;
  readonly quotaIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderErrorEnvelope(bodyText: string): ParsedProviderErrorEnvelope {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isRecord(parsed)) {
      return { hasRetryInfo: false, quotaIds: [] };
    }
    const errObj = isRecord(parsed.error) ? parsed.error : parsed;

    const code = typeof errObj.code === "string" ? errObj.code : undefined;
    const type = typeof errObj.type === "string" ? errObj.type : undefined;
    const status = typeof errObj.status === "string" ? errObj.status : undefined;

    let errorInfoReason: string | undefined;
    let hasRetryInfo = false;
    const quotaIds: string[] = [];

    if (Array.isArray(errObj.details)) {
      for (const detail of errObj.details) {
        if (!isRecord(detail)) continue;
        const detailType = typeof detail["@type"] === "string" ? detail["@type"] : "";
        if (
          detailType.endsWith("google.rpc.RetryInfo") &&
          typeof detail.retryDelay === "string"
        ) {
          hasRetryInfo = true;
        }
        if (
          detailType.endsWith("google.rpc.ErrorInfo") &&
          typeof detail.reason === "string"
        ) {
          errorInfoReason = detail.reason;
        }
        if (
          detailType.endsWith("google.rpc.QuotaFailure") &&
          Array.isArray(detail.violations)
        ) {
          for (const v of detail.violations) {
            if (isRecord(v) && typeof v.quotaId === "string") {
              quotaIds.push(v.quotaId);
            }
          }
        }
      }
    }

    return { code, type, status, errorInfoReason, hasRetryInfo, quotaIds };
  } catch {
    return { hasRetryInfo: false, quotaIds: [] };
  }
}

export function classifyHttpError(params: {
  readonly status: number;
  readonly bodyText: string;
  readonly provider: string;
  readonly model: string;
  readonly retryAfterHeader?: string | null | undefined;
}): LLMError {
  const { status, bodyText, provider, model, retryAfterHeader } = params;
  const lowerBody = bodyText.toLowerCase();
  const prefix =
    provider === "google"
      ? `Gemini API call failed (${model}, HTTP ${status})`
      : `LLM API call failed (${provider}/${model}, HTTP ${status})`;
  const message = `${prefix}: ${bodyText}`;

  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader, bodyText);
  const envelope = parseProviderErrorEnvelope(bodyText);
  const errCodeLower = envelope.code?.toLowerCase();
  const errTypeLower = envelope.type?.toLowerCase();
  const errReasonLower = envelope.errorInfoReason?.toLowerCase();

  const isAuth =
    status === 401 ||
    status === 403 ||
    errCodeLower === "invalid_api_key" ||
    errTypeLower === "authentication_error" ||
    errTypeLower === "permission_error" ||
    errReasonLower === "api_key_invalid" ||
    lowerBody.includes("invalid_api_key") ||
    lowerBody.includes("authentication_error") ||
    lowerBody.includes("api_key_invalid");

  if (isAuth) {
    return new AuthenticationError(message, { status, provider });
  }

  // Official provider structured rate-limit signals take precedence on HTTP 429:
  // - Google gRPC RetryInfo detail or PerMinute quotaId
  // - OpenAI code="rate_limit_exceeded" or type="tokens"/"requests"
  // - Anthropic type="rate_limit_error"
  // - Explicit Retry-After header or parsed retry delay
  const hasExplicitRateLimitSignal =
    status === 429 &&
    (envelope.hasRetryInfo ||
      retryAfterSeconds !== undefined ||
      errCodeLower === "rate_limit_exceeded" ||
      errTypeLower === "rate_limit_error" ||
      errTypeLower === "tokens" ||
      errTypeLower === "requests" ||
      (envelope.quotaIds.length > 0 &&
        envelope.quotaIds.every((id) => /perminute/i.test(id))));

  if (hasExplicitRateLimitSignal) {
    return new RateLimitError(message, {
      status,
      provider,
      retryAfterSeconds
    });
  }

  const isQuota =
    status === 402 ||
    errCodeLower === "insufficient_quota" ||
    errTypeLower === "insufficient_quota" ||
    errCodeLower === "billing_hard_limit_reached" ||
    errReasonLower === "billing_disabled" ||
    lowerBody.includes("insufficient_quota") ||
    lowerBody.includes("exceeded your current quota") ||
    lowerBody.includes("quota_exceeded") ||
    lowerBody.includes("billing_hard_limit_reached") ||
    lowerBody.includes("credit balance is too low");

  if (isQuota) {
    return new QuotaExhaustedError(message, { status, provider });
  }

  if (status === 408) {
    return new LLMTimeoutError(message, { status, provider });
  }

  if (status === 429) {
    return new RateLimitError(message, {
      status,
      provider,
      retryAfterSeconds
    });
  }

  if (status === 400 || status === 422) {
    return new BadRequestError(message, { status, provider });
  }

  if (status >= 500) {
    return new ServerError(message, { status, provider });
  }

  return new LLMError(message, { status, provider });
}

export function isTransientLLMError(err: unknown): boolean {
  if (
    err instanceof AuthenticationError ||
    err instanceof QuotaExhaustedError ||
    err instanceof BadRequestError ||
    err instanceof StructuredOutputValidationError
  ) {
    return false;
  }
  if (
    err instanceof RateLimitError ||
    err instanceof ServerError ||
    err instanceof LLMTimeoutError
  ) {
    return true;
  }
  if (err instanceof LLMError) {
    const st = err.status;
    return (
      st === 408 ||
      st === 429 ||
      st === 500 ||
      st === 502 ||
      st === 503 ||
      st === 504
    );
  }
  // Network / fetch errors (e.g. TypeError: fetch failed, ECONNRESET, AbortError)
  return err instanceof Error;
}

export function sanitizeJsonStringLiterals(candidate: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i]!;
    if (!inString) {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }

    if (ch === "\\") {
      const next = candidate[i + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      if (
        next === '"' ||
        next === "\\" ||
        next === "/" ||
        next === "n" ||
        next === "r" ||
        next === "t"
      ) {
        out += ch + next;
        i += 1;
        continue;
      }
      if (
        next === "u" &&
        /^[0-9a-fA-F]{4}$/.test(candidate.slice(i + 2, i + 6))
      ) {
        out += candidate.slice(i, i + 6);
        i += 5;
        continue;
      }
      out += "\\\\";
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      }
      continue;
    }

    out += ch;
  }
  return out;
}

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const outerFenceMatch = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i.exec(
    trimmed
  );
  if (outerFenceMatch && outerFenceMatch[1]) {
    const inner = outerFenceMatch[1].trim();
    if (inner.startsWith("{")) {
      return inner;
    }
  }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export function parseAndValidateStructuredOutput<T = unknown>(
  rawText: string,
  schemaSpec?: ResponseSchemaSpec<T> | undefined
): T {
  const extracted = extractJsonObject(rawText);
  if (!extracted) {
    throw new StructuredOutputValidationError(
      "LLM returned empty text when structured JSON output was expected.",
      { provider: "unknown", rawText }
    );
  }

  let parsed: unknown;
  try {
    try {
      parsed = JSON.parse(sanitizeJsonStringLiterals(extracted));
    } catch {
      parsed = JSON.parse(extracted);
    }
  } catch (err) {
    throw new StructuredOutputValidationError(
      `Failed to parse structured JSON output: ${err instanceof Error ? err.message : String(err)}`,
      { provider: "unknown", rawText, cause: err }
    );
  }

  if (!schemaSpec) {
    return parsed as T;
  }

  try {
    return schemaSpec.validate(parsed);
  } catch (err) {
    if (err instanceof StructuredOutputValidationError) {
      throw err;
    }
    throw new StructuredOutputValidationError(
      `Structured output failed validation for schema '${schemaSpec.name}': ${err instanceof Error ? err.message : String(err)}`,
      { provider: "unknown", rawText, cause: err }
    );
  }
}
