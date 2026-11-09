import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEngineError, type AgentSessionRequest } from "../src/agent/engine.js";
import { createPiAgentEngine, resolveVendoredPiDir } from "../src/agent/pi-engine.js";
import { translateModelForPi } from "../src/agent/pi-models.js";
import { snapshotWorktree } from "../src/agent/worktree-snapshot.js";
import { AuthenticationError, BadRequestError } from "../src/llm/errors.js";
import { runWithTokenUsageLedger, TokenUsageLedger } from "../src/usage/token-usage.js";
import { startFakeLlmUpstream, type FakeLlmUpstream } from "./fixtures/fake-llm-upstream.js";

const REAL_KEY = "sk-ant-real-RunnerHeldKey1234567890ABCDEF";
const PROXY_URL = "http://127.0.0.1:4100";

const tempDirs: string[] = [];
const upstreams: FakeLlmUpstream[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
});

function tempWorktree(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "epure-agent-test-"));
  tempDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("translateModelForPi", () => {
  it.each([
    {
      id: "anthropic-overrides-the-built-in-provider",
      model: "anthropic/claude-sonnet-4-5",
      providers: undefined,
      expected: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      expectedProviders: { anthropic: { baseUrl: PROXY_URL, apiKey: "$EPURE_LLM_PROXY_NONCE" } }
    },
    {
      id: "google-built-in-provider-gets-the-v1beta-root",
      model: "google/gemini-2.5-flash",
      providers: undefined,
      expected: { provider: "google", modelId: "gemini-2.5-flash" },
      expectedProviders: { google: { baseUrl: `${PROXY_URL}/v1beta`, apiKey: "$EPURE_LLM_PROXY_NONCE" } }
    },
    {
      id: "openai-overrides-the-built-in-provider",
      model: "openai/gpt-5",
      providers: undefined,
      expected: { provider: "openai", modelId: "gpt-5" },
      expectedProviders: { openai: { baseUrl: PROXY_URL, apiKey: "$EPURE_LLM_PROXY_NONCE" } }
    },
    {
      id: "openrouter-becomes-a-custom-chat-completions-provider",
      model: "openrouter/anthropic/claude-sonnet-4.5",
      providers: undefined,
      expected: { provider: "epure", modelId: "anthropic/claude-sonnet-4.5" },
      expectedProviders: {
        epure: expect.objectContaining({ baseUrl: PROXY_URL, api: "openai-completions", apiKey: "$EPURE_LLM_PROXY_NONCE" })
      }
    },
    {
      id: "azure-uses-the-openai-v1-path",
      model: "azure/gpt-prod",
      providers: undefined,
      expected: { provider: "epure", modelId: "gpt-prod" },
      expectedProviders: { epure: expect.objectContaining({ baseUrl: `${PROXY_URL}/openai/v1`, api: "openai-completions" }) }
    },
    {
      id: "vertex-uses-the-publisher-path",
      model: "vertex/gemini-2.5-pro",
      providers: undefined,
      expected: { provider: "epure", modelId: "gemini-2.5-pro" },
      expectedProviders: {
        epure: expect.objectContaining({ baseUrl: `${PROXY_URL}/v1/publishers/google`, api: "google-generative-ai" })
      }
    },
    {
      id: "openai-compatible-alias-keeps-its-bare-model",
      model: "local/qwen3-coder",
      providers: { local: { provider: "openrouter" as const, base_url: "https://llm.example.com/v1", api_key: "x" } },
      expected: { provider: "epure", modelId: "qwen3-coder" },
      expectedProviders: { epure: expect.objectContaining({ api: "openai-completions", models: [expect.objectContaining({ id: "qwen3-coder" })] }) }
    }
  ])("$id", ({ model, providers, expected, expectedProviders }) => {
    const route = translateModelForPi(model, providers, {});

    expect({ provider: route.provider, modelId: route.modelId }).toEqual(expected);
    expect(JSON.parse(route.modelsJson(PROXY_URL))).toEqual({ providers: expectedProviders });
  });
});

describe("snapshotWorktree", () => {
  it.each([
    {
      id: "added-modified-and-deleted-files",
      before: { "a.txt": "a\n", "b.txt": "b\n", "src/c.ts": "c\n" },
      change: (dir: string) => {
        writeFileSync(join(dir, "a.txt"), "a2\n");
        rmSync(join(dir, "b.txt"));
        writeFileSync(join(dir, "src/new.ts"), "n\n");
      },
      expected: {
        files: [
          { path: "a.txt", content: "a2\n" },
          { path: "src/new.ts", content: "n\n" }
        ],
        deleted_files: ["b.txt"]
      }
    },
    {
      id: "gitignored-output-is-left-out",
      before: { ".gitignore": "node_modules/\n*.log\n" },
      change: (dir: string) => {
        mkdirSync(join(dir, "node_modules/x"), { recursive: true });
        writeFileSync(join(dir, "node_modules/x/index.js"), "x");
        writeFileSync(join(dir, "run.log"), "log");
      },
      expected: { files: [], deleted_files: [] }
    },
    {
      id: "symlinks-and-binary-files-are-left-out",
      before: {},
      change: (dir: string) => {
        symlinkSync("/etc/hostname", join(dir, "host-link"));
        writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
      },
      expected: { files: [], deleted_files: [] }
    },
    {
      id: "unchanged-worktree-has-an-empty-diff",
      before: { "a.txt": "a\n" },
      change: () => {},
      expected: { files: [], deleted_files: [] }
    }
  ])("$id", ({ before, change, expected }) => {
    const dir = tempWorktree(before);
    const snapshot = snapshotWorktree(dir);
    try {
      change(dir);
      expect(snapshot.diff()).toEqual(expected);
    } finally {
      snapshot.dispose();
    }
  });

  it("never runs hooks or fsmonitor planted in the worktree's own .git", () => {
    const dir = tempWorktree({ "a.txt": "a\n" });
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    const marker = join(dir, "..", `${dir.split("/").pop()}-pwned`);
    const script = join(dir, ".git", "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(dir, ".git", "config"), `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${join(dir, ".git")}\n`);
    const snapshot = snapshotWorktree(dir);
    try {
      writeFileSync(join(dir, "a.txt"), "b\n");
      expect(snapshot.diff().files).toEqual([{ path: "a.txt", content: "b\n" }]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      snapshot.dispose();
    }
  });
});

// Anthropic Messages streaming, as the SDK inside Pi parses it (named SSE events).
function anthropicStream(
  content: { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown } | { readonly type: "text"; readonly text: string },
  usage: { readonly input: number; readonly output: number }
): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: 1 }
      }
    },
    content.type === "tool_use"
      ? { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: content.id, name: content.name, input: {} } }
      : { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    content.type === "tool_use"
      ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) } }
      : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content.text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: content.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output }
    },
    { type: "message_stop" }
  ];
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function scriptedUpstream(turns: readonly string[]): Promise<FakeLlmUpstream> {
  let turn = 0;
  return startFakeLlmUpstream((_req, res: ServerResponse) => {
    const body = turns[Math.min(turn, turns.length - 1)] ?? "";
    turn += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  });
}

