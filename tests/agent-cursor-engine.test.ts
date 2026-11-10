import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCursorPrompt,
  createCursorAgentEngine,
  CURSOR_ISOLATION_WARNING,
  resolveCursorToolsForPolicy,
  translateModelForCursor,
  type CursorSdkModule
} from "../src/agent/cursor-engine.js";
import {
  AgentEngineError,
  type AgentEngine,
  type AgentSessionRequest,
  resolveLifecycleAgentEngine
} from "../src/agent/engine.js";
import { parseAgentsYaml, planAndApplyRepoSetup } from "../src/bootstrap/setup-repo.js";
import {
  AuthenticationError as LLMAuthenticationError,
  BadRequestError,
  RateLimitError
} from "../src/llm/errors.js";
import { loadRepoAgentsConfig } from "../src/orchestrator/github/rest-client.js";
import { runWithTokenUsageLedger, TokenUsageLedger } from "../src/usage/token-usage.js";

const CURSOR_KEY = "cur_svc_RealCursorServiceKey1234567890";
const INSTALLATION_TOKEN = "ghs_installationToken1234567890abcdef";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempWorktree(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "epure-cursor-test-"));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(join(dir, relPath, ".."), { recursive: true });
    writeFileSync(join(dir, relPath), content, "utf8");
  }
  return dir;
}

function sessionRequest(
  worktree: string,
  overrides: Partial<AgentSessionRequest> = {}
): AgentSessionRequest {
  return {
    role: "implementer",
    toolPolicy: "write",
    instructions: "Follow repository architecture invariants.",
    prompt: "Create hello.txt and remove obsolete.txt.",
    worktree,
    timeoutMs: 30_000,
    model: "anthropic/claude-sonnet-4-5",
    ...overrides
  };
}

describe("translateModelForCursor", () => {
  it.each([
    {
      id: "strips-anthropic-provider-prefix",
      model: "anthropic/claude-sonnet-4-5",
      thinking: undefined,
      expected: {
        modelId: "claude-sonnet-4-5",
        providerPrefix: "anthropic"
      }
    },
    {
      id: "maps-openai-model-and-high-thinking-level",
      model: "openai/gpt-5",
      thinking: "high" as const,
      expected: {
        modelId: "gpt-5",
        providerPrefix: "openai",
        params: [{ id: "thinking", value: "high" }]
      }
    },
    {
      id: "maps-google-model-and-medium-thinking-level",
      model: "google/gemini-2.5-pro",
      thinking: "medium" as const,
      expected: {
        modelId: "gemini-2.5-pro",
        providerPrefix: "google",
        params: [{ id: "thinking", value: "medium" }]
      }
    },
    {
      id: "strips-openrouter-and-vendor-prefix",
      model: "openrouter/anthropic/claude-sonnet-4.5",
      thinking: "low" as const,
      expected: {
        modelId: "claude-sonnet-4.5",
        providerPrefix: "openrouter",
        params: [{ id: "thinking", value: "low" }]
      }
    },
    {
      id: "preserves-bare-cursor-model-id",
      model: "claude-4-sonnet",
      thinking: undefined,
      expected: {
        modelId: "claude-4-sonnet",
        providerPrefix: null
      }
    }
  ])("$id", ({ model, thinking, expected }) => {
    expect(translateModelForCursor(model, thinking)).toEqual(expected);
  });

  it.each([
    { id: "rejects-empty-model-id", model: "   " },
    { id: "rejects-slash-only-model-id", model: "///" }
  ])("$id", ({ model }) => {
    expect(() => translateModelForCursor(model)).toThrow(BadRequestError);
  });
});

describe("resolveCursorToolsForPolicy and buildCursorPrompt", () => {
  it.each([
    {
      id: "read-only-policy-disallows-edits-shell-subagents-and-mcp-and-suppresses-shell-executor",
      policy: "read_only" as const,
      expected: {
        tools: ["read", "glob", "grep", "ls", "semSearch"],
        disallowedTools: ["edit", "delete", "shell", "task", "mcp"],
        suppressDefaultShellExecutor: true
      }
    },
    {
      id: "write-policy-enables-workspace-tools-and-disallows-subagents-and-mcp",
      policy: "write" as const,
      expected: {
        tools: ["read", "edit", "delete", "glob", "grep", "ls", "shell", "semSearch"],
        disallowedTools: ["task", "mcp"],
        suppressDefaultShellExecutor: false
      }
    }
  ])("$id", ({ policy, expected }) => {
    expect(resolveCursorToolsForPolicy(policy)).toEqual(expected);
  });

  it.each([
    {
      id: "prepends-system-instructions-block-when-present",
      instructions: "Never touch .github/workflows.",
      prompt: "Fix the parser.",
      expected: "<system_instructions>\nNever touch .github/workflows.\n</system_instructions>\n\nFix the parser."
    },
    {
      id: "returns-raw-prompt-when-instructions-are-empty",
      instructions: "   ",
      prompt: "Fix the parser.",
      expected: "Fix the parser."
    }
  ])("$id", ({ instructions, prompt, expected }) => {
    expect(buildCursorPrompt(instructions, prompt)).toBe(expected);
  });
});

