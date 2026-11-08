import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { pipeline, Transform } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { containsPrivateKeyMaterial } from "../auth/github-apps.js";
import { redactSecrets } from "../auth/issue-command-gate.js";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  parseModelIdentifier,
  resolveProviderApiKey
} from "../llm/client.js";
import type { ProviderConfig } from "../llm/types.js";
import { resolveProviderUpstream, type ProviderUpstream } from "../llm/upstream.js";

export type SandboxErrorCode =
  | "NONE"
  | "SANDBOX_ISOLATION_UNAVAILABLE"
  | "LLM_API_KEY_MISSING"
  | "PROXY_UNAUTHORIZED_NONCE"
  | "PROXY_FORBIDDEN_ENDPOINT"
  | "PROXY_UPSTREAM_UNREACHABLE"
  | "PROXY_REQUEST_TOO_LARGE"
  | "SANDBOX_COMMAND_FAILED";

export type SandboxNetworkPolicy = "proxy_only" | "https_only" | "offline";

export type KernelSandboxBackend = "landrun" | "bubblewrap" | "bubblewrap+landrun" | "none";

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
  readonly readOnlyPaths?: readonly string[] | undefined;
  readonly agentDir?: string | undefined;
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

export interface SandboxCommand {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
}

// An agent session gets a fresh HOME/TMPDIR under /tmp: its only writable place besides cwd.
export interface SandboxAgentSession {
  // Run there first under https_only, before the LLM proxy and its nonce exist.
  readonly installCommands?: readonly SandboxCommand[] | undefined;
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
  // Readable and executable inside the sandbox, e.g. a vendored agent engine.
  readonly readOnlyPaths?: readonly string[] | undefined;
  readonly agentSession?: SandboxAgentSession | undefined;
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
  /^(?:.*API_KEY|.*_TOKEN|.*_SECRET|.*PRIVATE_KEY|LLM_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|EPURE_.*(?:KEY|TOKEN|SECRET)|AWS_.*|AZURE_.*|GCP_.*|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i;

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
// accept-encoding is dropped so observers and error redaction usually see plain bytes.
const DROPPED_REQUEST_HEADERS = new Set<string>([
  ...CREDENTIAL_HEADERS,
  ...HOP_BY_HOP_HEADERS,
  "host",
  "expect",
  "accept-encoding"
]);
// Bodies are relayed byte for byte, so content-length and content-encoding stay valid.
const DROPPED_RESPONSE_HEADERS = new Set<string>(HOP_BY_HOP_HEADERS);
export const MAX_PROXY_REQUEST_BYTES = 20 * 1024 * 1024;

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
  readonly readOnlyPaths?: readonly string[] | undefined;
  readonly agentDir?: string | undefined;
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
  for (const p of params.readOnlyPaths ?? []) {
    roxPaths.add(sanitizeLandrunPath(resolve(p)));
  }

  const rwxPaths = new Set<string>([
    resolvedCwd,
    params.agentDir ? sanitizeLandrunPath(resolve(params.agentDir)) : "/tmp"
  ]);
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

// Landlock does not mediate connect() on pathname Unix sockets, so the namespace must hide them:
// /run (docker.sock, containerd, D-Bus, /run/user/<uid>) and /tmp become empty tmpfs, and a fresh
// pid namespace and /proc keep the orchestrator's /proc/<pid>/environ out of reach.
export function buildBubblewrapInvocation(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly readOnlyPaths?: readonly string[] | undefined;
  readonly agentDir?: string | undefined;
  // Host network kept, and the root bound writable: landrun inside enforces ports and writes.
  readonly underLandrun?: boolean | undefined;
}): readonly string[] {
  const resolvedCwd = resolve(params.cwd);
  // Mounted after the /tmp tmpfs so paths under /tmp stay visible.
  const extraBinds = [
    ...(params.readOnlyPaths ?? []).flatMap((p) => ["--ro-bind", resolve(p), resolve(p)]),
    ...(params.agentDir
      ? ["--bind", resolve(params.agentDir), resolve(params.agentDir)]
      : [])
  ];
  return [
    ...(params.underLandrun ? [] : ["--unshare-net"]),
    "--unshare-pid",
    "--unshare-ipc",
    "--die-with-parent",
    params.underLandrun ? "--bind" : "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--ro-bind-try",
    "/run/systemd/resolve",
    "/run/systemd/resolve",
    ...extraBinds,
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

// bubblewrap alone isolates offline runs; networked runs need landrun (one TCP port) inside it.
export function selectKernelBackend(
  networkPolicy: SandboxNetworkPolicy,
  capabilities: KernelSandboxCapabilities
): KernelSandboxBackend {
  if (networkPolicy === "offline" && capabilities.bubblewrapAvailable) {
    return "bubblewrap";
  }
  if (capabilities.landrunAvailable) {
    return capabilities.bubblewrapAvailable ? "bubblewrap+landrun" : "landrun";
  }
  return "none";
}

// landrun alone leaves host sockets and other processes' /proc entries reachable.
function hidesHostSockets(backend: KernelSandboxBackend): boolean {
  return backend === "bubblewrap" || backend === "bubblewrap+landrun";
}

export function buildKernelSandboxedCommand(
  input: BuildKernelSandboxedCommandInput
): BuiltKernelSandboxedCommand {
  const backend = selectKernelBackend(input.networkPolicy, input.capabilities);
  const landrun = (): readonly string[] =>
    buildLandrunInvocation({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      sanitizedEnv: input.sanitizedEnv,
      networkPolicy: input.networkPolicy,
      proxyPort: input.proxyPort,
      readOnlyPaths: input.readOnlyPaths,
      agentDir: input.agentDir
    });
  const bubblewrap = (command: string, args: readonly string[]): readonly string[] =>
    buildBubblewrapInvocation({
      command,
      args,
      cwd: input.cwd,
      readOnlyPaths: input.readOnlyPaths,
      agentDir: input.agentDir,
      underLandrun: backend === "bubblewrap+landrun"
    });

  switch (backend) {
    case "bubblewrap":
      return { backend, command: "bwrap", args: bubblewrap(input.command, input.args) };
    case "bubblewrap+landrun":
      return { backend, command: "bwrap", args: bubblewrap("landrun", landrun()) };
    case "landrun":
      return { backend, command: "landrun", args: landrun() };
    case "none":
      return { backend, command: input.command, args: input.args };
  }
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
    const res = spawnSync(
      "bwrap",
      buildBubblewrapInvocation({ command: "/bin/true", args: [], cwd: "/", underLandrun: true }),
      { env: probeEnv, stdio: "ignore", timeout: 3000 }
    );
    bubblewrapAvailable = res.status === 0;
  } catch {
    bubblewrapAvailable = false;
  }

  const result = { landrunAvailable, bubblewrapAvailable };
  cachedDefaultCapabilities = result;
  cachedDefaultCapabilitiesPath = pathVal;
  return result;
}

function forwardedHeaders(
  source: IncomingHttpHeaders,
  dropped: ReadonlySet<string>
): OutgoingHttpHeaders {
  const namedByConnection = new Set(
    String(source.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !dropped.has(name) && !namedByConnection.has(name)) {
      out[name] = value;
    }
  }
  return out;
}

// A throwing observer must not break the relayed stream, and onEnd runs exactly once.
function guardObserver(
  open: () => LlmProxyResponseObserver | undefined
): { chunk(chunk: Uint8Array): void; end(): void } {
  let observer: LlmProxyResponseObserver | undefined;
  try {
    observer = open();
  } catch {
    observer = undefined;
  }
  let ended = false;
  return {
    chunk(chunk) {
      try {
        observer?.onChunk(chunk);
      } catch {
        // ignored: see above
      }
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      try {
        observer?.onEnd();
      } catch {
        // ignored: see above
      }
    }
  };
}

function decodeBody(body: Buffer, contentEncoding: string | string[] | undefined): Buffer {
  switch (String(contentEncoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(body);
    case "deflate":
      return inflateSync(body);
    case "br":
      return brotliDecompressSync(body);
    default:
      return body;
  }
}

class ProxyRequestTooLargeError extends Error {}

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
  const target = new URL(upstream.baseUrl);
  const upstreamHost = target.host;
  const basePath = target.pathname.replace(/\/+$/, "");
  // node:http(s) never follows redirects, so a 3xx cannot carry the key to another origin.
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const agent =
    target.protocol === "https:" ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
  const proxyNonce = randomBytes(24).toString("hex");
  const nonceBytes = Buffer.from(proxyNonce);

  const relay = (req: IncomingMessage, res: ServerResponse): void => {
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
    if (Number(req.headers["content-length"] ?? 0) > MAX_PROXY_REQUEST_BYTES) {
      res.setHeader("connection", "close");
      sendProxyError(
        res,
        413,
        "PROXY_REQUEST_TOO_LARGE",
        `Sandbox LLM proxy accepts request bodies up to ${MAX_PROXY_REQUEST_BYTES} bytes.`
      );
      return;
    }
    // Only a query that carried the nonce as ?key= is re-serialised; others are forwarded verbatim.
    const rawQuery = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
    let query = rawQuery;
    if (url.searchParams.has("key")) {
      url.searchParams.delete("key");
      query = url.search;
    }

    const headers = forwardedHeaders(req.headers, DROPPED_REQUEST_HEADERS);
    for (const [name, value] of Object.entries(upstream.defaultHeaders)) {
      headers[name.toLowerCase()] = value;
    }
    headers[upstream.authHeader] =
      upstream.authHeader === "authorization" ? `Bearer ${apiKey}` : apiKey;

    let responded = false;
    let failed = false;
    const fail = (status: number, code: SandboxErrorCode, message: string): void => {
      if (failed) {
        return;
      }
      failed = true;
      upstreamReq.destroy();
      if (res.headersSent) {
        res.destroy();
      } else {
        res.setHeader("connection", "close");
        sendProxyError(res, status, code, message);
      }
    };

    const upstreamReq = send({
      agent,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || undefined,
      method: "POST",
      path: `${basePath}${url.pathname}${query}`,
      headers,
      timeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS
    });
    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream idle timeout")));
    upstreamReq.on("error", () =>
      fail(502, "PROXY_UPSTREAM_UNREACHABLE", `Sandbox LLM proxy could not reach ${upstreamHost}.`)
    );
    res.on("close", () => {
      if (!res.writableFinished) {
        upstreamReq.destroy();
      }
    });

    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > MAX_PROXY_REQUEST_BYTES ? new ProxyRequestTooLargeError() : null, chunk);
      }
    });
    pipeline(req, limit, upstreamReq, (err) => {
      if (!err || responded) {
        return;
      }
      if (err instanceof ProxyRequestTooLargeError) {
        fail(
          413,
          "PROXY_REQUEST_TOO_LARGE",
          `Sandbox LLM proxy accepts request bodies up to ${MAX_PROXY_REQUEST_BYTES} bytes.`
        );
      } else {
        fail(502, "PROXY_UPSTREAM_UNREACHABLE", `Sandbox LLM proxy could not reach ${upstreamHost}.`);
      }
    });

    upstreamReq.on("response", (upstreamRes) => {
      responded = true;
      const status = upstreamRes.statusCode ?? 502;
      const responseHeaders = forwardedHeaders(upstreamRes.headers, DROPPED_RESPONSE_HEADERS);
      const observer = guardObserver(() =>
        options.observeResponse?.({
          method: "POST",
          path: url.pathname,
          status,
          contentType: String(upstreamRes.headers["content-type"] ?? "")
        })
      );

      if (status >= 400) {
        // Error bodies may echo the key: decode them so redaction sees plain text.
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("error", () => {
          observer.end();
          fail(502, "PROXY_UPSTREAM_UNREACHABLE", `Sandbox LLM proxy lost the response from ${upstreamHost}.`);
        });
        upstreamRes.on("end", () => {
          let body: Buffer;
          try {
            body = decodeBody(Buffer.concat(chunks), upstreamRes.headers["content-encoding"]);
          } catch {
            observer.end();
            fail(502, "PROXY_UPSTREAM_UNREACHABLE", `Sandbox LLM proxy could not decode the error from ${upstreamHost}.`);
            return;
          }
          const redacted = Buffer.from(redactSecrets(body.toString("utf8"), [apiKey]));
          delete responseHeaders["content-encoding"];
          responseHeaders["content-length"] = String(redacted.length);
          observer.chunk(redacted);
          observer.end();
          res.writeHead(status, responseHeaders).end(redacted);
        });
        return;
      }

      res.writeHead(status, responseHeaders);
      res.flushHeaders();
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          observer.chunk(chunk);
          callback(null, chunk);
        }
      });
      pipeline(upstreamRes, tap, res, () => observer.end());
    });
  };

  const server = createServer((req, res) => {
    try {
      relay(req, res);
    } catch {
      if (res.headersSent) {
        res.destroy();
      } else {
        sendProxyError(
          res,
          502,
          "PROXY_UPSTREAM_UNREACHABLE",
          `Sandbox LLM proxy could not build the request to ${upstreamHost}.`
        );
      }
    }
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
        agent.destroy();
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
    input.runnerEnv.EPURE_ENFORCE_KERNEL_SANDBOX === "true" ||
    isCiRunner(input.runnerEnv);
  const capabilities =
    input.kernelCapabilities ?? probeKernelSandboxCapabilities(input.runnerEnv);
  const installCommands = input.agentSession?.installCommands ?? [];
  const policies: SandboxNetworkPolicy[] = [
    ...(installCommands.length > 0 ? ["https_only" as const] : []),
    networkPolicy
  ];
  if (
    enforceKernelSandbox &&
    policies.some((policy) => !hidesHostSockets(selectKernelBackend(policy, capabilities)))
  ) {
    return {
      isolated: false,
      error_code: "SANDBOX_ISOLATION_UNAVAILABLE",
      error_message:
        "Fail-closed: kernel confinement is mandatory in CI or with EPURE_ENFORCE_KERNEL_SANDBOX=true, and this runner lacks a working bubblewrap (plus landrun for networked phases) (ADR-0034).",
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - startMs,
      proxy_url: "",
      kernel_backend: "none",
      network_policy: networkPolicy
    };
  }

  const secretValues = [
    ...collectRunnerSecretValues(input.runnerEnv),
    ...(llmTarget ? [llmTarget.apiKey] : [])
  ];
  const cwd = input.cwd ?? process.cwd();
  const timeoutMs = input.timeoutMs ?? 60 * 60 * 1000;
  const agentDir = input.agentSession ? mkdtempSync("/tmp/epure-agent-") : undefined;
  const agentEnv = agentDir ? { HOME: agentDir, TMPDIR: agentDir } : {};

  const runConfined = (
    command: SandboxCommand,
    policy: SandboxNetworkPolicy,
    env: Record<string, string>,
    proxyPort?: number | undefined
  ): Promise<SpawnedOutput> => {
    if (policy === "https_only") {
      const home = env.HOME?.trim() ?? "";
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
      command: command.command,
      args: command.args ?? [],
      cwd,
      sanitizedEnv: env,
      networkPolicy: policy,
      proxyPort,
      capabilities,
      readOnlyPaths: input.readOnlyPaths,
      agentDir
    });
    return spawnCaptured(wrapped.command, wrapped.args, cwd, env, timeoutMs);
  };

  let proxy: LlmSandboxProxyHandle | undefined;
  try {
    const installEnv = { ...buildSanitizedSandboxEnv(input.runnerEnv), ...agentEnv };
    for (const install of installCommands) {
      const installed = await runConfined(install, "https_only", installEnv);
      if (installed.exitCode !== 0) {
        return {
          isolated: true,
          error_code: "SANDBOX_COMMAND_FAILED",
          error_message: `Dependency install '${[install.command, ...(install.args ?? [])].join(" ")}' exited with code ${installed.exitCode} before the agent session.`,
          exit_code: installed.exitCode,
          stdout: redactSecrets(installed.stdout, secretValues),
          stderr: redactSecrets(installed.stderr, secretValues),
          duration_ms: Date.now() - startMs,
          proxy_url: "",
          kernel_backend: selectKernelBackend("https_only", capabilities),
          network_policy: "https_only"
        };
      }
    }

    proxy = llmTarget
      ? await createLlmSandboxProxy({ upstream: llmTarget.upstream, apiKey: llmTarget.apiKey })
      : undefined;
    const childResult = await runConfined(
      { command: input.command, args: input.args },
      networkPolicy,
      { ...buildSanitizedSandboxEnv(input.runnerEnv, proxy), ...agentEnv },
      proxy ? parsePortFromProxyUrl(proxy.proxyUrl) : undefined
    );
    const ok = childResult.exitCode === 0;

    return {
      isolated: true,
      error_code: ok ? "NONE" : "SANDBOX_COMMAND_FAILED",
      error_message: ok
        ? ""
        : `Sandboxed command exited with code ${childResult.exitCode}.`,
      exit_code: childResult.exitCode,
      stdout: redactSecrets(childResult.stdout, secretValues),
      stderr: redactSecrets(childResult.stderr, secretValues),
      duration_ms: Date.now() - startMs,
      proxy_url: proxy?.proxyUrl ?? "",
      kernel_backend: selectKernelBackend(networkPolicy, capabilities),
      network_policy: networkPolicy
    };
  } finally {
    await proxy?.close();
    if (agentDir) {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
}

// Reads this process's own environment too: callers cannot opt out by passing a trimmed runnerEnv.
function isCiRunner(runnerEnv: Readonly<Record<string, string | undefined>>): boolean {
  const flagged = (value: string | undefined): boolean =>
    value !== undefined && ["true", "1"].includes(value.trim().toLowerCase());
  return [process.env, runnerEnv].some(
    (env) => flagged(env.GITHUB_ACTIONS) || flagged(env.CI)
  );
}

interface SpawnedOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnCaptured(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<SpawnedOutput> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
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
}
