import { PROMPT_INJECTION_IMMUNITY_CLAUSE } from "../security/prompt-injection-guard.js";

export interface GeminiGenerateOptions {
  readonly apiKey: string;
  readonly model?: string | undefined;
  readonly systemInstruction?: string | undefined;
  readonly prompt: string;
  readonly responseMimeType?: "text/plain" | "application/json" | undefined;
  readonly temperature?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function callGeminiGenerateContent(
  options: GeminiGenerateOptions
): Promise<string> {
  const model = (options.model ?? "gemini-3.8-flash").trim();
  const fetchFn = options.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(options.apiKey.trim())}`;

  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.2
  };
  if (options.responseMimeType) {
    generationConfig.responseMimeType = options.responseMimeType;
  }

  const effectiveSystemInstruction = options.systemInstruction
    ? options.systemInstruction.includes("PROMPT_INJECTION_IMMUNITY") ||
      options.systemInstruction.includes("<untrusted_")
      ? options.systemInstruction
      : `${options.systemInstruction.trim()}\n\n${PROMPT_INJECTION_IMMUNITY_CLAUSE}`
    : PROMPT_INJECTION_IMMUNITY_CLAUSE;

  const body: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: effectiveSystemInstruction }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: options.prompt }]
      }
    ],
    generationConfig
  };

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
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";

  if (!text.trim()) {
    throw new Error(`Gemini API returned empty content for model '${model}'.`);
  }

  return text.trim();
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
