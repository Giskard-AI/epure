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
}

const MODEL = String.raw`[\w.@-]+`;
const GENERATE = String.raw`:(?:generateContent|streamGenerateContent)`;
const OPENAI_PATHS: readonly RegExp[] = [/^\/chat\/completions$/, /^\/responses$/];

function trimBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
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

  switch (provider) {
    case "openai":
    case "openrouter":
      return {
        provider,
        baseUrl: trimBase(
          configured ??
            (provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"))
        ).replace(/\/chat\/completions$/, ""),
        authHeader: "authorization",
        allowedPaths: OPENAI_PATHS
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
        ]
      };
    case "azure_ai": {
      const root = requireEndpoint(
        provider,
        configured ?? env.AZURE_AI_ENDPOINT ?? env.AZURE_AI_BASE_URL,
        "AZURE_AI_ENDPOINT / AZURE_AI_BASE_URL"
      )
        .replace(/\/models$/i, "")
        .replace(/\/chat\/completions$/, "");
      return {
        provider,
        baseUrl: /\/v1$/.test(root) ? root : `${root}/openai/v1`,
        authHeader: "api-key",
        allowedPaths: OPENAI_PATHS
      };
    }
    case "anthropic":
      return {
        provider,
        baseUrl: trimBase(configured ?? "https://api.anthropic.com").replace(
          /(?:\/v1)?(?:\/messages)?$/,
          ""
        ),
        authHeader: "x-api-key",
        allowedPaths: [/^\/v1\/messages$/]
      };
    case "google":
      return {
        provider,
        baseUrl: trimBase(
          configured ?? "https://generativelanguage.googleapis.com"
        ).replace(/\/v1(?:beta)?$/, ""),
        authHeader: "x-goog-api-key",
        allowedPaths: [new RegExp(`^/v1(?:beta)?/models/${MODEL}${GENERATE}$`)]
      };
    case "vertex":
      return {
        provider,
        baseUrl: trimBase(configured ?? "https://aiplatform.googleapis.com").replace(
          /\/v1(?:beta1)?$/,
          ""
        ),
        authHeader: "x-goog-api-key",
        allowedPaths: [
          new RegExp(
            `^/v1(?:beta1)?/(?:projects/[\\w-]+/locations/[\\w-]+/)?publishers/google/models/${MODEL}${GENERATE}$`
          )
        ]
      };
  }
}
