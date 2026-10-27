import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_CONFIG,
  parseAgentsYml,
  serializeAgentsYml
} from "../src/bootstrap/setup-repo.js";
import { formatNeedsHumanEscalationComment } from "../src/execution/external-ci-gate.js";
import {
  AuthenticationError,
  GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL,
  LLMClient,
  parseAndValidateStructuredOutput,
  QuotaExhaustedError,
  type ProviderConfig,
  type ResponseSchemaSpec
} from "../src/llm/index.js";
import {
  appendEpureCommandsSpoiler,
  formatEpureCommandsSpoiler
} from "../src/orchestrator/formatting/comments.js";
import {
  orchestrateIssueCommand,
  resolvePhaseModels
} from "../src/orchestrator/issue-orchestrator.js";
import {
  GENERATED_PLANNING_BUNDLE_SCHEMA,
  GRILL_ROUND_EVALUATION_SCHEMA
} from "../src/orchestrator/prompts/schemas.js";
import { runMultiAgentPrReviewPass } from "../src/review/multi-agent-pr-review.js";
import { runUserAdvocateDesignGate } from "../src/review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../src/review/squash-commit-generator.js";
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
          "resolvePhaseModels honours bare claude-* and gpt-* models when ANTHROPIC_API_KEY and OPENAI_API_KEY are set in process.env",
        inputModel: undefined as string | undefined,
        envVars: {
          ANTHROPIC_API_KEY: "sk-ant-env",
          OPENAI_API_KEY: "sk-openai-env"
        } as Record<string, string | undefined>,
        agentsConfig: DEFAULT_AGENTS_CONFIG,
        expectedPlanning: "claude-sonnet-4-20250514",
        expectedImplementation: "claude-sonnet-4-20250514",
        expectedReview: "gpt-4.1"
      },
      {
        scenario:
          "resolvePhaseModels falls back to gemini-3.8-flash for bare default models when no provider config or provider env key is set",
        inputModel: undefined as string | undefined,
        envVars: {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined
        } as Record<string, string | undefined>,
        agentsConfig: DEFAULT_AGENTS_CONFIG,
        expectedPlanning: "gemini-3.8-flash",
        expectedImplementation: "gemini-3.8-flash",
        expectedReview: "gemini-3.8-flash"
      }
    ])(
      "$scenario",
      ({
        inputModel,
        envVars,
        agentsConfig,
        expectedPlanning,
        expectedImplementation,
        expectedReview
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
          const resolved = resolvePhaseModels(inputModel, agentsConfig);
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
});
