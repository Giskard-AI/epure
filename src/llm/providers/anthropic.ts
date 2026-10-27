import {
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

export interface AnthropicProviderExecutionInput<T = unknown> {
  readonly model: string;
  readonly apiKey: string;
  readonly providerConfig?: ProviderConfig | undefined;
  readonly options: LLMCallOptions<T>;
  readonly executeRequest: (
    url: string,
    init: RequestInit
  ) => Promise<Response>;
}

export interface AnthropicProviderExecutionOutput<T = unknown> {
  readonly text: string;
  readonly data?: T | undefined;
}

export function buildAnthropicMessagesUrl(baseUrl?: string | undefined): string {
  const rawBase = (baseUrl ?? "https://api.anthropic.com")
    .trim()
    .replace(/\/+$/, "");

  if (rawBase.endsWith("/v1/messages") || rawBase.endsWith("/messages")) {
    return rawBase;
  }
  if (rawBase.endsWith("/v1")) {
    return `${rawBase}/messages`;
  }
  return `${rawBase}/v1/messages`;
}

interface AnthropicContentBlock {
  readonly type: "text" | "tool_use" | "tool_result";
  readonly text?: string | undefined;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly input?: Readonly<Record<string, unknown>> | undefined;
  readonly tool_use_id?: string | undefined;
  readonly content?: string | undefined;
}

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

export async function executeAnthropicProvider<T = unknown>(
  input: AnthropicProviderExecutionInput<T>
): Promise<AnthropicProviderExecutionOutput<T>> {
  const { model, apiKey, providerConfig, options, executeRequest } = input;
  const rawBaseUrl = providerConfig?.baseUrl ?? providerConfig?.base_url;
  const apiVersion =
    providerConfig?.apiVersion ?? providerConfig?.api_version ?? "2023-06-01";
  const defaultHeaders =
    providerConfig?.defaultHeaders ?? providerConfig?.default_headers ?? {};

  const url = buildAnthropicMessagesUrl(rawBaseUrl);
  const headers: Record<string, string> = {
    "x-api-key": apiKey.trim(),
    "anthropic-version": apiVersion,
    "content-type": "application/json",
    ...defaultHeaders
  };

  const effectiveSystemInstruction = buildProtectedSystemInstruction(
    options.systemInstruction
  );

  const messages: AnthropicMessage[] = [
    {
      role: "user",
      content: options.userPrompt
    }
  ];

  const hasTools = Boolean(options.tools && options.tools.length > 0);
  const maxToolRounds = options.maxToolRounds ?? 20;

  const anthropicTools =
    hasTools && options.tools
      ? options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: normalizeToolParametersForJsonSchema(tool.parameters)
        }))
      : undefined;

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const allowToolsThisRound = hasTools && round < maxToolRounds;
    const body: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      temperature: options.temperature ?? 0.2,
      system: effectiveSystemInstruction,
      messages
    };

    if (anthropicTools && allowToolsThisRound) {
      body.tools = anthropicTools;
    }

    if (options.responseSchema) {
      body.output_config = {
        format: {
          type: "json_schema",
          schema: closeObjectSchemasForOpenAI(options.responseSchema.schema)
        }
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
        provider: "anthropic",
        model,
        retryAfterHeader: response.headers.get("retry-after")
      });
    }

    const data = (await response.json()) as {
      content?: AnthropicContentBlock[];
    };

    const contentBlocks = data.content ?? [];
    const toolUseBlocks = contentBlocks.filter(
      (b): b is AnthropicContentBlock & { id: string; name: string } =>
        b.type === "tool_use" && Boolean(b.id && b.name)
    );

    if (
      toolUseBlocks.length > 0 &&
      allowToolsThisRound &&
      options.toolHandlers
    ) {
      messages.push({
        role: "assistant",
        content: contentBlocks
      });

      const toolResultBlocks: AnthropicContentBlock[] = [];
      for (const block of toolUseBlocks) {
        const handler = options.toolHandlers[block.name];
        let resultPayload: unknown;
        if (!handler) {
          resultPayload = { error: `Unknown tool '${block.name}'.` };
        } else {
          try {
            const output = await handler(block.input ?? {});
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

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(resultPayload)
        });
      }

      messages.push({
        role: "user",
        content: toolResultBlocks
      });
      continue;
    }

    const text = contentBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new LLMError(
        `Anthropic API returned empty content for model '${model}'.`,
        { provider: "anthropic" }
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
    `Anthropic API exceeded maximum tool rounds (${maxToolRounds}) for model '${model}'.`,
    { provider: "anthropic" }
  );
}
