import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { containsPrivateKeyMaterial } from "../auth/github-apps.js";
import { redactSecrets } from "../auth/issue-command-gate.js";
import { parseModelIdentifier, resolveProviderApiKey } from "../llm/client.js";
import type { ProviderConfig } from "../llm/types.js";
import { resolveProviderUpstream, type ProviderUpstream } from "../llm/upstream.js";

export type SandboxErrorCode =
  | "NONE"
  | "SANDBOX_ISOLATION_UNAVAILABLE"
  | "LLM_API_KEY_MISSING"
  | "PROXY_UNAUTHORIZED_NONCE"
  | "PROXY_FORBIDDEN_ENDPOINT"
  | "PROXY_UPSTREAM_UNREACHABLE"
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

export interface LlmProxyExchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly contentType: string;
}

// Sees the response bytes exactly as relayed to the sandbox, e.g. to read token usage from a stream.
export interface LlmProxyResponseObserver {
  onChunk(chunk: Uint8Array): void;
  onEnd(): void;
}

export interface CreateLlmSandboxProxyOptions {
  readonly upstream: ProviderUpstream;
  readonly apiKey: string;
  readonly observeResponse?:
    | ((exchange: LlmProxyExchange) => LlmProxyResponseObserver | undefined)
    | undefined;
}

export interface LlmSandboxProxyHandle extends SandboxProxyEndpoint {
  close(): Promise<void>;
}

// The model the sandboxed agent may call; its provider and key are resolved like LLMClient does.
export interface SandboxLlmRoute {
  readonly model: string;
  readonly providers?: Readonly<Record<string, ProviderConfig>> | undefined;
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
  readonly llm?: SandboxLlmRoute | undefined;
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
  /^(?:.*API_KEY|LLM_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|EPURE_.*(?:KEY|TOKEN|SECRET)|AWS_.*|AZURE_.*|GCP_.*|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i;

const NONCE_HEADER = "x-epure-proxy-nonce";
// The sandbox presents the nonce where its SDK would put a key; the proxy swaps it for the real one.
const CREDENTIAL_HEADERS = [
  NONCE_HEADER,
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key"
] as const;
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];
const DROPPED_REQUEST_HEADERS = new Set<string>([
  ...CREDENTIAL_HEADERS,
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
  "accept-encoding"
]);
// fetch already decoded the body, so the upstream length and encoding no longer apply.
const DROPPED_RESPONSE_HEADERS = new Set<string>([
  ...HOP_BY_HOP_HEADERS,
  "content-length",
  "content-encoding"
]);

export function buildSanitizedSandboxEnv(
  runnerEnv: Readonly<Record<string, string | undefined>>,
  proxy?: SandboxProxyEndpoint | undefined
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
  if (proxy) {
    sanitized.EPURE_LLM_PROXY_URL = proxy.proxyUrl;
    sanitized.EPURE_LLM_PROXY_NONCE = proxy.proxyNonce;
  }
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

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendProxyError(
  res: ServerResponse,
  status: number,
  errorCode: SandboxErrorCode,
  errorMessage: string
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error_code: errorCode, error_message: errorMessage }));
}

function presentedCredentials(req: IncomingMessage, url: URL): string[] {
  const values: string[] = [];
  for (const name of CREDENTIAL_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") {
      values.push(name === "authorization" ? value.replace(/^Bearer\s+/i, "") : value);
    }
  }
  const queryKey = url.searchParams.get("key");
  if (queryKey) {
    values.push(queryKey);
  }
  return values;
}

function isNonce(candidate: string, nonce: Buffer): boolean {
  const value = Buffer.from(candidate.trim());
  return value.length === nonce.length && timingSafeEqual(value, nonce);
}

