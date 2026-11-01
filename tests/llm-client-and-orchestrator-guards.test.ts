import { describe, expect, it } from "vitest";
import {
  type AgentsConfig,
  DEFAULT_AGENTS_CONFIG,
  parseAgentsYml,
  serializeAgentsYml
} from "../src/bootstrap/setup-repo.js";
import {
  formatNeedsHumanEscalationComment,
  resolveLlmEscalationReason,
  type NeedsHumanEscalationReason
} from "../src/execution/external-ci-gate.js";
import {
  AuthenticationError,
  BadRequestError,
  classifyHttpError,
  DEFAULT_FALLBACK_LLM_MODEL,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL,
  LLMClient,
  LLMError,
  LLMTimeoutError,
  parseAndValidateStructuredOutput,
  parseRetryAfterSeconds,
  QuotaExhaustedError,
  RateLimitError,
  ServerError,
  StructuredOutputValidationError,
  type ProviderConfig,
  type ResponseSchemaSpec
} from "../src/llm/index.js";
import {
  appendEpureCommandsSpoiler,
  formatEpureCommandsSpoiler
} from "../src/orchestrator/formatting/comments.js";
import {
  buildCompactWorkspaceFilesContext,
  buildRepoExplorationToolsAndHandlers,
  checkIsExistingRepoWorkspace,
  createGitHubRestHelper,
  createStagedTicketImplementationBuffer,
  mergeStagedBufferIntoImplementationPayload,
  orchestrateIssueCommand,
  resolvePhaseModels
} from "../src/orchestrator/issue-orchestrator.js";
import {
  createGeneratedTicketImplementationSchema,
  GENERATED_PLANNING_BUNDLE_SCHEMA,
  GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
  GRILL_ROUND_EVALUATION_SCHEMA
} from "../src/orchestrator/prompts/schemas.js";
import {
  buildReviewerInspectionTools,
  runMultiAgentPrReviewPass
} from "../src/review/multi-agent-pr-review.js";
import { runUserAdvocateDesignGate } from "../src/review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../src/review/squash-commit-generator.js";
import { detectPromptInjectionInPrFiles } from "../src/security/prompt-injection-guard.js";
import {
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas
} from "../src/state/git-ref-state.js";

