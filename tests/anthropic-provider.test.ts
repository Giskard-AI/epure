import { describe, expect, it } from "vitest";
import { parseAgentsYml } from "../src/bootstrap/setup-repo.js";
import {
  executeAnthropicProvider,
  LLMClient,
  LLMError,
  type ProviderConfig,
  type ResponseSchemaSpec
} from "../src/llm/index.js";

const summarySchema: ResponseSchemaSpec<{ summary: string }> = {
  name: "summary_schema",
  schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"]
  },
  validate: (parsed: unknown) => {
    const obj = parsed as { summary?: unknown };
    if (typeof obj.summary !== "string") {
      throw new Error("summary must be a string");
    }
    return { summary: obj.summary };
  }
};

const textResponse = (text: string): Response =>
  new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200
  });

function recordingExecutor(responses: readonly unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const executeRequest = async (
    _url: string,
    init: RequestInit
  ): Promise<Response> => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const next = responses[bodies.length - 1] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(next), { status: 200 });
  };
  return { bodies, executeRequest };
}

describe("Anthropic provider — current Claude models (sampling params, effort, refusal)", () => {
  it.each([
    { id: "claude-haiku-5-5 omits temperature", model: "claude-haiku-5-5", expected: undefined },
    { id: "claude-opus-5-5 omits temperature", model: "claude-opus-5-5", expected: undefined },
    { id: "claude-sonnet-5-5 omits temperature", model: "claude-sonnet-5-5", expected: undefined },
    { id: "claude-opus-4-7 omits temperature", model: "claude-opus-4-7", expected: undefined },
    { id: "claude-opus-4-8 omits temperature", model: "claude-opus-4-8", expected: undefined },
    { id: "unknown future claude-opus-6 omits temperature", model: "claude-opus-6", expected: undefined },
    { id: "claude-sonnet-4-20250514 keeps temperature", model: "claude-sonnet-4-20250514", expected: 0.1 },
    { id: "claude-haiku-4-5 keeps temperature", model: "claude-haiku-4-5", expected: 0.1 },
    { id: "claude-sonnet-4-5 keeps temperature", model: "claude-sonnet-4-5", expected: 0.1 },
    { id: "dated claude-opus-4-1-20250805 keeps temperature", model: "claude-opus-4-1-20250805", expected: 0.1 },
    { id: "claude-opus-4-6 keeps temperature", model: "claude-opus-4-6", expected: 0.1 },
    { id: "legacy claude-3-7-sonnet keeps temperature", model: "claude-3-7-sonnet", expected: 0.1 }
  ])("$id", async ({ model, expected }) => {
    const { bodies, executeRequest } = recordingExecutor([
      { content: [{ type: "text", text: "ok" }] }
    ]);

    await executeAnthropicProvider({
      model,
      apiKey: "sk-ant-test",
      options: { model, systemInstruction: "Sys", userPrompt: "Hi", temperature: 0.1 },
      executeRequest
    });

    expect(bodies[0]?.temperature).toBe(expected);
  });

  it.each([
    {
      id: "no effort and no schema omits output_config",
      providerConfig: undefined,
      responseSchema: undefined,
      expected: undefined
    },
    {
      id: "effort without schema sends output_config.effort only",
      providerConfig: { effort: "high" } satisfies ProviderConfig,
      responseSchema: undefined,
      expected: { effort: "high" }
    },
    {
      id: "schema without effort sends output_config.format only",
      providerConfig: undefined,
      responseSchema: summarySchema,
      expected: {
        format: {
          type: "json_schema",
          schema: expect.objectContaining({ additionalProperties: false })
        }
      }
    },
    {
      id: "effort with schema merges effort and format in one output_config",
      providerConfig: { effort: "xhigh" } satisfies ProviderConfig,
      responseSchema: summarySchema,
      expected: {
        effort: "xhigh",
        format: {
          type: "json_schema",
          schema: expect.objectContaining({ additionalProperties: false })
        }
      }
    }
  ])("$id", async ({ providerConfig, responseSchema, expected }) => {
    const { bodies, executeRequest } = recordingExecutor([
      { content: [{ type: "text", text: JSON.stringify({ summary: "ok" }) }] }
    ]);

    await executeAnthropicProvider({
      model: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
      providerConfig,
      options: { model: "claude-haiku-5-5", systemInstruction: "Sys", userPrompt: "Hi", responseSchema },
      executeRequest
    });

    expect(bodies[0]?.output_config).toEqual(expected);
  });

  it("structured-output validation retry keeps effort and format and still omits temperature", async () => {
    const { bodies, executeRequest } = recordingExecutor([
      { content: [{ type: "text", text: JSON.stringify({ summary: 42 }) }] },
      { content: [{ type: "text", text: JSON.stringify({ summary: "fixed" }) }] }
    ]);

    const out = await executeAnthropicProvider({
      model: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
      providerConfig: { effort: "high" },
      options: {
        model: "claude-haiku-5-5",
        systemInstruction: "Sys",
        userPrompt: "Hi",
        temperature: 0.1,
        responseSchema: summarySchema
      },
      executeRequest,
      onStructuredValidationRetry: () => {}
    });

    expect(out.data).toEqual({ summary: "fixed" });
    expect(bodies).toHaveLength(2);
    const retryBody = bodies[1]!;
    expect(retryBody.output_config).toEqual(bodies[0]!.output_config);
    expect(retryBody.output_config).toMatchObject({
      effort: "high",
      format: { type: "json_schema" }
    });
    expect(retryBody).not.toHaveProperty("temperature");
    const retryMessages = retryBody.messages as Array<{ role: string }>;
    expect(retryMessages[retryMessages.length - 1]?.role).toBe("user");
  });

  it("tool round passes thinking blocks back unmodified and ends the conversation with a user turn", async () => {
    const thinkingBlock = {
      type: "thinking",
      thinking: "Need README first.",
      signature: "sig_abc"
    };
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_1",
      name: "read_repo_file",
      input: { path: "README.md" }
    };
    const { bodies, executeRequest } = recordingExecutor([
      { content: [thinkingBlock, toolUseBlock], stop_reason: "tool_use" },
      { content: [thinkingBlock, { type: "text", text: "done" }] }
    ]);

    const out = await executeAnthropicProvider({
      model: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
      options: {
        model: "claude-haiku-5-5",
        systemInstruction: "Sys",
        userPrompt: "Read README.md",
        tools: [{ name: "read_repo_file", description: "Reads a file" }],
        toolHandlers: { read_repo_file: () => ({ content: "# Repo" }) }
      },
      executeRequest
    });

    expect(out.text).toBe("done");
    const messages = bodies[1]!.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [thinkingBlock, toolUseBlock]
    });
    expect(messages[messages.length - 1]?.role).toBe("user");
  });

  it.each([
    {
      id: "refusal with empty content raises a REFUSAL LLMError",
      responses: [{ content: [], stop_reason: "refusal" }],
      responseSchema: undefined,
      onStructuredValidationRetry: undefined
    },
    {
      id: "refusal with partial text raises a REFUSAL LLMError",
      responses: [
        { content: [{ type: "text", text: "I can't" }], stop_reason: "refusal" }
      ],
      responseSchema: undefined,
      onStructuredValidationRetry: undefined
    },
    {
      id: "refusal on the structured-output validation retry raises a REFUSAL LLMError",
      responses: [
        { content: [{ type: "text", text: JSON.stringify({ summary: 42 }) }] },
        { content: [], stop_reason: "refusal" }
      ],
      responseSchema: summarySchema,
      onStructuredValidationRetry: () => {}
    }
  ])("$id", async ({ responses, responseSchema, onStructuredValidationRetry }) => {
    const { executeRequest } = recordingExecutor(responses);

    const call = executeAnthropicProvider({
      model: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
      options: {
        model: "claude-haiku-5-5",
        systemInstruction: "Sys",
        userPrompt: "Hi",
        responseSchema
      },
      executeRequest,
      onStructuredValidationRetry
    });

    await expect(call).rejects.toBeInstanceOf(LLMError);
    await expect(call).rejects.toMatchObject({
      reasonCode: "REFUSAL",
      message: expect.stringContaining(
        "Anthropic model 'claude-haiku-5-5' refused the request"
      )
    });
  });

  it.each([
    {
      id: "LLMClient providers map forwards effort to the Anthropic request",
      providers: {
        anthropic: {
          provider: "anthropic",
          api_key: "sk-ant-test",
          effort: "high"
        }
      } satisfies Readonly<Record<string, ProviderConfig>>
    },
    {
      id: ".github/agents.yml providers block forwards effort to the Anthropic request",
      providers: parseAgentsYml(
        [
          "models:",
          "  planning: anthropic/claude-haiku-5-5",
          "providers:",
          "  anthropic:",
          "    provider: anthropic",
          "    api_key: sk-ant-test",
          "    effort: high",
          ""
        ].join("\n")
      ).providers
    }
  ])("$id", async ({ providers }) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return textResponse("ok");
    };

    await new LLMClient(providers).complete({
      model: "anthropic/claude-haiku-5-5",
      systemInstruction: "Sys",
      userPrompt: "Hi",
      fetchImpl
    });

    expect(bodies[0]?.output_config).toEqual({ effort: "high" });
    expect(bodies[0]).not.toHaveProperty("temperature");
  });
});
