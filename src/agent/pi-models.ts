import { parseModelIdentifier } from "../llm/client.js";
import type { ProviderConfig, ProviderKind } from "../llm/types.js";

// Pi presents this as the provider's API key; the sandbox proxy swaps it for the real one.
const NONCE_REFERENCE = "$EPURE_LLM_PROXY_NONCE";
const CUSTOM_PROVIDER_ID = "epure";

export interface PiModelRoute {
  readonly provider: string;
  readonly modelId: string;
  // models.json for a proxy listening at proxyUrl.
  modelsJson(proxyUrl: string): string;
}

// A built-in Pi provider already sends requests on the proxy's allowed paths, and overriding only its
// baseUrl and apiKey keeps Pi's model metadata. Other providers become a custom provider whose API
// lands on a path the proxy route allows.
type PiProviderRoute =
  | { readonly builtIn: string; readonly path: string }
  | { readonly api: string; readonly path: string };

const ROUTES: Record<ProviderKind, PiProviderRoute> = {
  anthropic: { builtIn: "anthropic", path: "" },
  openai: { builtIn: "openai", path: "" },
  google: { builtIn: "google", path: "/v1beta" },
  openrouter: { api: "openai-completions", path: "" },
  azure_ai: { api: "openai-completions", path: "" },
  azure: { api: "openai-completions", path: "/openai/v1" },
  vertex: { api: "google-generative-ai", path: "/v1/publishers/google" }
};

export function translateModelForPi(
  model: string,
  providers: Readonly<Record<string, ProviderConfig>> | undefined,
  env: Readonly<Record<string, string | undefined>>
): PiModelRoute {
  const parsed = parseModelIdentifier(model, providers, env);
  const route = ROUTES[parsed.provider];
  if ("builtIn" in route) {
    return {
      provider: route.builtIn,
      modelId: parsed.model,
      modelsJson: (proxyUrl) =>
        JSON.stringify({
          providers: {
            [route.builtIn]: { baseUrl: `${proxyUrl}${route.path}`, apiKey: NONCE_REFERENCE }
          }
        })
    };
  }
  return {
    provider: CUSTOM_PROVIDER_ID,
    modelId: parsed.model,
    modelsJson: (proxyUrl) =>
      JSON.stringify({
        providers: {
          [CUSTOM_PROVIDER_ID]: {
            baseUrl: `${proxyUrl}${route.path}`,
            api: route.api,
            apiKey: NONCE_REFERENCE,
            models: [
              {
                id: parsed.model,
                name: parsed.model,
                reasoning: false,
                input: ["text"],
                contextWindow: 128_000,
                maxTokens: 16_384
              }
            ]
          }
        }
      })
  };
}
