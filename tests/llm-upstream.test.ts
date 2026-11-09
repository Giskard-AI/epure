import { describe, expect, it } from "vitest";
import {
  BadRequestError,
  resolveProviderUpstream,
  type ProviderConfig,
  type ProviderKind
} from "../src/llm/index.js";
import { buildGoogleGenerateContentUrl } from "../src/llm/providers/google.js";
import { buildOpenAICompatibleEndpointAndHeaders } from "../src/llm/providers/openai.js";

describe("resolveProviderUpstream", () => {
  it.each([
    {
      id: "openai-default",
      provider: "openai",
      config: undefined,
      baseUrl: "https://api.openai.com/v1",
      authHeader: "authorization",
      allowed: ["/chat/completions", "/responses"],
      denied: ["/files", "/v1/chat/completions", "/chat/completions/../files"]
    },
    {
      id: "openai-compatible-alias-base-url",
      provider: "openai",
      config: { base_url: "https://llm.corp.internal/v1/chat/completions" },
      baseUrl: "https://llm.corp.internal/v1",
      authHeader: "authorization",
      allowed: ["/chat/completions"],
      denied: ["/models"]
    },
    {
      id: "openrouter-default",
      provider: "openrouter",
      config: undefined,
      baseUrl: "https://openrouter.ai/api/v1",
      authHeader: "authorization",
      allowed: ["/chat/completions", "/responses"],
      denied: ["/keys", "/credits"]
    },
    {
      id: "azure-openai-deployment",
      provider: "azure",
      config: { base_url: "https://res.openai.azure.com/" },
      baseUrl: "https://res.openai.azure.com",
      authHeader: "api-key",
      allowed: ["/openai/deployments/gpt-4o/chat/completions", "/openai/v1/responses"],
      denied: ["/openai/deployments/gpt-4o/files", "/openai/deployments/a/b/chat/completions"]
    },
    {
      id: "azure-ai-foundry-strips-models-suffix",
      provider: "azure_ai",
      config: { base_url: "https://hub.services.ai.azure.com/models" },
      baseUrl: "https://hub.services.ai.azure.com/openai/v1",
      authHeader: "api-key",
      allowed: ["/chat/completions", "/responses"],
      denied: ["/models"]
    },
    {
      id: "anthropic-default",
      provider: "anthropic",
      config: undefined,
      baseUrl: "https://api.anthropic.com",
      authHeader: "x-api-key",
      allowed: ["/v1/messages"],
      denied: ["/v1/messages/batches", "/v1/files"]
    },
    {
      id: "gemini-api-default",
      provider: "google",
      config: { base_url: "https://generativelanguage.googleapis.com/v1beta" },
      baseUrl: "https://generativelanguage.googleapis.com",
      authHeader: "x-goog-api-key",
      allowed: [
        "/v1beta/models/gemini-3-flash-preview:generateContent",
        "/v1beta/models/gemini-3-flash-preview:streamGenerateContent"
      ],
      denied: ["/v1beta/models/gemini-3-flash-preview:countTokens", "/v1beta/files", "/v1beta/cachedContents"]
    },
    {
      id: "vertex-express-default",
      provider: "vertex",
      config: undefined,
      baseUrl: "https://aiplatform.googleapis.com",
      authHeader: "x-goog-api-key",
      allowed: [
        "/v1/publishers/google/models/gemini-3-flash-preview:streamGenerateContent",
        "/v1/projects/p-1/locations/us-central1/publishers/google/models/gemini-3-flash-preview:generateContent"
      ],
      denied: ["/v1/publishers/google/models", "/v1/projects/p-1/locations/us/endpoints/e:predict"]
    }
  ] as const)(
    "[$id] declares one upstream host, its key header and the generation paths only",
    ({ provider, config, baseUrl, authHeader, allowed, denied }) => {
      const upstream = resolveProviderUpstream(
        provider as ProviderKind,
        config as ProviderConfig | undefined,
        {}
      );
      const isAllowed = (path: string) => upstream.allowedPaths.some((p) => p.test(path));

      expect(upstream.baseUrl).toBe(baseUrl);
      expect(upstream.authHeader).toBe(authHeader);
      expect(allowed.filter((p) => !isAllowed(p))).toEqual([]);
      expect(denied.filter(isAllowed)).toEqual([]);
    }
  );

  const MODEL = "m-1";
  const clientUrl = (provider: ProviderKind, baseUrl: string): string =>
    (provider === "google" || provider === "vertex"
      ? buildGoogleGenerateContentUrl({ model: MODEL, apiKey: "k", baseUrl, provider })
      : buildOpenAICompatibleEndpointAndHeaders({
          provider: provider as "openai" | "azure_ai",
          model: MODEL,
          apiKey: "k",
          providerConfig: { base_url: baseUrl },
          env: {}
        }).url
    ).replace(/\?.*$/, "");

  it.each([
    { id: "openai-alias-without-v1", provider: "openai", baseUrl: "http://127.0.0.1:9/", sdkPath: "/chat/completions" },
    { id: "openai-alias-with-v1", provider: "openai", baseUrl: "https://gw.example/v1", sdkPath: "/chat/completions" },
    { id: "openai-alias-full-url", provider: "openai", baseUrl: "https://gw.example/v1/chat/completions", sdkPath: "/chat/completions" },
    { id: "azure-ai-models-suffix", provider: "azure_ai", baseUrl: "https://hub.services.ai.azure.com/models", sdkPath: "/chat/completions" },
    { id: "azure-ai-v1", provider: "azure_ai", baseUrl: "https://hub.services.ai.azure.com/openai/v1", sdkPath: "/chat/completions" },
    { id: "gemini-models-suffix", provider: "google", baseUrl: "https://gw.example/v1beta/models", sdkPath: `/v1beta/models/${MODEL}:generateContent` },
    { id: "gemini-without-version", provider: "google", baseUrl: "https://gw.example", sdkPath: `/v1beta/models/${MODEL}:generateContent` },
    { id: "gemini-v1", provider: "google", baseUrl: "https://gw.example/v1", sdkPath: `/v1/models/${MODEL}:generateContent` },
    { id: "vertex-models-suffix", provider: "vertex", baseUrl: "https://aiplatform.googleapis.com/v1/publishers/google/models", sdkPath: `/v1/publishers/google/models/${MODEL}:generateContent` },
    { id: "vertex-without-version", provider: "vertex", baseUrl: "https://aiplatform.googleapis.com", sdkPath: `/v1/publishers/google/models/${MODEL}:generateContent` }
  ] as const)(
    "[$id] the proxy forwards to the same URL the LLMClient calls",
    ({ provider, baseUrl, sdkPath }) => {
      const upstream = resolveProviderUpstream(provider, { base_url: baseUrl }, {});

      expect(upstream.allowedPaths.some((p) => p.test(sdkPath))).toBe(true);
      expect(`${upstream.baseUrl}${sdkPath}`).toBe(clientUrl(provider, baseUrl));
    }
  );

  it.each([
    { id: "carries-default-headers", config: { default_headers: { "HTTP-Referer": "https://epure.dev" } }, expected: { "HTTP-Referer": "https://epure.dev" } },
    { id: "no-default-headers", config: {}, expected: {} }
  ])("[$id] carries the provider's default_headers to the proxy", ({ config, expected }) => {
    expect(resolveProviderUpstream("openrouter", config, {}).defaultHeaders).toEqual(expected);
  });

  it.each([
    { id: "azure-without-endpoint", provider: "azure" },
    { id: "azure-ai-without-endpoint", provider: "azure_ai" }
  ] as const)("[$id] requires a base_url", ({ provider }) => {
    expect(() => resolveProviderUpstream(provider, undefined, {})).toThrow(BadRequestError);
  });
});
