import {
  classifyHttpError,
  LLMError,
  parseAndValidateStructuredOutput,
  StructuredOutputValidationError
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
  readonly onStructuredValidationRetry?:
    | ((retryIndex?: number) => Promise<void> | void)
    | undefined;
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

// Opus 4.7+ and Claude 5.x+ reject temperature/top_p/top_k with HTTP 400; unknown IDs omit them since every model accepts omission.
const SAMPLING_PARAMS_MODEL_PATTERN =
  /^claude-(?:3-|(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:-\d{8})?$)/;

function throwIfRefused(stopReason: string | undefined, model: string): void {
  if (stopReason === "refusal") {
    throw new LLMError(
      `Anthropic model '${model}' refused the request (stop_reason: refusal).`,
      { provider: "anthropic", reasonCode: "REFUSAL" }
    );
  }
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
  const effort = providerConfig?.effort;
  const acceptsSamplingParams = SAMPLING_PARAMS_MODEL_PATTERN.test(
    model.trim().toLowerCase()
  );

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
      max_tokens: options.maxOutputTokens ?? 64000,
      ...(acceptsSamplingParams
        ? { temperature: options.temperature ?? 0.2 }
        : {}),
      system: effectiveSystemInstruction,
      messages
    };

    if (anthropicTools) {
      if (allowToolsThisRound) {
        body.tools = anthropicTools;
      } else if (round > 0) {
        body.tools = anthropicTools;
        body.tool_choice = { type: "none" };
      }
    }

    if (options.responseSchema || effort) {
      body.output_config = {
        ...(effort ? { effort } : {}),
        ...(options.responseSchema
          ? {
              format: {
                type: "json_schema",
                schema: closeObjectSchemasForOpenAI(
                  options.responseSchema.schema
                )
              }
            }
          : {})
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
      stop_reason?: string;
    };

    throwIfRefused(data.stop_reason, model);

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
      let currentText = text;
      const maxValidationRetries = input.onStructuredValidationRetry ? 2 : 0;
      for (let valRetry = 0; ; valRetry += 1) {
        try {
          const validated = parseAndValidateStructuredOutput(
            currentText,
            options.responseSchema
          );
          return { text: currentText, data: validated };
        } catch (err) {
          if (
            err instanceof StructuredOutputValidationError &&
            input.onStructuredValidationRetry &&
            valRetry < maxValidationRetries
          ) {
            await input.onStructuredValidationRetry(valRetry);
            messages.push(
              {
                role: "assistant",
                content: currentText || "{}"
              },
              {
                role: "user",
                content: `Your previous JSON response failed schema validation: ${err.message}\nOutput ONLY a corrected, complete JSON object strictly matching the required schema.`
              }
            );
            const retryBody: Record<string, unknown> = {
              ...body,
              messages,
              ...(anthropicTools
                ? { tools: anthropicTools, tool_choice: { type: "none" } }
                : {})
            };
            const retryResponse = await executeRequest(url, {
              method: "POST",
              headers,
              body: JSON.stringify(retryBody)
            });
            if (!retryResponse.ok) {
              const errText = await retryResponse.text();
              throw classifyHttpError({
                status: retryResponse.status,
                bodyText: errText,
                provider: "anthropic",
                model,
                retryAfterHeader: retryResponse.headers.get("retry-after")
              });
            }
            const retryData = (await retryResponse.json()) as {
              content?: AnthropicContentBlock[];
              stop_reason?: string;
            };
            throwIfRefused(retryData.stop_reason, model);
            currentText = (retryData.content ?? [])
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
              .trim();
            continue;
          }
          throw err;
        }
      }
    }

    return { text };
  }

  throw new LLMError(
    `Anthropic API exceeded maximum tool rounds (${maxToolRounds}) for model '${model}'.`,
    { provider: "anthropic" }
  );
}