describe("createCursorAgentEngine", () => {
  it("fails immediately with LLMAuthenticationError when CURSOR_API_KEY is missing", async () => {
    const createSpy = vi.fn();
    const engine = createCursorAgentEngine({
      runnerEnv: {},
      sdkLoader: async () => ({ Agent: { create: createSpy } as unknown as CursorSdkModule["Agent"] })
    });

    await expect(engine.run(sessionRequest(tempWorktree({})))).rejects.toBeInstanceOf(
      LLMAuthenticationError
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      id: "write-session-applies-worktree-diff-records-token-usage-and-disposes-agent",
      role: "implementer" as const,
      toolPolicy: "write" as const,
      thinking: "high" as const,
      usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 30, cacheWriteTokens: 10 },
      mutateWorktree: (dir: string) => {
        writeFileSync(join(dir, "hello.txt"), "hello world\n", "utf8");
        rmSync(join(dir, "obsolete.txt"));
      },
      expectedDiff: {
        files: [{ path: "hello.txt", content: "hello world\n", mode: "100644" }],
        deleted_files: ["obsolete.txt"],
        skipped: []
      },
      expectedLedgerCounts: {
        requests: 1,
        input_tokens: 160,
        cached_input_tokens: 30,
        output_tokens: 45,
        thinking_tokens: 0
      }
    },
    {
      id: "read-only-session-reverts-unexpected-mutations-and-records-unavailable-usage-when-omitted",
      role: "reviewer" as const,
      toolPolicy: "read_only" as const,
      thinking: "low" as const,
      usage: undefined,
      mutateWorktree: (dir: string) => {
        writeFileSync(join(dir, "unexpected.txt"), "should not persist\n", "utf8");
      },
      expectedDiff: {
        files: [],
        deleted_files: [],
        skipped: []
      },
      expectedLedgerCounts: {
        requests: 1,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        usage_unavailable: 1
      }
    }
  ])(
    "$id",
    async ({ role, toolPolicy, thinking, usage, mutateWorktree, expectedDiff, expectedLedgerCounts }) => {
      const worktree = tempWorktree({ "obsolete.txt": "old\n", "keep.txt": "keep\n" });
      const disposeSpy = vi.fn(async () => undefined);
      let capturedCreateOptions: Record<string, unknown> | undefined;
      let capturedPrompt = "";

      const engine = createCursorAgentEngine({
        runnerEnv: { CURSOR_API_KEY: CURSOR_KEY },
        sdkLoader: async () => ({
          Agent: {
            create: vi.fn(async (opts: Record<string, unknown>) => {
              capturedCreateOptions = opts;
              return {
                send: async (prompt: string) => {
                  capturedPrompt = prompt;
                  mutateWorktree(worktree);
                  return {
                    wait: async () => ({
                      id: "run-1",
                      status: "finished" as const,
                      result: "Session completed.",
                      ...(usage ? { usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } } : {})
                    }),
                    cancel: async () => undefined
                  };
                },
                getUsage: async () => ({
                  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
                  runs: []
                }),
                [Symbol.asyncDispose]: disposeSpy
              };
            })
          } as unknown as CursorSdkModule["Agent"]
        })
      });

      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ledger = new TokenUsageLedger();

      try {
        const res = await runWithTokenUsageLedger(
          ledger,
          { phase: "implementation", ticket: 11 },
          () => engine.run(sessionRequest(worktree, { role, toolPolicy, thinking }))
        );

        expect(res.finalMessage).toBe("Session completed.");
        expect(res.diff).toEqual(expectedDiff);
        expect(capturedPrompt).toContain("<system_instructions>");
        expect(capturedCreateOptions).toMatchObject({
          apiKey: CURSOR_KEY,
          model: {
            id: "claude-sonnet-4-5",
            params: [{ id: "thinking", value: thinking }]
          },
          mcpServers: {},
          disallowedTools: expect.arrayContaining(["task", "mcp"]),
          local: expect.objectContaining({
            cwd: worktree,
            settingSources: [],
            ...(toolPolicy === "read_only"
              ? { resourceProviderOptions: { suppressDefaultShellExecutor: true } }
              : {})
          })
        });
        if (toolPolicy === "read_only") {
          expect(existsSync(join(worktree, "unexpected.txt"))).toBe(false);
        }
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(CURSOR_ISOLATION_WARNING));
        expect(ledger.current()).toEqual({
          "11": {
            implementation: {
              "anthropic/claude-sonnet-4-5": expectedLedgerCounts
            }
          }
        });
      } finally {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
      }
    }
  );

  it.each([
    {
      id: "authentication-error-maps-to-LLMAuthenticationError-and-redacts-key",
      thrownError: Object.assign(new Error(`401 Unauthorized for key ${CURSOR_KEY}`), {
        name: "AuthenticationError"
      }),
      expectedClass: LLMAuthenticationError
    },
    {
      id: "rate-limit-error-maps-to-RateLimitError-and-redacts-key",
      thrownError: new Error(`429 rate limit exceeded (${CURSOR_KEY})`),
      expectedClass: RateLimitError
    },
    {
      id: "configuration-error-maps-to-BadRequestError",
      thrownError: Object.assign(new Error("400 invalid_argument: context length exceeded"), {
        name: "ConfigurationError"
      }),
      expectedClass: BadRequestError
    },
    {
      id: "unexpected-runtime-error-maps-to-AgentEngineError-AGENT_PROTOCOL_ERROR",
      thrownError: new Error(`stream disconnected with token ${INSTALLATION_TOKEN}`),
      expectedClass: AgentEngineError
    }
  ])("$id", async ({ thrownError, expectedClass }) => {
    const engine = createCursorAgentEngine({
      runnerEnv: { CURSOR_API_KEY: CURSOR_KEY },
      extraSecrets: [INSTALLATION_TOKEN],
      sdkLoader: async () => ({
        Agent: {
          create: vi.fn(async () => ({
            send: async () => ({
              wait: async () => {
                throw thrownError;
              },
              cancel: async () => undefined
            }),
            [Symbol.asyncDispose]: async () => undefined
          }))
        } as unknown as CursorSdkModule["Agent"]
      })
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const promise = engine.run(
        sessionRequest(tempWorktree({}), { secrets: [INSTALLATION_TOKEN] })
      );
      await expect(promise).rejects.toBeInstanceOf(expectedClass);
      await expect(promise).rejects.not.toHaveProperty(
        "message",
        expect.stringContaining(CURSOR_KEY)
      );
      await expect(promise).rejects.not.toHaveProperty(
        "message",
        expect.stringContaining(INSTALLATION_TOKEN)
      );
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it.each([
    {
      id: "secret-written-into-worktree-file-fails-with-AGENT_SECRET_IN_DIFF",
      mutate: (dir: string) => writeFileSync(join(dir, "leak.txt"), `key=${CURSOR_KEY}\n`, "utf8"),
      finalText: "Done."
    },
    {
      id: "secret-in-final-message-fails-with-AGENT_SECRET_IN_DIFF",
      mutate: () => undefined,
      finalText: `Used token ${INSTALLATION_TOKEN}`
    }
  ])("$id", async ({ mutate, finalText }) => {
    const worktree = tempWorktree({ "a.txt": "a\n" });
    const engine = createCursorAgentEngine({
      runnerEnv: { CURSOR_API_KEY: CURSOR_KEY },
      sdkLoader: async () => ({
        Agent: {
          create: vi.fn(async () => ({
            send: async () => {
              mutate(worktree);
              return {
                wait: async () => ({
                  id: "run-1",
                  status: "finished" as const,
                  result: finalText
                }),
                cancel: async () => undefined
              };
            },
            getUsage: async () => ({
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
              runs: []
            }),
            [Symbol.asyncDispose]: async () => undefined
          }))
        } as unknown as CursorSdkModule["Agent"]
      })
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const promise = engine.run(sessionRequest(worktree, { secrets: [INSTALLATION_TOKEN] }));
      await expect(promise).rejects.toMatchObject({
        name: "AgentEngineError",
        code: "AGENT_SECRET_IN_DIFF"
      });
      await expect(promise).rejects.not.toHaveProperty(
        "message",
        expect.stringContaining(CURSOR_KEY)
      );
      await expect(promise).rejects.not.toHaveProperty(
        "message",
        expect.stringContaining(INSTALLATION_TOKEN)
      );
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("aborts the session with AGENT_REQUEST_CAP_REACHED when steps exceed maxLlmRequests", async () => {
    const cancelSpy = vi.fn(async () => undefined);
    const engine = createCursorAgentEngine({
      runnerEnv: { CURSOR_API_KEY: CURSOR_KEY },
      sdkLoader: async () => ({
        Agent: {
          create: vi.fn(async () => ({
            send: async (
              _prompt: string,
              opts?: { onStep?: (args: { step: { type: string; message?: { text: string } } }) => void }
            ) => ({
              wait: async () => {
                opts?.onStep?.({ step: { type: "toolCall" } });
                opts?.onStep?.({ step: { type: "assistantMessage", message: { text: "step 2" } } });
                opts?.onStep?.({ step: { type: "toolCall" } });
                return {
                  id: "run-1",
                  status: "cancelled" as const,
                  result: ""
                };
              },
              cancel: cancelSpy
            }),
            [Symbol.asyncDispose]: async () => undefined
          }))
        } as unknown as CursorSdkModule["Agent"]
      })
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(
        engine.run(sessionRequest(tempWorktree({}), { maxLlmRequests: 2 }))
      ).rejects.toMatchObject({
        name: "AgentEngineError",
        code: "AGENT_REQUEST_CAP_REACHED"
      });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("aborts the session with AGENT_TIMEOUT when wait exceeds timeoutMs", async () => {
    const cancelSpy = vi.fn(async () => undefined);
    const engine = createCursorAgentEngine({
      runnerEnv: { CURSOR_API_KEY: CURSOR_KEY },
      sdkLoader: async () => ({
        Agent: {
          create: vi.fn(async () => ({
            send: async () => ({
              wait: () => new Promise(() => {}),
              cancel: cancelSpy
            }),
            [Symbol.asyncDispose]: async () => undefined
          }))
        } as unknown as CursorSdkModule["Agent"]
      })
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(
        engine.run(sessionRequest(tempWorktree({}), { timeoutMs: 50 }))
      ).rejects.toMatchObject({
        name: "AgentEngineError",
        code: "AGENT_TIMEOUT"
      });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});

describe("Harness configuration validation (pi | cursor)", () => {
  it.each([
    { id: "accepts-pi-harness", yaml: "harness: pi\n", expected: "pi" },
    { id: "accepts-cursor-harness", yaml: "harness: cursor\n", expected: "cursor" }
  ])("$id", ({ yaml, expected }) => {
    expect(parseAgentsYaml(yaml).harness).toBe(expected);
  });

  it.each([
    { id: "rejects-removed-codex-harness", yaml: "harness: codex\n", badValue: "codex" },
    { id: "rejects-unknown-harness-value", yaml: "harness: custom-agent\n", badValue: "custom-agent" }
  ])("$id", async ({ yaml, badValue }) => {
    expect(() => parseAgentsYaml(yaml)).toThrow(
      `Invalid .github/agents.yml harness '${badValue}'; expected 'pi' or 'cursor'.`
    );
    await expect(
      loadRepoAgentsConfig(
        {
          readSingleBranchFile: async (_branch, path) =>
            path === ".github/agents.yml" ? yaml : null
        },
        "dev"
      )
    ).rejects.toThrow(`Invalid .github/agents.yml on 'dev': Invalid .github/agents.yml harness '${badValue}'; expected 'pi' or 'cursor'.`);
  });

  it("configures CURSOR_API_KEY and isolation warning when setup-repo runs with harness=cursor", () => {
    const dir = tempWorktree({});
    const result = planAndApplyRepoSetup({
      repository: "acme-org/cursor-consumer",
      repoRootDir: dir,
      dryRun: false,
      agentsOverrides: { harness: "cursor" }
    });

    expect(result.status).toBe("applied");
    expect(result.agents_config.harness).toBe("cursor");
    expect(result.expected_secrets.map((s) => s.name)).toContain("CURSOR_API_KEY");
    expect(result.human_interventions.map((h) => h.id)).toContain(
      "cursor_harness_isolation_notice"
    );
    expect(result.summary_markdown).toContain(CURSOR_ISOLATION_WARNING);

    const workflowContent = readFileSync(
      join(dir, ".github", "workflows", "epure-issue-command.yml"),
      "utf8"
    );
    expect(workflowContent).toContain("cursor_api_key: ${{ secrets.CURSOR_API_KEY }}");
  });

  it.each([
    { id: "accepts-pi-engine-for-lifecycle-phases", name: "pi", expectedDefined: true },
    { id: "accepts-cursor-engine-for-lifecycle-phases", name: "cursor", expectedDefined: true },
    { id: "excludes-mock-test-engine-from-lifecycle-phases", name: "test-engine", expectedDefined: false }
  ])("$id", ({ name, expectedDefined }) => {
    const engine: AgentEngine = {
      name,
      run: vi.fn()
    };
    const resolved = resolveLifecycleAgentEngine(engine);
    expect(resolved !== undefined).toBe(expectedDefined);
  });
});
