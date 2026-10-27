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
import { sanitizeSchemaForGemini } from "./schema-utils.js";

export const GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL =
  "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=";

interface GeminiFunctionCallPart {
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
}

interface GeminiContentPart {
  readonly text?: string | undefined;
  readonly thought?: boolean | undefined;
  readonly thoughtSignature?: string | undefined;
  readonly functionCall?: GeminiFunctionCallPart | undefined;
  readonly functionResponse?:
    | {
        readonly name: string;
        readonly response: Readonly<Record<string, unknown>>;
      }
    | undefined;
}

interface GeminiContentTurn {
  readonly role: "user" | "model";
  readonly parts: readonly GeminiContentPart[];
}

export interface GoogleProviderExecutionInput<T = unknown> {
  readonly model: string;
  readonly apiKey: string;
  readonly providerConfig?: ProviderConfig | undefined;
  readonly options: LLMCallOptions<T>;
  readonly executeRequest: (
    url: string,
    init: RequestInit
  ) => Promise<Response>;
}

export interface GoogleProviderExecutionOutput<T = unknown> {
  readonly text: string;
  readonly data?: T | undefined;
}

export function buildGoogleGenerateContentUrl(params: {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
}): string {
  const modelEncoded = encodeURIComponent(params.model.trim());
  const keyEncoded = encodeURIComponent(params.apiKey.trim());
  const rawBase = (
    params.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
  )
    .trim()
    .replace(/\/+$/, "");

  if (rawBase.includes(":generateContent")) {
    const sep = rawBase.includes("?") ? "&" : "?";
    return rawBase.includes("key=")
      ? rawBase
      : `${rawBase}${sep}key=${keyEncoded}`;
  }

  if (rawBase.endsWith("/models")) {
    return `${rawBase}/${modelEncoded}:generateContent?key=${keyEncoded}`;
  }

  if (/\/v1(?:beta)?$/i.test(rawBase)) {
    return `${rawBase}/models/${modelEncoded}:generateContent?key=${keyEncoded}`;
  }

  return `${rawBase}/v1beta/models/${modelEncoded}:generateContent?key=${keyEncoded}`;
}

function extractTextFromParts(parts: readonly GeminiContentPart[]): string {
  const nonThoughtText = parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("");
  return nonThoughtText.trim()
    ? nonThoughtText
    : parts.map((p) => p.text ?? "").join("");
}

function attachThoughtSignaturesToModelParts(
  parts: readonly GeminiContentPart[]
): GeminiContentPart[] {
  return parts.map((part) => {
    if (part.functionCall && !part.thoughtSignature) {
      return {
        ...part,
        thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL
      };
    }
    return part;
  });
}

