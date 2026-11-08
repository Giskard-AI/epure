import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderUpstream, type ProviderKind } from "../src/llm/index.js";
import { meterRequest, meterResponse } from "../src/sandbox/llm-proxy-usage.js";
import { createLlmSandboxProxy, runInUntrustedCodeSandbox } from "../src/sandbox/llm-sandbox.js";
import { runWithTokenUsageLedger, TokenUsageLedger, type LLMRequestUsage } from "../src/usage/token-usage.js";
import { startFakeLlmUpstream, type FakeLlmUpstream } from "./fixtures/fake-llm-upstream.js";

const REAL_KEY = "sk-real-RunnerHeldKey1234567890ABCDEF";

const sse = (...events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const usage = (
  provider: ProviderKind,
  model: string,
  input: number,
  cached: number,
  output: number,
  thinking: number
): LLMRequestUsage => ({
  provider,
  model,
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  thinking_tokens: thinking
});

const ANTHROPIC_STREAM = sse(
  { type: "message_start", message: { model: "claude-x", usage: { input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 1 } } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "héllo" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42, output_tokens_details: { thinking_tokens: 30 } } },
  { type: "message_stop" }
);
const OPENAI_CHAT_STREAM = `${sse(
  { choices: [{ delta: { content: "hi" } }], usage: null },
  { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 4 } } }
)}data: [DONE]\n\n`;
const OPENAI_RESPONSES_STREAM = sse(
  { type: "response.created", response: { usage: null } },
  { type: "response.output_text.delta", delta: "hi" },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 70, input_tokens_details: { cached_tokens: 20 }, output_tokens: 15, output_tokens_details: { reasoning_tokens: 5 } } }
  }
);
const GEMINI_CHUNKS = [
  { candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { promptTokenCount: 30 } },
  { candidates: [{ content: { parts: [{ text: "b" }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, thoughtsTokenCount: 6 } }
];

describe("meterRequest", () => {
  it.each([
    {
      id: "openai-chat-stream-gets-include-usage",
      provider: "openai",
      path: "/chat/completions",
      body: { model: "gpt-x", stream: true, stream_options: { other: 1 } },
      expectedBody: { model: "gpt-x", stream: true, stream_options: { other: 1, include_usage: true } },
      expectedModel: "gpt-x"
    },
    {
      id: "azure-deployment-stream-gets-include-usage-and-takes-the-deployment-as-model",
      provider: "azure",
      path: "/openai/deployments/gpt-prod/chat/completions",
      body: { stream: true },
      expectedBody: { stream: true, stream_options: { include_usage: true } },
      expectedModel: "gpt-prod"
    },
    {
      id: "openai-chat-without-stream-is-forwarded-unchanged",
      provider: "openai",
      path: "/chat/completions",
      body: { model: "gpt-x" },
      expectedBody: { model: "gpt-x" },
      expectedModel: "gpt-x"
    },
    {
      id: "openai-responses-stream-reports-usage-without-asking",
      provider: "openai",
      path: "/responses",
      body: { model: "gpt-x", stream: true },
      expectedBody: { model: "gpt-x", stream: true },
      expectedModel: "gpt-x"
    },
    {
      id: "anthropic-stream-is-forwarded-unchanged",
      provider: "anthropic",
      path: "/v1/messages",
      body: { model: "claude-x", stream: true },
      expectedBody: { model: "claude-x", stream: true },
      expectedModel: "claude-x"
    },
    {
      id: "gemini-takes-the-model-from-the-path",
      provider: "google",
      path: "/v1beta/models/gemini-3-flash:streamGenerateContent",
      body: { contents: [] },
      expectedBody: { contents: [] },
      expectedModel: "gemini-3-flash"
    }
  ] as const)("$id", ({ provider, path, body, expectedBody, expectedModel }) => {
    const metered = meterRequest(provider, path, Buffer.from(JSON.stringify(body)), undefined);

    expect(JSON.parse(metered.body.toString("utf8"))).toEqual(expectedBody);
    expect(metered.model).toBe(expectedModel);
  });

  it.each([
    { id: "compressed-body-is-not-read", body: Buffer.from('{"model":"gpt-x","stream":true}'), encoding: "gzip" },
    { id: "non-json-body", body: Buffer.from("not json"), encoding: undefined }
  ])("$id: forwards the bytes as received, model unknown", ({ body, encoding }) => {
    const metered = meterRequest("openai", "/chat/completions", body, encoding);

    expect(metered.body).toBe(body);
    expect(metered.model).toBe("unknown");
  });
});

describe("meterResponse", () => {
  it.each([
    {
      id: "anthropic-message-start-then-message-delta",
      provider: "anthropic",
      contentType: "text/event-stream",
      body: ANTHROPIC_STREAM,
      expected: usage("anthropic", "m", 500, 400, 42, 30)
    },
    {
      id: "openai-chat-final-usage-chunk",
      provider: "openai",
      contentType: "text/event-stream",
      body: OPENAI_CHAT_STREAM,
      expected: usage("openai", "m", 50, 10, 9, 4)
    },
    {
      id: "openai-responses-completed-event",
      provider: "openai",
      contentType: "text/event-stream; charset=utf-8",
      body: OPENAI_RESPONSES_STREAM,
      expected: usage("openai", "m", 70, 20, 15, 5)
    },
    {
      id: "gemini-sse-last-usage-metadata",
      provider: "google",
      contentType: "text/event-stream",
      body: sse(...GEMINI_CHUNKS),
      expected: usage("google", "m", 30, 0, 14, 6)
    },
    {
      id: "gemini-json-array-without-alt-sse",
      provider: "google",
      contentType: "application/json",
      body: JSON.stringify(GEMINI_CHUNKS),
      expected: usage("google", "m", 30, 0, 14, 6)
    },
    {
      id: "anthropic-plain-json-response",
      provider: "anthropic",
      contentType: "application/json",
      body: JSON.stringify({ type: "message", usage: { input_tokens: 7, output_tokens: 3 } }),
      expected: usage("anthropic", "m", 7, 0, 3, 0)
    },
    {
      id: "stream-without-usage-is-unavailable-not-zero",
      provider: "openai",
      contentType: "text/event-stream",
      body: sse({ choices: [{ delta: { content: "hi" } }] }),
      expected: { provider: "openai", model: "m", unavailable: true }
    },
    {
      id: "unknown-content-type-is-unavailable",
      provider: "openai",
      contentType: "application/octet-stream",
      body: "x".repeat(64),
      expected: { provider: "openai", model: "m", unavailable: true }
    }
  ] as const)("$id, split into 7-byte chunks", ({ provider, contentType, body, expected }) => {
    const meter = meterResponse(provider, "m", contentType, undefined);
    const bytes = Buffer.from(body);
    for (let i = 0; i < bytes.length; i += 7) {
      meter.onChunk(bytes.subarray(i, i + 7));
    }

    expect(meter.onEnd()).toEqual(expected);
  });

  it("gzip stream is decoded before it is read", () => {
    const meter = meterResponse("anthropic", "m", "text/event-stream", "gzip");
    const compressed = gzipSync(ANTHROPIC_STREAM);
    meter.onChunk(compressed.subarray(0, 10));
    meter.onChunk(compressed.subarray(10));

    expect(meter.onEnd()).toEqual(usage("anthropic", "m", 500, 400, 42, 30));
  });
});

const openUpstreams: FakeLlmUpstream[] = [];

beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("CI", "");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(openUpstreams.splice(0).map((u) => u.close()));
});

describe("createLlmSandboxProxy usage", () => {
  it.each([
    {
      id: "openai-stream-is-asked-for-usage-and-counted-under-the-requested-model",
      provider: "openai",
      path: "/chat/completions",
      header: "authorization",
      requestBody: { model: "gpt-x", stream: true },
      status: 200,
      responseBody: OPENAI_CHAT_STREAM,
      expectedForwarded: { model: "gpt-x", stream: true, stream_options: { include_usage: true } },
      expectedUsage: {
        "openai/gpt-x": { requests: 1, input_tokens: 50, cached_input_tokens: 10, output_tokens: 9, thinking_tokens: 4 }
      }
    },
    {
      id: "anthropic-stream-is-counted",
      provider: "anthropic",
      path: "/v1/messages",
      header: "x-api-key",
      requestBody: { model: "claude-x", stream: true },
      status: 200,
      responseBody: ANTHROPIC_STREAM,
      expectedForwarded: { model: "claude-x", stream: true },
      expectedUsage: {
        "anthropic/claude-x": { requests: 1, input_tokens: 500, cached_input_tokens: 400, output_tokens: 42, thinking_tokens: 30 }
      }
    },
    {
      id: "error-response-is-not-counted",
      provider: "anthropic",
      path: "/v1/messages",
      header: "x-api-key",
      requestBody: { model: "claude-x" },
      status: 429,
      responseBody: '{"error":"rate limited"}',
      expectedForwarded: { model: "claude-x" },
      expectedUsage: {}
    }
  ] as const)(
    "$id",
    async ({ provider, path, header, requestBody, status, responseBody, expectedForwarded, expectedUsage }) => {
      const upstream = await startFakeLlmUpstream((_req, res) => {
        res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
        res.end(responseBody);
      });
      openUpstreams.push(upstream);
      const ledger = new TokenUsageLedger();
      const proxy = await runWithTokenUsageLedger(ledger, { phase: "implementation", ticket: 5 }, () =>
        createLlmSandboxProxy({
          upstream: resolveProviderUpstream(provider, { base_url: upstream.url }),
          apiKey: REAL_KEY
        })
      );

      try {
        const res = await fetch(`${proxy.proxyUrl}${path}`, {
          method: "POST",
          headers: { [header]: proxy.proxyNonce, "content-type": "application/json" },
          body: JSON.stringify(requestBody)
        });

        expect(await res.text()).toBe(responseBody);
        expect(JSON.parse(upstream.requests[0]!.body)).toEqual(expectedForwarded);
        await vi.waitFor(() =>
          expect(ledger.current()).toEqual(
            Object.keys(expectedUsage).length > 0 ? { "5": { implementation: expectedUsage } } : {}
          )
        );
      } finally {
        await proxy.close();
      }
    }
  );
});

describe("runInUntrustedCodeSandbox usage", () => {
  it.each([
    {
      id: "two-agent-requests-are-summed-in-the-callers-ledger",
      requests: 2,
      expected: {
        "anthropic/claude-x": { requests: 2, input_tokens: 1000, cached_input_tokens: 800, output_tokens: 84, thinking_tokens: 60 }
      }
    },
    { id: "agent-without-llm-requests-reports-no-usage", requests: 0, expected: {} }
  ])("$id", async ({ requests, expected }) => {
    const ledger = new TokenUsageLedger();
    const upstream = await startFakeLlmUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(ANTHROPIC_STREAM);
    });
    openUpstreams.push(upstream);
    const script = [
      "for (let i = 0; i < Number(process.argv[1]); i++) {",
      "  const res = await fetch(process.env.EPURE_LLM_PROXY_URL + '/v1/messages', {",
      "    method: 'POST',",
      "    headers: { 'x-api-key': process.env.EPURE_LLM_PROXY_NONCE },",
      "    body: JSON.stringify({ model: 'claude-x', stream: true })",
      "  });",
      "  await res.text();",
      "}"
    ].join("\n");

    const result = await runWithTokenUsageLedger(ledger, { phase: "implementation", ticket: 5 }, () =>
      runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", ANTHROPIC_API_KEY: REAL_KEY },
        command: process.execPath,
        args: ["--input-type=module", "-e", script, String(requests)],
        llm: { model: "anthropic/claude-configured", providers: { anthropic: { provider: "anthropic", base_url: upstream.url } } }
      })
    );

    expect(result.error_code).toBe("NONE");
    expect(ledger.current()).toEqual(requests > 0 ? { "5": { implementation: expected } } : {});
  });
});