describe("EPURE v1.2.0 — Unified Multi-Provider LLMClient, Spoilers & Wired Bucket A Guards (ADR-0029)", () => {
  const sampleNestedSchema: ResponseSchemaSpec<{
    summary: string;
    nested: { count: number };
  }> = {
    name: "test_nested_schema",
    description: "Sample nested schema for strict structured output testing",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        nested: {
          type: "object",
          properties: {
            count: { type: "integer" }
          }
        }
      },
      required: ["summary", "nested"]
    },
    validate: (parsed: unknown) => {
      const obj = parsed as { summary: string; nested: { count: number } };
      return {
        summary: String(obj.summary),
        nested: { count: Number(obj.nested.count) }
      };
    }
  };

  describe("1. Multi-provider routing & URL/Header translation", () => {

    it.each([
      {
        scenario:
          "openai/gpt-5.4 routes to OpenAI chat completions with Bearer auth, strict json_schema, and recursive additionalProperties: false",
        model: "openai/gpt-5.4",
        apiKey: "sk-openai-test-key",
        providers: undefined as Record<string, ProviderConfig> | undefined,
        envVars: {} as Record<string, string>,
        mockResponseBody: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "openai-ok",
                  nested: { count: 42 }
                })
              }
            }
          ]
        },
        expectedProvider: "openai",
        expectedUrl: "https://api.openai.com/v1/chat/completions",
        expectedHeaders: {
          Authorization: "Bearer sk-openai-test-key",
          "Content-Type": "application/json"
        },
        assertRequestBody: (body: Record<string, unknown>) => {
          expect(body.model).toBe("gpt-5.4");
          const rf = body.response_format as {
            type: string;
            json_schema: {
              name: string;
              strict: boolean;
              schema: Record<string, unknown>;
            };
          };
          expect(rf.type).toBe("json_schema");
          expect(rf.json_schema.strict).toBe(true);
          expect(rf.json_schema.schema.additionalProperties).toBe(false);
          const nestedProp = (
            rf.json_schema.schema.properties as Record<
              string,
              Record<string, unknown>
            >
          ).nested;
          expect(nestedProp?.additionalProperties).toBe(false);
          expect(nestedProp?.required).toEqual(["count"]);
        }
      },
      {
        scenario:
          "azure/gpt-4o-deploy routes to Azure deployment chat completions with api-version query and api-key header",
        model: "azure/gpt-4o-deploy",
        apiKey: "az-openai-secret",
        providers: {
          azure: {
            provider: "azure",
            base_url: "https://epure-resource.openai.azure.com/",
            api_version: "2024-10-21"
          }
        } as Record<string, ProviderConfig>,
        envVars: {} as Record<string, string>,
        mockResponseBody: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "azure-ok",
                  nested: { count: 7 }
                })
              }
            }
          ]
        },
        expectedProvider: "azure",
        expectedUrl:
          "https://epure-resource.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-10-21",
        expectedHeaders: {
          "api-key": "az-openai-secret",
          "Content-Type": "application/json"
        },
        assertRequestBody: (body: Record<string, unknown>) => {
          expect(body.model).toBe("gpt-4o-deploy");
          const rf = body.response_format as { type: string };
          expect(rf.type).toBe("json_schema");
        }
      },
      {
        scenario:
          "azure_ai/DeepSeek-R1 strips trailing /models suffix and calls /openai/v1/chat/completions",
        model: "azure_ai/DeepSeek-R1",
        apiKey: "foundry-key-123",
        providers: {
          azure_ai: {
            provider: "azure_ai",
            base_url: "https://my-foundry.services.ai.azure.com/models"
          }
        } as Record<string, ProviderConfig>,
        envVars: {} as Record<string, string>,
        mockResponseBody: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "foundry-ok",
                  nested: { count: 99 }
                })
              }
            }
          ]
        },
        expectedProvider: "azure_ai",
        expectedUrl:
          "https://my-foundry.services.ai.azure.com/openai/v1/chat/completions",
        expectedHeaders: {
          "api-key": "foundry-key-123",
          Authorization: "Bearer foundry-key-123",
          "Content-Type": "application/json"
        },
        assertRequestBody: (body: Record<string, unknown>) => {
          expect(body.model).toBe("DeepSeek-R1");
        }
      },
      {
        scenario:
          "anthropic/claude-3-7-sonnet routes to /v1/messages with x-api-key header and output_config.format.type === json_schema",
        model: "anthropic/claude-3-7-sonnet",
        apiKey: "sk-ant-test-key",
        providers: undefined as Record<string, ProviderConfig> | undefined,
        envVars: {} as Record<string, string>,
        mockResponseBody: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "anthropic-ok",
                nested: { count: 3 }
              })
            }
          ]
        },
        expectedProvider: "anthropic",
        expectedUrl: "https://api.anthropic.com/v1/messages",
        expectedHeaders: {
          "x-api-key": "sk-ant-test-key",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        assertRequestBody: (body: Record<string, unknown>) => {
          expect(body.model).toBe("claude-3-7-sonnet");
          const outCfg = body.output_config as {
            format: { type: string; schema: Record<string, unknown> };
          };
          expect(outCfg.format.type).toBe("json_schema");
          expect(outCfg.format.schema.additionalProperties).toBe(false);
        }
      },
      {
        scenario:
          "google/gemini-3.8-flash routes to generativelanguage.googleapis.com with generationConfig.responseSchema",
        model: "google/gemini-3.8-flash",
        apiKey: "AIza-google-key",
        providers: undefined as Record<string, ProviderConfig> | undefined,
        envVars: {} as Record<string, string>,
        mockResponseBody: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "google-ok",
                      nested: { count: 11 }
                    })
                  }
                ]
              }
            }
          ]
        },
        expectedProvider: "google",
        expectedUrl:
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=AIza-google-key",
        expectedHeaders: {
          "Content-Type": "application/json"
        },
        assertRequestBody: (body: Record<string, unknown>) => {
          const genCfg = body.generationConfig as {
            responseMimeType?: string;
            responseSchema?: Record<string, unknown>;
          };
          expect(genCfg.responseMimeType).toBe("application/json");
          expect(genCfg.responseSchema).toBeDefined();
          expect(genCfg.responseSchema?.type).toBe("object");
        }
      },
      {
        scenario:
          "gemini/gemini-3.8-flash alias routes to generativelanguage.googleapis.com with generationConfig.responseSchema",
        model: "gemini/gemini-3.8-flash",
        apiKey: "AIza-gemini-alias-key",
        providers: undefined as Record<string, ProviderConfig> | undefined,
        envVars: {} as Record<string, string>,
        mockResponseBody: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "gemini-alias-ok",
                      nested: { count: 12 }
                    })
                  }
                ]
              }
            }
          ]
        },
        expectedProvider: "google",
        expectedUrl:
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=AIza-gemini-alias-key",
        expectedHeaders: {
          "Content-Type": "application/json"
        },
        assertRequestBody: (body: Record<string, unknown>) => {
          const genCfg = body.generationConfig as {
            responseMimeType?: string;
            responseSchema?: Record<string, unknown>;
          };
          expect(genCfg.responseMimeType).toBe("application/json");
          expect(genCfg.responseSchema).toBeDefined();
        }
      },
      {
        scenario:
          "custom alias in configureFromDict resolves os.environ/CUSTOM_PROVIDER_KEY and os.environ/CUSTOM_BASE_URL dynamically from process.env",
        model: "corp-gateway/gpt-5.4-mini",
        apiKey: undefined as string | undefined,
        providers: {
          "corp-gateway": {
            provider: "openai",
            api_key: "os.environ/CUSTOM_PROVIDER_KEY",
            base_url: "os.environ/CUSTOM_BASE_URL",
            default_headers: { "X-Corp-Trace": "epure-trace-1" }
          }
        } as Record<string, ProviderConfig>,
        envVars: {
          CUSTOM_PROVIDER_KEY: "dyn-env-secret-999",
          CUSTOM_BASE_URL: "https://llm.corp.internal/v1/"
        } as Record<string, string>,
        mockResponseBody: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "custom-alias-ok",
                  nested: { count: 100 }
                })
              }
            }
          ]
        },
        expectedProvider: "openai",
        expectedUrl: "https://llm.corp.internal/v1/chat/completions",
        expectedHeaders: {
          Authorization: "Bearer dyn-env-secret-999",
          "Content-Type": "application/json",
          "X-Corp-Trace": "epure-trace-1"
        },
        assertRequestBody: (body: Record<string, unknown>) => {
          expect(body.model).toBe("gpt-5.4-mini");
        }
      }
    ])(
      "$scenario",
      async ({
        model,
        apiKey,
        providers,
        envVars,
        mockResponseBody,
        expectedProvider,
        expectedUrl,
        expectedHeaders,
        assertRequestBody
      }) => {
        const previousEnv: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(envVars)) {
          previousEnv[k] = process.env[k];
          process.env[k] = v;
        }

        try {
          let capturedUrl = "";
          let capturedHeaders: Record<string, string> = {};
          let capturedBody: Record<string, unknown> = {};

          const mockFetch: typeof fetch = async (input, init) => {
            capturedUrl = String(input);
            capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
            capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
              string,
              unknown
            >;
            return new Response(JSON.stringify(mockResponseBody), {
              status: 200
            });
          };

          const client = new LLMClient();
          if (providers) {
            client.configureFromDict(providers);
          }

          const res = await client.complete({
            model,
            apiKey,
            systemInstruction: "System test prompt",
            userPrompt: "User test prompt",
            responseSchema: sampleNestedSchema,
            fetchImpl: mockFetch
          });

          expect(res.provider).toBe(expectedProvider);
          expect(capturedUrl).toBe(expectedUrl);
          expect(capturedHeaders).toMatchObject(expectedHeaders);
          expect(res.data?.nested.count).toBeTypeOf("number");
          assertRequestBody(capturedBody);
        } finally {
          for (const [k, prev] of Object.entries(previousEnv)) {
            if (prev === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = prev;
            }
          }
        }
      }
    );
  });

  describe("2. Gemini 2-phase Tool Loop + Structured Output (ResponseSchemaSpec)", () => {
    it.each([
      {
        scenario:
          "preserves explicit thoughtSignature on functionCall and finalizes with mode NONE + responseSchema after non-JSON post-tool summary",
        returnedThoughtSignature: "explicit-sig-abc" as string | undefined,
        maxToolRounds: 5,
        postToolModelResponse: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: "I have inspected the repository files and I am ready to answer."
                  }
                ]
              }
            }
          ]
        },
        expectedThoughtSignature: "explicit-sig-abc"
      },
      {
        scenario:
          "injects sentinel thoughtSignature when missing and triggers Phase 2 schema finalization when maxToolRounds is reached",
        returnedThoughtSignature: undefined as string | undefined,
        maxToolRounds: 1,
        postToolModelResponse: {
          candidates: [
            {
              content: {
                parts: [{ text: "unused because maxToolRounds=1 stops after round 0" }]
              }
            }
          ]
        },
        expectedThoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL
      }
    ])(
      "$scenario",
      async ({
        returnedThoughtSignature,
        maxToolRounds,
        postToolModelResponse,
        expectedThoughtSignature
      }) => {
        const recordedRequests: Array<Record<string, unknown>> = [];
        let toolHandlerInvocations = 0;

        const mockFetch: typeof fetch = async (_url, init) => {
          const reqBody = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          recordedRequests.push(reqBody);

          // Call 1: Phase 1 tool call round
          if (recordedRequests.length === 1) {
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "read_repo_file",
                            args: { path: "src/index.ts" }
                          },
                          ...(returnedThoughtSignature
                            ? { thoughtSignature: returnedThoughtSignature }
                            : {})
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200 }
            );
          }

          // If maxToolRounds > 1, Call 2 is the second Phase 1 round returning prose, then Call 3 is Phase 2 finalization
          const isFinalizationCall =
            (
              reqBody.toolConfig as
                | { functionCallingConfig?: { mode?: string } }
                | undefined
            )?.functionCallingConfig?.mode === "NONE";

          if (!isFinalizationCall) {
            return new Response(JSON.stringify(postToolModelResponse), {
              status: 200
            });
          }

          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          frontier_resolved: true,
                          round_number: 2,
                          follow_up_questions_markdown: "",
                          rationale: "Validated via Phase 2 structured output"
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200 }
          );
        };

        const client = new LLMClient();
        const result = await client.completeStructured({
          model: "google/gemini-3.8-flash",
          apiKey: "gemini-test-key",
          systemInstruction: "Evaluate grill round",
          userPrompt: "Check src/index.ts first",
          maxToolRounds,
          tools: [
            {
              name: "read_repo_file",
              description: "Reads a file from the repo",
              parameters: {
                type: "OBJECT",
                properties: {
                  path: { type: "STRING", description: "File path" }
                },
                required: ["path"]
              }
            }
          ],
          toolHandlers: {
            read_repo_file: async (args) => {
              toolHandlerInvocations += 1;
              return { content: `// contents of ${String(args.path)}` };
            }
          },
          responseSchema: GRILL_ROUND_EVALUATION_SCHEMA,
          fetchImpl: mockFetch
        });

        expect(toolHandlerInvocations).toBe(1);
        expect(result).toEqual({
          frontier_resolved: true,
          round_number: 2,
          follow_up_questions_markdown: "",
          settled_decisions_summary_markdown: "",
          rationale: "Validated via Phase 2 structured output"
        });

        // Round 1 must send tools without responseMimeType: "application/json" (avoiding Gemini HTTP 400)
        const round1Req = recordedRequests[0]!;
        expect(round1Req.tools).toBeDefined();
        const round1GenCfg = round1Req.generationConfig as Record<
          string,
          unknown
        >;
        expect(round1GenCfg.responseMimeType).toBeUndefined();
        expect(round1GenCfg.responseSchema).toBeUndefined();

        // Final request must lock toolConfig.functionCallingConfig.mode === "NONE" and enforce responseSchema
        const finalReq = recordedRequests[recordedRequests.length - 1]!;
        expect(finalReq.toolConfig).toEqual({
          functionCallingConfig: { mode: "NONE" }
        });
        const finalGenCfg = finalReq.generationConfig as Record<string, unknown>;
        expect(finalGenCfg.responseMimeType).toBe("application/json");
        expect(finalGenCfg.responseSchema).toBeDefined();

        // Verify thoughtSignature preservation in conversation history
        const finalContents = finalReq.contents as Array<{
          role: string;
          parts: Array<{
            functionCall?: { name: string };
            thoughtSignature?: string;
          }>;
        }>;
        const modelTurnWithToolCall = finalContents.find(
          (turn) =>
            turn.role === "model" &&
            turn.parts.some((p) => Boolean(p.functionCall))
        );
        expect(modelTurnWithToolCall).toBeDefined();
        expect(modelTurnWithToolCall?.parts[0]?.thoughtSignature).toBe(
          expectedThoughtSignature
        );
      }
    );

    it.each([
      {
        id: "openai-retains-tools-with-tool-choice-none-on-final-round-when-maxToolRounds-reached",
        model: "openai/gpt-4.1",
        expectedToolChoice: "none"
      },
      {
        id: "anthropic-retains-tools-with-tool-choice-none-and-64000-max-tokens-on-final-round",
        model: "anthropic/claude-sonnet-4-5",
        expectedToolChoice: { type: "none" }
      }
    ])("$id", async ({ model, expectedToolChoice }) => {
      const recordedBodies: Array<Record<string, unknown>> = [];
      const mockFetch: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        recordedBodies.push(body);

        if (recordedBodies.length === 1) {
          if (model.startsWith("openai/")) {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function",
                          function: {
                            name: "read_repo_file",
                            arguments: JSON.stringify({ path: "README.md" })
                          }
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              content: [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "read_repo_file",
                  input: { path: "README.md" }
                }
              ]
            }),
            { status: 200 }
          );
        }

        const payloadJson = JSON.stringify({
          frontier_resolved: true,
          round_number: 2,
          follow_up_questions_markdown: "",
          rationale: "Resolved on final tool round"
        });
        if (model.startsWith("openai/")) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: payloadJson } }]
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: payloadJson }]
          }),
          { status: 200 }
        );
      };

      const client = new LLMClient();
      const out = await client.completeStructured({
        model,
        apiKey: "test-key",
        systemInstruction: "Evaluate grill round",
        userPrompt: "Read README.md first",
        maxToolRounds: 1,
        tools: [
          {
            name: "read_repo_file",
            description: "Reads a file",
            parameters: {
              type: "OBJECT",
              properties: { path: { type: "STRING" } },
              required: ["path"]
            }
          }
        ],
        toolHandlers: {
          read_repo_file: async () => ({ content: "# Repo" })
        },
        responseSchema: GRILL_ROUND_EVALUATION_SCHEMA,
        fetchImpl: mockFetch
      });

      expect(out.frontier_resolved).toBe(true);
      expect(recordedBodies).toHaveLength(2);
      const finalRoundBody = recordedBodies[1]!;
      expect(finalRoundBody.tools).toBeDefined();
      expect(finalRoundBody.tool_choice).toEqual(expectedToolChoice);
      if (model.startsWith("anthropic/")) {
        expect(finalRoundBody.max_tokens).toBe(64000);
      }
    });
  });

  describe("3. ADR-0012 Resilience (fail-fast vs transient retry)", () => {
    it.each([
      {
        scenario: "HTTP 401 throws AuthenticationError immediately (attempts === 1, no retry)",
        statusSequence: [401],
        expectedErrorClass: AuthenticationError,
        expectedAttempts: 1
      },
      {
        scenario: "HTTP 403 throws AuthenticationError immediately (attempts === 1, no retry)",
        statusSequence: [403],
        expectedErrorClass: AuthenticationError,
        expectedAttempts: 1
      },
      {
        scenario: "HTTP 402 throws QuotaExhaustedError immediately (attempts === 1, no retry)",
        statusSequence: [402],
        expectedErrorClass: QuotaExhaustedError,
        expectedAttempts: 1
      },
      {
        scenario: "HTTP 429 rate-limit retries transient error and succeeds on attempt 2",
        statusSequence: [429, 200],
        expectedErrorClass: null,
        expectedAttempts: 2
      },
      {
        scenario: "HTTP 503 service unavailable retries transient error and succeeds on attempt 3",
        statusSequence: [503, 503, 200],
        expectedErrorClass: null,
        expectedAttempts: 3
      }
    ])(
      "$scenario",
      async ({ statusSequence, expectedErrorClass, expectedAttempts }) => {
        let fetchAttempts = 0;
        const mockFetch: typeof fetch = async () => {
          const status =
            statusSequence[fetchAttempts] ??
            statusSequence[statusSequence.length - 1] ??
            200;
          fetchAttempts += 1;

          if (status !== 200) {
            return new Response(
              JSON.stringify({ error: { message: `HTTP ${status} failure` } }),
              { status }
            );
          }

          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "Recovered response" } }]
            }),
            { status: 200 }
          );
        };

        const client = new LLMClient();
        if (expectedErrorClass) {
          await expect(
            client.complete({
              model: "openai/gpt-5.4",
              apiKey: "sk-test",
              systemInstruction: "Sys",
              userPrompt: "User",
              maxTransientRetries: 2,
              sleepMs: async () => {},
              fetchImpl: mockFetch
            })
          ).rejects.toBeInstanceOf(expectedErrorClass);
          expect(fetchAttempts).toBe(expectedAttempts);
        } else {
          const res = await client.complete({
            model: "openai/gpt-5.4",
            apiKey: "sk-test",
            systemInstruction: "Sys",
            userPrompt: "User",
            maxTransientRetries: 2,
            sleepMs: async () => {},
            fetchImpl: mockFetch
          });
          expect(res.text).toBe("Recovered response");
          expect(res.attempts).toBe(expectedAttempts);
          expect(fetchAttempts).toBe(expectedAttempts);
        }
      }
    );
  });

  describe("4. .github/agents.yml providers: parsing & serialization", () => {
    it.each([
      {
        scenario:
          "round-trips serializeAgentsYml and parseAgentsYml with a providers block containing os.environ/ references",
        providersInput: {
          "azure-prod": {
            provider: "azure" as const,
            api_key: "os.environ/AZURE_OPENAI_API_KEY",
            base_url: "os.environ/AZURE_OPENAI_ENDPOINT",
            api_version: "2024-10-21",
            default_headers: {
              "X-Custom-Department": "epure-core"
            }
          },
          "foundry-ds": {
            provider: "azure_ai" as const,
            api_key: "os.environ/AZURE_AI_API_KEY",
            base_url: "https://my-foundry.services.ai.azure.com/models"
          }
        },
        expectProvidersBlockInYaml: true
      },
      {
        scenario:
          "omitting providers keeps default serializeAgentsYml output unchanged without a providers: section",
        providersInput: undefined,
        expectProvidersBlockInYaml: false
      }
    ])("$scenario", ({ providersInput, expectProvidersBlockInYaml }) => {
      const config = {
        ...DEFAULT_AGENTS_CONFIG,
        ...(providersInput ? { providers: providersInput } : {})
      };

      const yaml = serializeAgentsYml(config, false);
      if (expectProvidersBlockInYaml) {
        expect(yaml).toContain("providers:");
        expect(yaml).toContain("api_key: os.environ/AZURE_OPENAI_API_KEY");
        expect(yaml).toContain("base_url: os.environ/AZURE_OPENAI_ENDPOINT");
      } else {
        expect(yaml).not.toContain("providers:");
      }

      const parsed = parseAgentsYml(yaml);
      if (providersInput) {
        expect(parsed.providers?.["azure-prod"]?.provider).toBe("azure");
        expect(parsed.providers?.["azure-prod"]?.api_key).toBe(
          "os.environ/AZURE_OPENAI_API_KEY"
        );
        expect(parsed.providers?.["azure-prod"]?.apiKey).toBe(
          "os.environ/AZURE_OPENAI_API_KEY"
        );
        expect(parsed.providers?.["azure-prod"]?.base_url).toBe(
          "os.environ/AZURE_OPENAI_ENDPOINT"
        );
        expect(parsed.providers?.["azure-prod"]?.api_version).toBe(
          "2024-10-21"
        );
        expect(parsed.providers?.["azure-prod"]?.default_headers).toEqual({
          "X-Custom-Department": "epure-core"
        });
        expect(parsed.providers?.["foundry-ds"]?.provider).toBe("azure_ai");
        expect(parsed.providers?.["foundry-ds"]?.base_url).toBe(
          "https://my-foundry.services.ai.azure.com/models"
        );
      } else {
        expect(parsed.providers).toBeUndefined();
      }
    });
  });

  describe("5. Contextual /epure command spoilers", () => {
    it.each([
      {
        scenario: "grilling phase spoiler recommends answering directly or posting /epure to-spec",
        phase: "grilling",
        status: "active",
        issueNumber: 42,
        expectedSubstring: "/epure to-spec"
      },
      {
        scenario: "tickets phase spoiler recommends verifying spec and posting /epure approve",
        phase: "tickets",
        status: "awaiting-human",
        issueNumber: 42,
        expectedSubstring: "postez `/epure approve` sur l'issue #42 pour lancer l'implémentation"
      },
      {
        scenario: "implementation phase spoiler recommends /epure status or /epure cancel",
        phase: "implementation",
        status: "active",
        issueNumber: 42,
        expectedSubstring: "Postez `/epure status` sur l'issue #42 pour suivre l'avancement"
      },
      {
        scenario: "suspended phase spoiler recommends inspecting diagnostics and posting /epure approve",
        phase: "suspended",
        status: "suspended",
        issueNumber: 42,
        expectedSubstring: "Inspectez le diagnostic ci-dessus"
      },
      {
        scenario: "cancelled phase spoiler recommends /epure plan or /epure approve to resume",
        phase: "cancelled",
        status: "cancelled",
        issueNumber: 42,
        expectedSubstring: "L'orchestration est suspendue suite à une annulation"
      },
      {
        scenario: "completed phase spoiler recommends Squash & Merge on feature/* -> dev PR",
        phase: "completed",
        status: "completed",
        issueNumber: 42,
        expectedSubstring: "Squash & Merge"
      }
    ])(
      "$scenario",
      ({ phase, status, issueNumber, expectedSubstring }) => {
        const spoiler = formatEpureCommandsSpoiler({
          phase,
          status,
          issueNumber
        });
        expect(spoiler).toContain("<details>");
        expect(spoiler).toContain("Commandes <code>/epure</code> disponibles");
        expect(spoiler).toContain(expectedSubstring);

        const appendedOnce = appendEpureCommandsSpoiler("Header text", {
          phase,
          status,
          issueNumber
        });
        const appendedTwice = appendEpureCommandsSpoiler(appendedOnce, {
          phase,
          status,
          issueNumber
        });
        // Idempotent when already appended
        expect(appendedTwice).toBe(appendedOnce);
      }
    );

    it("includes contextual suspended /epure spoiler in formatNeedsHumanEscalationComment", () => {
      const comment = formatNeedsHumanEscalationComment({
        issueNumber: 18,
        ticketIssueNumber: 19,
        branch: "task/19-auth",
        reason: "remediation_exhausted",
        codeFixAttemptsUsed: 3,
        maxCodeFixAttempts: 3
      });
      expect(comment).toContain("<details>");
      expect(comment).toContain("Commandes <code>/epure</code> disponibles");
      expect(comment).toContain("sur l'issue #18");
    });
  });

  describe("6. Orchestrator Wired Bucket A Guards", () => {
    const BARE_MODELS_AGENTS_CONFIG: AgentsConfig = {
      ...DEFAULT_AGENTS_CONFIG,
      models: {
        planning: "claude-sonnet-4-20250514",
        implementation: "claude-sonnet-4-20250514",
        review: "gpt-4.1"
      }
    };

    it("detects cyclic ticket graph during /epure to-tickets, applies needs-human, posts escalation with spoiler, and creates 0 sub-issues", async () => {
      const store = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        issueNumber: 30,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "active",
          active_branch: "plan/30-cyclic-plan"
        })
      });

      const appliedLabels: string[] = [];
      const createdSubIssues: unknown[] = [];
      const postedComments: string[] = [];

      const mockFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        const method = init?.method ?? "GET";

        if (urlStr.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          plan_slug: "cyclic-plan",
                          glossary_markdown: "# GLOSSARY\n\n- **Term**: Def\n",
                          adrs: [
                            {
                              path: "docs/adr/0001-cycle.md",
                              content: "# ADR 1\n"
                            }
                          ],
                          spec_path: "docs/specs/cyclic-plan.md",
                          spec_markdown: "# Spec\n",
                          tickets: [
                            {
                              index: 0,
                              slug: "ticket-zero",
                              title: "[Ticket 0] Zero",
                              description: "Depends on 1",
                              acceptance_criteria: ["AC0"],
                              blocked_by_indices: [1],
                              files_to_create_or_update: ["src/a.ts"]
                            },
                            {
                              index: 1,
                              slug: "ticket-one",
                              title: "[Ticket 1] One",
                              description: "Depends on 0",
                              acceptance_criteria: ["AC1"],
                              blocked_by_indices: [0],
                              files_to_create_or_update: ["src/b.ts"]
                            }
                          ]
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }

        if (urlStr.endsWith("/issues/30") && method === "GET") {
          return new Response(
            JSON.stringify({
              number: 30,
              title: "[Plan] Cyclic test",
              body: "Plan description",
              state: "open"
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes("/git/ref/heads/")) {
          return new Response(
            JSON.stringify({ object: { sha: "base_sha_30" } }),
            { status: 200 }
          );
        }
        if (urlStr.includes("/issues/30/comments") && method === "GET") {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (urlStr.includes("/issues/30/labels") && method === "POST") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            labels?: string[];
          };
          appliedLabels.push(...(parsed.labels ?? []));
          return new Response(JSON.stringify(appliedLabels), { status: 200 });
        }
        if (urlStr.includes("/issues/30/comments") && method === "POST") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            body: string;
          };
          postedComments.push(parsed.body);
          return new Response(
            JSON.stringify({ html_url: "https://github.com/org/repo/issues/30#1" }),
            { status: 201 }
          );
        }
        if (urlStr.endsWith("/issues") && method === "POST") {
          createdSubIssues.push(init?.body);
          return new Response(
            JSON.stringify({
              number: 31,
              html_url: "https://github.com/org/repo/issues/31"
            }),
            { status: 201 }
          );
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const result = await orchestrateIssueCommand({
        repository: "Giskard-AI/epure",
        issueNumber: 30,
        command: "to-tickets",
        commandArgs: "",
        commentId: 201,
        actor: "Maintainer",
        fallbackGithubToken: "ghs_test",
        llmApiKey: "gemini_key",
        stateStore: store,
        fetchImpl: mockFetch
      });

      expect(result.status).toBe("suspended");
      expect(result.created_ticket_numbers).toHaveLength(0);
      expect(createdSubIssues).toHaveLength(0);
      expect(appliedLabels).toContain("needs-human");
      expect(result.summary_markdown).toContain("TICKET_GRAPH_CYCLE_DETECTED");
      expect(result.summary_markdown).toContain(
        "Commandes <code>/epure</code> disponibles"
      );
      expect(postedComments).toHaveLength(1);
    });

    it.each([
      {
        scenario:
          "unproven blocker ticket closed with state_reason: not_planned during /epure approve triggers reconcileProvenTicketDependencies, escalates to needs-human, and halts before dependent ticket",
        mode: "unproven_blocker" as const,
        expectedStatus: "suspended",
        expectedLabelOnPlan: ["needs-human"],
        expectedSummarySubstring: "UNPROVEN_BLOCKER_CLOSURE"
      },
      {
        scenario:
          "mid-run /epure cancel comment posted by an authorized user during /epure approve is detected before ticket execution, transitions status to cancelled, and skips tickets",
        mode: "mid_run_cancel" as const,
        expectedStatus: "cancelled",
        expectedLabelOnPlan: [] as string[],
        expectedSummarySubstring: "cancelled"
      }
    ])(
      "$scenario",
      async ({
        mode,
        expectedStatus,
        expectedLabelOnPlan,
        expectedSummarySubstring
      }) => {
        const store = createInMemoryGitRefStateStore();
        await updateIssueStateWithCas({
          issueNumber: 50,
          store,
          mutator: (prev) => ({
            ...prev,
            phase: "tickets",
            status: "awaiting_human_approval",
            active_branch: "plan/50-guarded-plan",
            last_processed_comment_id: 500
          })
        });

        const manifestPayload = {
          planBranch: "plan/50-guarded-plan",
          specPath: "docs/specs/guarded-plan.md",
          tickets: [
            {
              ticketIssueNumber: 52,
              slug: "dependent-ticket",
              title: "[Ticket 2] Dependent",
              description: "Depends on #51",
              acceptanceCriteria: ["AC2"],
              blockedByIssueNumbers: [51],
              filesToTouch: ["src/dep.ts"]
            }
          ]
        };

        const planLabels: string[] = [];
        const executedTddPrompts: string[] = [];

        const mockFetch: typeof fetch = async (url, init) => {
          const urlStr = String(url);
          const method = init?.method ?? "GET";

          if (urlStr.includes("generativelanguage.googleapis.com")) {
            const parsedReq = JSON.parse(String(init?.body ?? "{}")) as {
              contents?: Array<{ parts?: Array<{ text?: string }> }>;
            };
            const promptText =
              parsedReq.contents?.[0]?.parts?.[0]?.text ?? "";
            executedTddPrompts.push(promptText);
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            commit_message: "feat: should not run",
                            test_summary: "none",
                            files: []
                          })
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200 }
            );
          }

          if (urlStr.endsWith("/issues/50") && method === "GET") {
            return new Response(
              JSON.stringify({
                number: 50,
                title: "[Plan] Guarded execution",
                body: "Plan body",
                state: "open"
              }),
              { status: 200 }
            );
          }

          if (urlStr.endsWith("/issues/51") && method === "GET") {
            return new Response(
              JSON.stringify({
                number: 51,
                title: "[Ticket 1] Blocker",
                body: "Root ticket",
                state: "closed",
                state_reason:
                  mode === "unproven_blocker" ? "not_planned" : "completed"
              }),
              { status: 200 }
            );
          }

          if (urlStr.endsWith("/issues/52") && method === "GET") {
            return new Response(
              JSON.stringify({
                number: 52,
                title: "[Ticket 2] Dependent",
                body: "Depends on #51",
                state: "open",
                state_reason: null
              }),
              { status: 200 }
            );
          }

          if (urlStr.includes("/issues/50/comments") && method === "GET") {
            const comments = [
              {
                id: 499,
                body: `<!-- epure-plan-manifest:${JSON.stringify(manifestPayload)} -->`,
                user: { login: "epure-agent[bot]", type: "Bot" },
                created_at: "2026-10-26T10:00:00Z"
              },
              ...(mode === "mid_run_cancel"
                ? [
                    {
                      id: 505,
                      body: "/epure cancel",
                      user: { login: "Maintainer", type: "User" },
                      created_at: "2026-10-26T10:02:00Z"
                    }
                  ]
                : [])
            ];
            return new Response(JSON.stringify(comments), { status: 200 });
          }

          if (urlStr.includes("/issues/50/labels") && method === "POST") {
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              labels?: string[];
            };
            planLabels.push(...(parsed.labels ?? []));
            return new Response(JSON.stringify(planLabels), { status: 200 });
          }

          if (urlStr.includes("/git/trees/") && method === "GET") {
            return new Response(
              JSON.stringify({
                tree: [
                  {
                    path: "src/root.ts",
                    type: "blob",
                    sha: "blob_root_sha"
                  }
                ]
              }),
              { status: 200 }
            );
          }

          if (urlStr.endsWith("/git/blobs/blob_root_sha") && method === "GET") {
            return new Response(
              JSON.stringify({
                content: Buffer.from("export const root = 1;\n", "utf8").toString(
                  "base64"
                ),
                encoding: "base64"
              }),
              { status: 200 }
            );
          }

          if (urlStr.includes("/pulls?") && method === "GET") {
            return new Response(JSON.stringify([]), { status: 200 });
          }

          if (urlStr.includes("/git/ref/heads/")) {
            return new Response(
              JSON.stringify({ object: { sha: "base_sha_50" } }),
              { status: 200 }
            );
          }

          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };

        const result = await orchestrateIssueCommand({
          repository: "Giskard-AI/epure",
          issueNumber: 50,
          command: "approve",
          commandArgs: "",
          commentId: 500,
          actor: "Maintainer",
          fallbackGithubToken: "ghs_test",
          llmApiKey: "gemini_key",
          stateStore: store,
          fetchImpl: mockFetch,
          sleepFn: async () => {}
        });

        expect(result.executed).toBe(true);
        expect(result.status).toBe(expectedStatus);
        expect(planLabels).toEqual(expectedLabelOnPlan);
        expect(result.summary_markdown).toContain(expectedSummarySubstring);
        expect(result.summary_markdown).toContain(
          "Commandes <code>/epure</code> disponibles"
        );
        // Dependent ticket #52 must never be executed by the LLM
        expect(executedTddPrompts).toHaveLength(0);
      }
    );

    it.each([
      {
        scenario:
          "runMultiAgentPrReviewPass re-throws AuthenticationError (HTTP 401) instead of swallowing it as a passing review",
        httpStatus: 401,
        expectedErrorClass: AuthenticationError,
        invoke: (mockFetch: typeof fetch) =>
          runMultiAgentPrReviewPass({
            repository: "Giskard-AI/epure",
            prNumber: 99,
            headBranch: "task/99-fix",
            baseBranch: "feature/1-plan",
            ticketTitle: "Test auth fail-fast",
            acceptanceCriteria: ["AC1"],
            changedFiles: [{ path: "src/index.ts", content: "export const a = 1;\n" }],
            llmApiKey: "bad-key",
            model: "openai/gpt-5.4",
            fetchImpl: mockFetch
          })
      },
      {
        scenario:
          "runUserAdvocateDesignGate re-throws QuotaExhaustedError (HTTP 402) instead of returning fallback personas",
        httpStatus: 402,
        expectedErrorClass: QuotaExhaustedError,
        invoke: (mockFetch: typeof fetch) =>
          runUserAdvocateDesignGate({
            repository: "Giskard-AI/epure",
            planTitle: "Design gate quota test",
            glossaryMarkdown: "# GLOSSARY\n",
            specMarkdown: "# SPEC\n",
            llmApiKey: "exhausted-key",
            model: "anthropic/claude-3-7-sonnet",
            fetchImpl: mockFetch
          })
      },
      {
        scenario:
          "generateSemanticSquashCommitFromDiff re-throws AuthenticationError (HTTP 403) instead of silently falling back",
        httpStatus: 403,
        expectedErrorClass: AuthenticationError,
        invoke: (mockFetch: typeof fetch) =>
          generateSemanticSquashCommitFromDiff({
            prNumber: 100,
            targetBranch: "feature/1-plan",
            planIssueNumber: 1,
            ticketNumbers: [2],
            fallbackTitle: "feat: test",
            changedFiles: [{ path: "src/index.ts", content: "export const a = 1;\n" }],
            llmApiKey: "forbidden-key",
            model: "google/gemini-3.8-flash",
            fetchImpl: mockFetch
          })
      }
    ])("$scenario", async ({ httpStatus, expectedErrorClass, invoke }) => {
      const mockFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({ error: { message: `HTTP ${httpStatus}` } }),
          { status: httpStatus }
        );
      await expect(invoke(mockFetch)).rejects.toBeInstanceOf(
        expectedErrorClass
      );
    });

    it.each([
      {
        scenario:
          "resolvePhaseModels honours provider/model identifiers and providers dictionary from .github/agents.yml",
        inputModel: undefined as string | undefined,
        envVars: {} as Record<string, string | undefined>,
        agentsConfig: {
          ...DEFAULT_AGENTS_CONFIG,
          models: {
            planning: "anthropic/claude-3-7-sonnet",
            implementation: "openai/gpt-5.4",
            review: "azure/gpt-4o-deploy"
          },
          providers: {
            azure: {
              provider: "azure" as const,
              base_url: "https://epure.openai.azure.com"
            }
          }
        },
        expectedPlanning: "anthropic/claude-3-7-sonnet",
        expectedImplementation: "openai/gpt-5.4",
        expectedReview: "azure/gpt-4o-deploy"
      },
      {
        scenario:
          "resolvePhaseModels honours provider-prefixed DEFAULT_AGENTS_CONFIG models when the action input model is empty",
        inputModel: "" as string | undefined,
        envVars: {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          LLM_API_KEY: undefined
        } as Record<string, string | undefined>,
        agentsConfig: DEFAULT_AGENTS_CONFIG,
        expectedPlanning: "anthropic/claude-sonnet-4-20250514",
        expectedImplementation: "anthropic/claude-sonnet-4-20250514",
        expectedReview: "openai/gpt-4.1"
      },
      {
        scenario:
          "resolvePhaseModels lets an explicit action input model override every agents.yml phase model",
        inputModel: "google/gemini-2.5-pro" as string | undefined,
        envVars: {} as Record<string, string | undefined>,
        agentsConfig: DEFAULT_AGENTS_CONFIG,
        expectedPlanning: "google/gemini-2.5-pro",
        expectedImplementation: "google/gemini-2.5-pro",
        expectedReview: "google/gemini-2.5-pro"
      },
      {
        scenario:
          "resolvePhaseModels honours bare claude-* and gpt-* models when ANTHROPIC_API_KEY and OPENAI_API_KEY are set in process.env",
        inputModel: undefined as string | undefined,
        envVars: {
          ANTHROPIC_API_KEY: "sk-ant-env",
          OPENAI_API_KEY: "sk-openai-env",
          LLM_API_KEY: undefined
        } as Record<string, string | undefined>,
        agentsConfig: BARE_MODELS_AGENTS_CONFIG,
        expectedPlanning: "claude-sonnet-4-20250514",
        expectedImplementation: "claude-sonnet-4-20250514",
        expectedReview: "gpt-4.1"
      },
      {
        scenario:
          "resolvePhaseModels honours bare claude-* and gpt-* models verbatim when the orchestrator passes an explicit LLM API key",
        inputModel: undefined as string | undefined,
        envVars: {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          LLM_API_KEY: undefined
        } as Record<string, string | undefined>,
        agentsConfig: BARE_MODELS_AGENTS_CONFIG,
        llmApiKey: "sk-explicit-llm-key",
        expectedPlanning: "claude-sonnet-4-20250514",
        expectedImplementation: "claude-sonnet-4-20250514",
        expectedReview: "gpt-4.1"
      },
      {
        scenario:
          "resolvePhaseModels honours bare claude-* and gpt-* models verbatim when LLM_API_KEY is set in process.env",
        inputModel: undefined as string | undefined,
        envVars: {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          LLM_API_KEY: "sk-env-llm-key"
        } as Record<string, string | undefined>,
        agentsConfig: BARE_MODELS_AGENTS_CONFIG,
        expectedPlanning: "claude-sonnet-4-20250514",
        expectedImplementation: "claude-sonnet-4-20250514",
        expectedReview: "gpt-4.1"
      },
      {
        scenario:
          "resolvePhaseModels falls back to DEFAULT_FALLBACK_LLM_MODEL for bare models when no provider config or LLM API key is available",
        inputModel: undefined as string | undefined,
        envVars: {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          LLM_API_KEY: undefined
        } as Record<string, string | undefined>,
        agentsConfig: BARE_MODELS_AGENTS_CONFIG,
        expectedPlanning: DEFAULT_FALLBACK_LLM_MODEL,
        expectedImplementation: DEFAULT_FALLBACK_LLM_MODEL,
        expectedReview: DEFAULT_FALLBACK_LLM_MODEL
      }
    ])(
      "$scenario",
      ({
        inputModel,
        envVars,
        agentsConfig,
        llmApiKey,
        expectedPlanning,
        expectedImplementation,
        expectedReview
      }: {
        inputModel: string | undefined;
        envVars: Record<string, string | undefined>;
        agentsConfig: AgentsConfig;
        llmApiKey?: string;
        expectedPlanning: string;
        expectedImplementation: string;
        expectedReview: string;
      }) => {
        const prevEnv: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(envVars)) {
          prevEnv[k] = process.env[k];
          if (v === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = v;
          }
        }
        try {
          const resolved = resolvePhaseModels(
            inputModel,
            agentsConfig,
            llmApiKey
          );
          expect(resolved.planningModel).toBe(expectedPlanning);
          expect(resolved.implementationModel).toBe(expectedImplementation);
          expect(resolved.reviewModel).toBe(expectedReview);
        } finally {
          for (const [k, v] of Object.entries(prevEnv)) {
            if (v === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = v;
            }
          }
        }
      }
    );
  });

  describe("7. extractJsonObject and parseAndValidateStructuredOutput with embedded markdown code fences", () => {
    it.each([
      {
        scenario:
          "raw JSON object containing ```mermaid and ```typescript code fences inside string properties is preserved intact",
        rawInput: JSON.stringify({
          summary: "# Spec\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n```typescript\nconst x = { a: 1 };\n```",
          nested: { count: 7 }
        }),
        expectedCount: 7
      },
      {
        scenario:
          "outer ```json fence wrapping a JSON object that itself contains inner ```mermaid fences is extracted cleanly",
        rawInput:
          "```json\n" +
          JSON.stringify({
            summary: "Doc with ```mermaid\ngraph LR\n``` block",
            nested: { count: 9 }
          }) +
          "\n```",
        expectedCount: 9
      }
    ])("$scenario", ({ rawInput, expectedCount }) => {
      const parsed = parseAndValidateStructuredOutput(
        rawInput,
        sampleNestedSchema
      );
      expect(parsed.nested.count).toBe(expectedCount);
      expect(parsed.summary).toContain("```mermaid");
    });

    it.each([
      {
        scenario: "rejects ellipsis placeholder in spec_markdown ('# Spécification...')",
        payload: {
          plan_slug: "cleanup",
          glossary_markdown: "# GLOSSARY\n\nReal terms.",
          adrs: [{ path: "docs/adr/0001-clean.md", content: "# ADR 1\nReal content." }],
          spec_path: "docs/specs/cleanup.md",
          spec_markdown: "# Spécification...",
          tickets: [
            {
              index: 1,
              slug: "t1",
              title: "[Ticket 1] Audit docs",
              description: "Audit all markdown docs",
              acceptance_criteria: ["All docs listed"],
              blocked_by_indices: [],
              files_to_create_or_update: ["docs/FUTURE_FEATURES.md"]
            }
          ]
        },
        expectedErrorSubstring: "spec_markdown cannot be an ellipsis placeholder"
      },
      {
        scenario: "rejects ellipsis placeholder in ticket title ('...')",
        payload: {
          plan_slug: "cleanup",
          glossary_markdown: "# GLOSSARY\n\nReal terms.",
          adrs: [{ path: "docs/adr/0001-clean.md", content: "# ADR 1\nReal content." }],
          spec_path: "docs/specs/cleanup.md",
          spec_markdown: "# Spécification\n\nComplete specification body.",
          tickets: [
            {
              index: 1,
              slug: "t1",
              title: "...",
              description: "...",
              acceptance_criteria: [],
              blocked_by_indices: [],
              files_to_create_or_update: []
            }
          ]
        },
        expectedErrorSubstring: "title cannot be an ellipsis placeholder"
      }
    ])("$scenario", ({ payload, expectedErrorSubstring }) => {
      expect(() =>
        GENERATED_PLANNING_BUNDLE_SCHEMA.validate(payload)
      ).toThrow(expectedErrorSubstring);
    });
  });

  describe("8. Configurable LLM timeout (900s), non-penalizing 429 Retry-After waits, per-request retry scope & suspended state resumption", () => {
    it.each([
      {
        id: "numeric-retry-after-header",
        header: "42",
        body: undefined,
        nowMs: 1_700_000_000_000,
        expectedSeconds: 42
      },
      {
        id: "http-date-retry-after-header",
        header: new Date(1_700_000_065_000).toUTCString(),
        body: undefined,
        nowMs: 1_700_000_000_000,
        expectedSeconds: 65
      },
      {
        id: "gemini-json-body-retryDelay",
        header: null,
        body: JSON.stringify({
          error: {
            code: 429,
            details: [{ "@type": "RetryInfo", retryDelay: "37.4s" }]
          }
        }),
        nowMs: 1_700_000_000_000,
        expectedSeconds: 38
      },
      {
        id: "text-body-retry-after-hint",
        header: null,
        body: "Rate limit reached. Please retry after 19s.",
        nowMs: 1_700_000_000_000,
        expectedSeconds: 19
      },
      {
        id: "missing-header-and-body-returns-undefined",
        header: null,
        body: '{"error":"rate_limited"}',
        nowMs: 1_700_000_000_000,
        expectedSeconds: undefined
      }
    ])(
      "parseRetryAfterSeconds [$id]",
      ({ header, body, nowMs, expectedSeconds }) => {
        expect(parseRetryAfterSeconds(header, body, nowMs)).toBe(
          expectedSeconds
        );
      }
    );

    it.each([
      {
        id: "429-waits-retry-after-capped-at-300s-without-consuming-transient-retries",
        responses: [
          {
            status: 429,
            headers: { "retry-after": "25" },
            body: JSON.stringify({ error: { message: "Too Many Requests" } })
          },
          {
            status: 429,
            headers: { "retry-after": "999" },
            body: JSON.stringify({ error: { message: "Too Many Requests" } })
          },
          {
            status: 503,
            headers: {},
            body: JSON.stringify({ error: { message: "Backend overloaded" } })
          },
          {
            status: 200,
            headers: {},
            body: JSON.stringify({
              choices: [{ message: { content: "Success after 429 and 503" } }]
            })
          }
        ],
        maxTransientRetries: 1,
        maxRateLimitWaits: 5,
        expectError: false,
        expectedSleepsMs: [25_000, 300_000, 5_000],
        expectedTransientRetriesUsed: 1,
        expectedRateLimitWaitsUsed: 2
      },
      {
        id: "throws-RateLimitError-when-consecutive-429-exceeds-maxRateLimitWaits",
        responses: [
          {
            status: 429,
            headers: { "retry-after": "10" },
            body: JSON.stringify({ error: { message: "429 #1" } })
          },
          {
            status: 429,
            headers: { "retry-after": "10" },
            body: JSON.stringify({ error: { message: "429 #2" } })
          },
          {
            status: 429,
            headers: { "retry-after": "10" },
            body: JSON.stringify({ error: { message: "429 #3" } })
          }
        ],
        maxTransientRetries: 4,
        maxRateLimitWaits: 2,
        expectError: true,
        expectedSleepsMs: [10_000, 10_000],
        expectedTransientRetriesUsed: 0,
        expectedRateLimitWaitsUsed: 2
      }
    ])(
      "LLMClient rate-limit handling [$id]",
      async ({
        responses,
        maxTransientRetries,
        maxRateLimitWaits,
        expectError,
        expectedSleepsMs,
        expectedTransientRetriesUsed,
        expectedRateLimitWaitsUsed
      }) => {
        const recordedSleepsMs: number[] = [];
        let idx = 0;
        const mockFetch: typeof fetch = async () => {
          const item = responses[Math.min(idx, responses.length - 1)]!;
          idx += 1;
          return new Response(item.body, {
            status: item.status,
            headers: item.headers
          });
        };

        const client = new LLMClient();
        if (expectError) {
          await expect(
            client.complete({
              model: "openai/gpt-5.4",
              apiKey: "sk-test",
              systemInstruction: "Sys",
              userPrompt: "Prompt",
              maxTransientRetries,
              transientRetryBackoffSeconds: [5, 15, 45, 120],
              maxRateLimitWaits,
              sleepMs: async (ms) => {
                recordedSleepsMs.push(ms);
              },
              fetchImpl: mockFetch
            })
          ).rejects.toBeInstanceOf(RateLimitError);
          expect(recordedSleepsMs).toEqual(expectedSleepsMs);
        } else {
          const result = await client.complete({
            model: "openai/gpt-5.4",
            apiKey: "sk-test",
            systemInstruction: "Sys",
            userPrompt: "Prompt",
            maxTransientRetries,
            transientRetryBackoffSeconds: [5, 15, 45, 120],
            maxRateLimitWaits,
            sleepMs: async (ms) => {
              recordedSleepsMs.push(ms);
            },
            fetchImpl: mockFetch
          });
          expect(result.text).toBe("Success after 429 and 503");
          expect(result.transientRetriesUsed).toBe(expectedTransientRetriesUsed);
          expect(result.rateLimitWaitsUsed).toBe(expectedRateLimitWaitsUsed);
          expect(recordedSleepsMs).toEqual(expectedSleepsMs);
        }
      }
    );

    it("scopes maxTransientRetries per unitary HTTP request across multi-round tool calls and retries 1x on truncated JSON", async () => {
      const stepResponses: Array<{ status: number; body: unknown }> = [
        { status: 503, body: { error: { message: "503 r1-1" } } },
        { status: 503, body: { error: { message: "503 r1-2" } } },
        {
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: "read_repo_file",
                        args: { path: "README.md" }
                      }
                    }
                  ]
                }
              }
            ]
          }
        },
        { status: 503, body: { error: { message: "503 r2-1" } } },
        { status: 503, body: { error: { message: "503 r2-2" } } },
        {
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [{ text: '{"summary":"truncated",' }]
                }
              }
            ]
          }
        },
        {
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        summary: "Complete after per-request retries & 1x JSON retry",
                        nested: { count: 42 }
                      })
                    }
                  ]
                }
              }
            ]
          }
        }
      ];

      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        const current = stepResponses[Math.min(callCount, stepResponses.length - 1)]!;
        callCount += 1;
        return new Response(JSON.stringify(current.body), {
          status: current.status
        });
      };

      const client = new LLMClient();
      const res = await client.complete({
        model: "google/gemini-3.8-flash",
        apiKey: "gm-test",
        systemInstruction: "Sys",
        userPrompt: "Inspect and answer",
        maxTransientRetries: 2,
        requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
        sleepMs: async () => {},
        tools: [
          {
            name: "read_repo_file",
            description: "Read file",
            parameters: { type: "OBJECT", properties: {} }
          }
        ],
        toolHandlers: {
          read_repo_file: async () => "# README"
        },
        responseSchema: sampleNestedSchema,
        fetchImpl: mockFetch
      });

      expect(res.data?.nested.count).toBe(42);
      expect(res.transientRetriesUsed).toBe(4);
      expect(callCount).toBe(7);
    });

    it("escalates to needs-human without incrementing code_fix_attempts_used on LLM exhaustion and resumes cleanly on user reply", async () => {
      const stateStore = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        issueNumber: 123,
        store: stateStore,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "active",
          active_branch: "plan/123-dice-tray",
          code_fix_attempts_used: 1
        })
      });

      const postedComments: string[] = [];
      const addedLabels: string[][] = [];
      const removedLabels: string[] = [];
      let shouldFailLlm = true;

      const mockFetch: typeof fetch = async (inputUrl, init) => {
        const url = String(inputUrl);
        const method = init?.method ?? "GET";

        if (url.includes("generativelanguage.googleapis.com")) {
          if (shouldFailLlm) {
            return new Response(
              JSON.stringify({ error: { message: "Gateway timeout" } }),
              { status: 504 }
            );
          }
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          frontier_resolved: false,
                          round_number: 2,
                          follow_up_questions_markdown: "1. Question de suivi ?",
                          settled_decisions_summary_markdown:
                            "Merci pour vos précisions.",
                          rationale: "Encore une précision nécessaire."
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }

        if (url.endsWith("/issues/123") && method === "GET") {
          return new Response(
            JSON.stringify({
              number: 123,
              title: "Add 3D dice tray",
              body: "Feature description"
            }),
            { status: 200 }
          );
        }
        if (url.includes("/issues/123/comments") && method === "GET") {
          return new Response(
            JSON.stringify([
              {
                id: 901,
                body: "Ma réponse aux questions",
                created_at: "2026-10-27T10:00:00Z",
                user: { login: "maintainer", type: "User" }
              }
            ]),
            { status: 200 }
          );
        }
        if (url.includes("/issues/123/comments") && method === "POST") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            body?: string;
          };
          postedComments.push(parsed.body ?? "");
          return new Response(JSON.stringify({ id: 902 }), { status: 201 });
        }
        if (url.includes("/issues/123/labels") && method === "POST") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            labels?: string[];
          };
          addedLabels.push(parsed.labels ?? []);
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes("/issues/123/labels/") && method === "DELETE") {
          removedLabels.push(decodeURIComponent(url.split("/labels/")[1] ?? ""));
          return new Response(null, { status: 204 });
        }
        if (url.includes("/contents/.github/agents.yml")) {
          const customConfig = serializeAgentsYml(
            {
              ...DEFAULT_AGENTS_CONFIG,
              max_transient_api_retries: 1,
              transient_retry_backoff_seconds: [0, 0, 0, 0],
              llm_request_timeout_seconds: 600
            },
            false
          );
          return new Response(
            JSON.stringify({
              content: Buffer.from(customConfig, "utf8").toString("base64")
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      };

      const suspendedRes = await orchestrateIssueCommand({
        repository: "Hartorn-Inc/CozyVTT",
        issueNumber: 123,
        command: "reply",
        commandArgs: "",
        actor: "maintainer",
        commentId: 901,
        fallbackGithubToken: "ghs_testToken1234567890",
        llmApiKey: "gm_testKey1234567890",
        stateStore,
        fetchImpl: mockFetch
      });

      expect(suspendedRes.executed).toBe(true);
      expect(suspendedRes.status).toBe("suspended");
      expect(suspendedRes.phase).toBe("grilling");
      expect(addedLabels).toContainEqual(["needs-human"]);
      expect(postedComments.at(-1)).toContain("needs-human");
      expect(postedComments.at(-1)).toContain(
        "Transient LLM API retries or unitary request timeout exhausted"
      );

      const snapAfterSuspend = await stateStore.readRef("refs/epure/state/123");
      expect(snapAfterSuspend.state?.code_fix_attempts_used).toBe(1);
      expect(snapAfterSuspend.state?.status).toBe("suspended");

      shouldFailLlm = false;
      const resumedRes = await orchestrateIssueCommand({
        repository: "Hartorn-Inc/CozyVTT",
        issueNumber: 123,
        command: "reply",
        commandArgs: "",
        actor: "maintainer",
        commentId: 903,
        fallbackGithubToken: "ghs_testToken1234567890",
        llmApiKey: "gm_testKey1234567890",
        stateStore,
        fetchImpl: mockFetch
      });

      expect(resumedRes.executed).toBe(true);
      expect(resumedRes.status).toBe("active");
      expect(resumedRes.phase).toBe("grilling");
      expect(removedLabels).toContain("needs-human");
    });
  });

  describe("9. v1.5.7 — Literal \\b/\\f regex preservation, corrective structured-output retry, resolveLlmEscalationReason & internal_error escalation", () => {
    it.each([
      {
        id: "single-backslash-b-in-json-regex-preserved-as-literal-backslash-b",
        rawJson:
          '{"summary":"Motifs: `(?i)\\b(?:TODO|FIXME|XXX)\\b` et `\\bTODO\\\\(#[A-Za-z0-9_-]+\\\\):`","nested":{"count":1}}',
        expectedSubstrings: [
          "(?i)\\b(?:TODO|FIXME|XXX)\\b",
          "\\bTODO\\(#[A-Za-z0-9_-]+\\):"
        ]
      },
      {
        id: "already-doubled-backslash-b-and-single-backslash-f-preserved-without-control-chars",
        rawJson:
          '{"summary":"Already escaped \\\\bword\\\\b and unescaped \\fform","nested":{"count":2}}',
        expectedSubstrings: ["\\bword\\b", "\\fform"]
      }
    ])("$id", ({ rawJson, expectedSubstrings }) => {
      const parsed = parseAndValidateStructuredOutput(
        rawJson,
        sampleNestedSchema
      );
      for (const expected of expectedSubstrings) {
        expect(parsed.summary).toContain(expected);
      }
      expect(parsed.summary.includes("\x08")).toBe(false);
      expect(parsed.summary.includes("\x0c")).toBe(false);

      const findings = detectPromptInjectionInPrFiles([
        {
          path: "docs/specs/nettoyage-de-futures-features-docs-e.md",
          content: parsed.summary
        }
      ]);
      expect(findings).toHaveLength(0);
    });

    it.each([
      {
        id: "google-corrective-retry-injects-validation-error-without-rerunning-tools",
        model: "google/gemini-3.8-flash",
        buildInvalidResponse: () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      commit_message: "fix: attempt",
                      test_summary: " tested ",
                      files: [],
                      patches: [],
                      deleted_files: []
                    })
                  }
                ]
              }
            }
          ]
        }),
        buildValidResponse: () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      commit_message: "fix: add link checker",
                      test_summary: "12 tests passed",
                      files: [
                        {
                          path: "scripts/check-markdown-links.py",
                          content: "print('ok')\n"
                        }
                      ],
                      patches: [],
                      deleted_files: []
                    })
                  }
                ]
              }
            }
          ]
        })
      },
      {
        id: "openai-corrective-retry-injects-validation-error-and-recovers",
        model: "openai/gpt-5.4",
        buildInvalidResponse: () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  commit_message: "fix: attempt",
                  test_summary: "tested",
                  files: [],
                  patches: [],
                  deleted_files: []
                })
              }
            }
          ]
        }),
        buildValidResponse: () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  commit_message: "fix: add link checker",
                  test_summary: "12 tests passed",
                  files: [
                    {
                      path: "scripts/check-markdown-links.py",
                      content: "print('ok')\n"
                    }
                  ],
                  patches: [],
                  deleted_files: []
                })
              }
            }
          ]
        })
      },
      {
        id: "anthropic-corrective-retry-injects-validation-error-and-recovers",
        model: "anthropic/claude-sonnet-4-20250514",
        buildInvalidResponse: () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                commit_message: "fix: attempt",
                test_summary: "tested",
                files: [],
                patches: [],
                deleted_files: []
              })
            }
          ]
        }),
        buildValidResponse: () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                commit_message: "fix: add link checker",
                test_summary: "12 tests passed",
                files: [
                  {
                    path: "scripts/check-markdown-links.py",
                    content: "print('ok')\n"
                  }
                ],
                patches: [],
                deleted_files: []
              })
            }
          ]
        })
      }
    ])(
      "$id",
      async ({ model, buildInvalidResponse, buildValidResponse }) => {
        const requestBodies: string[] = [];
        const mockFetch: typeof fetch = async (_url, init) => {
          const bodyStr = String(init?.body ?? "");
          requestBodies.push(bodyStr);
          if (requestBodies.length === 1) {
            return new Response(JSON.stringify(buildInvalidResponse()), {
              status: 200
            });
          }
          return new Response(JSON.stringify(buildValidResponse()), {
            status: 200
          });
        };

        const client = new LLMClient();
        const res = await client.complete({
          model,
          apiKey: "test-key",
          systemInstruction: "Sys",
          userPrompt: "Implement ticket",
          maxTransientRetries: 2,
          transientRetryBackoffSeconds: [0, 0],
          sleepMs: async () => {},
          responseSchema: GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
          fetchImpl: mockFetch
        });

        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[1]).toContain(
          "Your previous JSON response failed schema validation"
        );
        expect(requestBodies[1]).toContain(
          "GeneratedTicketImplementation must include at least one non-empty file"
        );
        expect(res.data?.files?.[0]?.path).toBe(
          "scripts/check-markdown-links.py"
        );
        expect(res.transientRetriesUsed).toBe(1);
      }
    );

    it.each([
      {
        id: "auth-error-maps-to-llm-quota-or-auth-failure",
        err: new AuthenticationError("401 Unauthorized", {
          provider: "google",
          status: 401
        }),
        expectedReason: "llm_quota_or_auth_failure" as NeedsHumanEscalationReason,
        expectedHeadlineSubstring:
          "LLM provider quota/billing exhaustion or authentication failure"
      },
      {
        id: "quota-exhausted-maps-to-llm-quota-or-auth-failure",
        err: new QuotaExhaustedError("Insufficient quota", {
          provider: "openai",
          status: 429
        }),
        expectedReason: "llm_quota_or_auth_failure" as NeedsHumanEscalationReason,
        expectedHeadlineSubstring:
          "LLM provider quota/billing exhaustion or authentication failure"
      },
      {
        id: "server-503-maps-to-transient-llm-api-exhausted",
        err: new ServerError("503 Service Unavailable", {
          provider: "google",
          status: 503
        }),
        expectedReason: "transient_llm_api_exhausted" as NeedsHumanEscalationReason,
        expectedHeadlineSubstring:
          "Transient LLM API retries or unitary request timeout exhausted"
      },
      {
        id: "timeout-408-maps-to-transient-llm-api-exhausted",
        err: new LLMTimeoutError("Request timed out after 900000ms", {
          provider: "google",
          status: 408
        }),
        expectedReason: "transient_llm_api_exhausted" as NeedsHumanEscalationReason,
        expectedHeadlineSubstring:
          "Transient LLM API retries or unitary request timeout exhausted"
      },
      {
        id: "rate-limit-429-maps-to-transient-llm-api-exhausted",
        err: new RateLimitError("Too Many Requests", {
          provider: "google",
          status: 429
        }),
        expectedReason: "transient_llm_api_exhausted" as NeedsHumanEscalationReason,
        expectedHeadlineSubstring:
          "Transient LLM API retries or unitary request timeout exhausted"
      },
      {
        id: "structured-output-validation-error-maps-to-llm-request-invalid",
        err: new StructuredOutputValidationError(
          "Structured output failed validation for schema 'generated_ticket_implementation'",
          { provider: "google" }
        ),
        expectedReason: "llm_request_invalid" as NeedsHumanEscalationReason,
        expectedHeadlineSubstring:
          "LLM request rejected or response invalid after structured-output retry (non-transient)"
      },
      {
        id: "bad-request-400-maps-to-llm-request-invalid",
        err: new BadRequestError("400 Invalid schema", {
          provider: "openai",
          status: 400
        }),
        expectedReason: "llm_request_invalid" as NeedsHumanEscalationReason,
        expectedHeadlineSubstring:
          "LLM request rejected or response invalid after structured-output retry (non-transient)"
      }
    ])("$id", ({ err, expectedReason, expectedHeadlineSubstring }) => {
      const reason = resolveLlmEscalationReason(err);
      expect(reason).toBe(expectedReason);
      const comment = formatNeedsHumanEscalationComment({
        reason,
        issueNumber: 123,
        ticketIssueNumber: 136,
        branch: "task/136-links"
      });
      expect(comment).toContain(expectedHeadlineSubstring);
    });

    it.each([
      {
        id: "escalates-unhandled-non-llm-internal-error-to-suspended-with-internal-error-reason",
        failureMode: "non_llm_internal_error" as const,
        expectedHeadline:
          "Internal orchestrator error — code-fix budget preserved"
      },
      {
        id: "escalates-persistent-structured-output-validation-error-with-llm-request-invalid-reason",
        failureMode: "persistent_structured_validation_error" as const,
        expectedHeadline:
          "LLM request rejected or response invalid after structured-output retry (non-transient) — code-fix budget preserved"
      }
    ])("$id", async ({ failureMode, expectedHeadline }) => {
      const stateStore = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        issueNumber: 123,
        store: stateStore,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "active",
          active_branch: "plan/123-links",
          code_fix_attempts_used: 2
        })
      });

      const postedComments: string[] = [];
      const addedLabels: string[][] = [];

      const mockFetch: typeof fetch = async (inputUrl, init) => {
        const url = String(inputUrl);
        const method = init?.method ?? "GET";

        if (url.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: '{"not_matching_grill_schema": true}'
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }

        if (url.endsWith("/issues/123") && method === "GET") {
          if (failureMode === "non_llm_internal_error") {
            throw new TypeError("Simulated unexpected internal orchestrator bug");
          }
          return new Response(
            JSON.stringify({
              number: 123,
              title: "Check markdown links",
              body: "Plan body"
            }),
            { status: 200 }
          );
        }
        if (url.includes("/issues/123/comments") && method === "GET") {
          return new Response(
            JSON.stringify([
              {
                id: 950,
                body: "Go",
                created_at: "2026-10-28T10:00:00Z",
                user: { login: "maintainer", type: "User" }
              }
            ]),
            { status: 200 }
          );
        }
        if (url.includes("/issues/123/comments") && method === "POST") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            body?: string;
          };
          postedComments.push(parsed.body ?? "");
          return new Response(JSON.stringify({ id: 951 }), { status: 201 });
        }
        if (url.includes("/issues/123/labels") && method === "POST") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            labels?: string[];
          };
          addedLabels.push(parsed.labels ?? []);
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes("/contents/.github/agents.yml")) {
          const customConfig = serializeAgentsYml(
            {
              ...DEFAULT_AGENTS_CONFIG,
              max_transient_api_retries: 1,
              transient_retry_backoff_seconds: [0, 0, 0, 0]
            },
            false
          );
          return new Response(
            JSON.stringify({
              content: Buffer.from(customConfig, "utf8").toString("base64")
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      };

      const res = await orchestrateIssueCommand({
        repository: "Hartorn-Inc/CozyVTT",
        issueNumber: 123,
        command: "reply",
        commandArgs: "",
        actor: "maintainer",
        commentId: 950,
        fallbackGithubToken: "ghs_testToken1234567890",
        llmApiKey: "gm_testKey1234567890",
        stateStore,
        fetchImpl: mockFetch
      });

      expect(res.executed).toBe(true);
      expect(res.status).toBe("suspended");
      expect(addedLabels).toContainEqual(["needs-human"]);
      expect(postedComments.at(-1)).toContain(expectedHeadline);

      const snap = await stateStore.readRef("refs/epure/state/123");
      expect(snap.state?.status).toBe("suspended");
      expect(snap.state?.code_fix_attempts_used).toBe(2);
    });

    it.each([
      {
        id: "skips-already-deleted-file-in-base-tree-to-avoid-gitrpc-bad-object-state",
        baseTreeBlobs: ["README.md"],
        deletedFiles: ["docs/FUTURE_FEATURES.md"],
        expectedTreePathsPosted: ["README.md"]
      },
      {
        id: "includes-sha-null-when-deleted-file-still-exists-in-base-tree",
        baseTreeBlobs: ["README.md", "docs/FUTURE_FEATURES.md"],
        deletedFiles: ["docs/FUTURE_FEATURES.md"],
        expectedTreePathsPosted: ["README.md", "docs/FUTURE_FEATURES.md"]
      }
    ])(
      "$id",
      async ({ baseTreeBlobs, deletedFiles, expectedTreePathsPosted }) => {
        const postedTreeEntries: Array<{ path: string; sha: string | null }> =
          [];

        const mockFetch: typeof fetch = async (inputUrl, init) => {
          const url = String(inputUrl);
          const method = init?.method ?? "GET";

          if (url.includes("/git/ref/heads/") && method === "GET") {
            return new Response(
              JSON.stringify({ object: { sha: "parent_sha_1" } }),
              { status: 200 }
            );
          }
          if (url.includes("/git/commits/parent_sha_1") && method === "GET") {
            return new Response(
              JSON.stringify({ tree: { sha: "base_tree_sha_1" } }),
              { status: 200 }
            );
          }
          if (
            url.includes("/git/trees/base_tree_sha_1?recursive=1") &&
            method === "GET"
          ) {
            return new Response(
              JSON.stringify({
                tree: baseTreeBlobs.map((p) => ({
                  path: p,
                  type: "blob",
                  sha: "blob_existing"
                }))
              }),
              { status: 200 }
            );
          }
          if (url.endsWith("/git/blobs") && method === "POST") {
            return new Response(JSON.stringify({ sha: "new_blob_sha" }), {
              status: 201
            });
          }
          if (url.endsWith("/git/trees") && method === "POST") {
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              tree?: Array<{ path: string; sha: string | null }>;
            };
            postedTreeEntries.push(...(parsed.tree ?? []));
            return new Response(JSON.stringify({ sha: "new_tree_sha" }), {
              status: 201
            });
          }
          if (url.endsWith("/git/commits") && method === "POST") {
            return new Response(JSON.stringify({ sha: "new_commit_sha" }), {
              status: 201
            });
          }
          return new Response(JSON.stringify({}), { status: 200 });
        };

        const gh = createGitHubRestHelper({
          repository: "Hartorn-Inc/CozyVTT",
          token: "ghs_test",
          fetchImpl: mockFetch
        });

        await gh.commitFilesToBranch({
          branch: "task/137-triage",
          fromBranch: "feature/123-clean",
          commitMessage: "fix(review): update docs",
          files: [{ path: "README.md", content: "# Updated\n" }],
          deletedFiles
        });

        expect(postedTreeEntries.map((e) => e.path)).toEqual(
          expectedTreePathsPosted
        );
      }
    );

    it("excludes deletedFiles from reviewer inspection tools and reports DELETED status on read_file / read_line_range", async () => {
      const tools = buildReviewerInspectionTools({
        repository: "Hartorn-Inc/CozyVTT",
        prNumber: 146,
        headBranch: "task/137-triage",
        baseBranch: "feature/123-clean",
        ticketNumber: 137,
        ticketTitle: "Delete FUTURE_FEATURES.md",
        acceptanceCriteria: ["docs/FUTURE_FEATURES.md is deleted"],
        changedFiles: [{ path: "README.md", content: "# Clean\n" }],
        deletedFiles: ["docs/FUTURE_FEATURES.md"],
        trustedBaseBranchFiles: new Map([
          ["docs/FUTURE_FEATURES.md", "# Old Future Features\n"],
          ["README.md", "# Old Readme\n"]
        ])
      });

      const listOut = (await tools.handlers.list_files!({})) as {
        files: Array<{ path: string }>;
      };
      expect(listOut.files.map((f) => f.path)).not.toContain(
        "docs/FUTURE_FEATURES.md"
      );

      const readOut = (await tools.handlers.read_file!({
        path: "docs/FUTURE_FEATURES.md"
      })) as { deleted_in_pr?: boolean; status?: string };
      expect(readOut.deleted_in_pr).toBe(true);
      expect(readOut.status).toContain("DELETED");

      const rangeOut = (await tools.handlers.read_line_range!({
        path: "docs/FUTURE_FEATURES.md",
        start_line: 1,
        end_line: 20
      })) as { deleted_in_pr?: boolean; status?: string };
      expect(rangeOut.deleted_in_pr).toBe(true);
      expect(rangeOut.status).toContain("DELETED");
    });
  });

  describe("15. Structured provider error classification (Google gRPC RetryInfo/QuotaFailure vs OpenAI insufficient_quota)", () => {
    it.each([
      {
        id: "gemini-429-tpm-rate-limit-with-retry-info-and-exceeded-quota-prose",
        status: 429,
        provider: "google",
        model: "gemini-3.8-flash",
        bodyText: JSON.stringify({
          error: {
            code: 429,
            message:
              "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_3_input_token_count, limit: 20000000\nPlease retry in 12.552685711s.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [
                  {
                    quotaId:
                      "GenerateContentPaidTierInputTokensPerModelPerMinute-PaidTier3"
                  }
                ]
              },
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: "12s"
              }
            ]
          }
        }),
        expectedClass: RateLimitError,
        expectedRetryAfterSeconds: 12
      },
      {
        id: "openai-429-hard-billing-insufficient-quota-without-retry-delay",
        status: 429,
        provider: "openai",
        model: "gpt-5.4",
        bodyText: JSON.stringify({
          error: {
            message:
              "You exceeded your current quota, please check your plan and billing details.",
            type: "insufficient_quota",
            code: "insufficient_quota"
          }
        }),
        expectedClass: QuotaExhaustedError,
        expectedRetryAfterSeconds: undefined
      },
      {
        id: "gemini-403-billing-disabled-via-grpc-error-info",
        status: 429,
        provider: "google",
        model: "gemini-3.8-flash",
        bodyText: JSON.stringify({
          error: {
            code: 429,
            message: "Billing account is disabled.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "BILLING_DISABLED"
              }
            ]
          }
        }),
        expectedClass: QuotaExhaustedError,
        expectedRetryAfterSeconds: undefined
      },
      {
        id: "gemini-400-api-key-invalid-via-grpc-error-info",
        status: 400,
        provider: "google",
        model: "gemini-3.8-flash",
        bodyText: JSON.stringify({
          error: {
            code: 400,
            message: "API key not valid.",
            status: "INVALID_ARGUMENT",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_INVALID"
              }
            ]
          }
        }),
        expectedClass: AuthenticationError,
        expectedRetryAfterSeconds: undefined
      }
    ])(
      "classifyHttpError [$id] classifies structured provider error accurately",
      ({
        status,
        provider,
        model,
        bodyText,
        expectedClass,
        expectedRetryAfterSeconds
      }) => {
        const err = classifyHttpError({
          status,
          bodyText,
          provider,
          model
        });
        expect(err).toBeInstanceOf(expectedClass);
        if (err instanceof RateLimitError) {
          expect(err.retryAfterSeconds).toBe(expectedRetryAfterSeconds);
        }
      }
    );
  });

  describe("16. Incremental Workspace Mutation Tools, Compact Context & Chunked Fallback (ADR-0033)", () => {
    it.each([
      {
        id: "write-patch-delete-tools-stage-mutations-and-accept-empty-final-json",
        initialAccumulated: new Map([
          ["src/routes.ts", "export const routes = [\n  '/health'\n];\n"],
          ["src/legacy.ts", "export const legacy = true;\n"]
        ]),
        sensitivePathAttempt: ".github/workflows/ci.yml",
        patchMismatchOld: "non_existent_snippet",
        patchValidOld: "'/health'",
        patchValidNew: "'/health',\n  '/campaigns'",
        writtenPath: "src/postgres.ts",
        writtenContent: "export const pool = 'pg://localhost';\n",
        deletedPath: "src/legacy.ts"
      },
      {
        id: "path-traversal-rejected-and-multi-edit-patch-succeeds",
        initialAccumulated: new Map([
          ["packages/server/http.ts", "const port = 3000;\nconst host = '0.0.0.0';\n"],
          ["packages/server/old.ts", "// obsolete\n"]
        ]),
        sensitivePathAttempt: "../outside.ts",
        patchMismatchOld: "const port = 9999;",
        patchValidOld: "const port = 3000;",
        patchValidNew: "const port = 8080;",
        writtenPath: "packages/server/db.ts",
        writtenContent: "export const dbReady = true;\n",
        deletedPath: "packages/server/old.ts"
      }
    ])(
      "StagedTicketImplementationBuffer [$id] isolates tool mutations, enforces path guards, and validates empty final arrays",
      async ({
        initialAccumulated,
        sensitivePathAttempt,
        patchMismatchOld,
        patchValidOld,
        patchValidNew,
        writtenPath,
        writtenContent,
        deletedPath
      }) => {
        const baselineLoadedPaths: string[] = [];
        const stagedBuffer = createStagedTicketImplementationBuffer(
          async (paths) => {
            baselineLoadedPaths.push(...paths);
          }
        );
        const accumulatedCopy = new Map(initialAccumulated);
        const targetPatchPath = Array.from(initialAccumulated.keys())[0]!;

        const { tools, toolHandlers } = buildRepoExplorationToolsAndHandlers({
          branch: "task/72-slice-1",
          featureBranch: "feature/70-epic",
          accumulatedFiles: accumulatedCopy,
          stagedImplementation: stagedBuffer,
          devBranchPaths: Array.from(initialAccumulated.keys()),
          gh: {
            readSingleBranchFile: async () => null,
            listBranchPaths: async () => Array.from(initialAccumulated.keys())
          }
        });

        const toolNames = (tools ?? []).map((t) => t.name);
        expect(toolNames).toContain("write_repo_file");
        expect(toolNames).toContain("patch_repo_file");
        expect(toolNames).toContain("delete_repo_file");

        // 1. Sensitive or traversal path rejected on all 3 mutation tools
        const deniedWrite = (await toolHandlers!.write_repo_file!({
          path: sensitivePathAttempt,
          content: "malicious"
        })) as { error?: string };
        expect(deniedWrite.error).toContain("Access denied");

        const deniedPatch = (await toolHandlers!.patch_repo_file!({
          path: sensitivePathAttempt,
          edits: [{ old_string: "a", new_string: "b" }]
        })) as { error?: string };
        expect(deniedPatch.error).toContain("Access denied");

        const deniedDelete = (await toolHandlers!.delete_repo_file!({
          path: sensitivePathAttempt
        })) as { error?: string };
        expect(deniedDelete.error).toContain("Access denied");
        expect(stagedBuffer.hasMutations()).toBe(false);

        // 2. Mismatched patch returns actionable error without mutating buffer
        const failedPatch = (await toolHandlers!.patch_repo_file!({
          path: targetPatchPath,
          edits: [{ old_string: patchMismatchOld, new_string: "replacement" }]
        })) as { error?: string };
        expect(failedPatch.error).toContain("did not match");
        expect(stagedBuffer.files.has(targetPatchPath)).toBe(false);

        // 3. Valid patch, write, and delete stage cleanly in overlay without mutating accumulatedCopy
        const okPatch = (await toolHandlers!.patch_repo_file!({
          path: targetPatchPath,
          edits: [{ old_string: patchValidOld, new_string: patchValidNew }]
        })) as { applied?: boolean };
        expect(okPatch.applied).toBe(true);

        const okWrite = (await toolHandlers!.write_repo_file!({
          path: writtenPath,
          content: writtenContent
        })) as { staged?: boolean };
        expect(okWrite.staged).toBe(true);

        const okDelete = (await toolHandlers!.delete_repo_file!({
          path: deletedPath
        })) as { deleted?: boolean };
        expect(okDelete.deleted).toBe(true);

        // Transactional isolation: accumulatedCopy is untouched
        expect(accumulatedCopy.has(writtenPath)).toBe(false);
        expect(accumulatedCopy.get(targetPatchPath)).toBe(
          initialAccumulated.get(targetPatchPath)
        );
        expect(baselineLoadedPaths).toContain(targetPatchPath);
        expect(baselineLoadedPaths).toContain(writtenPath);
        expect(baselineLoadedPaths).toContain(deletedPath);

        // Read tools see the staged overlay
        const readPatched = (await toolHandlers!.read_repo_file!({
          path: targetPatchPath
        })) as { content?: string };
        expect(readPatched.content).toContain(patchValidNew);

        const readDeleted = (await toolHandlers!.read_repo_file!({
          path: deletedPath
        })) as { error?: string };
        expect(readDeleted.error).toContain("was deleted");

        // Contextual schema accepts empty final arrays because stagedBuffer has mutations
        const contextualSchema = createGeneratedTicketImplementationSchema({
          hasStagedMutations: () => stagedBuffer.hasMutations()
        });
        const validatedFinal = contextualSchema.validate({
          commit_message: "feat(slice-1): stage postgres and routes",
          test_summary: "All tests pass",
          files: [],
          patches: [],
          deleted_files: []
        });
        const merged = mergeStagedBufferIntoImplementationPayload(
          stagedBuffer,
          validatedFinal
        );
        expect(merged.files?.map((f) => f.path)).toEqual(
          expect.arrayContaining([targetPatchPath, writtenPath])
        );
        expect(merged.deleted_files).toEqual([deletedPath]);
      }
    );

    it.each([
      {
        id: "monorepo-with-root-package-json-and-large-cached-files",
        accumulatedEntries: [
          ["package.json", '{\n  "name": "root"\n}'],
          ["src/target.ts", "export const target = 1;\n"],
          [
            "src/huge-unrelated.ts",
            Array.from({ length: 450 }, (_, i) => `const line${i} = ${i};`).join(
              "\n"
            )
          ]
        ] as const,
        devBranchPaths: ["package.json", "src/target.ts", "src/huge-unrelated.ts"],
        priorityPaths: ["src/target.ts"],
        expectedInlinedPath: "--- FILE: src/target.ts ---",
        expectedCatalogEntry: "- src/huge-unrelated.ts (450 lines)"
      },
      {
        id: "polyglot-rust-repo-without-root-package-json",
        accumulatedEntries: [
          ["Cargo.toml", '[workspace]\nmembers = ["crates/server"]'],
          ["crates/server/src/lib.rs", "pub fn run() {}\n"],
          ["crates/engine/src/lib.rs", "pub fn engine() {}\n"]
        ] as const,
        devBranchPaths: ["Cargo.toml", "crates/server/src/lib.rs"],
        priorityPaths: ["crates/server/src/lib.rs"],
        expectedInlinedPath: "--- FILE: crates/server/src/lib.rs ---",
        expectedCatalogEntry: "- crates/engine/src/lib.rs (2 lines)"
      }
    ])(
      "checkIsExistingRepoWorkspace and buildCompactWorkspaceFilesContext [$id] inline priority files without mid-file truncation and catalog the rest",
      ({
        accumulatedEntries,
        devBranchPaths,
        priorityPaths,
        expectedInlinedPath,
        expectedCatalogEntry
      }) => {
        const map = new Map<string, string>(accumulatedEntries);
        expect(checkIsExistingRepoWorkspace(map, devBranchPaths)).toBe(true);

        const compact = buildCompactWorkspaceFilesContext({
          accumulatedFiles: map,
          priorityPaths
        });
        expect(compact).toContain(expectedInlinedPath);
        expect(compact).toContain(expectedCatalogEntry);
        expect(compact).toContain("WORKSPACE FILE CATALOG");
      }
    );

    it.each([
      {
        id: "chunked-fallback-recovers-when-single-shot-returns-empty-files",
        mode: "fallback_success" as const,
        expectedStatus: "done"
      },
      {
        id: "incremental-write-tool-succeeds-with-empty-final-json-arrays",
        mode: "incremental_tool_write" as const,
        expectedStatus: "done"
      },
      {
        id: "chunked-fallback-discards-staged-buffer-and-escalates-when-subcall-fails",
        mode: "fallback_exhausted" as const,
        expectedStatus: "suspended"
      }
    ])(
      "orchestrateIssueCommand [$id] handles incremental tool writes and chunked file-by-file fallback on ticket #72",
      async ({ mode, expectedStatus }) => {
        const stateStore = createInMemoryGitRefStateStore();
        await updateIssueStateWithCas({
          issueNumber: 70,
          store: stateStore,
          mutator: (s) => ({
            ...s,
            phase: "tickets",
            status: "awaiting_human_approval",
            spec_sha: "spec-sha-70",
            active_branch: "plan/70-postgres-slice"
          })
        });

        const manifestPayload = {
          planBranch: "plan/70-postgres-slice",
          specPath: "docs/specs/postgres-slice.md",
          tickets: [
            {
              ticketIssueNumber: 72,
              slug: "slice-1-postgres-and-routes",
              title: "[Ticket 1] Slice 1 Postgres and Routes",
              description: "Implement postgres store, HTTP routes, and tests",
              acceptanceCriteria: ["Postgres store and routes work"],
              blockedByIssueNumbers: [],
              filesToTouch: ["src/postgres.ts", "src/routes.ts"]
            }
          ]
        };

        let geminiCallIndex = 0;
        const committedBranches: string[] = [];

        const mockFetch: typeof fetch = async (url, init) => {
          const urlStr = String(url);
          const method = init?.method ?? "GET";

          if (urlStr.includes("generativelanguage.googleapis.com")) {
            geminiCallIndex += 1;
            const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
              contents?: Array<{
                role?: string;
                parts?: Array<{
                  text?: string;
                  functionResponse?: { name: string; response: unknown };
                }>;
              }>;
              tools?: unknown[];
              generationConfig?: {
                responseJsonSchema?: {
                  properties?: Record<string, unknown>;
                };
              };
            };

            const allText = JSON.stringify(reqBody.contents ?? []);
            const schemaProps =
              reqBody.generationConfig?.responseJsonSchema?.properties ?? {};

            // Reviewer findings schema
            if ("findings" in schemaProps) {
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              reviewer: "standards-reviewer",
                              summary: "LGTM",
                              findings: []
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }

            // Epic convergence audit schema
            if ("verdict" in schemaProps && "unwired_modules" in schemaProps) {
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              verdict: "CONVERGED",
                              rationale: "All entrypoints wired.",
                              unwired_modules: [],
                              stub_violations: [],
                              unmet_criteria: [],
                              remediation_tickets: []
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }

            // Squash commit schema
            if ("type" in schemaProps && "scope" in schemaProps && "subject" in schemaProps) {
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              type: "feat",
                              scope: "postgres",
                              subject: "add postgres store and routes",
                              body: "Implemented slice 1."
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }

            // Ticket implementation calls
            if (mode === "incremental_tool_write") {
              const hasToolResponse = (reqBody.contents ?? []).some((c) =>
                (c.parts ?? []).some((p) => p.functionResponse !== undefined)
              );
              const declaredToolNames = JSON.stringify(reqBody.tools ?? []);
              if (
                reqBody.tools &&
                declaredToolNames.includes("write_repo_file") &&
                !hasToolResponse
              ) {
                return new Response(
                  JSON.stringify({
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              functionCall: {
                                name: "write_repo_file",
                                args: {
                                  path: "src/postgres.ts",
                                  content: "export const pg = true;\n"
                                }
                              }
                            },
                            {
                              functionCall: {
                                name: "write_repo_file",
                                args: {
                                  path: "src/routes.ts",
                                  content: "export const routes = ['pg'];\n"
                                }
                              }
                            },
                            {
                              functionCall: {
                                name: "write_repo_file",
                                args: {
                                  path: "tests/slice1.test.ts",
                                  content: "export const tested = true;\n"
                                }
                              }
                            }
                          ]
                        }
                      }
                    ]
                  }),
                  { status: 200 }
                );
              }
              // Phase 2 structured output returns empty arrays because files were written via tools!
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              commit_message:
                                "feat(ticket-72): implement postgres and routes via incremental tools",
                              test_summary: "Incremental tool writes verified",
                              files: [],
                              patches: [],
                              deleted_files: []
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }

            if (mode === "fallback_success") {
              if (!allText.includes("REPLI SEGMENTÉ")) {
                // Primary single-shot call fails validation (returns empty arrays across all retries)
                return new Response(
                  JSON.stringify({
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              text: JSON.stringify({
                                commit_message: "feat: truncated single-shot",
                                test_summary: "",
                                files: [],
                                patches: [],
                                deleted_files: []
                              })
                            }
                          ]
                        }
                      }
                    ]
                  }),
                  { status: 200 }
                );
              }
              // Chunked fallback calls succeed per target file
              if (allText.includes("src/postgres.ts")) {
                return new Response(
                  JSON.stringify({
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              text: JSON.stringify({
                                commit_message: "feat(ticket-72): add postgres",
                                test_summary: "postgres chunk",
                                files: [
                                  {
                                    path: "src/postgres.ts",
                                    content: "export const pg = 'ready';\n"
                                  }
                                ],
                                patches: [],
                                deleted_files: []
                              })
                            }
                          ]
                        }
                      }
                    ]
                  }),
                  { status: 200 }
                );
              }
              if (allText.includes("src/routes.ts")) {
                return new Response(
                  JSON.stringify({
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              text: JSON.stringify({
                                commit_message: "feat(ticket-72): add routes",
                                test_summary: "routes chunk",
                                files: [
                                  {
                                    path: "src/routes.ts",
                                    content: "export const routes = true;\n"
                                  }
                                ],
                                patches: [],
                                deleted_files: []
                              })
                            }
                          ]
                        }
                      }
                    ]
                  }),
                  { status: 200 }
                );
              }
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              commit_message:
                                "feat(ticket-72): complete chunked slice 1",
                              test_summary: "tests chunk",
                              files: [
                                {
                                  path: "tests/slice1.test.ts",
                                  content: "export const testSuite = true;\n"
                                }
                              ],
                              patches: [],
                              deleted_files: []
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }

            // mode === "fallback_exhausted": both primary and fallback return empty files
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            commit_message: "feat: always empty",
                            test_summary: "",
                            files: [],
                            patches: [],
                            deleted_files: []
                          })
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200 }
            );
          }

          if (urlStr.endsWith("/issues/70") && method === "GET") {
            return new Response(
              JSON.stringify({
                id: 7000,
                number: 70,
                title: "[Plan] Slice 1 Postgres",
                body: "Plan body",
                state: "open"
              }),
              { status: 200 }
            );
          }
          if (urlStr.endsWith("/issues/72") && method === "GET") {
            return new Response(
              JSON.stringify({
                id: 7200,
                number: 72,
                title: "[Ticket 1] Slice 1 Postgres and Routes",
                body: "Ticket body",
                state: "open"
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/issues/70/comments") && method === "GET") {
            return new Response(
              JSON.stringify([
                {
                  id: 701,
                  body: `<!-- epure-plan-manifest:${JSON.stringify(manifestPayload)} -->`,
                  user: { login: "epure-agent[bot]", type: "Bot" },
                  created_at: "2026-10-31T10:00:00Z"
                }
              ]),
              { status: 200 }
            );
          }
          if (urlStr.includes("/git/trees/") && method === "GET") {
            return new Response(
              JSON.stringify({
                tree: [
                  {
                    path: "package.json",
                    type: "blob",
                    size: 100
                  }
                ]
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/contents/package.json") && method === "GET") {
            return new Response(
              JSON.stringify({
                content: Buffer.from(
                  JSON.stringify({
                    name: "slice-test",
                    scripts: { test: "vitest run", build: "tsc -b" }
                  })
                ).toString("base64"),
                encoding: "base64"
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/git/ref/heads/") && method === "GET") {
            return new Response(
              JSON.stringify({ object: { sha: "base-sha-70" } }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/git/commits/") && method === "GET") {
            return new Response(
              JSON.stringify({
                sha: "commit-sha-70",
                tree: { sha: "tree-sha-70" }
              }),
              { status: 200 }
            );
          }
          if (urlStr.endsWith("/git/blobs") && method === "POST") {
            return new Response(JSON.stringify({ sha: "blob-sha-70" }), {
              status: 201
            });
          }
          if (urlStr.endsWith("/git/trees") && method === "POST") {
            return new Response(JSON.stringify({ sha: "new-tree-sha-70" }), {
              status: 201
            });
          }
          if (urlStr.endsWith("/git/commits") && method === "POST") {
            return new Response(JSON.stringify({ sha: "new-commit-sha-70" }), {
              status: 201
            });
          }
          if (urlStr.includes("/git/refs/heads/") && method === "PATCH") {
            const branchName = decodeURIComponent(
              urlStr.split("/git/refs/heads/")[1] ?? ""
            );
            committedBranches.push(branchName);
            return new Response(
              JSON.stringify({ object: { sha: "new-commit-sha-70" } }),
              { status: 200 }
            );
          }
          if (urlStr.endsWith("/git/refs") && method === "POST") {
            return new Response(
              JSON.stringify({ ref: "refs/heads/task/72-slice-1" }),
              { status: 201 }
            );
          }
          if (urlStr.includes("/pulls") && method === "GET") {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          if (urlStr.endsWith("/pulls") && method === "POST") {
            return new Response(
              JSON.stringify({
                number: 172,
                html_url: "https://github.com/acme/repo/pull/172",
                head: { sha: "new-commit-sha-70" },
                mergeable: true
              }),
              { status: 201 }
            );
          }
          if (urlStr.includes("/pulls/172/merge") && method === "PUT") {
            return new Response(
              JSON.stringify({ merged: true, sha: "merged-sha-172" }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/actions/workflows") && method === "GET") {
            return new Response(
              JSON.stringify({ total_count: 0, workflows: [] }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };

        const res = await orchestrateIssueCommand({
          repository: "acme/repo",
          issueNumber: 70,
          command: "approve",
          commandArgs: "",
          commentId: 999,
          actor: "Maintainer",
          fallbackGithubToken: "ghs_mock_token",
          llmApiKey: "AIzaMockKey",
          stateStore,
          fetchImpl: mockFetch,
          sandboxRunner: async () => ({
            isolated: true,
            error_code: "NONE",
            error_message: "",
            exit_code: 0,
            stdout: "All tests passed",
            stderr: "",
            duration_ms: 15,
            proxy_url: "http://127.0.0.1:0"
          })
        });

        expect(res.status).toBe(expectedStatus);
        expect(geminiCallIndex).toBeGreaterThan(0);
        if (mode === "fallback_exhausted") {
          expect(committedBranches).not.toContain(
            "task/72-slice-1-postgres-and-routes"
          );
          expect(res.summary_markdown).toContain(
            "LLM request rejected or response invalid after structured-output retry"
          );
        } else {
          expect(committedBranches).toContain(
            "task/72-slice-1-postgres-and-routes"
          );
        }
      }
    );
  });
});