function sessionRequest(worktree: string, overrides: Partial<AgentSessionRequest> = {}): AgentSessionRequest {
  return {
    role: "implementer",
    toolPolicy: "write",
    instructions: "You implement tickets.",
    prompt: "Create hello.txt and remove obsolete.txt.",
    worktree,
    timeoutMs: 60_000,
    model: "anthropic/claude-sonnet-4-5",
    ...overrides
  };
}

const PI_AVAILABLE = (() => {
  try {
    resolveVendoredPiDir();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!PI_AVAILABLE)("Pi agent engine in the sandbox, against a fake provider", () => {
  it("edits the worktree through Pi's tools and reports usage once, through the proxy", async () => {
    const upstream = await scriptedUpstream([
      anthropicStream({ type: "tool_use", id: "toolu_1", name: "write", input: { path: "hello.txt", content: "hello\n" } }, { input: 100, output: 20 }),
      anthropicStream({ type: "tool_use", id: "toolu_2", name: "bash", input: { command: "rm obsolete.txt" } }, { input: 150, output: 10 }),
      anthropicStream({ type: "text", text: "Done: hello.txt created." }, { input: 200, output: 5 })
    ]);
    upstreams.push(upstream);
    const worktree = tempWorktree({ "obsolete.txt": "old\n", "keep.txt": "keep\n" });
    const engine = createPiAgentEngine({
      runnerEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: REAL_KEY, ANTHROPIC_BASE_URL: upstream.url }
    });
    const ledger = new TokenUsageLedger();

    const result = await runWithTokenUsageLedger(ledger, { phase: "implementation", ticket: 7 }, () =>
      engine.run(
        sessionRequest(worktree, {
          providers: { anthropic: { provider: "anthropic", base_url: upstream.url, api_key: REAL_KEY } }
        })
      )
    );

    expect(result).toEqual({
      finalMessage: "Done: hello.txt created.",
      diff: { files: [{ path: "hello.txt", content: "hello\n" }], deleted_files: ["obsolete.txt"] }
    });
    expect(upstream.requests).toHaveLength(3);
    for (const req of upstream.requests) {
      expect(req.url).toMatch(/^\/v1\/messages/);
      expect(req.headers["x-api-key"]).toBe(REAL_KEY);
    }
    expect(ledger.current()).toEqual({
      "7": {
        implementation: {
          "anthropic/claude-sonnet-4-5": expect.objectContaining({ requests: 3, input_tokens: 450, output_tokens: 35 })
        }
      }
    });
  }, 120_000);

  it.each([
    {
      id: "rejected-key-becomes-an-authentication-error",
      status: 401,
      body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      expected: AuthenticationError
    },
    {
      id: "invalid-request-becomes-a-bad-request-error",
      status: 400,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}',
      expected: BadRequestError
    }
  ])("$id", async ({ status, body, expected }) => {
    const upstream = await startFakeLlmUpstream((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    upstreams.push(upstream);
    const worktree = tempWorktree({ "a.txt": "a\n" });
    const engine = createPiAgentEngine({ runnerEnv: { PATH: process.env.PATH } });

    const run = engine.run(
      sessionRequest(worktree, {
        providers: { anthropic: { provider: "anthropic", base_url: upstream.url, api_key: REAL_KEY } }
      })
    );

    await expect(run).rejects.toBeInstanceOf(expected);
  }, 120_000);

  it("aborts a session that outlives its timeout", async () => {
    const upstream = await startFakeLlmUpstream(() => {
      // never answers
    });
    upstreams.push(upstream);
    const worktree = tempWorktree({ "a.txt": "a\n" });
    const engine = createPiAgentEngine({ runnerEnv: { PATH: process.env.PATH } });

    const run = engine.run(
      sessionRequest(worktree, {
        timeoutMs: 2_000,
        providers: { anthropic: { provider: "anthropic", base_url: upstream.url, api_key: REAL_KEY } }
      })
    );

    await expect(run).rejects.toMatchObject({ name: "AgentEngineError", code: "AGENT_TIMEOUT" });
    await expect(run).rejects.toBeInstanceOf(AgentEngineError);
  }, 120_000);
});
