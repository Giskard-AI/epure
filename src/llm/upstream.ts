import { BadRequestError } from "./errors.js";
import type { ProviderConfig, ProviderKind } from "./types.js";

export type ProviderAuthHeader =
  | "authorization"
  | "x-api-key"
  | "api-key"
  | "x-goog-api-key";

// Where a provider's HTTP API lives, how it takes its key, and which paths (relative to baseUrl) generate text.
export interface ProviderUpstream {
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  readonly authHeader: ProviderAuthHeader;
  readonly allowedPaths: readonly RegExp[];
  readonly defaultHeaders: Readonly<Record<string, string>>;
}

const MODEL = String.raw`[\w.@-]+`;
const GENERATE = String.raw`:(?:generateContent|streamGenerateContent)`;
const OPENAI_PATHS: readonly RegExp[] = [/^\/chat\/completions$/, /^\/responses$/];

function trimBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

// The root that "/chat/completions" is appended to, for the LLMClient and the sandbox proxy alike.
export function openAiCompatibleRoot(base: string): string {
  const trimmed = trimBase(base);
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function azureAiRoot(endpoint: string): string {
  const root = trimBase(endpoint).replace(/\/models$/i, "");
  if (root.endsWith("/chat/completions")) {
    return root.slice(0, -"/chat/completions".length);
  }
  return /\/v1$/.test(root) ? root : `${root}/openai/v1`;
}

// Splits a Gemini/Vertex base into the host root and the API version the client calls.
export function googleApiRoot(
  base: string,
  provider: "google" | "vertex"
): { readonly root: string; readonly version: string } {
  const trimmed = trimBase(base).replace(/(?:\/publishers\/google)?\/models$/, "");
  const versioned = /^(.*)\/(v1beta1?|v1)$/i.exec(trimmed);
  if (versioned?.[1] !== undefined && versioned[2] !== undefined) {
    return { root: versioned[1], version: versioned[2] };
  }
  return { root: trimmed, version: provider === "vertex" ? "v1" : "v1beta" };
}

function requireEndpoint(
  provider: ProviderKind,
  value: string | undefined,
  hint: string
): string {
  if (!value?.trim()) {
    throw new BadRequestError(`Provider '${provider}' requires base_url (or ${hint}).`, {
      provider,
      status: 400
    });
  }
  return trimBase(value);
}

export function resolveProviderUpstream(
  provider: ProviderKind,
  providerConfig?: ProviderConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
): ProviderUpstream {
  const configured = providerConfig?.baseUrl ?? providerConfig?.base_url;
  const defaultHeaders = {
    ...(providerConfig?.defaultHeaders ?? providerConfig?.default_headers ?? {})
  };

  switch (provider) {
    case "openai":
    case "openrouter":
      return {
        provider,
        baseUrl: openAiCompatibleRoot(
          configured ??
            (provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"))
        ),
        authHeader: "authorization",
        allowedPaths: OPENAI_PATHS,
        defaultHeaders
      };
    case "azure":
      return {
        provider,
        baseUrl: requireEndpoint(
          provider,
          configured ?? env.AZURE_OPENAI_ENDPOINT ?? env.AZURE_API_BASE,
          "AZURE_OPENAI_ENDPOINT / AZURE_API_BASE"
        ),
        authHeader: "api-key",
        allowedPaths: [
          new RegExp(`^/openai/deployments/${MODEL}/chat/completions$`),
          /^\/openai\/v1\/(?:chat\/completions|responses)$/
        ],
        defaultHeaders
      };
    case "azure_ai":
      return {
        provider,
        baseUrl: azureAiRoot(
          requireEndpoint(
            provider,
            configured ?? env.AZURE_AI_ENDPOINT ?? env.AZURE_AI_BASE_URL,
            "AZURE_AI_ENDPOINT / AZURE_AI_BASE_URL"
          )
        ),
        authHeader: "api-key",
        allowedPaths: OPENAI_PATHS,
        defaultHeaders
      };
    case "anthropic":
      return {
        provider,
        baseUrl: trimBase(configured ?? "https://api.anthropic.com").replace(
          /(?:\/v1)?(?:\/messages)?$/,
          ""
        ),
        authHeader: "x-api-key",
        allowedPaths: [/^\/v1\/messages$/],
        defaultHeaders
      };
    case "google":
      return {
        provider,
        baseUrl: googleApiRoot(configured ?? "https://generativelanguage.googleapis.com", provider)
          .root,
        authHeader: "x-goog-api-key",
        allowedPaths: [new RegExp(`^/v1(?:beta)?/models/${MODEL}${GENERATE}$`)],
        defaultHeaders
      };
    case "vertex":
      return {
        provider,
        baseUrl: googleApiRoot(configured ?? "https://aiplatform.googleapis.com", provider).root,
        defaultHeaders,
        authHeader: "x-goog-api-key",
        allowedPaths: [
          new RegExp(
            `^/v1(?:beta1)?/(?:projects/[\\w-]+/locations/[\\w-]+/)?publishers/google/models/${MODEL}${GENERATE}$`
          )
        ]
      };
  }
}
