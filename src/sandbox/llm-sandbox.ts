import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { containsPrivateKeyMaterial } from "../auth/github-apps.js";
import { redactSecrets } from "../auth/issue-command-gate.js";

export type SandboxErrorCode =
  | "NONE"
  | "SANDBOX_ISOLATION_UNAVAILABLE"
  | "LLM_API_KEY_MISSING"
  | "PROXY_UNAUTHORIZED_NONCE"
  | "PROXY_FORBIDDEN_ENDPOINT"
  | "SANDBOX_COMMAND_FAILED";

export type SandboxNetworkPolicy = "proxy_only" | "https_only" | "offline";

export type KernelSandboxBackend = "landrun" | "bubblewrap" | "none";

export interface KernelSandboxCapabilities {
  readonly landrunAvailable: boolean;
  readonly bubblewrapAvailable: boolean;
}

export interface BuildKernelSandboxedCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sanitizedEnv: Readonly<Record<string, string>>;
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly proxyPort?: number | undefined;
  readonly capabilities: KernelSandboxCapabilities;
}

export interface BuiltKernelSandboxedCommand {
  readonly backend: KernelSandboxBackend;
  readonly command: string;
  readonly args: readonly string[];
}

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
  readonly networkPolicy?: SandboxNetworkPolicy | undefined;
  readonly enforceKernelSandbox?: boolean | undefined;
  readonly kernelCapabilities?: KernelSandboxCapabilities | undefined;
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
  readonly kernel_backend?: KernelSandboxBackend | undefined;
  readonly network_policy?: SandboxNetworkPolicy | undefined;
}

const SECRET_ENV_NAME_PATTERN =
  /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|LLM_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|EPURE_.*(?:KEY|TOKEN|SECRET)|AWS_.*|AZURE_.*|GCP_.*|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i;

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
  sanitized.RTK_TELEMETRY_DISABLED = "1";
  sanitized.RTK_RECALL = "0";
  sanitized.RTK_TEE = "0";
  sanitized.RTK_SUPPRESS_HOOK_WARNING = "1";
  sanitized.NO_COLOR = "1";

  return sanitized;
}

export function buildLandrunInvocation(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sanitizedEnv: Readonly<Record<string, string>>;
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly proxyPort?: number | undefined;
}): readonly string[] {
  const sanitizeLandrunPath = (p: string): string => p.replace(/,/g, "");
  const resolvedCwd = sanitizeLandrunPath(resolve(params.cwd));
  const roxPaths = new Set<string>([
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc",
    "/opt",
    "/run"
  ]);
  if (params.command.startsWith("/")) {
    roxPaths.add(sanitizeLandrunPath(dirname(resolve(params.command))));
  }

  const rwxPaths = new Set<string>([resolvedCwd, "/tmp"]);
  if (params.networkPolicy === "https_only") {
    const home = sanitizeLandrunPath(params.sanitizedEnv.HOME?.trim() ?? "");
    if (home) {
      rwxPaths.add(`${home}/.npm`);
      rwxPaths.add(`${home}/.cache`);
      rwxPaths.add(`${home}/.cargo`);
    }
  }

  const landrunArgs: string[] = [
    "--rox",
    Array.from(roxPaths).join(","),
    "--ro",
    "/dev,/proc",
    "--rwx",
    Array.from(rwxPaths).join(",")
  ];

  if (params.networkPolicy === "proxy_only") {
    if (typeof params.proxyPort === "number" && params.proxyPort > 0) {
      landrunArgs.push("--connect-tcp", String(params.proxyPort));
    }
  } else if (params.networkPolicy === "https_only") {
    landrunArgs.push("--connect-tcp", "443");
  }
  // When networkPolicy === "offline", zero --connect-tcp flags are emitted.

  for (const key of Object.keys(params.sanitizedEnv).sort()) {
    landrunArgs.push("--env", key);
  }

  landrunArgs.push("--", params.command, ...params.args);
  return landrunArgs;
}

export function buildBubblewrapInvocation(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}): readonly string[] {
  const resolvedCwd = resolve(params.cwd);
  return [
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    resolvedCwd,
    resolvedCwd,
    "--chdir",
    resolvedCwd,
    "--",
    params.command,
    ...params.args
  ];
}

export function buildKernelSandboxedCommand(
  input: BuildKernelSandboxedCommandInput
): BuiltKernelSandboxedCommand {
  if (input.networkPolicy === "offline") {
    if (input.capabilities.bubblewrapAvailable) {
      return {
        backend: "bubblewrap",
        command: "bwrap",
        args: buildBubblewrapInvocation({
          command: input.command,
          args: input.args,
          cwd: input.cwd
        })
      };
    }
    if (input.capabilities.landrunAvailable) {
      return {
        backend: "landrun",
        command: "landrun",
        args: buildLandrunInvocation({
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          sanitizedEnv: input.sanitizedEnv,
          networkPolicy: "offline",
          proxyPort: input.proxyPort
        })
      };
    }
    return {
      backend: "none",
      command: input.command,
      args: input.args
    };
  }

  if (input.capabilities.landrunAvailable) {
    return {
      backend: "landrun",
      command: "landrun",
      args: buildLandrunInvocation({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        sanitizedEnv: input.sanitizedEnv,
        networkPolicy: input.networkPolicy,
        proxyPort: input.proxyPort
      })
    };
  }

  return {
    backend: "none",
    command: input.command,
    args: input.args
  };
}

