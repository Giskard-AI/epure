import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { containsPrivateKeyMaterial } from "../auth/github-apps.js";
import { redactSecrets } from "../auth/issue-command-gate.js";

export type SandboxErrorCode =
  | "NONE"
  | "SANDBOX_ISOLATION_UNAVAILABLE"
  | "LLM_API_KEY_MISSING"
  | "PROXY_UNAUTHORIZED_NONCE"
  | "PROXY_FORBIDDEN_ENDPOINT"
  | "SANDBOX_COMMAND_FAILED";

export interface SandboxProxyEndpoint {
  readonly proxyUrl: string;
  readonly proxyNonce: string;
}

export interface LlmProxyRequestPayload {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface LlmProxyResponsePayload {
  readonly status: number;
  readonly body: string;
}

export interface CreateLlmSandboxProxyOptions {
  readonly llmApiKey: string;
  readonly upstreamHandler?:
    | ((
        req: LlmProxyRequestPayload,
        apiKeyInRunnerMemory: string
      ) => Promise<LlmProxyResponsePayload>)
    | undefined;
}

export interface LlmSandboxProxyHandle extends SandboxProxyEndpoint {
  close(): Promise<void>;
}

export interface SandboxExecutionInput {
  readonly isolationAvailable: boolean;
  readonly runnerEnv: Readonly<Record<string, string | undefined>>;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly upstreamHandler?:
    | ((
        req: LlmProxyRequestPayload,
        apiKeyInRunnerMemory: string
      ) => Promise<LlmProxyResponsePayload>)
    | undefined;
}

export interface SandboxExecutionResult {
  readonly isolated: boolean;
  readonly error_code: SandboxErrorCode;
  readonly error_message: string;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
  readonly proxy_url: string;
}

const SECRET_ENV_NAME_PATTERN =
  /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|LLM_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|EPURE_.*(?:KEY|TOKEN|SECRET)|AWS_.*|AZURE_.*|GCP_.*|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i;

const ALLOWED_PROXY_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/chat/completions",
  "/responses",
  "/messages"
]);

export function buildSanitizedSandboxEnv(
  runnerEnv: Readonly<Record<string, string | undefined>>,
  proxy: SandboxProxyEndpoint
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(runnerEnv)) {
    if (typeof value !== "string") {
      continue;
    }
    if (SECRET_ENV_NAME_PATTERN.test(key)) {
      continue;
    }
    if (containsPrivateKeyMaterial(value)) {
      continue;
    }
    sanitized[key] = value;
  }

  sanitized.EPURE_SANDBOX_ACTIVE = "true";
  sanitized.EPURE_LLM_PROXY_URL = proxy.proxyUrl;
  sanitized.EPURE_LLM_PROXY_NONCE = proxy.proxyNonce;
  sanitized.GITHUB_TOKEN_PERMISSIONS = "none";

  return sanitized;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function createLlmSandboxProxy(
  options: CreateLlmSandboxProxyOptions
): Promise<LlmSandboxProxyHandle> {
  const realKey = options.llmApiKey.trim();
  const proxyNonce = randomBytes(24).toString("hex");

  const defaultUpstream = async (
    req: LlmProxyRequestPayload
  ): Promise<LlmProxyResponsePayload> => ({
    status: 200,
    body: JSON.stringify({
      id: "chatcmpl-epure-proxy",
      object: "chat.completion",
      path: req.path,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }]
    })
  });

  const handler = options.upstreamHandler ?? defaultUpstream;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const providedNonce = req.headers["x-epure-proxy-nonce"];
      if (providedNonce !== proxyNonce) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error_code: "PROXY_UNAUTHORIZED_NONCE",
            error_message:
              "Missing or invalid x-epure-proxy-nonce header for local sandbox LLM proxy."
          })
        );
        return;
      }

      const rawUrl = req.url ?? "/";
      const normalizedPath = rawUrl.split("?")[0] ?? "/";
      if (!ALLOWED_PROXY_PATHS.has(normalizedPath)) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error_code: "PROXY_FORBIDDEN_ENDPOINT",
            error_message: `Sandbox LLM proxy forbids access to '${normalizedPath}'.`
          })
        );
        return;
      }

      const body = await readRequestBody(req);
      const upstreamResp = await handler(
        {
          method: req.method ?? "POST",
          path: normalizedPath,
          body
        },
        realKey
      );

      res.statusCode = upstreamResp.status;
      res.setHeader("content-type", "application/json");
      res.end(redactSecrets(upstreamResp.body, [realKey]));
    }
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const proxyUrl = `http://127.0.0.1:${address.port}`;

  return {
    proxyUrl,
    proxyNonce,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

function collectRunnerSecretValues(
  runnerEnv: Readonly<Record<string, string | undefined>>
): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(runnerEnv)) {
    if (typeof value === "string" && value.trim().length >= 8) {
      if (SECRET_ENV_NAME_PATTERN.test(key) || containsPrivateKeyMaterial(value)) {
        values.push(value.trim());
      }
    }
  }
  return values;
}

export async function runInUntrustedCodeSandbox(
  input: SandboxExecutionInput
): Promise<SandboxExecutionResult> {
  const startMs = Date.now();

  if (!input.isolationAvailable) {
    return {
      isolated: false,
      error_code: "SANDBOX_ISOLATION_UNAVAILABLE",
      error_message:
        "Fail-closed: container/process sandbox isolation is unavailable on this runner (ADR-0011, ADR-0023).",
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - startMs,
      proxy_url: ""
    };
  }

  const llmApiKey = (
    input.runnerEnv.OPENAI_API_KEY ??
    input.runnerEnv.ANTHROPIC_API_KEY ??
    input.runnerEnv.LLM_API_KEY ??
    ""
  ).trim();

  if (!llmApiKey) {
    return {
      isolated: false,
      error_code: "LLM_API_KEY_MISSING",
      error_message:
        "Fail-closed: runner is missing LLM API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or LLM_API_KEY) for the local proxy sidecar.",
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - startMs,
      proxy_url: ""
    };
  }

  const secretValues = collectRunnerSecretValues(input.runnerEnv);
  const proxy = await createLlmSandboxProxy({
    llmApiKey,
    upstreamHandler: input.upstreamHandler
  });

  try {
    const sanitizedEnv = buildSanitizedSandboxEnv(input.runnerEnv, {
      proxyUrl: proxy.proxyUrl,
      proxyNonce: proxy.proxyNonce
    });

    const args = input.args ? [...input.args] : [];
    const timeoutMs = input.timeoutMs ?? 60 * 60 * 1000;

    const childResult = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn(input.command, args, {
        cwd: input.cwd ?? process.cwd(),
        env: sanitizedEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: err.message
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8")
        });
      });
    });

    const cleanStdout = redactSecrets(childResult.stdout, secretValues);
    const cleanStderr = redactSecrets(childResult.stderr, secretValues);
    const ok = childResult.exitCode === 0;

    return {
      isolated: true,
      error_code: ok ? "NONE" : "SANDBOX_COMMAND_FAILED",
      error_message: ok
        ? ""
        : `Sandboxed command exited with code ${childResult.exitCode}.`,
      exit_code: childResult.exitCode,
      stdout: cleanStdout,
      stderr: cleanStderr,
      duration_ms: Date.now() - startMs,
      proxy_url: proxy.proxyUrl
    };
  } finally {
    await proxy.close();
  }
}
