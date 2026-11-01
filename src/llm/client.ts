import {
  AuthenticationError,
  classifyHttpError,
  isTransientLLMError,
  LLMError,
  LLMTimeoutError,
  RateLimitError
} from "./errors.js";
import { executeAnthropicProvider } from "./providers/anthropic.js";
import { executeGoogleProvider } from "./providers/google.js";
import { executeOpenAIProvider } from "./providers/openai.js";
import type {
  LLMCallOptions,
  LLMCompletionResult,
  ProviderConfig,
  ProviderKind,
  ResponseSchemaSpec
} from "./types.js";

export const DEFAULT_FALLBACK_LLM_MODEL = "google/gemini-3.8-flash";

export function resolveConfigValue(
  val: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (val === undefined) {
    return undefined;
  }
  const trimmed = val.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("os.environ/")) {
    const envKey = trimmed.slice("os.environ/".length).trim();
    if (!envKey) {
      return undefined;
    }
    const envVal = env[envKey]?.trim();
    return envVal && envVal.length > 0 ? envVal : undefined;
  }
  return trimmed;
}

function mapKnownProviderPrefix(prefix: string): ProviderKind | undefined {
  const lower = prefix.trim().toLowerCase();
  if (lower === "google" || lower === "gemini") {
    return "google";
  }
  if (lower === "openai") {
    return "openai";
  }
  if (lower === "azure") {
    return "azure";
  }
  if (lower === "azure_ai" || lower === "azure-ai") {
    return "azure_ai";
  }
  if (lower === "anthropic" || lower === "claude") {
    return "anthropic";
  }
  return undefined;
}

function inferProviderFromBareModel(model: string): ProviderKind {
  const lower = model.trim().toLowerCase();
  if (lower.startsWith("claude-")) {
    return "anthropic";
  }
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("chatgpt-")
  ) {
    return "openai";
  }
  if (lower.startsWith("gemini-")) {
    return "google";
  }
  return "google";
}

export function normalizeProviderConfig(
  raw?: ProviderConfig | undefined,
  env: NodeJS.ProcessEnv = process.env
): ProviderConfig | undefined {
  if (!raw) {
    return undefined;
  }
  const apiKeyRaw = raw.apiKey ?? raw.api_key;
  const baseUrlRaw = raw.baseUrl ?? raw.base_url;
  const apiVersionRaw = raw.apiVersion ?? raw.api_version;
  const defaultHeaders = raw.defaultHeaders ?? raw.default_headers;

  const resolvedApiKey = resolveConfigValue(apiKeyRaw, env);
  const resolvedBaseUrl = resolveConfigValue(baseUrlRaw, env);
  const resolvedApiVersion = resolveConfigValue(apiVersionRaw, env);

  return {
    ...(raw.provider ? { provider: raw.provider } : {}),
    ...(resolvedApiKey
      ? { apiKey: resolvedApiKey, api_key: apiKeyRaw }
      : apiKeyRaw
        ? { api_key: apiKeyRaw }
        : {}),
    ...(resolvedBaseUrl
      ? { baseUrl: resolvedBaseUrl, base_url: baseUrlRaw }
      : baseUrlRaw
        ? { base_url: baseUrlRaw }
        : {}),
    ...(resolvedApiVersion
      ? { apiVersion: resolvedApiVersion, api_version: apiVersionRaw }
      : apiVersionRaw
        ? { api_version: apiVersionRaw }
        : {}),
    ...(defaultHeaders
      ? { defaultHeaders: { ...defaultHeaders }, default_headers: { ...defaultHeaders } }
      : {})
  };
}

export interface ParsedModelIdentifier {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly alias?: string | undefined;
  readonly providerConfig?: ProviderConfig | undefined;
}

export function parseModelIdentifier(
  modelId: string | undefined,
  configuredProviders?: Readonly<Record<string, ProviderConfig>> | undefined,
  env: NodeJS.ProcessEnv = process.env
): ParsedModelIdentifier {
  const effectiveModelId =
    modelId && modelId.trim().length > 0
      ? modelId.trim()
      : DEFAULT_FALLBACK_LLM_MODEL;

  if (effectiveModelId.includes("/")) {
    const slashIndex = effectiveModelId.indexOf("/");
    const prefix = effectiveModelId.slice(0, slashIndex).trim();
    const bareModel = effectiveModelId.slice(slashIndex + 1).trim();

    if (configuredProviders && prefix in configuredProviders) {
      const rawCfg = configuredProviders[prefix];
      const provider: ProviderKind =
        rawCfg?.provider ?? mapKnownProviderPrefix(prefix) ?? "openai";
      return {
        provider,
        model: bareModel,
        alias: prefix,
        providerConfig: normalizeProviderConfig(
          { ...rawCfg, provider },
          env
        )
      };
    }

    const mappedProvider =
      mapKnownProviderPrefix(prefix) ?? inferProviderFromBareModel(bareModel);
    const fallbackCfg =
      configuredProviders?.[prefix] ?? configuredProviders?.[mappedProvider];

    return {
      provider: fallbackCfg?.provider ?? mappedProvider,
      model: bareModel,
      alias: prefix,
      providerConfig: normalizeProviderConfig(fallbackCfg, env)
    };
  }

  const inferredProvider = inferProviderFromBareModel(effectiveModelId);
  const matchedCfg = configuredProviders?.[inferredProvider];

  return {
    provider: matchedCfg?.provider ?? inferredProvider,
    model: effectiveModelId,
    providerConfig: normalizeProviderConfig(matchedCfg, env)
  };
}

