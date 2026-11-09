import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { pipeline, Transform, Writable, type Readable } from "node:stream";
import { containsPrivateKeyMaterial } from "../auth/github-apps.js";
import { redactSecrets } from "../auth/issue-command-gate.js";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  mapKnownProviderPrefix,
  parseModelIdentifier,
  resolveProviderApiKey
} from "../llm/client.js";
import type { ProviderConfig } from "../llm/types.js";
import { resolveProviderUpstream, type ProviderUpstream } from "../llm/upstream.js";
import { usageReporter } from "../llm/usage.js";
import { decodeBody, meterRequest, meterResponse, type MeteredRequest } from "./llm-proxy-usage.js";

export type SandboxErrorCode =
  | "NONE"
  | "SANDBOX_ISOLATION_UNAVAILABLE"
  | "LLM_API_KEY_MISSING"
  | "LLM_MODEL_MISSING"
  | "LLM_ROUTE_INVALID"
  | "PROXY_UNAUTHORIZED_NONCE"
  | "PROXY_FORBIDDEN_ENDPOINT"
  | "PROXY_UPSTREAM_UNREACHABLE"
  | "PROXY_REQUEST_TOO_LARGE"
  | "PROXY_REQUEST_UNREADABLE"
  | "PROXY_REQUEST_TIMEOUT"
  | "PROXY_REQUEST_CAP_REACHED"
  | "LLM_REQUEST_CAP_REACHED"
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
  readonly readOnlyCwd?: boolean | undefined;
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
  // Time to receive a request body, counted from when the request gets a slot. Default: the upstream timeout.
  readonly requestBodyTimeoutMs?: number | undefined;
  // Requests past it get a 429 and onRequestCapReached runs; none of them reaches the upstream.
  readonly maxRequests?: number | undefined;
  readonly onRequestCapReached?: (() => void) | undefined;
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
// Its environment is PATH, LANG, HOME, TMPDIR, the proxy variables and `env`, nothing else from the runner.
export interface SandboxAgentSession {
  // Run there first under https_only, before the LLM proxy and its nonce exist.
  readonly installCommands?: readonly SandboxCommand[] | undefined;
  // Written under HOME (relative paths) once the proxy exists, e.g. an agent's model config.
  readonly homeFiles?:
    | ((proxy: SandboxProxyEndpoint | undefined) => Readonly<Record<string, string>>)
    | undefined;
  readonly env?: ((home: string) => Readonly<Record<string, string>>) | undefined;
  readonly readOnlyCwd?: boolean | undefined;
}

export interface SandboxSessionIo {
  readonly stdin: Writable;
  readonly stdout: Readable;
  // Kills the command's process group.
  kill(): void;
}

export interface SandboxExecutionInput {
  readonly isolationAvailable: boolean;
  readonly runnerEnv: Readonly<Record<string, string | undefined>>;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly readOnlyCwd?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly networkPolicy?: SandboxNetworkPolicy | undefined;
  readonly enforceKernelSandbox?: boolean | undefined;
  readonly kernelCapabilities?: KernelSandboxCapabilities | undefined;
  readonly llm?: SandboxLlmRoute | undefined;
  // Readable and executable inside the sandbox, e.g. a vendored agent engine.
  readonly readOnlyPaths?: readonly string[] | undefined;
  readonly agentSession?: SandboxAgentSession | undefined;
  readonly observeLlmResponse?: CreateLlmSandboxProxyOptions["observeResponse"];
  // Past it the command is killed and the result is LLM_REQUEST_CAP_REACHED.
  readonly maxLlmRequests?: number | undefined;
  // Talks to the command over stdin/stdout (stdout is then not captured, stderr keeps its last 64 KiB);
  // stdin is closed when it settles.
  readonly interact?: ((io: SandboxSessionIo) => Promise<void>) | undefined;
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
  // false when the command ran without any kernel backend (local fallback outside CI).
  readonly confined?: boolean | undefined;
  readonly network_policy?: SandboxNetworkPolicy | undefined;
}

