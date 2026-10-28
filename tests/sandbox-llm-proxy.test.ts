import { describe, expect, it } from "vitest";
import {
  buildKernelSandboxedCommand,
  buildSanitizedSandboxEnv,
  createLlmSandboxProxy,
  runInUntrustedCodeSandbox,
  type KernelSandboxCapabilities,
  type SandboxExecutionInput,
  type SandboxNetworkPolicy
} from "../src/sandbox/llm-sandbox.js";

describe("Ticket 06 (#7) — Sandbox LLM proxy & untrusted code credential isolation", () => {
  const RUNNER_SECRETS_ENV: Readonly<Record<string, string>> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/runner",
    NODE_ENV: "test",
    OPENAI_API_KEY: "sk-proj-RealRunnerSecretKey1234567890ABCDEF",
    ANTHROPIC_API_KEY: "sk-ant-api03-RealAnthropicSecret9876543210",
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
    {
      id: "strips-openai-key",
      forbiddenKey: "OPENAI_API_KEY"
    },
    {
      id: "strips-anthropic-key",
      forbiddenKey: "ANTHROPIC_API_KEY"
    },
    {
      id: "strips-github-token",
      forbiddenKey: "GITHUB_TOKEN"
    },
    {
      id: "strips-gh-token",
      forbiddenKey: "GH_TOKEN"
    },
    {
      id: "strips-agent-app-private-key",
      forbiddenKey: "EPURE_AGENT_APP_PRIVATE_KEY"
    },
    {
      id: "strips-release-app-private-key",
      forbiddenKey: "EPURE_RELEASE_APP_PRIVATE_KEY"
    },
    {
      id: "strips-npm-and-cloud-tokens",
      forbiddenKey: "NPM_TOKEN"
    }
  ])(
    "buildSanitizedSandboxEnv [$id]: strips '$forbiddenKey' and injects only local proxy endpoint & session nonce",
    ({ forbiddenKey }) => {
      const sanitized = buildSanitizedSandboxEnv(RUNNER_SECRETS_ENV, {
        proxyUrl: "http://127.0.0.1:43199/v1",
        proxyNonce: "nonce-ephemeral-123"
      });

      expect(sanitized[forbiddenKey]).toBeUndefined();
      expect(sanitized.EPURE_LLM_PROXY_URL).toBe("http://127.0.0.1:43199/v1");
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
        ]
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
      id: "legitimate-test-command-succeeds-and-returns-output",
      input: {
        isolationAvailable: true,
        runnerEnv: RUNNER_SECRETS_ENV,
        command: process.execPath,
        args: ["-e", "console.log('test-suite: 12 passed')"]
      } satisfies SandboxExecutionInput,
      expectedExitCode: 0,
      expectedAllowed: true,
      expectedErrorCode: "NONE",
      verifyOutput: (stdout: string) => {
        expect(stdout.trim()).toBe("test-suite: 12 passed");
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
      id: "fail-closed-when-llm-api-key-missing-on-runner",
      input: {
        isolationAvailable: true,
        runnerEnv: { PATH: "/usr/bin" },
        command: process.execPath,
        args: ["-e", "console.log('should-never-run')"]
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
    async ({
      input,
      expectedExitCode,
      expectedAllowed,
      expectedErrorCode,
      verifyOutput
    }) => {
      const result = await runInUntrustedCodeSandbox(input);
      expect(result.isolated).toBe(expectedAllowed);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.exit_code).toBe(expectedExitCode);
      verifyOutput(result.stdout);
    }
  );

  it.each([
    {
      id: "valid-nonce-chat-completion-succeeds-without-leaking-key",
      path: "/v1/chat/completions",
      useValidNonce: true,
      expectedStatus: 200,
      expectedErrorCode: "NONE"
    },
    {
      id: "invalid-nonce-is-rejected-by-proxy",
      path: "/v1/chat/completions",
      useValidNonce: false,
      expectedStatus: 401,
      expectedErrorCode: "PROXY_UNAUTHORIZED_NONCE"
    },
    {
      id: "adversarial-raw-key-endpoint-is-blocked-by-proxy",
      path: "/v1/debug/raw-key",
      useValidNonce: true,
      expectedStatus: 403,
      expectedErrorCode: "PROXY_FORBIDDEN_ENDPOINT"
    }
  ])(
    "createLlmSandboxProxy [$id]: mediates LLM requests in runner memory without exposing raw key",
    async ({ path, useValidNonce, expectedStatus, expectedErrorCode }) => {
      const proxy = await createLlmSandboxProxy({
        llmApiKey: "sk-proj-RealRunnerSecretKey1234567890ABCDEF",
        upstreamHandler: async (_req, apiKeyInRunnerMemory) => {
          expect(apiKeyInRunnerMemory).toBe(
            "sk-proj-RealRunnerSecretKey1234567890ABCDEF"
          );
          return {
            status: 200,
            body: JSON.stringify({
              id: "chatcmpl-test",
              content: "ok"
            })
          };
        }
      });

      try {
        const res = await fetch(`${proxy.proxyUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-epure-proxy-nonce": useValidNonce
              ? proxy.proxyNonce
              : "wrong-nonce"
          },
          body: JSON.stringify({ prompt: "hello" })
        });

        expect(res.status).toBe(expectedStatus);
        const bodyText = await res.text();
        expect(bodyText).not.toContain(
          "sk-proj-RealRunnerSecretKey1234567890ABCDEF"
        );
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        if (expectedErrorCode !== "NONE") {
          expect(parsed.error_code).toBe(expectedErrorCode);
        } else {
          expect(parsed.id).toBe("chatcmpl-test");
        }
      } finally {
        await proxy.close();
      }
    }
  );

  it.each([
    {
      id: "https-only-install-uses-landrun-with-port-443-and-proxy-port",
      networkPolicy: "https_only" as SandboxNetworkPolicy,
      proxyPort: 43120,
      capabilities: {
        landrunAvailable: true,
        bubblewrapAvailable: true
      } satisfies KernelSandboxCapabilities,
      expectedBackend: "landrun" as const,
      expectedCommand: "landrun",
      requiredArgs: ["--connect-tcp", "443", "43120", "--rwx", "--rox"],
      forbiddenArgs: ["--unshare-net"]
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

  it("fails closed with SANDBOX_ISOLATION_UNAVAILABLE when EPURE_ENFORCE_KERNEL_SANDBOX=true and kernel backends are unavailable", async () => {
    const result = await runInUntrustedCodeSandbox({
      isolationAvailable: true,
      runnerEnv: {
        ...RUNNER_SECRETS_ENV,
        EPURE_ENFORCE_KERNEL_SANDBOX: "true"
      },
      command: process.execPath,
      args: ["-e", "console.log('should-not-execute')"],
      networkPolicy: "offline",
      kernelCapabilities: {
        landrunAvailable: false,
        bubblewrapAvailable: false
      }
    });

    expect(result.isolated).toBe(false);
    expect(result.error_code).toBe("SANDBOX_ISOLATION_UNAVAILABLE");
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe("");
  });
});
