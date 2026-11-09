import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type ServerResponse } from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderUpstream, type ProviderKind } from "../src/llm/index.js";
import { runPolyglotStage1Verification } from "../src/sandbox/polyglot-workspace-runner.js";
import {
  buildAgentSessionEnv,
  buildKernelSandboxedCommand,
  buildSanitizedSandboxEnv,
  createLlmSandboxProxy,
  MAX_PROXY_REQUEST_BYTES,
  probeKernelSandboxCapabilities,
  runInUntrustedCodeSandbox,
  selectKernelBackend,
  type KernelSandboxCapabilities,
  type LlmProxyExchange,
  type SandboxExecutionInput,
  type SandboxNetworkPolicy
} from "../src/sandbox/llm-sandbox.js";
import {
  rawProxyRequest,
  startFakeLlmUpstream,
  type FakeLlmUpstream,
  type RecordedUpstreamRequest
} from "./fixtures/fake-llm-upstream.js";

const REAL_KEY = "sk-real-RunnerHeldKey1234567890ABCDEF";
// OpenAI-compatible streams report usage only when the request asks for it.
const STREAM_ASKING_FOR_USAGE = '{"stream":true,"stream_options":{"include_usage":true}}';
const SSE_BODY = 'data: {"delta":"he"}\n\ndata: {"delta":"llo"}\n\n';

const openUpstreams: FakeLlmUpstream[] = [];
async function sseUpstream(): Promise<FakeLlmUpstream> {
  const upstream = await startFakeLlmUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(SSE_BODY);
  });
  openUpstreams.push(upstream);
  return upstream;
}

// The suite itself runs in CI: rows that need "not CI" must not inherit the runner's flags.
beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("CI", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(openUpstreams.splice(0).map((u) => u.close()));
});

