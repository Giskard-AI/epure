import { PROMPT_INJECTION_IMMUNITY_CLAUSE } from "../security/prompt-injection-guard.js";

export interface GeminiToolParameterSchema {
  readonly type: "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "OBJECT" | "ARRAY";
  readonly description?: string | undefined;
  readonly properties?: Readonly<Record<string, GeminiToolParameterSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
}

export interface GeminiFunctionDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters?: GeminiToolParameterSchema | undefined;
}

export type GeminiToolHandler = (
  args: Readonly<Record<string, unknown>>
) => Promise<unknown> | unknown;

export interface GeminiGenerateOptions {
  readonly apiKey: string;
  readonly model?: string | undefined;
  readonly systemInstruction?: string | undefined;
  readonly prompt: string;
  readonly responseMimeType?: "text/plain" | "application/json" | undefined;
  readonly temperature?: number | undefined;
  readonly tools?: readonly GeminiFunctionDeclaration[] | undefined;
  readonly toolHandlers?: Readonly<Record<string, GeminiToolHandler>> | undefined;
  readonly maxToolRounds?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

interface GeminiFunctionCallPart {
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
}

interface GeminiContentPart {
  readonly text?: string | undefined;
  readonly functionCall?: GeminiFunctionCallPart | undefined;
  readonly functionResponse?: {
    readonly name: string;
    readonly response: Readonly<Record<string, unknown>>;
  } | undefined;
}

interface GeminiContentTurn {
  readonly role: "user" | "model";
  readonly parts: readonly GeminiContentPart[];
}

export async function callGeminiGenerateContent(
  options: GeminiGenerateOptions
): Promise<string> {
  const model = (options.model ?? "gemini-3.8-flash").trim();
  const fetchFn = options.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(options.apiKey.trim())}`;

  const hasTools = Boolean(options.tools && options.tools.length > 0);
  const maxToolRounds = options.maxToolRounds ?? 6;

  const effectiveSystemInstruction = options.systemInstruction
    ? options.systemInstruction.includes("PROMPT_INJECTION_IMMUNITY") ||
      options.systemInstruction.includes("<untrusted_")
      ? options.systemInstruction
      : `${options.systemInstruction.trim()}\n\n${PROMPT_INJECTION_IMMUNITY_CLAUSE}`
    : PROMPT_INJECTION_IMMUNITY_CLAUSE;

  const contents: GeminiContentTurn[] = [
    {
      role: "user",
      parts: [{ text: options.prompt }]
    }
  ];

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const allowToolsThisRound = hasTools && round < maxToolRounds;
    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.2
    };
    // Gemini v1beta does not allow responseMimeType: "application/json" simultaneously with functionDeclarations
    if (options.responseMimeType && !allowToolsThisRound) {
      generationConfig.responseMimeType = options.responseMimeType;
    }

    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: effectiveSystemInstruction }]
      },
      contents,
      generationConfig
    };

    if (allowToolsThisRound && options.tools) {
      body.tools = [
        {
          functionDeclarations: options.tools
        }
      ];
    }

    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Gemini API call failed (${model}, HTTP ${response.status}): ${errText}`
      );
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: GeminiContentPart[];
        };
      }>;
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const functionCalls = parts
      .map((p) => p.functionCall)
      .filter((fc): fc is GeminiFunctionCallPart => Boolean(fc && fc.name));

    if (
      functionCalls.length > 0 &&
      allowToolsThisRound &&
      options.toolHandlers
    ) {
      contents.push({
        role: "model",
        parts
      });

      const responseParts: GeminiContentPart[] = [];
      for (const call of functionCalls) {
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

    const text = parts.map((p) => p.text ?? "").join("");
    if (!text.trim()) {
      throw new Error(`Gemini API returned empty content for model '${model}'.`);
    }

    return text.trim();
  }

  throw new Error(
    `Gemini API exceeded maximum tool rounds (${maxToolRounds}) for model '${model}'.`
  );
}

function sanitizeJsonBackslashes(candidate: string): string {
  // Replace invalid JSON escape sequences (where \ is not followed by ", \, /, b, f, n, r, t, or uXXXX)
  return candidate.replace(
    /\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g,
    "\\\\"
  );
}

export function extractJsonObject<T>(rawText: string): T {
  const tryParse = (str: string): T => {
    try {
      return JSON.parse(str) as T;
    } catch {
      return JSON.parse(sanitizeJsonBackslashes(str)) as T;
    }
  };

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(rawText);
  if (fenceMatch && fenceMatch[1]) {
    return tryParse(fenceMatch[1].trim());
  }
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParse(rawText.slice(firstBrace, lastBrace + 1));
  }
  return tryParse(rawText.trim());
}
