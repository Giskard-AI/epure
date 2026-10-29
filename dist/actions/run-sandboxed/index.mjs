// actions/run-sandboxed/index.ts
import { appendFileSync } from "node:fs";

// src/sandbox/llm-sandbox.ts
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

// src/auth/issue-command-gate.ts
var SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,255}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bAuthorization:\s*(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,512}\b/gi
];
function redactSecrets(text, extraSecrets = []) {
  let result = text;
  for (const secret of extraSecrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 4) {
      result = result.split(trimmed).join("[REDACTED]");
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const authHeaderMatch = /^(Authorization:\s*(?:Bearer|Basic|token))\s+/i.exec(match);
      if (authHeaderMatch) {
        return `${authHeaderMatch[1]} [REDACTED]`;
      }
      if (/^bearer\s+/i.test(match)) {
        return "Bearer [REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return result;
}

// src/auth/github-apps.ts
var PRIVATE_KEY_DETECTION_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|EPURE_(?:AGENT|RELEASE)_APP_PRIVATE_KEY\s*=\s*\S+/i;
function containsPrivateKeyMaterial(text) {
  return PRIVATE_KEY_DETECTION_PATTERN.test(text);
}

// src/sandbox/llm-sandbox.ts
var SECRET_ENV_NAME_PATTERN = /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|LLM_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|EPURE_.*(?:KEY|TOKEN|SECRET)|AWS_.*|AZURE_.*|GCP_.*|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i;
var ALLOWED_PROXY_PATHS = /* @__PURE__ */ new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/chat/completions",
  "/responses",
  "/messages"
]);
function buildSanitizedSandboxEnv(runnerEnv, proxy) {
  const sanitized = {};
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
function buildLandrunInvocation(params) {
  const sanitizeLandrunPath = (p) => p.replace(/,/g, "");
  const resolvedCwd = sanitizeLandrunPath(resolve(params.cwd));
  const roxPaths = /* @__PURE__ */ new Set([
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
  const rwxPaths = /* @__PURE__ */ new Set([resolvedCwd, "/tmp"]);
  if (params.networkPolicy === "https_only") {
    const home = sanitizeLandrunPath(params.sanitizedEnv.HOME?.trim() ?? "");
    if (home) {
      rwxPaths.add(`${home}/.npm`);
      rwxPaths.add(`${home}/.cache`);
      rwxPaths.add(`${home}/.cargo`);
    }
  }
  const landrunArgs = [
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
  for (const key of Object.keys(params.sanitizedEnv).sort()) {
    landrunArgs.push("--env", key);
  }
  landrunArgs.push("--", params.command, ...params.args);
  return landrunArgs;
}
function buildBubblewrapInvocation(params) {
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
function buildKernelSandboxedCommand(input) {
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
var cachedDefaultCapabilities = null;
var cachedDefaultCapabilitiesPath = "";
function probeKernelSandboxCapabilities(runnerEnv = process.env) {
  if (process.platform !== "linux") {
    return { landrunAvailable: false, bubblewrapAvailable: false };
  }
  const pathVal = runnerEnv.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  if (cachedDefaultCapabilities !== null && cachedDefaultCapabilitiesPath === pathVal) {
    return cachedDefaultCapabilities;
  }
  const probeEnv = {
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
        timeout: 3e3
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
      timeout: 3e3
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
function readRequestBody(req) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function createLlmSandboxProxy(options) {
  const realKey = options.llmApiKey.trim();
  const proxyNonce = randomBytes(24).toString("hex");
  const defaultUpstream = async (req) => ({
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
    async (req, res) => {
      const providedNonce = req.headers["x-epure-proxy-nonce"];
      if (providedNonce !== proxyNonce) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error_code: "PROXY_UNAUTHORIZED_NONCE",
            error_message: "Missing or invalid x-epure-proxy-nonce header for local sandbox LLM proxy."
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
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve2());
  });
  const address = server.address();
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  return {
    proxyUrl,
    proxyNonce,
    close: () => new Promise((resolve2) => {
      server.close(() => resolve2());
    })
  };
}
function collectRunnerSecretValues(runnerEnv) {
  const values = [];
  for (const [key, value] of Object.entries(runnerEnv)) {
    if (typeof value === "string" && value.trim().length >= 8) {
      if (SECRET_ENV_NAME_PATTERN.test(key) || containsPrivateKeyMaterial(value)) {
        values.push(value.trim());
      }
    }
  }
  return values;
}
function parsePortFromProxyUrl(proxyUrl) {
  const match = /:(\d+)(?:\/|$)/.exec(proxyUrl);
  if (!match || !match[1]) {
    return void 0;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
}
async function runInUntrustedCodeSandbox(input) {
  const startMs = Date.now();
  const networkPolicy = input.networkPolicy ?? "proxy_only";
  if (!input.isolationAvailable) {
    return {
      isolated: false,
      error_code: "SANDBOX_ISOLATION_UNAVAILABLE",
      error_message: "Fail-closed: container/process sandbox isolation is unavailable on this runner (ADR-0011, ADR-0023).",
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - startMs,
      proxy_url: "",
      kernel_backend: "none",
      network_policy: networkPolicy
    };
  }
  const llmApiKey = (input.runnerEnv.OPENAI_API_KEY ?? input.runnerEnv.ANTHROPIC_API_KEY ?? input.runnerEnv.GOOGLE_API_KEY ?? input.runnerEnv.GEMINI_API_KEY ?? input.runnerEnv.LLM_API_KEY ?? "").trim();
  if (!llmApiKey) {
    return {
      isolated: false,
      error_code: "LLM_API_KEY_MISSING",
      error_message: "Fail-closed: runner is missing LLM API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or LLM_API_KEY) for the local proxy sidecar.",
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - startMs,
      proxy_url: "",
      kernel_backend: "none",
      network_policy: networkPolicy
    };
  }
  const enforceKernelSandbox = input.enforceKernelSandbox === true || input.runnerEnv.EPURE_ENFORCE_KERNEL_SANDBOX === "true";
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
    const timeoutMs = input.timeoutMs ?? 60 * 60 * 1e3;
    const proxyPort = parsePortFromProxyUrl(proxy.proxyUrl);
    const capabilities = input.kernelCapabilities ?? probeKernelSandboxCapabilities(input.runnerEnv);
    if (networkPolicy === "https_only") {
      const home = sanitizedEnv.HOME?.trim() ?? "";
      if (home) {
        for (const sub of [".npm", ".cache", ".cargo"]) {
          try {
            mkdirSync(resolve(home, sub), { recursive: true });
          } catch {
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
    const kernelBackend = wrapped.backend;
    if (wrapped.backend === "none" && enforceKernelSandbox) {
      return {
        isolated: false,
        error_code: "SANDBOX_ISOLATION_UNAVAILABLE",
        error_message: "Fail-closed: kernel sandbox backend (landrun/bubblewrap) is unavailable while EPURE_ENFORCE_KERNEL_SANDBOX=true (ADR-0030).",
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
    const childResult = await new Promise((resolvePromise) => {
      const child = spawn(spawnCommand, [...spawnArgs], {
        cwd,
        env: sanitizedEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
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
      error_message: ok ? "" : `Sandboxed command exited with code ${childResult.exitCode}.`,
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

// actions/run-sandboxed/index.ts
function writeActionOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    if (value.includes("\n")) {
      const delimiter = "EPURE_EOF";
      appendFileSync(
        outputPath,
        `${key}<<${delimiter}
${value}
${delimiter}
`,
        "utf8"
      );
    } else {
      appendFileSync(outputPath, `${key}=${value}
`, "utf8");
    }
  }
}
async function main() {
  const command = process.env.INPUT_COMMAND ?? "";
  const rawArgs = process.env.INPUT_ARGS_JSON ?? "[]";
  const isolationAvailable = (process.env.INPUT_ISOLATION_AVAILABLE ?? "true").toLowerCase() === "true";
  let args = [];
  try {
    const parsed = JSON.parse(rawArgs);
    if (Array.isArray(parsed)) {
      args = parsed.filter((item) => typeof item === "string");
    }
  } catch {
    args = [];
  }
  const result = await runInUntrustedCodeSandbox({
    isolationAvailable,
    runnerEnv: process.env,
    command,
    args
  });
  writeActionOutputs({
    isolated: String(result.isolated),
    error_code: result.error_code,
    exit_code: String(result.exit_code),
    stdout: result.stdout,
    stderr: result.stderr
  });
  if (!result.isolated || result.exit_code !== 0) {
    process.stderr.write(`${result.error_code}: ${result.error_message}
`);
    process.exitCode = 1;
  }
}
await main();