const SECRET_ENV_NAME_PATTERN =
  /^(?:.*API_KEY|.*_TOKEN|.*_SECRET|.*PRIVATE_KEY|LLM_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|EPURE_.*(?:KEY|TOKEN|SECRET)|AWS_.*|AZURE_.*|GCP_.*|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i;

const SANDBOX_STRIPPED_GIT_ENV_NAMES = new Set<string>([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_WORK_TREE"
]);

const SANDBOX_DEFAULT_GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "EPURE Agent",
  GIT_AUTHOR_EMAIL: "epure-agent@localhost",
  GIT_COMMITTER_NAME: "EPURE Agent",
  GIT_COMMITTER_EMAIL: "epure-agent@localhost"
} as const;

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
// Each request body is held whole; further requests wait for a slot before their body is read.
export const MAX_PROXY_IN_FLIGHT_REQUESTS = 4;

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
    if (SANDBOX_STRIPPED_GIT_ENV_NAMES.has(key)) {
      continue;
    }
    if (containsPrivateKeyMaterial(value)) {
      continue;
    }
    sanitized[key] = value;
  }

  Object.assign(sanitized, SANDBOX_DEFAULT_GIT_IDENTITY_ENV);
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

const AGENT_SESSION_INHERITED_ENV = ["PATH", "LANG"] as const;

