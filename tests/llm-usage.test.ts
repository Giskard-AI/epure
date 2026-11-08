import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../src/llm/client.js";
import { extractLLMTokenUsage, LLM_USAGE_LOG_PREFIX } from "../src/llm/usage.js";

describe("extractLLMTokenUsage", () => {
  it.each([
    {
      id: "gemini-output-counts-thinking-and-input-counts-tool-use-prompt",
      provider: "google",
      body: {
        usageMetadata: {
          promptTokenCount: 1000,
          toolUsePromptTokenCount: 50,
          cachedContentTokenCount: 400,
          candidatesTokenCount: 200,
          thoughtsTokenCount: 300
        }
      },
      expected: { input_tokens: 1050, cached_input_tokens: 400, output_tokens: 500, thinking_tokens: 300 }
    },
    {
      id: "anthropic-input-adds-cache-reads-and-cache-writes",
      provider: "anthropic",
      body: {
        usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 70 }
      },
      expected: { input_tokens: 1050, cached_input_tokens: 900, output_tokens: 70, thinking_tokens: 0 }
    },
    {
      id: "openai-chat-completion-reports-cached-and-reasoning-details",
      provider: "openai",
      body: {
        usage: {
          prompt_tokens: 800,
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 600 },
          completion_tokens_details: { reasoning_tokens: 80 }
        }
      },
      expected: { input_tokens: 800, cached_input_tokens: 600, output_tokens: 120, thinking_tokens: 80 }
    },
    {
      id: "missing-fields-count-as-zero",
      provider: "google",
      body: { usageMetadata: { promptTokenCount: 10 } },
      expected: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, thinking_tokens: 0 }
    }
  ])("$id", ({ provider, body, expected }) => {
    expect(extractLLMTokenUsage(provider, "m", body)).toEqual({ provider, model: "m", ...expected });
  });

  it.each([
    { id: "gemini-response-without-usage-metadata", provider: "google", body: { candidates: [] } },
    { id: "openai-response-without-usage", provider: "openai", body: { choices: [] } },
    { id: "non-object-body", provider: "anthropic", body: "text" }
  ])("returns null for $id", ({ provider, body }) => {
    expect(extractLLMTokenUsage(provider, "m", body)).toBeNull();
  });
});

describe("LLMClient usage log line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      id: "response-with-usage-writes-one-line-and-still-returns-the-text",
      body: {
        candidates: [{ content: { parts: [{ text: "hello" }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 4 }
      },
      expectedLines: [
        `${LLM_USAGE_LOG_PREFIX} {"provider":"google","model":"gemini-3.8-flash","input_tokens":12,"cached_input_tokens":0,"output_tokens":7,"thinking_tokens":4}\n`
      ]
    },
    {
      id: "response-without-usage-writes-nothing",
      body: { candidates: [{ content: { parts: [{ text: "hello" }] } }] },
      expectedLines: []
    }
  ])("$id", async ({ body, expectedLines }) => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const result = await new LLMClient().complete({
      model: "google/gemini-3.8-flash",
      apiKey: "test-key",
      systemInstruction: "test",
      userPrompt: "hi",
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 })
    });

    expect(result.text).toBe("hello");
    expect(writes.filter((w) => w.startsWith(LLM_USAGE_LOG_PREFIX))).toEqual(expectedLines);
  });
});
