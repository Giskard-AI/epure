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
  readonly thinkingLevel?: "LOW" | "MEDIUM" | "HIGH" | undefined;
  readonly logLabel?: string | undefined;
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
  readonly thought?: boolean | undefined;
  readonly thoughtSignature?: string | undefined;
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
  const maxToolRounds = options.maxToolRounds ?? 20;

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

  async function fetchWithRetry(
    reqUrl: string,
    reqInit: RequestInit,
    maxRetries = 3
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const res = await fetchFn(reqUrl, reqInit);
        if (res.status >= 500 && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  const effectiveThinkingLevel =
    options.thinkingLevel ??
    (/^gemini-3/i.test(model) ? "HIGH" : undefined);

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const allowToolsThisRound = hasTools && round < maxToolRounds;
    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: 65536
    };
    if (effectiveThinkingLevel && /^gemini-3/i.test(model)) {
      generationConfig.thinkingConfig = {
        thinkingLevel: effectiveThinkingLevel
      };
    }
    // Gemini v1beta does not allow responseMimeType: "application/json" simultaneously with functionDeclarations
    if (options.responseMimeType && !hasTools) {
      generationConfig.responseMimeType = options.responseMimeType;
    }

    const requestContents =
      hasTools && !allowToolsThisRound
        ? [
            ...contents,
            {
              role: "user" as const,
              parts: [
                {
                  text: "Tool budget reached. Do not call any more tools. Output ONLY the final valid JSON object matching the required schema."
                }
              ]
            }
          ]
        : contents;

    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: effectiveSystemInstruction }]
      },
      contents: requestContents,
      generationConfig
    };

    if (hasTools && options.tools) {
      body.tools = [
        {
          functionDeclarations: options.tools
        }
      ];
      if (!allowToolsThisRound) {
        body.toolConfig = {
          functionCallingConfig: {
            mode: "NONE"
          }
        };
      }
    }

    const response = await fetchWithRetry(url, {
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
        if (options.logLabel || process.env.GITHUB_ACTIONS === "true") {
          const prefix = options.logLabel ? `[EPURE][${options.logLabel}]` : "[EPURE][Tool]";
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

    const nonThoughtText = parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    const text = nonThoughtText.trim()
      ? nonThoughtText
      : parts.map((p) => p.text ?? "").join("");
    if (!text.trim()) {
      throw new Error(`Gemini API returned empty content for model '${model}'.`);
    }

    return text.trim();
  }

  throw new Error(
    `Gemini API exceeded maximum tool rounds (${maxToolRounds}) for model '${model}'.`
  );
}

function sanitizeJsonStringLiterals(candidate: string): string {
  // Walk the JSON candidate character-by-character so we only repair invalid
  // escape sequences and unescaped control characters inside JSON string literals,
  // while preserving valid escape pairs like `\\s` or `\"`.
  let out = "";
  let inString = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i]!;
    if (!inString) {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }

    if (ch === "\\") {
      const next = candidate[i + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      if (
        next === '"' ||
        next === "\\" ||
        next === "/" ||
        next === "b" ||
        next === "f" ||
        next === "n" ||
        next === "r" ||
        next === "t"
      ) {
        out += ch + next;
        i += 1;
        continue;
      }
      if (
        next === "u" &&
        /^[0-9a-fA-F]{4}$/.test(candidate.slice(i + 2, i + 6))
      ) {
        out += candidate.slice(i, i + 6);
        i += 5;
        continue;
      }
      // Invalid escape sequence (e.g. \' or \s or \d): double the backslash
      out += "\\\\";
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      }
      continue;
    }

    out += ch;
  }
  return out;
}

export function extractJsonObject<T>(rawText: string): T {
  const tryParse = (str: string): T => {
    try {
      return JSON.parse(str) as T;
    } catch {
      return JSON.parse(sanitizeJsonStringLiterals(str)) as T;
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
