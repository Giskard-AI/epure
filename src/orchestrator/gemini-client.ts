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
  const model = (options.model ?? "gemini-2.5-flash").trim();
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

  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [{ text: options.prompt }]
      }
    ],
    generationConfig
  };

  if (options.systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: options.systemInstruction }]
    };
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

export function extractJsonObject<T>(rawText: string): T {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(rawText);
  if (fenceMatch && fenceMatch[1]) {
    return JSON.parse(fenceMatch[1].trim()) as T;
  }
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(rawText.slice(firstBrace, lastBrace + 1)) as T;
  }
  return JSON.parse(rawText.trim()) as T;
}
