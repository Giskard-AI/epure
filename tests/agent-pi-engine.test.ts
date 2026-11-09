import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  AgentEngineError,
  assertNoSecretMaterial,
  type AgentSessionRequest,
  type WorktreeDiff
} from "../src/agent/engine.js";
import { createPiAgentEngine, resolveVendoredPiDir } from "../src/agent/pi-engine.js";
import { translateModelForPi } from "../src/agent/pi-models.js";
import { listTrackedPaths, snapshotWorktree } from "../src/agent/worktree-snapshot.js";
import { AuthenticationError, BadRequestError } from "../src/llm/errors.js";
import type { SandboxExecutionInput, SandboxExecutionResult } from "../src/sandbox/llm-sandbox.js";
import { isSensitiveTaskBranchPath } from "../src/sandbox/polyglot-workspace-runner.js";
import { runWithTokenUsageLedger, TokenUsageLedger } from "../src/usage/token-usage.js";
import { startFakeLlmUpstream, type FakeLlmUpstream } from "./fixtures/fake-llm-upstream.js";

const REAL_KEY = "sk-ant-real-RunnerHeldKey1234567890ABCDEF";
const INSTALLATION_TOKEN = "ghs_installationToken1234567890abcdef";
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

// Every path under the worktree except .git, with its content (or "<symlink>"), sorted.
function treeOf(dir: string, prefix = ""): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(dir, rel));
    if (rel === ".git") {
      continue;
    } else if (stat.isSymbolicLink()) {
      entries[rel] = "<symlink>";
    } else if (stat.isDirectory()) {
      Object.assign(entries, treeOf(dir, rel));
    } else {
      entries[rel] = readFileSync(join(dir, rel)).toString("latin1");
    }
  }
  return entries;
}