export function resolveProviderApiKey(params: {
  readonly provider: ProviderKind;
  readonly explicitApiKey?: string | undefined;
  readonly providerConfig?: ProviderConfig | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string | undefined {
  const env = params.env ?? process.env;
  const rawCfgKey =
    params.providerConfig?.api_key ?? params.providerConfig?.apiKey;
  const resolvedCfgKey = resolveConfigValue(rawCfgKey, env);

  // 1 & 2. If providerConfig explicitly configures an apiKey (e.g. os.environ/...), prefer it when resolved;
  // otherwise use explicit options.apiKey.
  if (resolvedCfgKey) {
    return resolvedCfgKey;
  }
  if (params.explicitApiKey && params.explicitApiKey.trim().length > 0) {
    return params.explicitApiKey.trim();
  }

  // 3. Provider-specific environment variables
  let providerEnvKey: string | undefined;
  if (params.provider === "google") {
    providerEnvKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  } else if (params.provider === "openai") {
    providerEnvKey = env.OPENAI_API_KEY?.trim();
  } else if (params.provider === "azure") {
    providerEnvKey =
      env.AZURE_OPENAI_API_KEY?.trim() || env.AZURE_API_KEY?.trim();
  } else if (params.provider === "azure_ai") {
    providerEnvKey = env.AZURE_AI_API_KEY?.trim() || env.AZURE_AI_KEY?.trim();
  } else if (params.provider === "anthropic") {
    providerEnvKey = env.ANTHROPIC_API_KEY?.trim();
  }

  if (providerEnvKey) {
    return providerEnvKey;
  }

  // 4. Fallback to LLM_API_KEY
  const fallback = env.LLM_API_KEY?.trim();
  return fallback && fallback.length > 0 ? fallback : undefined;
}

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_TRANSIENT_RETRIES = 4;
export const DEFAULT_RATE_LIMIT_FALLBACK_SECONDS: readonly number[] = [
  15, 30, 60, 120
];
export const MAX_RATE_LIMIT_WAIT_SECONDS = 300;
export const DEFAULT_MAX_RATE_LIMIT_WAITS = 10;

export class LLMClient {
  private readonly providers: Map<string, ProviderConfig> = new Map();

  constructor(
    initialProviders?: Readonly<Record<string, ProviderConfig>> | undefined
  ) {
    if (initialProviders) {
      this.configureFromDict(initialProviders);
    }
  }

  configure(name: string, config: ProviderConfig): void {
    const key = name.trim();
    if (!key) {
      return;
    }
    this.providers.set(key, { ...config });
  }

  configureFromDict(dict: Readonly<Record<string, ProviderConfig>>): void {
    for (const [name, cfg] of Object.entries(dict)) {
      this.configure(name, cfg);
    }
  }

  getConfiguredProviders(): Readonly<Record<string, ProviderConfig>> {
    const out: Record<string, ProviderConfig> = {};
    for (const [k, v] of this.providers.entries()) {
      out[k] = v;
    }
    return out;
  }

  async complete<T = unknown>(
    options: LLMCallOptions<T>
  ): Promise<LLMCompletionResult<T>> {
    const mergedProviders: Record<string, ProviderConfig> = {
      ...this.getConfiguredProviders(),
      ...(options.providers ?? {})
    };

    const parsed = parseModelIdentifier(options.model, mergedProviders);
    const { provider, model, providerConfig } = parsed;

    const apiKey = resolveProviderApiKey({
      provider,
      explicitApiKey: options.apiKey,
      providerConfig
    });

    if (!apiKey) {
      throw new AuthenticationError(
        `Missing API key for LLM provider '${provider}' (model '${model}').`,
        { provider, status: 401 }
      );
    }

    const fetchFn = options.fetchImpl ?? fetch;
    const maxTransientRetries =
      options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
    const defaultBackoff = options.fetchImpl ? [0, 0, 0, 0] : [5, 15, 45, 120];
    const backoffSeconds =
      options.transientRetryBackoffSeconds ?? defaultBackoff;
    const requestTimeoutMs =
      options.requestTimeoutMs !== undefined && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs
        : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    const maxRateLimitWaits =
      options.maxRateLimitWaits ?? DEFAULT_MAX_RATE_LIMIT_WAITS;
    const defaultRateLimitFallback =
      options.fetchImpl && !options.sleepMs
        ? [0, 0, 0, 0]
        : DEFAULT_RATE_LIMIT_FALLBACK_SECONDS;
    const rateLimitFallback =
      options.rateLimitFallbackSeconds ?? defaultRateLimitFallback;

    const sleepMs =
      options.sleepMs ??
      (async (ms: number) => {
        if (ms > 0) {
          await new Promise((resolve) => setTimeout(resolve, ms));
        }
      });

    let totalTransientRetriesUsed = 0;
    let totalRateLimitWaitsUsed = 0;

    const executeRequest = async (
      reqUrl: string,
      reqInit: RequestInit
    ): Promise<Response> => {
      let requestRetriesUsed = 0;
      let requestRateLimitWaitsUsed = 0;

      while (true) {
        try {
          const effectiveInit: RequestInit =
            reqInit.signal ||
            (options.fetchImpl && options.requestTimeoutMs === undefined)
              ? reqInit
              : { ...reqInit, signal: AbortSignal.timeout(requestTimeoutMs) };
          const res = await fetchFn(reqUrl, effectiveInit);
          if (res.ok) {
            return res;
          }

          const errText = await res.text();
          const classified = classifyHttpError({
            status: res.status,
            bodyText: errText,
            provider,
            model,
            retryAfterHeader: res.headers.get("retry-after")
          });

          if (classified instanceof RateLimitError) {
            if (requestRateLimitWaitsUsed < maxRateLimitWaits) {
              const waitSec =
                classified.retryAfterSeconds !== undefined
                  ? Math.min(
                      Math.max(classified.retryAfterSeconds, 1),
                      MAX_RATE_LIMIT_WAIT_SECONDS
                    )
                  : (rateLimitFallback[requestRateLimitWaitsUsed] ??
                    rateLimitFallback[rateLimitFallback.length - 1] ??
                    120);
              requestRateLimitWaitsUsed += 1;
              totalRateLimitWaitsUsed += 1;
              await sleepMs(waitSec * 1000);
              continue;
            }
            throw classified;
          }

          if (
            isTransientLLMError(classified) &&
            requestRetriesUsed < maxTransientRetries
          ) {
            const backoffSec =
              backoffSeconds[requestRetriesUsed] ??
              backoffSeconds[backoffSeconds.length - 1] ??
              0;
            requestRetriesUsed += 1;
            totalTransientRetriesUsed += 1;
            await sleepMs(backoffSec * 1000);
            continue;
          }

          throw classified;
        } catch (err) {
          if (err instanceof LLMError) {
            throw err;
          }

          if (requestRetriesUsed < maxTransientRetries) {
            const backoffSec =
              backoffSeconds[requestRetriesUsed] ??
              backoffSeconds[backoffSeconds.length - 1] ??
              0;
            requestRetriesUsed += 1;
            totalTransientRetriesUsed += 1;
            await sleepMs(backoffSec * 1000);
            continue;
          }

          throw new LLMTimeoutError(
            `LLM network/timeout error (${provider}/${model}): ${err instanceof Error ? err.message : String(err)}`,
            { provider, status: 408, cause: err }
          );
        }
      }
    };

    const onStructuredValidationRetry =
      maxTransientRetries > 0
        ? async (retryIndex = 0) => {
            const backoffSec =
              backoffSeconds[retryIndex] ?? backoffSeconds[0] ?? 0;
            totalTransientRetriesUsed += 1;
            await sleepMs(backoffSec * 1000);
          }
        : undefined;

    const invokeProvider = async (): Promise<{
      readonly text: string;
      readonly data?: T | undefined;
    }> => {
      if (provider === "google") {
        return await executeGoogleProvider({
          model,
          apiKey,
          providerConfig,
          options,
          executeRequest,
          onStructuredValidationRetry
        });
      }

      if (provider === "anthropic") {
        return await executeAnthropicProvider({
          model,
          apiKey,
          providerConfig,
          options,
          executeRequest,
          onStructuredValidationRetry
        });
      }

      return await executeOpenAIProvider({
        provider,
        model,
        apiKey,
        providerConfig,
        options,
        executeRequest,
        onStructuredValidationRetry
      });
    };

    try {
      const result = await invokeProvider();
      return {
        text: result.text,
        ...(result.data !== undefined ? { data: result.data } : {}),
        provider,
        model,
        attempts: 1 + totalTransientRetriesUsed + totalRateLimitWaitsUsed,
        transientRetriesUsed: totalTransientRetriesUsed,
        rateLimitWaitsUsed: totalRateLimitWaitsUsed
      };
    } catch (err) {
      if (err && typeof err === "object" && totalTransientRetriesUsed > 0) {
        (
          err as { transientRetriesUsed?: number }
        ).transientRetriesUsed = totalTransientRetriesUsed;
      }
      throw err;
    }
  }

  async completeText(options: LLMCallOptions): Promise<string> {
    const res = await this.complete(options);
    return res.text;
  }

  async completeStructured<T>(
    options: LLMCallOptions<T> & {
      readonly responseSchema: ResponseSchemaSpec<T>;
    }
  ): Promise<T> {
    const res = await this.complete<T>(options);
    return res.data as T;
  }
}