let cachedDefaultCapabilities: KernelSandboxCapabilities | null = null;
let cachedDefaultCapabilitiesPath = "";

export function probeKernelSandboxCapabilities(
  runnerEnv: Readonly<Record<string, string | undefined>> = process.env
): KernelSandboxCapabilities {
  if (process.platform !== "linux") {
    return { landrunAvailable: false, bubblewrapAvailable: false };
  }

  const pathVal =
    runnerEnv.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  if (
    cachedDefaultCapabilities !== null &&
    cachedDefaultCapabilitiesPath === pathVal
  ) {
    return cachedDefaultCapabilities;
  }

  const probeEnv: NodeJS.ProcessEnv = {
    PATH: pathVal
  };

  let landrunAvailable = false;
  try {
    const res = spawnSync(
      "landrun",
      ["--rox", "/usr,/bin,/lib,/lib64", "--", "/bin/true"],
      {
        env: probeEnv,
        stdio: "ignore",
        timeout: 3000
      }
    );
    landrunAvailable = res.status === 0;
  } catch {
    landrunAvailable = false;
  }

  let bubblewrapAvailable = false;
  try {
    const res = spawnSync("bwrap", ["--version"], {
      env: probeEnv,
      stdio: "ignore",
      timeout: 3000
    });
    bubblewrapAvailable = res.status === 0;
  } catch {
    bubblewrapAvailable = false;
  }

  const result = { landrunAvailable, bubblewrapAvailable };
  cachedDefaultCapabilities = result;
  cachedDefaultCapabilitiesPath = pathVal;
  return result;
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

function parsePortFromProxyUrl(proxyUrl: string): number | undefined {
  const match = /:(\d+)(?:\/|$)/.exec(proxyUrl);
  if (!match || !match[1]) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function runInUntrustedCodeSandbox(
  input: SandboxExecutionInput
): Promise<SandboxExecutionResult> {
  const startMs = Date.now();
  const networkPolicy: SandboxNetworkPolicy = input.networkPolicy ?? "proxy_only";

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
      proxy_url: "",
      kernel_backend: "none",
      network_policy: networkPolicy
    };
  }

  const llmApiKey = (
    input.runnerEnv.OPENAI_API_KEY ??
    input.runnerEnv.ANTHROPIC_API_KEY ??
    input.runnerEnv.GOOGLE_API_KEY ??
    input.runnerEnv.GEMINI_API_KEY ??
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
      proxy_url: "",
      kernel_backend: "none",
      network_policy: networkPolicy
    };
  }

  const enforceKernelSandbox =
    input.enforceKernelSandbox === true ||
    input.runnerEnv.EPURE_ENFORCE_KERNEL_SANDBOX === "true";

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
    const cwd = input.cwd ?? process.cwd();
    const timeoutMs = input.timeoutMs ?? 60 * 60 * 1000;
    const proxyPort = parsePortFromProxyUrl(proxy.proxyUrl);

    const capabilities =
      input.kernelCapabilities ??
      probeKernelSandboxCapabilities(input.runnerEnv);
    if (networkPolicy === "https_only") {
      const home = sanitizedEnv.HOME?.trim() ?? "";
      if (home) {
        for (const sub of [".npm", ".cache", ".cargo"]) {
          try {
            mkdirSync(resolve(home, sub), { recursive: true });
          } catch {
            // Best-effort cache directory creation before Landlock ruleset population
          }
        }
      }
    }
    const wrapped = buildKernelSandboxedCommand({
      command: input.command,
      args,
      cwd,
      sanitizedEnv,
      networkPolicy,
      proxyPort,
      capabilities
    });
    const kernelBackend: KernelSandboxBackend = wrapped.backend;
    if (wrapped.backend === "none" && enforceKernelSandbox) {
      return {
        isolated: false,
        error_code: "SANDBOX_ISOLATION_UNAVAILABLE",
        error_message:
          "Fail-closed: kernel sandbox backend (landrun/bubblewrap) is unavailable while EPURE_ENFORCE_KERNEL_SANDBOX=true (ADR-0030).",
        exit_code: 1,
        stdout: "",
        stderr: "",
        duration_ms: Date.now() - startMs,
        proxy_url: "",
        kernel_backend: "none",
        network_policy: networkPolicy
      };
    }
    const spawnCommand = wrapped.command;
    const spawnArgs = wrapped.args;

    const childResult = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolvePromise) => {
      const child = spawn(spawnCommand, [...spawnArgs], {
        cwd,
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
        resolvePromise({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: err.message
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({
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
      proxy_url: proxy.proxyUrl,
      kernel_backend: kernelBackend,
      network_policy: networkPolicy
    };
  } finally {
    await proxy.close();
  }
}
