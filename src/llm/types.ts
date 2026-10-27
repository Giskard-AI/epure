import { PROMPT_INJECTION_IMMUNITY_CLAUSE } from "../security/prompt-injection-guard.js";

export const PROMPT_INJECTION_IMMUNITY_SYSTEM_CLAUSE =
  PROMPT_INJECTION_IMMUNITY_CLAUSE;

export { PROMPT_INJECTION_IMMUNITY_CLAUSE };

export function buildProtectedSystemInstruction(
  systemInstruction?: string | undefined
): string {
  const trimmed = (systemInstruction ?? "").trim();
  if (!trimmed) {
    return PROMPT_INJECTION_IMMUNITY_SYSTEM_CLAUSE;
  }
  if (
    trimmed.includes(PROMPT_INJECTION_IMMUNITY_SYSTEM_CLAUSE) ||
    trimmed.includes("PROMPT_INJECTION_IMMUNITY")
  ) {
    return trimmed;
  }
  return `${PROMPT_INJECTION_IMMUNITY_SYSTEM_CLAUSE}\n\n${trimmed}`;
}

export interface ResponseSchemaSpec<T = unknown> {
  readonly name: string;
  readonly description?: string | undefined;
  readonly schema: Record<string, unknown>;
  readonly validate: (parsed: unknown) => T;
}

export type ToolParameterType =
  | "STRING"
  | "NUMBER"
  | "INTEGER"
  | "BOOLEAN"
  | "OBJECT"
  | "ARRAY"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array";

export interface ToolParameterProperty {
  readonly type: ToolParameterType;
  readonly description?: string | undefined;
  readonly properties?: Readonly<Record<string, ToolParameterProperty>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly items?: ToolParameterProperty | undefined;
  readonly enum?: readonly string[] | undefined;
}

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters?: ToolParameterProperty | undefined;
}

export type ToolHandler = (
  args: Readonly<Record<string, unknown>>
) => Promise<unknown> | unknown;

export type ProviderKind =
  | "google"
  | "openai"
  | "azure"
  | "azure_ai"
  | "anthropic";

export interface ProviderConfig {
  readonly provider?: ProviderKind | undefined;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly defaultHeaders?: Readonly<Record<string, string>> | undefined;
  readonly api_key?: string | undefined;
  readonly base_url?: string | undefined;
  readonly api_version?: string | undefined;
  readonly default_headers?: Readonly<Record<string, string>> | undefined;
}

export interface LLMCallOptions<T = unknown> {
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly systemInstruction: string;
  readonly userPrompt: string;
  readonly temperature?: number | undefined;
  readonly responseMimeType?: "application/json" | "text/plain" | undefined;
  readonly responseSchema?: ResponseSchemaSpec<T> | undefined;
  readonly tools?: readonly ToolDeclaration[] | undefined;
  readonly toolHandlers?: Readonly<Record<string, ToolHandler>> | undefined;
  readonly maxToolRounds?: number | undefined;
  readonly thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined;
  readonly maxTransientRetries?: number | undefined;
  readonly transientRetryBackoffSeconds?: readonly number[] | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleepMs?: ((ms: number) => Promise<void>) | undefined;
  readonly logLabel?: string | undefined;
  readonly providers?: Readonly<Record<string, ProviderConfig>> | undefined;
}

export interface LLMCompletionResult<T = unknown> {
  readonly text: string;
  readonly data?: T | undefined;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly attempts: number;
}
