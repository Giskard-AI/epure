import {
  BadRequestError,
  classifyHttpError,
  LLMError,
  parseAndValidateStructuredOutput
} from "../errors.js";
import {
  buildProtectedSystemInstruction,
  type LLMCallOptions,
  type ProviderConfig
} from "../types.js";
import {
  closeObjectSchemasForOpenAI,
  normalizeToolParametersForJsonSchema
} from "./schema-utils.js";

export type OpenAICompatibleProviderKind = "openai" | "azure" | "azure_ai";

export interface OpenAIProviderExecutionInput<T = unknown> {
  readonly provider: OpenAICompatibleProviderKind;
  readonly model: string;
  readonly apiKey: string;
  readonly providerConfig?: ProviderConfig | undefined;
  readonly options: LLMCallOptions<T>;
  readonly executeRequest: (
    url: string,
    init: RequestInit
  ) => Promise<Response>;
}

export interface OpenAIProviderExecutionOutput<T = unknown> {
  readonly text: string;
  readonly data?: T | undefined;
}

export function buildOpenAICompatibleEndpointAndHeaders(params: {
  readonly provider: OpenAICompatibleProviderKind;
  readonly model: string;
  readonly apiKey: string;
  readonly providerConfig?: ProviderConfig | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): {
  readonly url: string;
  readonly headers: Record<string, string>;
} {
  const env = params.env ?? process.env;
  const cfg = params.providerConfig;
  const rawBaseUrl = cfg?.baseUrl ?? cfg?.base_url;
  const rawApiVersion = cfg?.apiVersion ?? cfg?.api_version;
  const defaultHeaders = cfg?.defaultHeaders ?? cfg?.default_headers ?? {};
  const apiKey = params.apiKey.trim();

  if (params.provider === "azure") {
    const base = (
      rawBaseUrl ??
      env.AZURE_OPENAI_ENDPOINT ??
      env.AZURE_API_BASE ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");

    if (!base) {
      throw new BadRequestError(
        "Azure OpenAI provider requires baseUrl (or AZURE_OPENAI_ENDPOINT / AZURE_API_BASE).",
        { provider: "azure", status: 400 }
      );
    }

    const apiVersion = (
      rawApiVersion ??
      env.AZURE_API_VERSION ??
      "2024-10-21"
    ).trim();
    const url = `${base}/openai/deployments/${encodeURIComponent(params.model.trim())}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

    return {
      url,
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
        ...defaultHeaders
      }
    };
  }

  if (params.provider === "azure_ai") {
    const rawEndpoint = (
      rawBaseUrl ??
      env.AZURE_AI_ENDPOINT ??
      env.AZURE_AI_BASE_URL ??
      ""
    ).trim();

    if (!rawEndpoint) {
      throw new BadRequestError(
        "Azure AI provider requires baseUrl (or AZURE_AI_ENDPOINT / AZURE_AI_BASE_URL).",
        { provider: "azure_ai", status: 400 }
      );
    }

    // Strip trailing slashes and any trailing /models suffix on Azure AI Foundry endpoints
    const normalizedBase = rawEndpoint
      .replace(/\/+$/, "")
      .replace(/\/models$/i, "");

    let url: string;
    if (normalizedBase.endsWith("/chat/completions")) {
      url = normalizedBase;
    } else if (normalizedBase.endsWith("/v1")) {
      url = `${normalizedBase}/chat/completions`;
    } else {
      url = `${normalizedBase}/openai/v1/chat/completions`;
    }

    return {
      url,
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
        ...defaultHeaders
      }
    };
  }

  // Standard OpenAI or OpenAI-compatible custom endpoint
  const openAiBase = (
    rawBaseUrl ??
    env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  )
    .trim()
    .replace(/\/+$/, "");

  let url: string;
  if (openAiBase.endsWith("/chat/completions")) {
    url = openAiBase;
  } else if (openAiBase.endsWith("/v1")) {
    url = `${openAiBase}/chat/completions`;
  } else {
    url = `${openAiBase}/v1/chat/completions`;
  }

  return {
    url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...defaultHeaders
    }
  };
}

interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null | undefined;
  readonly tool_calls?: readonly OpenAIToolCall[] | undefined;
  readonly tool_call_id?: string | undefined;
}

export async function executeOpenAIProvider<T = unknown>(
  input: OpenAIProviderExecutionInput<T>
): Promise<OpenAIProviderExecutionOutput<T>> {
  const { provider, model, apiKey, providerConfig, options, executeRequest } =
    input;
  const { url, headers } = buildOpenAICompatibleEndpointAndHeaders({
    provider,
    model,
    apiKey,
    providerConfig
  });

  const effectiveSystemInstruction = buildProtectedSystemInstruction(
    options.systemInstruction
  );

  const messages: OpenAIChatMessage[] = [
    {
      role: "system",
      content: effectiveSystemInstruction
    },
    {
      role: "user",
      content: options.userPrompt
    }
  ];

  const hasTools = Boolean(options.tools && options.tools.length > 0);
  const maxToolRounds = options.maxToolRounds ?? 20;

  const openAiTools =
    hasTools && options.tools
      ? options.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: normalizeToolParametersForJsonSchema(tool.parameters)
          }
        }))
      : undefined;

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const allowToolsThisRound = hasTools && round < maxToolRounds;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.2
    };

    if (openAiTools && allowToolsThisRound) {
      body.tools = openAiTools;
    }

    if (options.responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: options.responseSchema.name,
          ...(options.responseSchema.description
            ? { description: options.responseSchema.description }
            : {}),
          strict: true,
          schema: closeObjectSchemasForOpenAI(options.responseSchema.schema)
        }
      };
    } else if (options.responseMimeType === "application/json") {
      body.response_format = {
        type: "json_object"
      };
    }

    const response = await executeRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw classifyHttpError({
        status: response.status,
        bodyText: errText,
        provider,
        model,
        retryAfterHeader: response.headers.get("retry-after")
      });
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: OpenAIToolCall[];
        };
      }>;
    };

    const message = data.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];

    if (
      toolCalls.length > 0 &&
      allowToolsThisRound &&
      options.toolHandlers
    ) {
      messages.push({
        role: "assistant",
        content: message?.content ?? null,
        tool_calls: toolCalls
      });

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        let parsedArgs: Record<string, unknown> = {};
        if (tc.function.arguments) {
          try {
            const rawArgs = JSON.parse(tc.function.arguments) as unknown;
            if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
              parsedArgs = rawArgs as Record<string, unknown>;
            }
          } catch {
            parsedArgs = {};
          }
        }

        const handler = options.toolHandlers[toolName];
        let resultPayload: unknown;
        if (!handler) {
          resultPayload = { error: `Unknown tool '${toolName}'.` };
        } else {
          try {
            const output = await handler(parsedArgs);
            resultPayload =
              output && typeof output === "object" && !Array.isArray(output)
                ? output
                : { result: output };
          } catch (err) {
            resultPayload = {
              error: err instanceof Error ? err.message : String(err)
            };
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(resultPayload)
        });
      }
      continue;
    }

    const text = (message?.content ?? "").trim();
    if (!text) {
      throw new LLMError(
        `OpenAI-compatible provider '${provider}' returned empty content for model '${model}'.`,
        { provider }
      );
    }

    if (options.responseSchema) {
      const validated = parseAndValidateStructuredOutput(
        text,
        options.responseSchema
      );
      return { text, data: validated };
    }

    return { text };
  }

  throw new LLMError(
    `OpenAI-compatible provider '${provider}' exceeded maximum tool rounds (${maxToolRounds}) for model '${model}'.`,
    { provider }
  );
}