// Streaming reverse proxy to one declared provider: the key lives only here, the sandbox holds a nonce.
export async function createLlmSandboxProxy(
  options: CreateLlmSandboxProxyOptions
): Promise<LlmSandboxProxyHandle> {
  const { upstream } = options;
  const apiKey = options.apiKey.trim();
  const upstreamHost = new URL(upstream.baseUrl).host;
  const proxyNonce = randomBytes(24).toString("hex");
  const nonceBytes = Buffer.from(proxyNonce);

  const relay = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith("/")) {
      sendProxyError(
        res,
        403,
        "PROXY_FORBIDDEN_ENDPOINT",
        `Sandbox LLM proxy only forwards to ${upstreamHost}.`
      );
      return;
    }
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (!presentedCredentials(req, url).some((value) => isNonce(value, nonceBytes))) {
      sendProxyError(
        res,
        401,
        "PROXY_UNAUTHORIZED_NONCE",
        `Missing or invalid sandbox nonce: send EPURE_LLM_PROXY_NONCE as the API key or in ${NONCE_HEADER}.`
      );
      return;
    }
    if (req.method !== "POST" || !upstream.allowedPaths.some((p) => p.test(url.pathname))) {
      sendProxyError(
        res,
        403,
        "PROXY_FORBIDDEN_ENDPOINT",
        `Sandbox LLM proxy forbids ${req.method ?? "?"} '${url.pathname}' on ${upstreamHost}.`
      );
      return;
    }
    url.searchParams.delete("key");

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    headers.set(
      upstream.authHeader,
      upstream.authHeader === "authorization" ? `Bearer ${apiKey}` : apiKey
    );
    const body = await readRequestBody(req);

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${upstream.baseUrl}${url.pathname}${url.search}`, {
        method: "POST",
        headers,
        body,
        signal: abort.signal
      });
    } catch {
      sendProxyError(
        res,
        502,
        "PROXY_UPSTREAM_UNREACHABLE",
        `Sandbox LLM proxy could not reach ${upstreamHost}.`
      );
      return;
    }

    res.statusCode = upstreamRes.status;
    upstreamRes.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) {
        res.setHeader(name, value);
      }
    });
    const observer = options.observeResponse?.({
      method: "POST",
      path: url.pathname,
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get("content-type") ?? ""
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      const errorBody = Buffer.from(redactSecrets(await upstreamRes.text(), [apiKey]));
      observer?.onChunk(errorBody);
      observer?.onEnd();
      res.end(errorBody);
      return;
    }

    res.flushHeaders();
    for await (const chunk of upstreamRes.body) {
      observer?.onChunk(chunk);
      if (!res.write(chunk)) {
        await once(res, "drain", { signal: abort.signal });
      }
    }
    observer?.onEnd();
    res.end();
  };

  const server = createServer((req, res) => {
    relay(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
      } else {
        sendProxyError(
          res,
          502,
          "PROXY_UPSTREAM_UNREACHABLE",
          `Sandbox LLM proxy lost the response from ${upstreamHost}.`
        );
      }
    });
  });

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
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

type ResolvedLlmProxyTarget =
  | { readonly upstream: ProviderUpstream; readonly apiKey: string }
  | { readonly missingKeyFor: string };

function resolveLlmProxyTarget(
  llm: SandboxLlmRoute,
  runnerEnv: Readonly<Record<string, string | undefined>>
): ResolvedLlmProxyTarget {
  const { provider, providerConfig } = parseModelIdentifier(
    llm.model,
    llm.providers,
    runnerEnv
  );
  const apiKey = resolveProviderApiKey({ provider, providerConfig, env: runnerEnv });
  if (!apiKey) {
    return { missingKeyFor: provider };
  }
  return { upstream: resolveProviderUpstream(provider, providerConfig, runnerEnv), apiKey };
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

  const llmTarget = input.llm
    ? resolveLlmProxyTarget(input.llm, input.runnerEnv)
    : undefined;
  if (llmTarget && "missingKeyFor" in llmTarget) {
    return {
      isolated: false,
      error_code: "LLM_API_KEY_MISSING",
      error_message: `Fail-closed: runner has no API key for LLM provider '${llmTarget.missingKeyFor}' (model '${input.llm?.model ?? ""}') to hold in the sandbox proxy.`,
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

  const secretValues = [
    ...collectRunnerSecretValues(input.runnerEnv),
    ...(llmTarget ? [llmTarget.apiKey] : [])
  ];
  const proxy = llmTarget
    ? await createLlmSandboxProxy({ upstream: llmTarget.upstream, apiKey: llmTarget.apiKey })
    : undefined;

  try {
    const sanitizedEnv = buildSanitizedSandboxEnv(input.runnerEnv, proxy);

    const args = input.args ? [...input.args] : [];
    const cwd = input.cwd ?? process.cwd();
    const timeoutMs = input.timeoutMs ?? 60 * 60 * 1000;
    const proxyPort = proxy ? parsePortFromProxyUrl(proxy.proxyUrl) : undefined;

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
      proxy_url: proxy?.proxyUrl ?? "",
      kernel_backend: kernelBackend,
      network_policy: networkPolicy
    };
  } finally {
    await proxy?.close();
  }
}