describe("Sandbox LLM proxy & untrusted code credential isolation (#98)", () => {
  const RUNNER_SECRETS_ENV: Readonly<Record<string, string>> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/runner",
    NODE_ENV: "test",
    OPENAI_API_KEY: "sk-proj-RealRunnerSecretKey1234567890ABCDEF",
    ANTHROPIC_API_KEY: "sk-ant-api03-RealAnthropicSecret9876543210",
    OPENROUTER_API_KEY: "sk-or-v1-RealOpenRouterSecret1234567890",
    CORP_GATEWAY_API_KEY: "corp-RealGatewaySecret1234567890",
    GITHUB_TOKEN: "ghs_RealWriteInstallationToken1234567890",
    GH_TOKEN: "ghp_RealPersonalAccessToken1234567890",
    INPUT_GITHUB_TOKEN: "ghs_ActionInputToken1234567890",
    EPURE_AGENT_APP_PRIVATE_KEY:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0123456789\n-----END RSA PRIVATE KEY-----",
    EPURE_RELEASE_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQE\n-----END PRIVATE KEY-----",
    EPURE_INSTALLATION_TOKEN: "ghs_PublisherToken9999999999999999",
    NPM_TOKEN: "npm_SecretPublishToken123456789",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  };

  it.each([
    { id: "strips-openai-key", forbiddenKey: "OPENAI_API_KEY" },
    { id: "strips-anthropic-key", forbiddenKey: "ANTHROPIC_API_KEY" },
    { id: "strips-openrouter-key", forbiddenKey: "OPENROUTER_API_KEY" },
    { id: "strips-alias-key-named-in-agents-yml", forbiddenKey: "CORP_GATEWAY_API_KEY" },
    { id: "strips-github-token", forbiddenKey: "GITHUB_TOKEN" },
    { id: "strips-gh-token", forbiddenKey: "GH_TOKEN" },
    { id: "strips-action-input-github-token", forbiddenKey: "INPUT_GITHUB_TOKEN" },
    { id: "strips-agent-app-private-key", forbiddenKey: "EPURE_AGENT_APP_PRIVATE_KEY" },
    { id: "strips-release-app-private-key", forbiddenKey: "EPURE_RELEASE_APP_PRIVATE_KEY" },
    { id: "strips-npm-and-cloud-tokens", forbiddenKey: "NPM_TOKEN" }
  ])(
    "buildSanitizedSandboxEnv [$id]: strips '$forbiddenKey' and injects only local proxy endpoint & session nonce",
    ({ forbiddenKey }) => {
      const sanitized = buildSanitizedSandboxEnv(RUNNER_SECRETS_ENV, {
        proxyUrl: "http://127.0.0.1:43199",
        proxyNonce: "nonce-ephemeral-123"
      });

      expect(sanitized[forbiddenKey]).toBeUndefined();
      expect(sanitized.EPURE_LLM_PROXY_URL).toBe("http://127.0.0.1:43199");
      expect(sanitized.EPURE_LLM_PROXY_NONCE).toBe("nonce-ephemeral-123");
      expect(sanitized.EPURE_SANDBOX_ACTIVE).toBe("true");
      expect(sanitized.RTK_TELEMETRY_DISABLED).toBe("1");
      expect(sanitized.RTK_RECALL).toBe("0");
      expect(sanitized.RTK_TEE).toBe("0");
      expect(sanitized.RTK_SUPPRESS_HOOK_WARNING).toBe("1");
      expect(sanitized.NO_COLOR).toBe("1");
    }
  );

  it.each([
    {
      id: "adversarial-env-dump-cannot-read-secrets",
      input: {
        isolationAvailable: true,
        runnerEnv: RUNNER_SECRETS_ENV,
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, gh: process.env.GITHUB_TOKEN ?? null, pem: process.env.EPURE_AGENT_APP_PRIVATE_KEY ?? null, proxy: process.env.EPURE_LLM_PROXY_URL ?? null }))"
        ],
        llm: { model: "openai/gpt-5.4" }
      } satisfies SandboxExecutionInput,
      expectedExitCode: 0,
      expectedAllowed: true,
      expectedErrorCode: "NONE",
      verifyOutput: (stdout: string) => {
        const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
        expect(parsed.openai).toBeNull();
        expect(parsed.anthropic).toBeNull();
        expect(parsed.gh).toBeNull();
        expect(parsed.pem).toBeNull();
        expect(typeof parsed.proxy).toBe("string");
        expect(stdout).not.toContain("sk-proj-RealRunnerSecretKey");
        expect(stdout).not.toContain("sk-ant-api03-RealAnthropicSecret");
        expect(stdout).not.toContain("ghs_RealWriteInstallationToken");
      }
    },
    {
      id: "command-without-llm-route-gets-no-proxy",
      input: {
        isolationAvailable: true,
        runnerEnv: RUNNER_SECRETS_ENV,
        command: process.execPath,
        args: ["-e", "console.log(process.env.EPURE_LLM_PROXY_URL ?? 'no-proxy')"]
      } satisfies SandboxExecutionInput,
      expectedExitCode: 0,
      expectedAllowed: true,
      expectedErrorCode: "NONE",
      verifyOutput: (stdout: string) => {
        expect(stdout.trim()).toBe("no-proxy");
      }
    },
    {
      id: "fail-closed-when-sandbox-isolation-unavailable",
      input: {
        isolationAvailable: false,
        runnerEnv: RUNNER_SECRETS_ENV,
        command: process.execPath,
        args: ["-e", "console.log('should-never-run')"]
      } satisfies SandboxExecutionInput,
      expectedExitCode: 1,
      expectedAllowed: false,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE",
      verifyOutput: (stdout: string) => {
        expect(stdout).toBe("");
      }
    },
    {
      id: "fail-closed-when-the-llm-route-has-no-key-on-the-runner",
      input: {
        isolationAvailable: true,
        runnerEnv: { PATH: "/usr/bin" },
        command: process.execPath,
        args: ["-e", "console.log('should-never-run')"],
        llm: { model: "anthropic/claude-haiku-5-5" }
      } satisfies SandboxExecutionInput,
      expectedExitCode: 1,
      expectedAllowed: false,
      expectedErrorCode: "LLM_API_KEY_MISSING",
      verifyOutput: (stdout: string) => {
        expect(stdout).toBe("");
      }
    }
  ])(
    "runInUntrustedCodeSandbox [$id]: enforces isolation and fail-closed invariants",
    async ({ input, expectedExitCode, expectedAllowed, expectedErrorCode, verifyOutput }) => {
      const result = await runInUntrustedCodeSandbox(input);
      expect(result.isolated).toBe(expectedAllowed);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.exit_code).toBe(expectedExitCode);
      verifyOutput(result.stdout);
    }
  );

  it.each([
    { id: "no-llm-route-runs-offline", llm: undefined, expectedPolicy: "offline" },
    { id: "llm-route-runs-proxy-only", llm: { model: "openai/gpt-5.4" }, expectedPolicy: "proxy_only" }
  ])(
    "runInUntrustedCodeSandbox [$id]: picks the network policy and reports an unconfined fallback",
    async ({ llm, expectedPolicy }) => {
      const result = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: RUNNER_SECRETS_ENV,
        kernelCapabilities: { landrunAvailable: false, bubblewrapAvailable: false },
        command: process.execPath,
        args: ["-e", "0"],
        llm
      });

      expect(result.error_code).toBe("NONE");
      expect(result.network_policy).toBe(expectedPolicy);
      expect(result.kernel_backend).toBe("none");
      expect(result.confined).toBe(false);
    }
  );

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A killed orphan stays visible to kill(pid, 0) until init reaps it, which lags under load.
  const exitsWithin = async (pid: number, ms: number): Promise<boolean> => {
    for (const deadline = Date.now() + ms; isAlive(pid) && Date.now() < deadline; ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !isAlive(pid);
  };
  it.each([
    {
      id: "a-background-process-left-by-the-phase-dies-with-it",
      script:
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); c.unref(); console.log(c.pid);",
      timeoutMs: 20_000,
      expectedExitCode: 0
    },
    {
      id: "a-timeout-kills-the-whole-group",
      script:
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); console.log(c.pid); setTimeout(() => {}, 30000);",
      timeoutMs: 1_000,
      expectedExitCode: 1
    }
  ])("runInUntrustedCodeSandbox [$id]", async ({ script, timeoutMs, expectedExitCode }) => {
    const started = Date.now();
    const result = await runInUntrustedCodeSandbox({
      isolationAvailable: true,
      runnerEnv: { PATH: process.env.PATH },
      kernelCapabilities: { landrunAvailable: false, bubblewrapAvailable: false },
      command: process.execPath,
      args: ["-e", script],
      timeoutMs
    });

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.exit_code).toBe(expectedExitCode);
    expect(await exitsWithin(Number(result.stdout.trim()), 2_000)).toBe(true);
  });

  it("runInUntrustedCodeSandbox [interactive-session-talks-over-stdio-and-reads-proxy-aware-home-files]", async () => {
    const upstream = await sseUpstream();
    let reply = "";
    const result = await runInUntrustedCodeSandbox({
      isolationAvailable: true,
      runnerEnv: { PATH: process.env.PATH, OPENAI_API_KEY: REAL_KEY, OPENAI_BASE_URL: upstream.url },
      kernelCapabilities: { landrunAvailable: false, bubblewrapAvailable: false },
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.once('data', (d) => { const cfg = JSON.parse(require('node:fs').readFileSync(process.env.HOME + '/.cfg/route.json', 'utf8')); process.stdout.write(JSON.stringify({ got: String(d).trim(), cfg, nonce: process.env.EPURE_LLM_PROXY_NONCE }) + '\\n'); })"
      ],
      llm: { model: "openai/gpt-x" },
      agentSession: {
        homeFiles: (proxy) => ({ ".cfg/route.json": JSON.stringify({ url: proxy?.proxyUrl, nonce: proxy?.proxyNonce }) })
      },
      interact: async ({ stdin, stdout }) => {
        stdin.write("ping\n");
        for await (const chunk of stdout) {
          reply += String(chunk);
          if (reply.includes("\n")) {
            return;
          }
        }
      }
    });
    const parsed = JSON.parse(reply) as { got: string; cfg: { url: string; nonce: string }; nonce: string };

    expect(result.error_code).toBe("NONE");
    expect(result.stdout).toBe("");
    expect(parsed.got).toBe("ping");
    expect(parsed.cfg).toEqual({ url: result.proxy_url, nonce: parsed.nonce });
  });

  it("runInUntrustedCodeSandbox [interactive-session-keeps-only-the-last-64-KiB-of-stderr]", async () => {
    const result = await runInUntrustedCodeSandbox({
      isolationAvailable: true,
      runnerEnv: { PATH: process.env.PATH },
      kernelCapabilities: { landrunAvailable: false, bubblewrapAvailable: false },
      command: process.execPath,
      args: ["-e", "for (let i = 0; i < 64; i++) process.stderr.write('x'.repeat(4095) + '\\n'); process.stderr.write('LAST-LINE\\n');"],
      agentSession: {},
      interact: async ({ stdout }) => {
        for await (const _ of stdout) {
          // drain
        }
      }
    });

    expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stderr.trimEnd().endsWith("LAST-LINE")).toBe(true);
  });

  it.each([
    {
      id: "runner-variables-outside-the-allowlist-are-dropped",
      runnerEnv: { PATH: "/usr/bin", LANG: "C.UTF-8", NODE_OPTIONS: "--require /tmp/evil.js", PI_CODING_AGENT_DIR: "/home/runner/.pi", GITHUB_TOKEN: "ghs_x", HOME: "/home/runner" },
      sessionEnv: undefined,
      expected: { PATH: "/usr/bin", LANG: "C.UTF-8", HOME: "/tmp/epure-agent-x", TMPDIR: "/tmp/epure-agent-x" },
      absent: ["NODE_OPTIONS", "PI_CODING_AGENT_DIR", "GITHUB_TOKEN"]
    },
    {
      id: "session-variables-are-set-explicitly-and-cannot-move-home",
      runnerEnv: { PATH: "/usr/bin" },
      sessionEnv: (home: string) => ({ PI_CODING_AGENT_DIR: `${home}/.pi/agent`, HOME: "/elsewhere" }),
      expected: { PI_CODING_AGENT_DIR: "/tmp/epure-agent-x/.pi/agent", HOME: "/tmp/epure-agent-x" },
      absent: []
    }
  ])("buildAgentSessionEnv [$id]", ({ runnerEnv, sessionEnv, expected, absent }) => {
    const env = buildAgentSessionEnv(runnerEnv, "/tmp/epure-agent-x", { proxyUrl: "http://127.0.0.1:1", proxyNonce: "n" }, sessionEnv);

    expect(env).toMatchObject({ ...expected, EPURE_LLM_PROXY_URL: "http://127.0.0.1:1", EPURE_LLM_PROXY_NONCE: "n" });
    for (const name of absent) {
      expect(env[name]).toBeUndefined();
    }
  });

  it("createLlmSandboxProxy [requests-past-the-cap-get-429-and-never-reach-the-upstream]", async () => {
    const upstream = await sseUpstream();
    const onRequestCapReached = vi.fn();
    const proxy = await createLlmSandboxProxy({
      upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
      apiKey: REAL_KEY,
      maxRequests: 2,
      onRequestCapReached
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await rawProxyRequest(proxy.proxyUrl, {
          method: "POST",
          path: "/v1/messages",
          headers: { "x-api-key": proxy.proxyNonce, "content-type": "application/json" },
          body: "{}"
        });
        statuses.push(res.status);
      }

      expect(statuses).toEqual([200, 200, 429]);
      expect(upstream.requests).toHaveLength(2);
      expect(onRequestCapReached).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
    }
  });

  const RUNNER_KEYS = {
    PATH: "/usr/bin",
    OPENAI_API_KEY: REAL_KEY,
    GEMINI_API_KEY: REAL_KEY,
    LLM_API_KEY: REAL_KEY,
    AZURE_OPENAI_API_KEY: REAL_KEY,
    AZURE_AI_API_KEY: REAL_KEY
  };
  it.each([
    { id: "empty-model", model: "", providers: undefined, expectedErrorCode: "LLM_MODEL_MISSING" },
    { id: "whitespace-model", model: "   ", providers: undefined, expectedErrorCode: "LLM_MODEL_MISSING" },
    { id: "unprefixed-model-is-not-inferred", model: "gpt-5.4", providers: undefined, expectedErrorCode: "LLM_ROUTE_INVALID" },
    {
      id: "unknown-prefix-without-a-declared-alias-is-not-inferred",
      model: "corp-gateway/qwen-coder",
      providers: undefined,
      expectedErrorCode: "LLM_ROUTE_INVALID"
    },
    {
      id: "alias-without-its-own-api-key-gets-no-fallback-key",
      model: "corp-gateway/qwen-coder",
      providers: { "corp-gateway": { provider: "openai", base_url: "https://llm.corp.example/v1" } },
      expectedErrorCode: "LLM_API_KEY_MISSING"
    },
    {
      id: "alias-over-plain-http-is-refused",
      model: "corp-gateway/qwen-coder",
      providers: {
        "corp-gateway": { provider: "openai", base_url: "http://llm.corp.example/v1", api_key: "os.environ/LLM_API_KEY" }
      },
      expectedErrorCode: "LLM_ROUTE_INVALID"
    },
    {
      id: "known-provider-overridden-to-plain-http-is-refused",
      model: "openai/gpt-5.4",
      providers: { openai: { base_url: "http://api.example/v1" } },
      expectedErrorCode: "LLM_ROUTE_INVALID"
    },
    { id: "azure-without-endpoint", model: "azure/gpt-4o", providers: undefined, expectedErrorCode: "LLM_ROUTE_INVALID" },
    { id: "azure-ai-without-endpoint", model: "azure_ai/phi-5", providers: undefined, expectedErrorCode: "LLM_ROUTE_INVALID" }
  ] as const)(
    "runInUntrustedCodeSandbox [$id]: refuses the LLM route before starting anything",
    async ({ model, providers, expectedErrorCode }) => {
      const result = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: RUNNER_KEYS,
        command: process.execPath,
        args: ["-e", "console.log('should-never-run')"],
        llm: { model, providers }
      });

      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.isolated).toBe(false);
      expect(result.stdout).toBe("");
      expect(result.error_message).not.toContain(REAL_KEY);
    }
  );

  it.each([
    {
      id: "openai-bearer",
      provider: "openai",
      baseSuffix: "/v1",
      path: "/chat/completions",
      credential: (nonce: string) => ({ authorization: `Bearer ${nonce}` }),
      expectedUpstreamUrl: "/v1/chat/completions",
      expectedAuth: ["authorization", `Bearer ${REAL_KEY}`],
      expectedForwardedBody: STREAM_ASKING_FOR_USAGE
    },
    {
      id: "openai-compatible-alias-nonce-header-replaces-sdk-placeholder",
      provider: "openai",
      baseSuffix: "/compat/v1",
      path: "/chat/completions",
      credential: (nonce: string) => ({
        "x-epure-proxy-nonce": nonce,
        authorization: "Bearer sk-placeholder"
      }),
      expectedUpstreamUrl: "/compat/v1/chat/completions",
      expectedAuth: ["authorization", `Bearer ${REAL_KEY}`],
      expectedForwardedBody: STREAM_ASKING_FOR_USAGE
    },
    {
      id: "openrouter-bearer",
      provider: "openrouter",
      baseSuffix: "/api/v1",
      path: "/chat/completions",
      credential: (nonce: string) => ({ authorization: `Bearer ${nonce}` }),
      expectedUpstreamUrl: "/api/v1/chat/completions",
      expectedAuth: ["authorization", `Bearer ${REAL_KEY}`],
      expectedForwardedBody: STREAM_ASKING_FOR_USAGE
    },
    {
      id: "azure-openai-api-key-keeps-api-version-query",
      provider: "azure",
      baseSuffix: "",
      path: "/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
      credential: (nonce: string) => ({ "api-key": nonce }),
      expectedUpstreamUrl: "/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
      expectedAuth: ["api-key", REAL_KEY],
      expectedForwardedBody: STREAM_ASKING_FOR_USAGE
    },
    {
      id: "azure-ai-foundry-api-key",
      provider: "azure_ai",
      baseSuffix: "/models",
      path: "/chat/completions",
      credential: (nonce: string) => ({ "api-key": nonce }),
      expectedUpstreamUrl: "/openai/v1/chat/completions",
      expectedAuth: ["api-key", REAL_KEY],
      expectedForwardedBody: STREAM_ASKING_FOR_USAGE
    },
    {
      id: "anthropic-x-api-key",
      provider: "anthropic",
      baseSuffix: "",
      path: "/v1/messages",
      credential: (nonce: string) => ({ "x-api-key": nonce, "anthropic-version": "2023-06-01" }),
      expectedUpstreamUrl: "/v1/messages",
      expectedAuth: ["x-api-key", REAL_KEY],
      expectedForwardedBody: '{"stream":true}'
    },
    {
      id: "gemini-key-query-moves-to-header-and-alt-sse-stays",
      provider: "google",
      baseSuffix: "/v1beta",
      path: "/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=NONCE",
      credential: () => ({}),
      expectedUpstreamUrl: "/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
      expectedAuth: ["x-goog-api-key", REAL_KEY],
      expectedForwardedBody: '{"stream":true}'
    },
    {
      id: "vertex-express-x-goog-api-key",
      provider: "vertex",
      baseSuffix: "",
      path: "/v1/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
      credential: (nonce: string) => ({ "x-goog-api-key": nonce }),
      expectedUpstreamUrl:
        "/v1/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
      expectedAuth: ["x-goog-api-key", REAL_KEY],
      expectedForwardedBody: '{"stream":true}'
    }
  ] as const)(
    "createLlmSandboxProxy [$id]: forwards to the declared provider with the real key and streams SSE back",
    async ({ provider, baseSuffix, path, credential, expectedUpstreamUrl, expectedAuth, expectedForwardedBody }) => {
      const upstream = await sseUpstream();
      const proxy = await createLlmSandboxProxy({
        upstream: resolveProviderUpstream(provider as ProviderKind, {
          base_url: `${upstream.url}${baseSuffix}`
        }),
        apiKey: REAL_KEY
      });

      try {
        const res = await fetch(`${proxy.proxyUrl}${path.replace("NONCE", proxy.proxyNonce)}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...credential(proxy.proxyNonce) },
          body: '{"stream":true}'
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        expect(await res.text()).toBe(SSE_BODY);

        const [forwarded] = upstream.requests;
        expect(upstream.requests).toHaveLength(1);
        expect(forwarded?.url).toBe(expectedUpstreamUrl);
        expect(forwarded?.body).toBe(expectedForwardedBody);
        expect(forwarded?.headers[expectedAuth[0]]).toBe(expectedAuth[1]);
        const otherCredentialHeaders = ["authorization", "x-api-key", "api-key", "x-goog-api-key"]
          .filter((name) => name !== expectedAuth[0])
          .filter((name) => forwarded?.headers[name] !== undefined);
        expect(otherCredentialHeaders).toEqual([]);
        expect(JSON.stringify(forwarded)).not.toContain(proxy.proxyNonce);
      } finally {
        await proxy.close();
      }
    }
  );

  it.each<{
    id: string;
    method: string;
    path: string;
    withNonce: boolean;
    headers?: Record<string, string>;
    expectedStatus: number;
    expectedErrorCode: string | undefined;
  }>([
    {
      id: "missing-nonce",
      method: "POST",
      path: "/v1/messages",
      withNonce: false,
      expectedStatus: 401,
      expectedErrorCode: "PROXY_UNAUTHORIZED_NONCE"
    },
    {
      id: "real-provider-key-instead-of-nonce",
      method: "POST",
      path: "/v1/messages",
      withNonce: false,
      headers: { "x-api-key": REAL_KEY },
      expectedStatus: 401,
      expectedErrorCode: "PROXY_UNAUTHORIZED_NONCE"
    },
    {
      id: "undeclared-path-on-the-provider",
      method: "POST",
      path: "/v1/messages/batches",
      withNonce: true,
      expectedStatus: 403,
      expectedErrorCode: "PROXY_FORBIDDEN_ENDPOINT"
    },
    {
      id: "dot-segments-to-an-undeclared-path",
      method: "POST",
      path: "/v1/messages/../files",
      withNonce: true,
      expectedStatus: 403,
      expectedErrorCode: "PROXY_FORBIDDEN_ENDPOINT"
    },
    {
      id: "encoded-dot-segments-to-an-undeclared-path",
      method: "POST",
      path: "/v1/%2e%2e/v1/files",
      withNonce: true,
      expectedStatus: 403,
      expectedErrorCode: "PROXY_FORBIDDEN_ENDPOINT"
    },
    {
      id: "non-post-method",
      method: "GET",
      path: "/v1/messages",
      withNonce: true,
      expectedStatus: 403,
      expectedErrorCode: "PROXY_FORBIDDEN_ENDPOINT"
    },
    {
      id: "absolute-form-request-to-an-undeclared-host",
      method: "POST",
      path: "http://exfil.example/v1/messages",
      withNonce: true,
      expectedStatus: 403,
      expectedErrorCode: "PROXY_FORBIDDEN_ENDPOINT"
    },
    {
      id: "connect-tunnel-to-an-undeclared-host",
      method: "CONNECT",
      path: "exfil.example:443",
      withNonce: true,
      expectedStatus: 0,
      expectedErrorCode: undefined
    }
  ])(
    "createLlmSandboxProxy [$id]: refuses before reaching the upstream",
    async ({ method, path, withNonce, headers, expectedStatus, expectedErrorCode }) => {
      const upstream = await sseUpstream();
      const proxy = await createLlmSandboxProxy({
        upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
        apiKey: REAL_KEY
      });

      try {
        const res = await rawProxyRequest(proxy.proxyUrl, {
          method,
          path,
          headers: { ...(withNonce ? { "x-api-key": proxy.proxyNonce } : {}), ...headers },
          body: "{}"
        });

        expect(res.status).toBe(expectedStatus);
        if (expectedErrorCode) {
          expect((JSON.parse(res.body) as { error_code: string }).error_code).toBe(
            expectedErrorCode
          );
        }
        expect(res.body).not.toContain(REAL_KEY);
        expect(upstream.requests).toEqual([]);
      } finally {
        await proxy.close();
      }
    }
  );

  it("createLlmSandboxProxy [streams-each-chunk-before-the-upstream-finishes-and-exposes-it-to-an-observer]", async () => {
    let releaseSecondEvent: () => void = () => undefined;
    const secondEventReleased = new Promise<void>((resolve) => {
      releaseSecondEvent = resolve;
    });
    const upstream = await startFakeLlmUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"he"}\n\n');
      await secondEventReleased;
      res.end('data: {"delta":"llo"}\n\n');
    });
    openUpstreams.push(upstream);
    const exchanges: LlmProxyExchange[] = [];
    const observed: Buffer[] = [];
    let observerEnded = false;
    const proxy = await createLlmSandboxProxy({
      upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
      apiKey: REAL_KEY,
      observeResponse: (exchange) => {
        exchanges.push(exchange);
        return {
          onChunk: (chunk) => observed.push(Buffer.from(chunk)),
          onEnd: () => {
            observerEnded = true;
          }
        };
      }
    });

    try {
      const res = await fetch(`${proxy.proxyUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": proxy.proxyNonce },
        body: "{}"
      });
      const reader = res.body!.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("proxy buffered the stream")), 2_000)
        )
      ]);
      expect(Buffer.from(first.value!).toString()).toBe('data: {"delta":"he"}\n\n');

      releaseSecondEvent();
      let rest = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        rest += Buffer.from(chunk.value).toString();
      }
      expect(rest).toBe('data: {"delta":"llo"}\n\n');
      expect(exchanges).toEqual([
        { method: "POST", path: "/v1/messages", status: 200, contentType: "text/event-stream" }
      ]);
      expect(Buffer.concat(observed).toString()).toBe(SSE_BODY);
      expect(observerEnded).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it.each([
    {
      id: "redirect-is-relayed-to-the-sandbox-and-never-followed-with-the-key",
      respond: (second: FakeLlmUpstream) => (_req: RecordedUpstreamRequest, res: ServerResponse) => {
        res.writeHead(307, { location: `${second.url}/v1/messages` });
        res.end();
      },
      expectedStatus: 307,
      expectedHeaders: (second: FakeLlmUpstream) => ({ location: `${second.url}/v1/messages` }),
      expectedBody: ""
    },
    {
      id: "rate-limit-429-keeps-retry-after",
      respond: () => (_req: RecordedUpstreamRequest, res: ServerResponse) => {
        res.writeHead(429, { "retry-after": "7", "content-type": "application/json" });
        res.end('{"error":"rate limited"}');
      },
      expectedStatus: 429,
      expectedHeaders: () => ({ "retry-after": "7" }),
      expectedBody: '{"error":"rate limited"}'
    },
    {
      id: "gzip-stream-is-relayed-byte-for-byte",
      respond: () => (_req: RecordedUpstreamRequest, res: ServerResponse) => {
        res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
        res.end(gzipSync(SSE_BODY));
      },
      expectedStatus: 200,
      expectedHeaders: () => ({ "content-encoding": "gzip" }),
      expectedBody: SSE_BODY
    },
    {
      id: "gzip-error-echoing-the-key-is-decoded-and-redacted",
      respond: () => (req: RecordedUpstreamRequest, res: ServerResponse) => {
        res.writeHead(401, { "content-encoding": "gzip" });
        res.end(gzipSync(`invalid x-api-key ${String(req.headers["x-api-key"])}`));
      },
      expectedStatus: 401,
      expectedHeaders: () => ({ "content-encoding": undefined }),
      expectedBody: "invalid x-api-key [REDACTED]"
    }
  ])(
    "createLlmSandboxProxy [$id]: relays the upstream answer",
    async ({ respond, expectedStatus, expectedHeaders, expectedBody }) => {
      const second = await startFakeLlmUpstream((_req, res) => {
        res.end();
      });
      const upstream = await startFakeLlmUpstream(respond(second));
      openUpstreams.push(second, upstream);
      const proxy = await createLlmSandboxProxy({
        upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
        apiKey: REAL_KEY
      });

      try {
        const res = await rawProxyRequest(proxy.proxyUrl, {
          method: "POST",
          path: "/v1/messages",
          headers: { "x-api-key": proxy.proxyNonce },
          body: "{}"
        });
        const body =
          res.headers["content-encoding"] === "gzip"
            ? gunzipSync(res.rawBody).toString("utf8")
            : res.body;

        const expected = expectedHeaders(second);
        expect(res.status).toBe(expectedStatus);
        expect(Object.fromEntries(Object.keys(expected).map((name) => [name, res.headers[name]]))).toEqual(expected);
        expect(body).toBe(expectedBody);
        expect(second.requests).toEqual([]);
      } finally {
        await proxy.close();
      }
    }
  );

  it.each([
    {
      id: "query-without-a-key-is-forwarded-verbatim",
      query: "?alt=sse&x=a%20b",
      expectedQuery: "?alt=sse&x=a%20b"
    },
    {
      id: "query-carrying-the-nonce-as-key-is-rebuilt-without-it",
      query: "?key=NONCE&alt=sse",
      expectedQuery: "?alt=sse"
    }
  ])(
    "createLlmSandboxProxy [$id]: shapes the forwarded request",
    async ({ query, expectedQuery }) => {
      const upstream = await sseUpstream();
      const proxy = await createLlmSandboxProxy({
        upstream: resolveProviderUpstream("google", {
          base_url: upstream.url,
          default_headers: { "X-Gateway-Tenant": "epure" }
        }),
        apiKey: REAL_KEY
      });
      const path = "/v1beta/models/gemini-3-flash:streamGenerateContent";

      try {
        const res = await rawProxyRequest(proxy.proxyUrl, {
          method: "POST",
          path: `${path}${query.replace("NONCE", proxy.proxyNonce)}`,
          headers: {
            "x-goog-api-key": proxy.proxyNonce,
            connection: "x-hop",
            "x-hop": "1",
            expect: "100-continue"
          },
          body: "{}"
        });

        expect(res.status).toBe(200);
        expect(upstream.requests.map((r) => r.url)).toEqual([`${path}${expectedQuery}`]);
        const forwarded = upstream.requests[0]!.headers;
        expect(forwarded["x-goog-api-key"]).toBe(REAL_KEY);
        expect(forwarded["x-gateway-tenant"]).toBe("epure");
        expect(forwarded["x-hop"]).toBeUndefined();
        expect(forwarded.expect).toBeUndefined();
      } finally {
        await proxy.close();
      }
    }
  );

  it.each([
    {
      id: "declared-length-over-the-cap",
      headers: { "content-length": String(MAX_PROXY_REQUEST_BYTES + 1) },
      body: "{}"
    },
    {
      id: "chunked-body-over-the-cap",
      headers: { "transfer-encoding": "chunked" },
      body: "x".repeat(MAX_PROXY_REQUEST_BYTES + 1024)
    }
  ])("createLlmSandboxProxy [$id]: answers 413", async ({ headers, body }) => {
    const upstream = await sseUpstream();
    const proxy = await createLlmSandboxProxy({
      upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
      apiKey: REAL_KEY
    });

    try {
      const res = await rawProxyRequest(proxy.proxyUrl, {
        method: "POST",
        path: "/v1/messages",
        headers: { "x-api-key": proxy.proxyNonce, ...headers },
        body
      });

      expect(res.status).toBe(413);
      expect((JSON.parse(res.body) as { error_code: string }).error_code).toBe(
        "PROXY_REQUEST_TOO_LARGE"
      );
      expect(upstream.requests).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it.each([
    {
      id: "observer-throwing-on-every-call",
      observeResponse: () => ({
        onChunk: () => {
          throw new Error("observer bug");
        },
        onEnd: () => {
          throw new Error("observer bug");
        }
      })
    },
    {
      id: "observer-factory-throwing",
      observeResponse: () => {
        throw new Error("observer bug");
      }
    }
  ])("createLlmSandboxProxy [$id]: the stream still reaches the sandbox", async ({ observeResponse }) => {
    const upstream = await sseUpstream();
    const proxy = await createLlmSandboxProxy({
      upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
      apiKey: REAL_KEY,
      observeResponse
    });

    try {
      const res = await fetch(`${proxy.proxyUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": proxy.proxyNonce },
        body: "{}"
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SSE_BODY);
    } finally {
      await proxy.close();
    }
  });

  it("createLlmSandboxProxy [client-abort-reaches-the-upstream-and-ends-the-observer]", async () => {
    let upstreamClosedEarly: (value: boolean) => void = () => undefined;
    const upstreamClosed = new Promise<boolean>((resolveClosed) => {
      upstreamClosedEarly = resolveClosed;
    });
    const upstream = await startFakeLlmUpstream((_req, res) => {
      res.on("close", () => upstreamClosedEarly(!res.writableFinished));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"he"}\n\n');
    });
    openUpstreams.push(upstream);
    let observerEnded = false;
    const proxy = await createLlmSandboxProxy({
      upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
      apiKey: REAL_KEY,
      observeResponse: () => ({
        onChunk: () => undefined,
        onEnd: () => {
          observerEnded = true;
        }
      })
    });

    try {
      const abort = new AbortController();
      const res = await fetch(`${proxy.proxyUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": proxy.proxyNonce },
        body: "{}",
        signal: abort.signal
      });
      await res.body!.getReader().read();
      abort.abort();

      expect(await upstreamClosed).toBe(true);
      await vi.waitFor(() => expect(observerEnded).toBe(true));
    } finally {
      await proxy.close();
    }
  });

  it("createLlmSandboxProxy [backpressure-from-a-slow-sandbox-reaches-the-upstream]", async () => {
    const total = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 97);
    let written = 0;
    const upstream = await startFakeLlmUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const pump = (): void => {
        while (written < total) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    openUpstreams.push(upstream);
    const proxy = await createLlmSandboxProxy({
      upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
      apiKey: REAL_KEY
    });

    try {
      const { hostname, port } = new URL(proxy.proxyUrl);
      const received = await new Promise<{ whilePaused: number; bytes: number }>((resolveBytes) => {
        const req = httpRequest(
          { host: hostname, port, method: "POST", path: "/v1/messages", headers: { "x-api-key": proxy.proxyNonce } },
          (res) => {
            res.pause();
            setTimeout(() => {
              const whilePaused = written;
              let bytes = 0;
              res.on("data", (data: Buffer) => {
                bytes += data.length;
              });
              res.on("end", () => resolveBytes({ whilePaused, bytes }));
              res.resume();
            }, 300);
          }
        );
        req.end("{}");
      });

      expect(received.whilePaused).toBeLessThan(total / 2);
      expect(received.bytes).toBe(total);
    } finally {
      await proxy.close();
    }
  });

  it.each([
    {
      id: "upstream-error-echoing-the-key-is-redacted",
      start: () =>
        startFakeLlmUpstream((req, res) => {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `invalid x-api-key ${String(req.headers["x-api-key"])}` }));
        }),
      expectedStatus: 401,
      expectedBody: /\[REDACTED\]/
    },
    {
      id: "unreachable-upstream-answers-502",
      start: async () => {
        const closed = await startFakeLlmUpstream(() => undefined);
        await closed.close();
        return closed;
      },
      expectedStatus: 502,
      expectedBody: /PROXY_UPSTREAM_UNREACHABLE/
    }
  ])(
    "createLlmSandboxProxy [$id]: never hands the key back to the sandbox",
    async ({ start, expectedStatus, expectedBody }) => {
      const upstream = await start();
      openUpstreams.push(upstream);
      const proxy = await createLlmSandboxProxy({
        upstream: resolveProviderUpstream("anthropic", { base_url: upstream.url }),
        apiKey: REAL_KEY
      });

      try {
        const res = await fetch(`${proxy.proxyUrl}/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": proxy.proxyNonce },
          body: "{}"
        });
        const body = await res.text();

        expect(res.status).toBe(expectedStatus);
        expect(body).toMatch(expectedBody);
        expect(body).not.toContain(REAL_KEY);
      } finally {
        await proxy.close();
      }
    }
  );

  it.each([
    {
      id: "agent-calls-anthropic-through-the-proxy-with-the-nonce-only",
      model: "anthropic/claude-haiku-5-5",
      providerKey: "ANTHROPIC_API_KEY",
      path: "/v1/messages",
      header: "x-api-key"
    },
    {
      id: "agent-calls-an-openai-compatible-alias-through-the-proxy",
      model: "corp-gateway/qwen-coder",
      providerKey: "CORP_GATEWAY_API_KEY",
      path: "/chat/completions",
      header: "authorization"
    }
  ])(
    "runInUntrustedCodeSandbox [$id]: the sandbox reaches the provider without ever holding its key",
    async ({ model, providerKey, path, header }) => {
      const upstream = await sseUpstream();
      const script = [
        "const res = await fetch(process.env.EPURE_LLM_PROXY_URL + process.argv[1], {",
        "  method: 'POST',",
        "  headers: { [process.argv[2]]: process.env.EPURE_LLM_PROXY_NONCE },",
        "  body: '{}'",
        "});",
        "console.log(res.status, JSON.stringify(await res.text()));"
      ].join("\n");

      const result = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", [providerKey]: REAL_KEY },
        command: process.execPath,
        args: ["--input-type=module", "-e", script, path, header],
        llm: {
          model,
          providers: {
            anthropic: { provider: "anthropic", base_url: upstream.url },
            "corp-gateway": {
              provider: "openai",
              base_url: `${upstream.url}/v1`,
              api_key: "os.environ/CORP_GATEWAY_API_KEY"
            }
          }
        }
      });

      expect(result.error_code).toBe("NONE");
      expect(result.stdout.trim()).toBe(`200 ${JSON.stringify(SSE_BODY)}`);
      expect(String(upstream.requests[0]?.headers[header])).toContain(REAL_KEY);
      expect(result.stdout).not.toContain(REAL_KEY);
    }
  );

  it.each([
    {
      id: "https-only-install-runs-landrun-with-port-443-only-inside-a-bubblewrap-namespace-hiding-run",
      networkPolicy: "https_only" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: true
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "bubblewrap+landrun" as const,
      expectedCommand: "bwrap",
      requiredArgs: ["--unshare-pid", "/run", "landrun", "--connect-tcp", "443", "--rwx", "--rox"],
      forbiddenArgs: ["43120", "--unshare-net"]
    },
    {
      id: "proxy-only-harness-runs-landrun-with-the-proxy-port-only-inside-a-bubblewrap-namespace",
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: true
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "bubblewrap+landrun" as const,
      expectedCommand: "bwrap",
      requiredArgs: ["--unshare-pid", "/run", "landrun", "--connect-tcp", "43120", "--rwx", "--rox"],
      forbiddenArgs: ["443", "--unshare-net"]
    },
    {
      id: "proxy-only-falls-back-to-bare-landrun-without-bubblewrap",
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: false
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "landrun" as const,
      expectedCommand: "landrun",
      requiredArgs: ["--connect-tcp", "43120"],
      forbiddenArgs: ["--unshare-pid"]
    },
    {
      id: "offline-verification-uses-bubblewrap-unshare-net-and-tmpfs-when-available",
      networkPolicy: "offline" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: true
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "bubblewrap" as const,
      expectedCommand: "bwrap",
      requiredArgs: [
        "--unshare-net",
        "--unshare-pid",
        "--unshare-ipc",
        "--die-with-parent",
        "--tmpfs",
        "/tmp",
        "/run"
      ],
      forbiddenArgs: ["--connect-tcp", "landrun"]
    },
    {
      id: "offline-verification-falls-back-to-landrun-with-zero-tcp-ports-when-bwrap-unavailable",
      networkPolicy: "offline" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: false
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "landrun" as const,
      expectedCommand: "landrun",
      requiredArgs: ["--rox", "--rwx"],
      forbiddenArgs: ["--connect-tcp", "443", "43120"]
    }
  ])(
    "buildKernelSandboxedCommand [$id]: builds two-phase Ubuntu 26.04 kernel confinement invocation",
    ({
      networkPolicy,
      proxyPort,
      capabilities,
      expectedBackend,
      expectedCommand,
      requiredArgs,
      forbiddenArgs
    }) => {
      const wrapped = buildKernelSandboxedCommand({
        command: "npm",
        args: ["test"],
        cwd: "/tmp/epure-work",
        sanitizedEnv: {
          PATH: "/usr/bin:/bin",
          HOME: "/home/runner",
          RTK_TELEMETRY_DISABLED: "1"
        },
        networkPolicy,
        proxyPort,
        capabilities
      });

      expect(wrapped.backend).toBe(expectedBackend);
      expect(wrapped.command).toBe(expectedCommand);
      for (const reqArg of requiredArgs) {
        expect(wrapped.args).toContain(reqArg);
      }
      for (const forbidden of forbiddenArgs) {
        expect(wrapped.args).not.toContain(forbidden);
      }
    }
  );

  it.each([
    {
      id: "landrun-reads-the-vendored-engine-and-writes-only-cwd-and-agent-dir",
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      capabilities: { landrunAvailable: true, bubblewrapAvailable: true },
      expectedSequences: [
        ["--rox", "/usr,/bin,/lib,/lib64,/etc,/opt,/run,/opt/epure/engine"],
        ["--rwx", "/tmp/epure-work,/tmp/epure-agent-x"]
      ]
    },
    {
      id: "bubblewrap-mounts-the-engine-read-only-and-the-agent-dir-over-the-tmp-tmpfs",
      networkPolicy: "offline" as SandboxNetworkPolicy,
      capabilities: { landrunAvailable: true, bubblewrapAvailable: true },
      expectedSequences: [
        [
          "--tmpfs",
          "/tmp",
          "--tmpfs",
          "/run",
          "--ro-bind-try",
          "/run/systemd/resolve",
          "/run/systemd/resolve",
          "--ro-bind",
          "/opt/epure/engine",
          "/opt/epure/engine",
          "--bind",
          "/tmp/epure-agent-x",
          "/tmp/epure-agent-x"
        ]
      ]
    },
    {
      id: "bubblewrap-under-landrun-mounts-the-root-read-only-and-binds-cwd-and-agent-dir",
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      capabilities: { landrunAvailable: true, bubblewrapAvailable: true },
      expectedSequences: [
        ["--die-with-parent", "--ro-bind", "/", "/"],
        ["--bind", "/tmp/epure-agent-x", "/tmp/epure-agent-x"],
        ["--bind", "/tmp/epure-work", "/tmp/epure-work", "--chdir", "/tmp/epure-work"]
      ]
    },
    {
      id: "dependency-install-under-landrun-also-binds-the-package-caches",
      networkPolicy: "https_only" as SandboxNetworkPolicy,
      capabilities: { landrunAvailable: true, bubblewrapAvailable: true },
      expectedSequences: [
        ["--die-with-parent", "--ro-bind", "/", "/"],
        ["--bind-try", "/tmp/epure-agent-x/.npm", "/tmp/epure-agent-x/.npm"],
        ["--bind-try", "/tmp/epure-agent-x/.cache", "/tmp/epure-agent-x/.cache"]
      ]
    }
  ])(
    "buildKernelSandboxedCommand [$id]: confines an agent session",
    ({ networkPolicy, capabilities, expectedSequences }) => {
      const wrapped = buildKernelSandboxedCommand({
        command: "pi",
        args: [],
        cwd: "/tmp/epure-work",
        sanitizedEnv: { PATH: "/usr/bin:/bin", HOME: "/tmp/epure-agent-x" },
        networkPolicy,
        proxyPort: 43120,
        capabilities,
        readOnlyPaths: ["/opt/epure/engine"],
        agentDir: "/tmp/epure-agent-x"
      });

      const joined = wrapped.args.join("\u0000");
      for (const sequence of expectedSequences) {
        expect(joined).toContain(sequence.join("\u0000"));
      }
    }
  );

  const NO_BACKEND: KernelSandboxCapabilities = {
    landrunAvailable: false,
    bubblewrapAvailable: false
  };
  it.each([
    {
      id: "fails-closed-when-enforce-kernel-sandbox-is-true-and-backends-are-unavailable",
      env: { EPURE_ENFORCE_KERNEL_SANDBOX: "true" },
      capabilities: NO_BACKEND,
      networkPolicy: "offline" as SandboxNetworkPolicy,
      installCommands: undefined,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE"
    },
    {
      id: "fails-closed-on-github-actions-even-when-enforcement-is-switched-off",
      env: { GITHUB_ACTIONS: "true", EPURE_ENFORCE_KERNEL_SANDBOX: "false" },
      capabilities: NO_BACKEND,
      networkPolicy: "offline" as SandboxNetworkPolicy,
      installCommands: undefined,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE"
    },
    {
      id: "fails-closed-on-any-ci-runner-without-the-enforcement-variable",
      env: { CI: "true" },
      capabilities: NO_BACKEND,
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      installCommands: undefined,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE"
    },
    {
      id: "fails-closed-in-ci-when-only-bubblewrap-exists-for-a-networked-session",
      env: { GITHUB_ACTIONS: "true" },
      capabilities: { landrunAvailable: false, bubblewrapAvailable: true },
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      installCommands: undefined,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE"
    },
    {
      id: "fails-closed-in-ci-with-bare-landrun-because-host-sockets-stay-reachable",
      env: { GITHUB_ACTIONS: "true" },
      capabilities: { landrunAvailable: true, bubblewrapAvailable: false },
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      installCommands: undefined,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE"
    },
    {
      id: "fails-closed-in-ci-before-installing-when-the-install-phase-cannot-be-confined",
      env: { GITHUB_ACTIONS: "true" },
      capabilities: { landrunAvailable: false, bubblewrapAvailable: true },
      networkPolicy: "offline" as SandboxNetworkPolicy,
      installCommands: [
        { command: process.execPath, args: ["-e", "console.log('sandbox-check')"] }
      ],
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE"
    },
    {
      id: "falls-back-to-an-unconfined-spawn-outside-ci-when-enforcement-is-off",
      env: { EPURE_ENFORCE_KERNEL_SANDBOX: "false" },
      capabilities: NO_BACKEND,
      networkPolicy: "offline" as SandboxNetworkPolicy,
      installCommands: undefined,
      expectedErrorCode: "NONE"
    }
  ])(
    "runInUntrustedCodeSandbox [$id]: kernel sandbox enforcement vs local fallback",
    async ({ env, capabilities, networkPolicy, installCommands, expectedErrorCode }) => {
      const result = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: { ...RUNNER_SECRETS_ENV, ...env },
        command: process.execPath,
        args: ["-e", "console.log('sandbox-check')"],
        networkPolicy,
        kernelCapabilities: capabilities,
        ...(installCommands ? { agentSession: { installCommands } } : {})
      });

      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.isolated).toBe(expectedErrorCode === "NONE");
      expect(result.stdout).toBe(expectedErrorCode === "NONE" ? "sandbox-check\n" : "");
    }
  );

  it.each([
    {
      id: "github-actions-in-the-orchestrator-env-refuses-even-with-a-trimmed-runner-env",
      processEnv: { GITHUB_ACTIONS: "true" },
      expected: { error_code: "SANDBOX_ISOLATION_UNAVAILABLE", isolated: false }
    },
    {
      id: "ci-equals-1-counts-as-ci",
      processEnv: { CI: "1" },
      expected: { error_code: "SANDBOX_ISOLATION_UNAVAILABLE", isolated: false }
    },
    {
      id: "outside-ci-the-step-runs-unconfined-and-fails-on-its-own",
      processEnv: {},
      expected: { error_code: "SANDBOX_COMMAND_FAILED", isolated: true }
    }
  ])(
    "runPolyglotStage1Verification [$id]: Stage 1 cannot bypass CI fail-closed",
    async ({ processEnv, expected }) => {
      for (const [name, value] of Object.entries(processEnv)) {
        vi.stubEnv(name, value);
      }
      const seen: Array<{ error_code: string; isolated: boolean }> = [];
      const res = await runPolyglotStage1Verification({
        profile: {
          wait_for_external_ci: false,
          external_ci_timeout_minutes: 1,
          grace_window_seconds: 0,
          targets: [
            {
              name: "api",
              working_directory: ".",
              kind: "node",
              path_patterns: ["**"],
              test_command: "npm test"
            }
          ]
        },
        files: [{ path: "src/index.ts", content: "export const x = 1;\n" }],
        changedPaths: ["src/index.ts"],
        llmApiKey: "test-llm-key",
        // No landrun or bwrap on this PATH, and no CI flag in what Stage 1 passes down.
        runnerEnv: { PATH: "/nonexistent-epure-bin", HOME: "/nonexistent-epure-home" },
        sandboxRunner: async (input) => {
          const result = await runInUntrustedCodeSandbox(input);
          seen.push({ error_code: result.error_code, isolated: result.isolated });
          return result;
        }
      });

      expect(res.passed).toBe(false);
      expect(seen).toEqual([expected]);
    }
  );

  const AGENT_REPORT = [
    "const fs = require('node:fs');",
    "const installed = JSON.parse(fs.readFileSync(process.env.HOME + '/installed.json', 'utf8'));",
    "console.log(JSON.stringify({ home: process.env.HOME, tmpdir: process.env.TMPDIR, installed, sessionNonce: Boolean(process.env.EPURE_LLM_PROXY_NONCE) }));"
  ].join("\n");
  const INSTALL_STEP = {
    command: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync(process.env.HOME + '/installed.json', JSON.stringify({ nonce: Boolean(process.env.EPURE_LLM_PROXY_NONCE) }))"
    ]
  };
  it.each([
    {
      id: "installs-first-without-the-nonce-then-runs-the-session-in-the-same-tmp-home",
      installCommands: [INSTALL_STEP],
      expected: {
        error_code: "NONE",
        network_policy: "proxy_only",
        installed: { nonce: false },
        sessionNonce: true
      }
    },
    {
      id: "a-failed-install-stops-before-the-session-starts",
      installCommands: [
        { command: process.execPath, args: ["-e", "console.error('lockfile drift'); process.exit(3)"] }
      ],
      expected: { error_code: "SANDBOX_COMMAND_FAILED", network_policy: "https_only", exit_code: 3 }
    }
  ])(
    "runInUntrustedCodeSandbox [$id]: dependencies are installed before the agent session",
    async ({ installCommands, expected }) => {
      const result = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: RUNNER_SECRETS_ENV,
        command: process.execPath,
        args: ["-e", AGENT_REPORT],
        llm: { model: "openai/gpt-5.4" },
        agentSession: { installCommands }
      });

      expect(result).toMatchObject({
        error_code: expected.error_code,
        network_policy: expected.network_policy
      });
      if (expected.error_code !== "NONE") {
        expect(result.exit_code).toBe(expected.exit_code);
        expect(result.stderr).toContain("lockfile drift");
        expect(result.stdout).toBe("");
        return;
      }
      const report = JSON.parse(result.stdout) as {
        home: string;
        tmpdir: string;
        installed: unknown;
        sessionNonce: boolean;
      };
      expect(report.home).toMatch(/^\/tmp\/epure-agent-/);
      expect(report.tmpdir).toBe(report.home);
      expect(report.installed).toEqual(expected.installed);
      expect(report.sessionNonce).toBe(expected.sessionNonce);
      expect(existsSync(report.home)).toBe(false);
    }
  );
});

// Runs only where the backend works (CI provisions both); skipped tests mean "proven only in CI".
describe("Kernel confinement of sandboxed runs (#98)", () => {
  const capabilities = probeKernelSandboxCapabilities(process.env);
  const workDirs: string[] = [];
  afterEach(() => {
    for (const dir of workDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const scratch = (prefix: string): string => {
    const dir = mkdtempSync(join("/tmp", prefix));
    workDirs.push(dir);
    return dir;
  };

  const PROBE = [
    "const fs = require('node:fs');",
    "const r = {};",
    "const t = (k, f) => { try { f(); r[k] = 'ok'; } catch { r[k] = 'denied'; } };",
    "t('writeHome', () => fs.writeFileSync(process.env.HOME + '/state', '1'));",
    "t('writeOutside', () => fs.writeFileSync(process.env.ESCAPE_FILE, '1'));",
    "t('readEngine', () => fs.readFileSync(process.env.ENGINE_FILE));",
    "t('writeEngine', () => fs.writeFileSync(process.env.ENGINE_FILE, 'tampered'));",
    "console.log(JSON.stringify(r));"
  ].join("\n");

  const DECLARED = { writeHome: "ok", writeOutside: "denied", readEngine: "ok", writeEngine: "denied" };
  const UNDECLARED = { ...DECLARED, readEngine: "denied" };
  it.for([
    {
      id: "landrun-session-reads-the-declared-engine-and-writes-only-its-tmp-home",
      backend: "bubblewrap+landrun",
      networkPolicy: "proxy_only",
      declareEngine: true,
      expected: DECLARED
    },
    {
      id: "landrun-session-cannot-read-an-undeclared-engine",
      backend: "bubblewrap+landrun",
      networkPolicy: "proxy_only",
      declareEngine: false,
      expected: UNDECLARED
    },
    {
      id: "bubblewrap-offline-run-sees-the-declared-engine-read-only",
      backend: "bubblewrap",
      networkPolicy: "offline",
      declareEngine: true,
      expected: DECLARED
    },
    {
      id: "bubblewrap-offline-run-cannot-see-an-undeclared-engine-under-tmp",
      backend: "bubblewrap",
      networkPolicy: "offline",
      declareEngine: false,
      expected: UNDECLARED
    }
  ] as const)(
    "runInUntrustedCodeSandbox [$id]",
    async ({ backend, networkPolicy, declareEngine, expected }, { skip }) => {
      if (selectKernelBackend(networkPolicy, capabilities) !== backend) {
        skip(`${backend} is not usable on this host`);
      }
      const engineDir = scratch("epure-engine-");
      const engineFile = join(engineDir, "engine.js");
      writeFileSync(engineFile, "engine");
      const escapeFile = join(scratch("epure-outside-"), "escaped");

      const result = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: { PATH: process.env.PATH },
        command: process.execPath,
        args: ["-e", PROBE],
        cwd: scratch("epure-work-"),
        networkPolicy,
        enforceKernelSandbox: true,
        readOnlyPaths: declareEngine ? [engineDir] : [],
        agentSession: { env: () => ({ ENGINE_FILE: engineFile, ESCAPE_FILE: escapeFile }) }
      });

      expect(result.kernel_backend).toBe(backend);
      expect(JSON.parse(result.stdout)).toEqual(expected);
      expect(existsSync(escapeFile)).toBe(false);
      expect(readFileSync(engineFile, "utf8")).toBe("engine");
    }
  );

  const SOCKET_PROBE = [
    "const net = require('node:net');",
    "const fs = require('node:fs');",
    "const connect = (p) => new Promise((r) => { const s = net.connect(p); s.on('connect', () => { s.destroy(); r('connected'); }); s.on('error', () => r('unreachable')); });",
    "(async () => {",
    "  const out = {};",
    "  for (const p of JSON.parse(process.env.SOCKETS)) out[p] = await connect(p);",
    "  try { fs.readFileSync('/proc/' + process.env.PARENT_PID + '/environ'); out.parentEnviron = 'read'; } catch { out.parentEnviron = 'unreadable'; }",
    "  console.log(JSON.stringify(out));",
    "})();"
  ].join("\n");
  const hostConnect = (path: string): Promise<boolean> =>
    new Promise((resolveConnect) => {
      const socket = createConnection(path);
      socket.on("connect", () => {
        socket.destroy();
        resolveConnect(true);
      });
      socket.on("error", () => resolveConnect(false));
    });

  it.for([
    { id: "bubblewrap-offline-run", backend: "bubblewrap", networkPolicy: "offline" },
    { id: "landrun-session-inside-bubblewrap", backend: "bubblewrap+landrun", networkPolicy: "proxy_only" }
  ] as const)(
    "runInUntrustedCodeSandbox [$id]: cannot reach docker.sock, /run/user sockets or the orchestrator's environ",
    async ({ backend, networkPolicy }, { skip }) => {
      if (selectKernelBackend(networkPolicy, capabilities) !== backend) {
        skip(`${backend} is not usable on this host`);
      }
      const sockets: string[] = [];
      // GitHub-hosted runners put the runner user in the docker group: this is the escape to close.
      if (await hostConnect("/var/run/docker.sock")) {
        sockets.push("/var/run/docker.sock");
      }
      const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
      let server: Server | undefined;
      if (existsSync(runtimeDir)) {
        const path = join(runtimeDir, `epure-probe-${process.pid}.sock`);
        server = createServer((socket) => socket.end());
        await new Promise<void>((resolveListen, rejectListen) => {
          server?.once("error", rejectListen);
          server?.listen(path, () => resolveListen());
        });
        sockets.push(path);
      }
      try {
        for (const path of sockets) {
          expect(await hostConnect(path)).toBe(true);
        }
        const result = await runInUntrustedCodeSandbox({
          isolationAvailable: true,
          runnerEnv: { PATH: process.env.PATH },
          command: process.execPath,
          args: ["-e", SOCKET_PROBE],
          cwd: scratch("epure-work-"),
          networkPolicy,
          enforceKernelSandbox: true,
          agentSession: {
            env: () => ({ SOCKETS: JSON.stringify(sockets), PARENT_PID: String(process.pid) })
          }
        });

        expect(result.kernel_backend).toBe(backend);
        expect(JSON.parse(result.stdout)).toEqual({
          ...Object.fromEntries(sockets.map((path) => [path, "unreachable"])),
          parentEnviron: "unreadable"
        });
      } finally {
        await new Promise<void>((resolveClose) =>
          server ? server.close(() => resolveClose()) : resolveClose()
        );
      }
    }
  );

  it.for([
    { id: "landrun-proxy-only-session-reaches-the-proxy-but-not-the-upstream-directly" }
  ])("runInUntrustedCodeSandbox [$id]", async (_row, { skip }) => {
    if (selectKernelBackend("proxy_only", capabilities) !== "bubblewrap+landrun") {
      skip("landrun inside bubblewrap is not usable on this host");
    }
    const upstream = await sseUpstream();
    const script = [
      "const auth = { authorization: 'Bearer ' + process.env.EPURE_LLM_PROXY_NONCE, 'content-type': 'application/json' };",
      "const viaProxy = await fetch(process.env.EPURE_LLM_PROXY_URL + '/chat/completions', { method: 'POST', headers: auth, body: '{}' }).then((r) => r.status);",
      "const direct = await fetch(process.env.DIRECT_URL, { method: 'POST', body: '{}' }).then((r) => r.status, () => 'blocked');",
      "console.log(JSON.stringify({ viaProxy, direct }));"
    ].join("\n");

    const result = await runInUntrustedCodeSandbox({
      isolationAvailable: true,
      runnerEnv: {
        PATH: process.env.PATH,
        CORP_GATEWAY_API_KEY: REAL_KEY,
        DIRECT_URL: `${upstream.url}/v1/chat/completions`
      },
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
      cwd: scratch("epure-work-"),
      enforceKernelSandbox: true,
      llm: {
        model: "corp-gateway/qwen-coder",
        providers: {
          "corp-gateway": {
            provider: "openai",
            base_url: `${upstream.url}/v1`,
            api_key: "os.environ/CORP_GATEWAY_API_KEY"
          }
        }
      },
      agentSession: {}
    });

    expect(result.kernel_backend).toBe("bubblewrap+landrun");
    expect(JSON.parse(result.stdout)).toEqual({ viaProxy: 200, direct: "blocked" });
    expect(upstream.requests).toHaveLength(1);
  });
});
