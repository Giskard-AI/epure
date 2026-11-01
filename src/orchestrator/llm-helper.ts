import { LLMClient } from "../llm/client.js";
import { parseAndValidateStructuredOutput } from "../llm/errors.js";
import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  PROMPT_INJECTION_IMMUNITY_SYSTEM_CLAUSE,
  type ProviderConfig,
  type ResponseSchemaSpec,
  type ToolDeclaration,
  type ToolHandler,
  type ToolParameterProperty
} from "../llm/types.js";

export {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  PROMPT_INJECTION_IMMUNITY_SYSTEM_CLAUSE,
  type ProviderConfig,
  type ResponseSchemaSpec
};

export type LlmToolParameterProperty = ToolParameterProperty;
export type LlmToolParameterSchema = ToolParameterProperty;
export type LlmToolDeclaration = ToolDeclaration;
export type LlmFunctionDeclaration = ToolDeclaration;
export type LlmToolHandler = ToolHandler;

export interface LlmCallOptions<T = unknown> {
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined;
  readonly logLabel?: string | undefined;
  readonly systemInstruction?: string | undefined;
  readonly prompt?: string | undefined;
  readonly userPrompt?: string | undefined;
  readonly responseMimeType?: "text/plain" | "application/json" | undefined;
  readonly responseSchema?: ResponseSchemaSpec<T> | undefined;
  readonly providers?: Readonly<Record<string, ProviderConfig>> | undefined;
  readonly temperature?: number | undefined;
  readonly tools?: readonly LlmToolDeclaration[] | undefined;
  readonly toolHandlers?: Readonly<Record<string, LlmToolHandler>> | undefined;
  readonly maxToolRounds?: number | undefined;
  readonly maxTransientRetries?: number | undefined;
  readonly transientRetryBackoffSeconds?: readonly number[] | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly maxRateLimitWaits?: number | undefined;
  readonly onTransientRetriesUsed?: ((retriesUsed: number) => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleepMs?: ((ms: number) => Promise<void>) | undefined;
}

export type LlmGenerateOptions<T = unknown> = LlmCallOptions<T>;

export async function callLlmText(
  options: LlmCallOptions
): Promise<string> {
  const client = new LLMClient(options.providers);
  try {
    const res = await client.complete({
      apiKey: options.apiKey,
      model: options.model,
      systemInstruction: options.systemInstruction ?? "",
      userPrompt: options.userPrompt ?? options.prompt ?? "",
      temperature: options.temperature,
      responseMimeType: options.responseMimeType,
      responseSchema: options.responseSchema,
      tools: options.tools,
      toolHandlers: options.toolHandlers,
      maxToolRounds: options.maxToolRounds,
      thinkingLevel: options.thinkingLevel,
      maxTransientRetries: options.maxTransientRetries,
      transientRetryBackoffSeconds: options.transientRetryBackoffSeconds,
      requestTimeoutMs: options.requestTimeoutMs,
      maxRateLimitWaits: options.maxRateLimitWaits,
      fetchImpl: options.fetchImpl,
      sleepMs: options.sleepMs,
      logLabel: options.logLabel,
      providers: options.providers
    });
    const used = res.transientRetriesUsed ?? 0;
    if (used > 0 && options.onTransientRetriesUsed) {
      options.onTransientRetriesUsed(used);
    }
    return res.text;
  } catch (err) {
    const used =
      err && typeof err === "object"
        ? ((err as { transientRetriesUsed?: number }).transientRetriesUsed ?? 0)
        : 0;
    if (used > 0 && options.onTransientRetriesUsed) {
      options.onTransientRetriesUsed(used);
    }
    throw err;
  }
}

export async function callLlmJson<T = unknown>(
  options: LlmCallOptions<T>
): Promise<T> {
  const client = new LLMClient(options.providers);
  if (options.responseSchema) {
    try {
      const res = await client.complete<T>({
        apiKey: options.apiKey,
        model: options.model,
        systemInstruction: options.systemInstruction ?? "",
        userPrompt: options.userPrompt ?? options.prompt ?? "",
        temperature: options.temperature,
        responseMimeType: "application/json",
        responseSchema: options.responseSchema,
        tools: options.tools,
        toolHandlers: options.toolHandlers,
        maxToolRounds: options.maxToolRounds,
        thinkingLevel: options.thinkingLevel,
        maxTransientRetries: options.maxTransientRetries,
        transientRetryBackoffSeconds: options.transientRetryBackoffSeconds,
        requestTimeoutMs: options.requestTimeoutMs,
        maxRateLimitWaits: options.maxRateLimitWaits,
        fetchImpl: options.fetchImpl,
        sleepMs: options.sleepMs,
        logLabel: options.logLabel,
        providers: options.providers
      });
      const used = res.transientRetriesUsed ?? 0;
      if (used > 0 && options.onTransientRetriesUsed) {
        options.onTransientRetriesUsed(used);
      }
      return res.data as T;
    } catch (err) {
      const used =
        err && typeof err === "object"
          ? ((err as { transientRetriesUsed?: number }).transientRetriesUsed ??
            0)
          : 0;
      if (used > 0 && options.onTransientRetriesUsed) {
        options.onTransientRetriesUsed(used);
      }
      throw err;
    }
  }

  const rawText = await callLlmText({
    ...options,
    responseMimeType: options.responseMimeType ?? "application/json"
  });
  return extractJsonObject<T>(rawText);
}

export function extractJsonObject<T = unknown>(
  rawText: string,
  schemaSpec?: ResponseSchemaSpec<T> | undefined
): T {
  return parseAndValidateStructuredOutput<T>(rawText, schemaSpec);
}