export async function executeGoogleProvider<T = unknown>(
  input: GoogleProviderExecutionInput<T>
): Promise<GoogleProviderExecutionOutput<T>> {
  const { model, apiKey, providerConfig, options, executeRequest } = input;
  const baseUrl = providerConfig?.baseUrl ?? providerConfig?.base_url;
  const defaultHeaders =
    providerConfig?.defaultHeaders ?? providerConfig?.default_headers ?? {};

  const url = buildGoogleGenerateContentUrl({
    model,
    apiKey,
    baseUrl
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...defaultHeaders
  };

  const hasTools = Boolean(options.tools && options.tools.length > 0);
  const maxToolRounds = options.maxToolRounds ?? 20;
  const effectiveSystemInstruction = buildProtectedSystemInstruction(
    options.systemInstruction
  );

  const effectiveThinkingLevel =
    options.thinkingLevel ?? (/^gemini-3/i.test(model) ? "HIGH" : undefined);

  const buildBaseGenerationConfig = (): Record<string, unknown> => {
    const gen: Record<string, unknown> = {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: 65536
    };
    if (effectiveThinkingLevel && /^gemini-3/i.test(model)) {
      gen.thinkingConfig = {
        thinkingLevel: effectiveThinkingLevel
      };
    }
    return gen;
  };

  const sendGenerateContent = async (
    body: Record<string, unknown>
  ): Promise<readonly GeminiContentPart[]> => {
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
        provider: "google",
        model,
        retryAfterHeader: response.headers.get("retry-after")
      });
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: GeminiContentPart[];
        };
      }>;
    };

    return data.candidates?.[0]?.content?.parts ?? [];
  };

  const contents: GeminiContentTurn[] = [
    {
      role: "user",
      parts: [{ text: options.userPrompt }]
    }
  ];

  // Case 1: No tools provided -> single-turn request (with direct responseSchema if provided)
  if (!hasTools) {
    const generationConfig = buildBaseGenerationConfig();
    if (options.responseSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = sanitizeSchemaForGemini(
        options.responseSchema.schema
      );
    } else if (options.responseMimeType) {
      generationConfig.responseMimeType = options.responseMimeType;
    }

    const parts = await sendGenerateContent({
      systemInstruction: {
        parts: [{ text: effectiveSystemInstruction }]
      },
      contents,
      generationConfig
    });

    const text = extractTextFromParts(parts).trim();
    if (!text) {
      throw new LLMError(
        `Gemini API returned empty content for model '${model}'.`,
        { provider: "google" }
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

  // Case 2: Tools provided -> Phase 1 tool-calling loop without responseMimeType: "application/json"
  for (let round = 0; round < maxToolRounds; round += 1) {
    const generationConfig = buildBaseGenerationConfig();
    if (
      options.responseMimeType &&
      options.responseMimeType !== "application/json"
    ) {
      generationConfig.responseMimeType = options.responseMimeType;
    }

    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: effectiveSystemInstruction }]
      },
      contents,
      generationConfig,
      tools: [
        {
          functionDeclarations: options.tools
        }
      ]
    };

    const parts = await sendGenerateContent(body);
    const functionCalls = parts
      .map((p) => p.functionCall)
      .filter((fc): fc is GeminiFunctionCallPart => Boolean(fc && fc.name));

    if (functionCalls.length > 0 && options.toolHandlers) {
      contents.push({
        role: "model",
        parts: attachThoughtSignaturesToModelParts(parts)
      });

      const responseParts: GeminiContentPart[] = [];
      for (const call of functionCalls) {
        if (options.logLabel || process.env.GITHUB_ACTIONS === "true") {
          const prefix = options.logLabel
            ? `[EPURE][${options.logLabel}]`
            : "[EPURE][Tool]";
          process.stdout.write(
            `${prefix} tool_call ${call.name}(${JSON.stringify(call.args ?? {})})\n`
          );
        }
        const handler = options.toolHandlers[call.name];
        let resultPayload: Record<string, unknown>;
        if (!handler) {
          resultPayload = {
            error: `Unknown tool '${call.name}'.`
          };
        } else {
          try {
            const output = await handler(call.args ?? {});
            resultPayload =
              output && typeof output === "object" && !Array.isArray(output)
                ? (output as Record<string, unknown>)
                : { result: output };
          } catch (err) {
            resultPayload = {
              error: err instanceof Error ? err.message : String(err)
            };
          }
        }
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: resultPayload
          }
        });
      }

      contents.push({
        role: "user",
        parts: responseParts
      });
      continue;
    }

    const text = extractTextFromParts(parts).trim();

    if (options.responseSchema) {
      if (text) {
        try {
          const validated = parseAndValidateStructuredOutput(
            text,
            options.responseSchema
          );
          return { text, data: validated };
        } catch {
          // Fall through to Phase 2 structured-output finalization
        }
      }
      if (parts.length > 0) {
        contents.push({
          role: "model",
          parts: attachThoughtSignaturesToModelParts(parts)
        });
      }
      break;
    }

    if (!text) {
      if (round + 1 < maxToolRounds) {
        if (parts.length > 0) {
          contents.push({
            role: "model",
            parts: attachThoughtSignaturesToModelParts(parts)
          });
        }
        contents.push({
          role: "user",
          parts: [
            {
              text: "Your previous response was empty. Output ONLY the final valid JSON object matching the required schema (or call a tool if needed)."
            }
          ]
        });
        continue;
      }
      break;
    }

    return { text };
  }

  // Phase 2: Finalization turn when responseSchema is set or maxToolRounds reached
  if (options.responseSchema) {
    const finalGenerationConfig = buildBaseGenerationConfig();
    finalGenerationConfig.responseMimeType = "application/json";
    finalGenerationConfig.responseSchema = sanitizeSchemaForGemini(
      options.responseSchema.schema
    );

    const finalContents: GeminiContentTurn[] = [
      ...contents,
      {
        role: "user",
        parts: [
          {
            text: "Produce the final JSON response strictly matching the required schema."
          }
        ]
      }
    ];

    const finalParts = await sendGenerateContent({
      systemInstruction: {
        parts: [{ text: effectiveSystemInstruction }]
      },
      contents: finalContents,
      toolConfig: {
        functionCallingConfig: {
          mode: "NONE"
        }
      },
      generationConfig: finalGenerationConfig
    });

    const finalText = extractTextFromParts(finalParts).trim();
    const validated = parseAndValidateStructuredOutput(
      finalText,
      options.responseSchema
    );
    return { text: finalText, data: validated };
  }

  // Non-schema finalization when tool budget was reached while still calling tools
  const fallbackContents: GeminiContentTurn[] = [
    ...contents,
    {
      role: "user",
      parts: [
        {
          text: "Tool budget reached. Do not call any more tools. Output ONLY the final valid JSON object matching the required schema."
        }
      ]
    }
  ];

  const fallbackParts = await sendGenerateContent({
    systemInstruction: {
      parts: [{ text: effectiveSystemInstruction }]
    },
    contents: fallbackContents,
    tools: [
      {
        functionDeclarations: options.tools
      }
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: "NONE"
      }
    },
    generationConfig: buildBaseGenerationConfig()
  });

  const fallbackText = extractTextFromParts(fallbackParts).trim();
  if (!fallbackText) {
    throw new LLMError(
      `Gemini API returned empty content for model '${model}'.`,
      { provider: "google" }
    );
  }
  return { text: fallbackText };
}