export function buildAgentSessionEnv(
  runnerEnv: Readonly<Record<string, string | undefined>>,
  home: string,
  proxy: SandboxProxyEndpoint | undefined,
  sessionEnv: SandboxAgentSession["env"]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of AGENT_SESSION_INHERITED_ENV) {
    const value = runnerEnv[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  const customSessionEnv = sessionEnv?.(home);
  if (customSessionEnv) {
    for (const [key, value] of Object.entries(customSessionEnv)) {
      if (!SANDBOX_STRIPPED_GIT_ENV_NAMES.has(key)) {
        env[key] = value;
      }
    }
  }
  return {
    ...env,
    ...SANDBOX_DEFAULT_GIT_IDENTITY_ENV,
    HOME: home,
    TMPDIR: home,
    EPURE_SANDBOX_ACTIVE: "true",
    NO_COLOR: "1",
    ...(proxy ? { EPURE_LLM_PROXY_URL: proxy.proxyUrl, EPURE_LLM_PROXY_NONCE: proxy.proxyNonce } : {})
  };
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
  readonly readOnlyCwd?: boolean | undefined;
  // Only under bubblewrap, whose /dev is a private minimal devtmpfs.
  readonly writableDevNull?: boolean | undefined;
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
  if (params.readOnlyCwd) {
    roxPaths.add(resolvedCwd);
  }

  const rwxPaths = new Set<string>([
    ...(params.readOnlyCwd ? [] : [resolvedCwd]),
    params.agentDir ? sanitizeLandrunPath(resolve(params.agentDir)) : "/tmp",
    ...packageCacheDirs(params.networkPolicy, params.sanitizedEnv).map(sanitizeLandrunPath)
  ]);

  const landrunArgs: string[] = [
    "--rox",
    Array.from(roxPaths).join(","),
    "--ro",
    "/dev,/proc",
    "--rwx",
    Array.from(rwxPaths).join(","),
    ...(params.writableDevNull ? ["--rw", "/dev/null"] : [])
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

// Writable for dependency installs (https_only), under HOME.
function packageCacheDirs(
  networkPolicy: SandboxNetworkPolicy,
  env: Readonly<Record<string, string>>
): string[] {
  const home = env.HOME?.trim() ?? "";
  return networkPolicy === "https_only" && home
    ? [".npm", ".cache", ".cargo"].map((sub) => `${home}/${sub}`)
    : [];
}

// Landlock does not mediate connect() on pathname Unix sockets, so the namespace must hide them:
// /run (docker.sock, containerd, D-Bus, /run/user/<uid>) and /tmp become empty tmpfs, and a fresh
// pid namespace and /proc keep the orchestrator's /proc/<pid>/environ out of reach. The root is
// read-only; cwd, the agent dir and writablePaths are bound writable.
export function buildBubblewrapInvocation(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly readOnlyPaths?: readonly string[] | undefined;
  readonly agentDir?: string | undefined;
  readonly writablePaths?: readonly string[] | undefined;
  readonly readOnlyCwd?: boolean | undefined;
  // Host network kept: landrun inside enforces ports.
  readonly underLandrun?: boolean | undefined;
}): readonly string[] {
  const resolvedCwd = resolve(params.cwd);
  // Mounted after the /tmp tmpfs so paths under /tmp stay visible.
  const extraBinds = [
    ...(params.readOnlyPaths ?? []).flatMap((p) => ["--ro-bind", resolve(p), resolve(p)]),
    ...(params.agentDir
      ? ["--bind", resolve(params.agentDir), resolve(params.agentDir)]
      : []),
    ...(params.writablePaths ?? []).flatMap((p) => ["--bind-try", resolve(p), resolve(p)])
  ];
  return [
    ...(params.underLandrun ? [] : ["--unshare-net"]),
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
    "--tmpfs",
    "/run",
    "--ro-bind-try",
    "/run/systemd/resolve",
    "/run/systemd/resolve",
    ...extraBinds,
    params.readOnlyCwd ? "--ro-bind" : "--bind",
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
      agentDir: input.agentDir,
      readOnlyCwd: input.readOnlyCwd,
      writableDevNull: backend === "bubblewrap+landrun"
    });
  const bubblewrap = (command: string, args: readonly string[]): readonly string[] =>
    buildBubblewrapInvocation({
      command,
      args,
      cwd: input.cwd,
      readOnlyPaths: input.readOnlyPaths,
      agentDir: input.agentDir,
      writablePaths: packageCacheDirs(input.networkPolicy, input.sanitizedEnv),
      readOnlyCwd: input.readOnlyCwd,
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
  const reportUsage = usageReporter({ labelledBySandbox: true });
  const requestBodyTimeoutMs = options.requestBodyTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  let acceptedRequests = 0;

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
    acceptedRequests += 1;
    if (options.maxRequests !== undefined && acceptedRequests > options.maxRequests) {
      res.setHeader("connection", "close");
      sendProxyError(
        res,
        429,
        "PROXY_REQUEST_CAP_REACHED",
        `Sandbox LLM proxy forwards at most ${options.maxRequests} requests per session.`
      );
      options.onRequestCapReached?.();
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

    let upstreamReq: ClientRequest | undefined;
    let failed = false;
    const fail = (status: number, code: SandboxErrorCode, message: string): void => {
      if (failed) {
        return;
      }
      failed = true;
      upstreamReq?.destroy();
      if (res.headersSent) {
        res.destroy();
      } else {
        res.setHeader("connection", "close");
        sendProxyError(res, status, code, message);
      }
    };
    res.on("close", () => {
      if (!res.writableFinished) {
        upstreamReq?.destroy();
      }
    });

    const forward = ({ body, model }: MeteredRequest): void => {
      headers["content-length"] = String(body.length);
      const sent = send({
        agent,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        method: "POST",
        path: `${basePath}${url.pathname}${query}`,
        headers,
        timeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS
      });
      upstreamReq = sent;
      sent.on("timeout", () => sent.destroy(new Error("upstream idle timeout")));
      sent.on("error", () =>
        fail(502, "PROXY_UPSTREAM_UNREACHABLE", `Sandbox LLM proxy could not reach ${upstreamHost}.`)
      );
      sent.on("response", (upstreamRes) => relayResponse(upstreamRes, model));
      sent.end(body);
    };

    // Read whole, within the cap: the model is in the body, and the usage request may have to be added.
    const chunks: Buffer[] = [];
    let received = 0;
    const collect = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_PROXY_REQUEST_BYTES) {
          callback(new ProxyRequestTooLargeError());
          return;
        }
        chunks.push(chunk);
        callback();
      }
    });
    const bodyTimer = setTimeout(
      () =>
        fail(
          408,
          "PROXY_REQUEST_TIMEOUT",
          `Sandbox LLM proxy did not receive the request body within ${requestBodyTimeoutMs} ms.`
        ),
      requestBodyTimeoutMs
    );
    pipeline(req, collect, (err) => {
      clearTimeout(bodyTimer);
      if (!err) {
        // Runs outside the server's try: a body that cannot be re-serialised must not reach the process.
        try {
          forward(meterRequest(upstream.provider, url.pathname, Buffer.concat(chunks), req.headers["content-encoding"]));
        } catch {
          fail(400, "PROXY_REQUEST_UNREADABLE", "Sandbox LLM proxy could not read the request body.");
        }
      } else if (err instanceof ProxyRequestTooLargeError) {
        fail(
          413,
          "PROXY_REQUEST_TOO_LARGE",
          `Sandbox LLM proxy accepts request bodies up to ${MAX_PROXY_REQUEST_BYTES} bytes.`
        );
      } else {
        fail(502, "PROXY_UPSTREAM_UNREACHABLE", `Sandbox LLM proxy could not reach ${upstreamHost}.`);
      }
    });

    const relayResponse = (upstreamRes: IncomingMessage, model: string): void => {
      const status = upstreamRes.statusCode ?? 502;
      const contentType = String(upstreamRes.headers["content-type"] ?? "");
      const responseHeaders = forwardedHeaders(upstreamRes.headers, DROPPED_RESPONSE_HEADERS);
      const observer = guardObserver(() =>
        options.observeResponse?.({ method: "POST", path: url.pathname, status, contentType })
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
      const meter = meterResponse(upstream.provider, model, contentType, upstreamRes.headers["content-encoding"]);
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          meter.onChunk(chunk);
          observer.chunk(chunk);
          callback(null, chunk);
        }
      });
      pipeline(upstreamRes, tap, res, () => {
        observer.end();
        reportUsage(meter.onEnd());
      });
    };
  };

  let inFlight = 0;
  const waiting: Array<() => void> = [];
  // Node's requestTimeout runs from the connection, so it would also count the wait for a slot.
  const server = createServer({ requestTimeout: 0 }, (req, res) => {
    const start = (): void => {
      inFlight += 1;
      res.once("close", () => {
        inFlight -= 1;
        waiting.shift()?.();
      });
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
    };
    if (inFlight < MAX_PROXY_IN_FLIGHT_REQUESTS) {
      start();
      return;
    }
    waiting.push(start);
    res.once("close", () => {
      const index = waiting.indexOf(start);
      if (index >= 0) {
        waiting.splice(index, 1);
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
        agent.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

type ResolvedLlmProxyTarget =
  | { readonly upstream: ProviderUpstream; readonly apiKey: string }
  | { readonly error_code: SandboxErrorCode; readonly message: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Stricter than LLMClient: the proxy hands a real key to whatever this resolves to, so nothing is inferred.
function resolveLlmProxyTarget(
  llm: SandboxLlmRoute,
  runnerEnv: Readonly<Record<string, string | undefined>>
): ResolvedLlmProxyTarget {
  const model = llm.model.trim();
  if (!model) {
    return {
      error_code: "LLM_MODEL_MISSING",
      message: "Fail-closed: the sandbox LLM route has no model; set the 'model' input to '<provider>/<model>'."
    };
  }
  const slash = model.indexOf("/");
  const prefix = slash > 0 ? model.slice(0, slash).trim() : "";
  const isKnownProvider = prefix !== "" && mapKnownProviderPrefix(prefix) !== undefined;
  const isAlias = prefix !== "" && !isKnownProvider && llm.providers?.[prefix] !== undefined;
  if (!isKnownProvider && !isAlias) {
    return {
      error_code: "LLM_ROUTE_INVALID",
      message: `Fail-closed: model '${model}' must start with a provider (openai/, anthropic/, google/, azure/, azure_ai/, openrouter/, vertex/) or a provider alias declared in .github/agents.yml; the sandbox proxy does not infer providers.`
    };
  }

  const { provider, providerConfig } = parseModelIdentifier(model, llm.providers, runnerEnv);
  // An alias gets only the key it declares, never OPENAI_API_KEY or LLM_API_KEY meant for someone else.
  const apiKey = isAlias
    ? providerConfig?.apiKey?.trim()
    : resolveProviderApiKey({ provider, providerConfig, env: runnerEnv });
  if (!apiKey) {
    return {
      error_code: "LLM_API_KEY_MISSING",
      message: isAlias
        ? `Fail-closed: provider alias '${prefix}' must declare its own api_key in .github/agents.yml (e.g. os.environ/${prefix.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY) and the runner must have it.`
        : `Fail-closed: runner has no API key for LLM provider '${provider}' (model '${model}') to hold in the sandbox proxy.`
    };
  }

  try {
    const upstream = resolveProviderUpstream(provider, providerConfig, runnerEnv);
    const base = new URL(upstream.baseUrl);
    if (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname))) {
      return {
        error_code: "LLM_ROUTE_INVALID",
        message: `Fail-closed: the sandbox proxy only sends keys over https, not to '${base.origin}' (model '${model}').`
      };
    }
    return { upstream, apiKey };
  } catch (err) {
    return {
      error_code: "LLM_ROUTE_INVALID",
      message: `Fail-closed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export function collectRunnerSecretValues(
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
  const networkPolicy: SandboxNetworkPolicy =
    input.networkPolicy ?? (input.llm ? "proxy_only" : "offline");

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
  if (llmTarget && "error_code" in llmTarget) {
    return {
      isolated: false,
      error_code: llmTarget.error_code,
      error_message: llmTarget.message,
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
  const installHomeEnv = agentDir ? { HOME: agentDir, TMPDIR: agentDir } : {};

  const runConfined = (
    command: SandboxCommand,
    policy: SandboxNetworkPolicy,
    env: Record<string, string>,
    proxyPort?: number | undefined,
    interact?: SandboxExecutionInput["interact"]
  ): Promise<SpawnedOutput> => {
    for (const dir of packageCacheDirs(policy, env)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Best-effort cache directory creation before Landlock ruleset population
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
      agentDir,
      readOnlyCwd: input.readOnlyCwd ?? input.agentSession?.readOnlyCwd
    });
    return spawnCaptured(wrapped.command, wrapped.args, cwd, env, timeoutMs, interact, (kill) => {
      killChild = kill;
    });
  };

  let killChild: (() => void) | undefined;
  let requestCapReached = false;
  let proxy: LlmSandboxProxyHandle | undefined;
  try {
    const installEnv = { ...buildSanitizedSandboxEnv(input.runnerEnv), ...installHomeEnv };
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
          confined: selectKernelBackend("https_only", capabilities) !== "none",
          network_policy: "https_only"
        };
      }
    }

    proxy = llmTarget
      ? await createLlmSandboxProxy({
          upstream: llmTarget.upstream,
          apiKey: llmTarget.apiKey,
          observeResponse: input.observeLlmResponse,
          maxRequests: input.maxLlmRequests,
          onRequestCapReached: () => {
            requestCapReached = true;
            killChild?.();
          }
        })
      : undefined;
    if (agentDir) {
      for (const [relPath, content] of Object.entries(input.agentSession?.homeFiles?.(proxy) ?? {})) {
        const target = resolve(agentDir, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
      }
    }
    const childResult = await runConfined(
      { command: input.command, args: input.args },
      networkPolicy,
      agentDir
        ? buildAgentSessionEnv(input.runnerEnv, agentDir, proxy, input.agentSession?.env)
        : buildSanitizedSandboxEnv(input.runnerEnv, proxy),
      proxy ? parsePortFromProxyUrl(proxy.proxyUrl) : undefined,
      input.interact
    );
    const ok = childResult.exitCode === 0 && !requestCapReached;

    return {
      isolated: true,
      error_code: requestCapReached ? "LLM_REQUEST_CAP_REACHED" : ok ? "NONE" : "SANDBOX_COMMAND_FAILED",
      error_message: requestCapReached
        ? `Sandboxed command was killed after its ${input.maxLlmRequests ?? 0} allowed LLM requests.`
        : ok
          ? ""
          : `Sandboxed command exited with code ${childResult.exitCode}.`,
      exit_code: childResult.exitCode,
      stdout: redactSecrets(childResult.stdout, secretValues),
      stderr: redactSecrets(childResult.stderr, secretValues),
      duration_ms: Date.now() - startMs,
      proxy_url: proxy?.proxyUrl ?? "",
      kernel_backend: selectKernelBackend(networkPolicy, capabilities),
      confined: selectKernelBackend(networkPolicy, capabilities) !== "none",
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

const MAX_SESSION_STDERR_BYTES = 64 * 1024;

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
  timeoutMs: number,
  interact: SandboxExecutionInput["interact"],
  onSpawn: (kill: () => void) => void
): Promise<SpawnedOutput> {
  return new Promise((resolvePromise) => {
    // Own process group, so a phase's background processes die with it instead of outliving it.
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    child.stdin.on("error", () => {
      // the child exited before reading everything it was sent
    });
    const killGroup = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // the group is already gone
        }
      }
    };

    onSpawn(killGroup);

    const stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    const timer = setTimeout(killGroup, timeoutMs);
    child.on("exit", killGroup);

    if (interact) {
      void interact({ stdin: child.stdin, stdout: child.stdout, kill: killGroup }).then(
        () => child.stdin.end(),
        () => killGroup()
      );
    } else {
      child.stdin.end();
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      if (interact && stderrBytes > MAX_SESSION_STDERR_BYTES) {
        const tail = Buffer.concat(stderrChunks).subarray(-MAX_SESSION_STDERR_BYTES);
        stderrChunks = [tail];
        stderrBytes = tail.length;
      }
    });

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