// The worktree a commit of `diff` on top of `before` would publish.
function publishedTree(before: Readonly<Record<string, string>>, diff: WorktreeDiff): Record<string, string> {
  const tree: Record<string, string> = { ...before };
  for (const path of diff.deleted_files) {
    delete tree[path];
  }
  for (const f of diff.files) {
    tree[f.path] = Buffer.from(f.content, "utf8").toString("latin1");
  }
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)));
}

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
          { path: "a.txt", content: "a2\n", mode: "100644" },
          { path: "src/new.ts", content: "n\n", mode: "100644" }
        ],
        deleted_files: ["b.txt"],
        skipped: []
      }
    },
    {
      id: "executable-bit-is-carried-with-the-file",
      before: { "run.sh": "#!/bin/sh\necho hi\n" },
      change: (dir: string) => {
        chmodSync(join(dir, "run.sh"), 0o755);
        writeFileSync(join(dir, "new.sh"), "#!/bin/sh\n", { mode: 0o755 });
      },
      expected: {
        files: [
          { path: "new.sh", content: "#!/bin/sh\n", mode: "100755" },
          { path: "run.sh", content: "#!/bin/sh\necho hi\n", mode: "100755" }
        ],
        deleted_files: [],
        skipped: []
      }
    },
    {
      id: "utf8-byte-order-mark-is-kept",
      before: {},
      change: (dir: string) => {
        writeFileSync(join(dir, "bom.cs"), "\uFEFFclass A {}\n");
      },
      expected: {
        files: [{ path: "bom.cs", content: "\uFEFFclass A {}\n", mode: "100644" }],
        deleted_files: [],
        skipped: []
      }
    },
    {
      id: "new-gitignored-file-is-reported-and-removed",
      before: { ".gitignore": "*.log\n" },
      change: (dir: string) => {
        writeFileSync(join(dir, "run.log"), "log");
      },
      expected: { files: [], deleted_files: [], skipped: [{ path: "run.log", reason: "ignored" }] }
    },
    {
      id: "new-dependency-and-build-output-without-a-gitignore-is-reported-and-removed",
      before: {},
      change: (dir: string) => {
        for (const path of ["node_modules/.vite/x.js", "dist/index.js", "coverage/lcov.info", "tsconfig.tsbuildinfo"]) {
          mkdirSync(join(dir, path, ".."), { recursive: true });
          writeFileSync(join(dir, path), "x");
        }
      },
      expected: {
        files: [],
        deleted_files: [],
        skipped: [
          { path: "coverage", reason: "ignored" },
          { path: "dist", reason: "ignored" },
          { path: "node_modules", reason: "ignored" },
          { path: "tsconfig.tsbuildinfo", reason: "ignored" }
        ]
      }
    },
    {
      id: "nested-build-directory-is-source-and-committed",
      before: {},
      change: (dir: string) => {
        mkdirSync(join(dir, "src/build"), { recursive: true });
        writeFileSync(join(dir, "src/build/plan.ts"), "export const p = 1;\n");
      },
      expected: {
        files: [{ path: "src/build/plan.ts", content: "export const p = 1;\n", mode: "100644" }],
        deleted_files: [],
        skipped: []
      }
    },
    {
      id: "symlink-binary-and-non-utf8-files-are-reported-and-removed",
      before: { "keep.txt": "k\n" },
      change: (dir: string) => {
        symlinkSync("/etc/hostname", join(dir, "host-link"));
        writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
        writeFileSync(join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      },
      expected: {
        files: [],
        deleted_files: [],
        skipped: [
          { path: "host-link", reason: "symlink" },
          { path: "blob.bin", reason: "binary" },
          { path: "latin1.txt", reason: "binary" }
        ]
      }
    },
    {
      id: "edited-binary-is-put-back-to-its-snapshot-content",
      before: { "img.bin": "\u0000old" },
      change: (dir: string) => {
        writeFileSync(join(dir, "img.bin"), "\u0000new");
      },
      expected: { files: [], deleted_files: [], skipped: [{ path: "img.bin", reason: "binary" }] }
    },
    {
      id: "unchanged-worktree-has-an-empty-diff",
      before: { "a.txt": "a\n" },
      change: () => {},
      expected: { files: [], deleted_files: [], skipped: [] }
    }
  ] as const)("$id", async ({ before, change, expected }) => {
    const dir = tempWorktree(before);
    const snapshot = await snapshotWorktree(dir);
    try {
      change(dir);
      const diff = await snapshot.collect();

      expect({ ...diff, files: [...diff.files].sort((a, b) => a.path.localeCompare(b.path)) }).toEqual(expected);
      expect(treeOf(dir)).toEqual(expect.objectContaining(publishedTree(before, diff)));
      for (const s of diff.skipped) {
        expect(treeOf(dir)[s.path]).toBe(before[s.path as keyof typeof before]);
        expect(existsSync(join(dir, s.path))).toBe(s.path in before);
      }
    } finally {
      snapshot.dispose();
    }
  });

  it("agent-adding-a-binary-a-test-needs-leaves-a-worktree-where-that-test-fails-as-it-would-on-the-published-tree", async () => {
    const dir = tempWorktree({ "package.json": "{}\n" });
    const snapshot = await snapshotWorktree(dir);
    try {
      writeFileSync(join(dir, "fixture.bin"), Buffer.from([0, 255, 1]));
      writeFileSync(join(dir, "fixture.test.cjs"), "require('node:fs').readFileSync(__dirname + '/fixture.bin');\n");
      const runTest = () => execFileSync(process.execPath, ["fixture.test.cjs"], { cwd: dir, stdio: "pipe" });
      expect(runTest).not.toThrow();

      const diff = await snapshot.collect();

      expect(diff.files.map((f) => f.path)).toEqual(["fixture.test.cjs"]);
      expect(diff.skipped).toEqual([{ path: "fixture.bin", reason: "binary" }]);
      expect(treeOf(dir)).toEqual(publishedTree({ "package.json": "{}\n" }, diff));
      expect(runTest).toThrow();
    } finally {
      snapshot.dispose();
    }
  });

  it.each([
    {
      id: "edit-to-a-tracked-but-gitignored-file-is-kept",
      before: { ".gitignore": "*.lock\n", "deps.lock": "v1\n" },
      trackedPaths: ["deps.lock", ".gitignore"],
      isProtectedPath: undefined,
      change: (dir: string) => writeFileSync(join(dir, "deps.lock"), "v2\n"),
      expected: { files: [{ path: "deps.lock", content: "v2\n", mode: "100644" }], deleted_files: [], skipped: [] },
      expectedTree: { ".gitignore": "*.lock\n", "deps.lock": "v2\n" }
    },
    {
      id: "protected-paths-are-put-back-and-reported",
      before: { ".github/workflows/ci.yml": "on: push\n", "src/a.ts": "a\n" },
      trackedPaths: undefined,
      isProtectedPath: (path: string) => path.startsWith(".github/workflows/") || path.startsWith(".env"),
      change: (dir: string) => {
        writeFileSync(join(dir, ".github/workflows/ci.yml"), "on: pull_request_target\n");
        writeFileSync(join(dir, ".env.local"), "TOKEN=x\n");
        writeFileSync(join(dir, "src/a.ts"), "b\n");
      },
      expected: {
        files: [{ path: "src/a.ts", content: "b\n", mode: "100644" }],
        deleted_files: [],
        skipped: [
          { path: ".env.local", reason: "protected" },
          { path: ".github/workflows/ci.yml", reason: "protected" }
        ]
      },
      expectedTree: { ".github/workflows/ci.yml": "on: push\n", "src/a.ts": "b\n" }
    },
    {
      id: "new-file-in-a-tracked-dist-directory-is-committed",
      before: { "dist/index.js": "v1\n" },
      trackedPaths: ["dist/index.js"],
      isProtectedPath: undefined,
      change: (dir: string) => writeFileSync(join(dir, "dist/extra.js"), "e\n"),
      expected: { files: [{ path: "dist/extra.js", content: "e\n", mode: "100644" }], deleted_files: [], skipped: [] },
      expectedTree: { "dist/extra.js": "e\n", "dist/index.js": "v1\n" }
    },
    {
      id: "ignored-files-in-a-directory-ignored-before-are-kept-and-not-reported",
      before: { ".gitignore": "*.log\n", "logs/old.log": "old\n" },
      trackedPaths: undefined,
      isProtectedPath: undefined,
      change: (dir: string) => writeFileSync(join(dir, "logs/new.log"), "new\n"),
      expected: { files: [], deleted_files: [], skipped: [] },
      expectedTree: { ".gitignore": "*.log\n", "logs/new.log": "new\n", "logs/old.log": "old\n" }
    },
    {
      id: "directory-folded-into-one-ignored-entry-keeps-its-pre-existing-ignored-file",
      before: { ".gitignore": "*.log\n", "tmp/a.log": "old\n", "tmp/keep.ts": "k\n" },
      trackedPaths: undefined,
      isProtectedPath: undefined,
      change: (dir: string) => rmSync(join(dir, "tmp/keep.ts")),
      expected: { files: [], deleted_files: ["tmp/keep.ts"], skipped: [] },
      expectedTree: { ".gitignore": "*.log\n", "tmp/a.log": "old\n" }
    },
    {
      id: "new-ignored-directory-next-to-a-pre-existing-one-is-reported-and-removed",
      before: { ".gitignore": "*.log\n", "logs/old.log": "old\n" },
      trackedPaths: undefined,
      isProtectedPath: undefined,
      change: (dir: string) => {
        mkdirSync(join(dir, "logs2"));
        writeFileSync(join(dir, "logs2/new.log"), "new\n");
      },
      expected: { files: [], deleted_files: [], skipped: [{ path: "logs2", reason: "ignored" }] },
      expectedTree: { ".gitignore": "*.log\n", "logs/old.log": "old\n" }
    }
  ])("$id", async ({ before, trackedPaths, isProtectedPath, change, expected, expectedTree }) => {
    const dir = tempWorktree(before);
    const snapshot = await snapshotWorktree(dir, { trackedPaths, isProtectedPath });
    try {
      change(dir);

      expect(await snapshot.collect()).toEqual(expected);
      expect(treeOf(dir)).toEqual(expectedTree);
    } finally {
      snapshot.dispose();
    }
  });

  const replaceWithFile = (path: string) => (dir: string) => {
    rmSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path), "x\n");
  };
  const replaceWithDirectory = (path: string) => (dir: string) => {
    rmSync(join(dir, path));
    mkdirSync(join(dir, path));
    writeFileSync(join(dir, path, "x"), "x\n");
  };
  it.each([
    {
      id: "github-directory-replaced-by-a-file",
      before: { ".github/workflows/ci.yml": "on: push\n", "src/a.ts": "a\n" },
      change: replaceWithFile(".github"),
      expectedSkipped: [".github", ".github/workflows/ci.yml"]
    },
    {
      id: "agents-directory-replaced-by-a-file",
      before: { ".agents/reviewers/security.md": "r\n", "src/a.ts": "a\n" },
      change: replaceWithFile(".agents"),
      expectedSkipped: [".agents", ".agents/reviewers/security.md"]
    },
    {
      id: "agents-yml-replaced-by-a-directory",
      before: { ".github/agents.yml": "models: {}\n", "src/a.ts": "a\n" },
      change: replaceWithDirectory(".github/agents.yml"),
      expectedSkipped: [".github/agents.yml", ".github/agents.yml/x"]
    },
    {
      id: "env-file-replaced-by-a-directory",
      before: { ".env": "TOKEN=1\n", "src/a.ts": "a\n" },
      change: replaceWithDirectory(".env"),
      expectedSkipped: [".env", ".env/x"]
    },
    {
      id: "directory-holding-a-nested-env-file-replaced-by-a-file",
      before: { "config/.env.production": "TOKEN=1\n", "src/a.ts": "a\n" },
      change: replaceWithFile("config"),
      expectedSkipped: ["config", "config/.env.production"]
    }
  ])("[$id] a file/directory swap over a protected path is put back and reported", async ({ before, change, expectedSkipped }) => {
    const dir = tempWorktree(before);
    const snapshot = await snapshotWorktree(dir, { isProtectedPath: (path) => isSensitiveTaskBranchPath(path) });
    try {
      change(dir);
      const diff = await snapshot.collect();

      expect(diff.files).toEqual([]);
      expect(diff.deleted_files).toEqual([]);
      expect(diff.skipped.map((s) => s.path).sort()).toEqual(expectedSkipped);
      expect(new Set(diff.skipped.map((s) => s.reason))).toEqual(new Set(["protected"]));
      expect(treeOf(dir)).toEqual(before);
    } finally {
      snapshot.dispose();
    }
  });

  it.each([
    { id: "too-many-files", limits: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 4096 }, files: { "a.txt": "a", "b.txt": "b" } },
    { id: "file-over-the-per-file-cap", limits: { maxFiles: 10, maxFileBytes: 4, maxTotalBytes: 4096 }, files: { "a.txt": "12345" } },
    { id: "diff-over-the-total-cap", limits: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 6 }, files: { "a.txt": "1234", "b.txt": "1234" } }
  ])("$id-fails-with-AGENT_DIFF_TOO_LARGE", async ({ limits, files }) => {
    const dir = tempWorktree({});
    const snapshot = await snapshotWorktree(dir, { limits });
    try {
      for (const [path, content] of Object.entries(files)) {
        writeFileSync(join(dir, path), content);
      }

      await expect(snapshot.collect()).rejects.toMatchObject({ name: "AgentEngineError", code: "AGENT_DIFF_TOO_LARGE" });
    } finally {
      snapshot.dispose();
    }
  });

  it("unreadable-file-fails-with-AGENT_SNAPSHOT_FAILED", async () => {
    const dir = tempWorktree({});
    const snapshot = await snapshotWorktree(dir);
    try {
      writeFileSync(join(dir, "secret.txt"), "x");
      chmodSync(join(dir, "secret.txt"), 0o000);

      await expect(snapshot.collect()).rejects.toMatchObject({ name: "AgentEngineError", code: "AGENT_SNAPSHOT_FAILED" });
    } finally {
      chmodSync(join(dir, "secret.txt"), 0o644);
      snapshot.dispose();
    }
  });

  it("listTrackedPaths-reads-the-checkout-index", async () => {
    const dir = tempWorktree({ ".gitignore": "*.lock\n", "deps.lock": "v1\n", "a.txt": "a\n" });
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    execFileSync("git", ["add", "--force", "deps.lock", "a.txt"], { cwd: dir });

    expect((await listTrackedPaths(dir)).sort()).toEqual(["a.txt", "deps.lock"]);
  });

  it("never runs hooks or fsmonitor planted in the worktree's own .git", async () => {
    const dir = tempWorktree({ "a.txt": "a\n" });
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    const marker = join(dir, "..", `${dir.split("/").pop()}-pwned`);
    const script = join(dir, ".git", "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(dir, ".git", "config"), `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${join(dir, ".git")}\n`);
    const snapshot = await snapshotWorktree(dir);
    try {
      writeFileSync(join(dir, "a.txt"), "b\n");
      expect((await snapshot.collect()).files).toEqual([{ path: "a.txt", content: "b\n", mode: "100644" }]);
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

describe("createPiAgentEngine", () => {
  it.each([
    { id: "kernel-confinement-is-required-by-default", option: undefined, expected: true },
    { id: "a-test-may-opt-out-explicitly", option: false, expected: false }
  ])("$id", async ({ option, expected }) => {
    const sandboxRunner = vi.fn(async (): Promise<SandboxExecutionResult> => ({
      isolated: false,
      error_code: "SANDBOX_ISOLATION_UNAVAILABLE",
      error_message: "landrun is missing.",
      proxy_url: "",
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: 0
    }));
    const engine = createPiAgentEngine({ runnerEnv: {}, piDir: "/opt/pi", sandboxRunner, enforceKernelSandbox: option });

    await expect(engine.run(sessionRequest(tempWorktree({})))).rejects.toMatchObject({ code: "AGENT_ISOLATION_UNAVAILABLE" });
    expect(sandboxRunner).toHaveBeenCalledWith(expect.objectContaining({ enforceKernelSandbox: expected }));
  });

  it.each([
    { id: "line-at-the-8-mib-cap-is-read", bytes: 8 * 1024 * 1024, killed: false, code: "AGENT_PROTOCOL_ERROR", message: /before the session settled/ },
    { id: "line-over-the-8-mib-cap-kills-the-session", bytes: 8 * 1024 * 1024 + 1, killed: true, code: "AGENT_PROTOCOL_ERROR", message: /RPC line over/ }
  ])("$id", async ({ bytes, killed, code, message }) => {
    const kill = vi.fn();
    const sandboxRunner = vi.fn(async (input: SandboxExecutionInput): Promise<SandboxExecutionResult> => {
      const stdout = new PassThrough();
      const session = input.interact?.({ stdin: new PassThrough(), stdout, kill: () => { kill(); stdout.end(); } });
      stdout.write(Buffer.alloc(bytes, 0x61));
      stdout.end();
      await session;
      return { isolated: true, error_code: "NONE", error_message: "", proxy_url: "", exit_code: 1, stdout: "", stderr: "", duration_ms: 0 };
    });
    const engine = createPiAgentEngine({ runnerEnv: {}, piDir: "/opt/pi", sandboxRunner });

    await expect(engine.run(sessionRequest(tempWorktree({})))).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
    expect(kill).toHaveBeenCalledTimes(killed ? 1 : 0);
  });
});

describe("assertNoSecretMaterial", () => {
  it.each([
    { id: "secret-in-the-commit-message", label: "the commit message", text: `fix: rotate ${INSTALLATION_TOKEN}`, leaks: true },
    { id: "private-key-in-the-test-summary", label: "the test summary", text: "-----BEGIN RSA PRIVATE KEY-----\nAAAA", leaks: true },
    { id: "clean-summary-text", label: "the test summary", text: "12 tests pass.", leaks: false }
  ])("$id", ({ label, text, leaks }) => {
    const check = (): void => assertNoSecretMaterial([{ label, text }], [INSTALLATION_TOKEN]);

    if (leaks) {
      expect(check).toThrow(expect.objectContaining({ code: "AGENT_SECRET_IN_DIFF", message: expect.stringContaining(label) }));
      expect(check).not.toThrow(expect.objectContaining({ message: expect.stringContaining(INSTALLATION_TOKEN) }));
    } else {
      expect(check).not.toThrow();
    }
  });
});

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
      runnerEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: REAL_KEY, ANTHROPIC_BASE_URL: upstream.url },
      enforceKernelSandbox: false
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
      diff: { files: [{ path: "hello.txt", content: "hello\n", mode: "100644" }], deleted_files: ["obsolete.txt"], skipped: [] }
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
    const engine = createPiAgentEngine({ runnerEnv: { PATH: process.env.PATH }, enforceKernelSandbox: false });

    const run = engine.run(
      sessionRequest(worktree, {
        providers: { anthropic: { provider: "anthropic", base_url: upstream.url, api_key: REAL_KEY } }
      })
    );

    await expect(run).rejects.toBeInstanceOf(expected);
  }, 120_000);

  it.each([
    {
      id: "runner-secret-written-into-the-worktree-fails-the-session-without-echoing-it",
      turns: [
        anthropicStream({ type: "tool_use", id: "toolu_1", name: "write", input: { path: "leak.txt", content: `key=${REAL_KEY}\n` } }, { input: 10, output: 5 }),
        anthropicStream({ type: "text", text: "Done." }, { input: 10, output: 5 })
      ],
      maxLlmRequests: undefined,
      expected: { name: "AgentEngineError", code: "AGENT_SECRET_IN_DIFF" }
    },
    {
      id: "private-key-block-in-the-worktree-fails-the-session",
      turns: [
        anthropicStream(
          { type: "tool_use", id: "toolu_1", name: "write", input: { path: "id.pem", content: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n" } },
          { input: 10, output: 5 }
        ),
        anthropicStream({ type: "text", text: "Done." }, { input: 10, output: 5 })
      ],
      maxLlmRequests: undefined,
      expected: { name: "AgentEngineError", code: "AGENT_SECRET_IN_DIFF" }
    },
    {
      id: "installation-token-in-a-file-path-fails-the-session-without-echoing-it",
      turns: [
        anthropicStream({ type: "tool_use", id: "toolu_1", name: "write", input: { path: `notes-${INSTALLATION_TOKEN}.txt`, content: "x\n" } }, { input: 10, output: 5 }),
        anthropicStream({ type: "text", text: "Done." }, { input: 10, output: 5 })
      ],
      maxLlmRequests: undefined,
      expected: { name: "AgentEngineError", code: "AGENT_SECRET_IN_DIFF" }
    },
    {
      id: "runner-secret-in-the-final-message-fails-the-session-without-echoing-it",
      turns: [anthropicStream({ type: "text", text: `Used key ${REAL_KEY}.` }, { input: 10, output: 5 })],
      maxLlmRequests: undefined,
      expected: { name: "AgentEngineError", code: "AGENT_SECRET_IN_DIFF" }
    },
    {
      id: "session-past-its-llm-request-cap-is-aborted",
      turns: [
        anthropicStream({ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "true" } }, { input: 10, output: 5 })
      ],
      maxLlmRequests: 2,
      expected: { name: "AgentEngineError", code: "AGENT_REQUEST_CAP_REACHED" }
    }
  ])("$id", async ({ turns, maxLlmRequests, expected }) => {
    const upstream = await scriptedUpstream(turns);
    upstreams.push(upstream);
    const worktree = tempWorktree({ "a.txt": "a\n" });
    const engine = createPiAgentEngine({ runnerEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: REAL_KEY }, enforceKernelSandbox: false });

    const run = engine.run(
      sessionRequest(worktree, {
        maxLlmRequests,
        secrets: [INSTALLATION_TOKEN],
        providers: { anthropic: { provider: "anthropic", base_url: upstream.url, api_key: REAL_KEY } }
      })
    );

    await expect(run).rejects.toMatchObject(expected);
    await expect(run).rejects.not.toHaveProperty("message", expect.stringContaining(REAL_KEY));
    await expect(run).rejects.not.toHaveProperty("message", expect.stringContaining(INSTALLATION_TOKEN));
    if (maxLlmRequests !== undefined) {
      expect(upstream.requests).toHaveLength(maxLlmRequests);
    }
  }, 120_000);

  it("runs Pi with an allowlisted environment and the requested thinking level", async () => {
    const upstream = await scriptedUpstream([
      anthropicStream({ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "env | cut -d= -f1 | sort > env-names.txt" } }, { input: 10, output: 5 }),
      anthropicStream({ type: "text", text: "Done." }, { input: 10, output: 5 })
    ]);
    upstreams.push(upstream);
    const worktree = tempWorktree({ "a.txt": "a\n" });
    const engine = createPiAgentEngine({
      runnerEnv: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        ANTHROPIC_API_KEY: REAL_KEY,
        NODE_OPTIONS: "--max-old-space-size=4096",
        PI_CODING_AGENT_DIR: "/home/runner/.pi-runner",
        GITHUB_TOKEN: "ghs_runnerTokenValue1234567890"
      },
      enforceKernelSandbox: false
    });

    const { diff } = await engine.run(
      sessionRequest(worktree, {
        thinking: "high",
        providers: { anthropic: { provider: "anthropic", base_url: upstream.url, api_key: REAL_KEY } }
      })
    );
    const names = diff.files.find((f) => f.path === "env-names.txt")?.content.trim().split("\n") ?? [];

    expect(names).toEqual(expect.arrayContaining(["HOME", "LANG", "PATH", "PI_CODING_AGENT_DIR", "TMPDIR"]));
    expect(names).not.toEqual(expect.arrayContaining(["NODE_OPTIONS"]));
    expect(names).not.toEqual(expect.arrayContaining(["GITHUB_TOKEN"]));
    expect(names).not.toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY"]));
    expect((JSON.parse(upstream.requests[0]?.body ?? "{}") as { thinking?: unknown }).thinking).toMatchObject({ type: "enabled" });
  }, 120_000);

  it("aborts a session that outlives its timeout", async () => {
    const upstream = await startFakeLlmUpstream(() => {
      // never answers
    });
    upstreams.push(upstream);
    const worktree = tempWorktree({ "a.txt": "a\n" });
    const engine = createPiAgentEngine({ runnerEnv: { PATH: process.env.PATH }, enforceKernelSandbox: false });

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
