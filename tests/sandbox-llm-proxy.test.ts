import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderUpstream, type ProviderKind } from "../src/llm/index.js";
import {
  buildKernelSandboxedCommand,
  buildSanitizedSandboxEnv,
  createLlmSandboxProxy,
  runInUntrustedCodeSandbox,
  type KernelSandboxCapabilities,
  type LlmProxyExchange,
  type SandboxExecutionInput,
  type SandboxNetworkPolicy
} from "../src/sandbox/llm-sandbox.js";
import {
  rawProxyRequest,
  startFakeLlmUpstream,
  type FakeLlmUpstream
} from "./fixtures/fake-llm-upstream.js";

const REAL_KEY = "sk-real-RunnerHeldKey1234567890ABCDEF";
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

afterEach(async () => {
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
    {
      id: "openai-bearer",
      provider: "openai",
      baseSuffix: "/v1",
      path: "/chat/completions",
      credential: (nonce: string) => ({ authorization: `Bearer ${nonce}` }),
      expectedUpstreamUrl: "/v1/chat/completions",
      expectedAuth: ["authorization", `Bearer ${REAL_KEY}`]
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
      expectedAuth: ["authorization", `Bearer ${REAL_KEY}`]
    },
    {
      id: "openrouter-bearer",
      provider: "openrouter",
      baseSuffix: "/api/v1",
      path: "/chat/completions",
      credential: (nonce: string) => ({ authorization: `Bearer ${nonce}` }),
      expectedUpstreamUrl: "/api/v1/chat/completions",
      expectedAuth: ["authorization", `Bearer ${REAL_KEY}`]
    },
    {
      id: "azure-openai-api-key-keeps-api-version-query",
      provider: "azure",
      baseSuffix: "",
      path: "/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
      credential: (nonce: string) => ({ "api-key": nonce }),
      expectedUpstreamUrl: "/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
      expectedAuth: ["api-key", REAL_KEY]
    },
    {
      id: "azure-ai-foundry-api-key",
      provider: "azure_ai",
      baseSuffix: "/models",
      path: "/chat/completions",
      credential: (nonce: string) => ({ "api-key": nonce }),
      expectedUpstreamUrl: "/openai/v1/chat/completions",
      expectedAuth: ["api-key", REAL_KEY]
    },
    {
      id: "anthropic-x-api-key",
      provider: "anthropic",
      baseSuffix: "",
      path: "/v1/messages",
      credential: (nonce: string) => ({ "x-api-key": nonce, "anthropic-version": "2023-06-01" }),
      expectedUpstreamUrl: "/v1/messages",
      expectedAuth: ["x-api-key", REAL_KEY]
    },
    {
      id: "gemini-key-query-moves-to-header-and-alt-sse-stays",
      provider: "google",
      baseSuffix: "/v1beta",
      path: "/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=NONCE",
      credential: () => ({}),
      expectedUpstreamUrl: "/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
      expectedAuth: ["x-goog-api-key", REAL_KEY]
    },
    {
      id: "vertex-express-x-goog-api-key",
      provider: "vertex",
      baseSuffix: "",
      path: "/v1/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
      credential: (nonce: string) => ({ "x-goog-api-key": nonce }),
      expectedUpstreamUrl:
        "/v1/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
      expectedAuth: ["x-goog-api-key", REAL_KEY]
    }
  ] as const)(
    "createLlmSandboxProxy [$id]: forwards to the declared provider with the real key and streams SSE back",
    async ({ provider, baseSuffix, path, credential, expectedUpstreamUrl, expectedAuth }) => {
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
        expect(forwarded?.body).toBe('{"stream":true}');
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
      id: "https-only-install-uses-landrun-with-port-443-only-and-excludes-proxy-port",
      networkPolicy: "https_only" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: true
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "landrun" as const,
      expectedCommand: "landrun",
      requiredArgs: ["--connect-tcp", "443", "--rwx", "--rox"],
      forbiddenArgs: ["43120", "--unshare-net"]
    },
    {
      id: "proxy-only-harness-uses-landrun-with-ephemeral-proxy-port-only",
      networkPolicy: "proxy_only" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: true
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "landrun" as const,
      expectedCommand: "landrun",
      requiredArgs: ["--connect-tcp", "43120", "--rwx", "--rox"],
      forbiddenArgs: ["443", "--unshare-net"]
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
        "/tmp"
      ],
      forbiddenArgs: ["--connect-tcp"]
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
      id: "fails-closed-when-enforce-kernel-sandbox-is-true-and-backends-are-unavailable",
      enforceEnv: "true",
      capabilities: {
        landrunAvailable: false,
        bubblewrapAvailable: false
      } satisfies KernelSandboxCapabilities,
      expectedIsolated: false,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE",
      expectedExitCode: 1
    },
    {
      id: "falls-back-gracefully-to-unconfined-spawn-when-enforce-kernel-sandbox-is-false-and-backends-are-unavailable",
      enforceEnv: "false",
      capabilities: {
        landrunAvailable: false,
        bubblewrapAvailable: false
      } satisfies KernelSandboxCapabilities,
      expectedIsolated: true,
      expectedErrorCode: "NONE",
      expectedExitCode: 0
    }
  ])(
    "runInUntrustedCodeSandbox [$id]: kernel sandbox enforcement vs local fallback",
    async ({ enforceEnv, capabilities, expectedIsolated, expectedErrorCode, expectedExitCode }) => {
      const result = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: {
          ...RUNNER_SECRETS_ENV,
          EPURE_ENFORCE_KERNEL_SANDBOX: enforceEnv
        },
        command: process.execPath,
        args: ["-e", "console.log('sandbox-check')"],
        networkPolicy: "offline",
        kernelCapabilities: capabilities
      });

      expect(result.isolated).toBe(expectedIsolated);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.exit_code).toBe(expectedExitCode);
      expect(result.kernel_backend).toBe("none");
    }
  );
});
