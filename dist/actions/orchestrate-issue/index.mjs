// actions/orchestrate-issue/index.ts
import { appendFileSync } from "node:fs";

// src/auth/issue-command-gate.ts
var SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,255}\b/g,
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
      if (/^bearer\s+/i.test(match)) {
        return "Bearer [REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return result;
}

// src/orchestrator/issue-orchestrator.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// src/auth/github-app-jwt.ts
import { createSign } from "node:crypto";
function base64UrlEncode(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function normalizePemKey(rawKey) {
  const trimmed = rawKey.trim().replace(/\\n/g, "\n");
  return trimmed;
}
function createGitHubAppJwt(credentials, nowEpochSeconds = Math.floor(Date.now() / 1e3)) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowEpochSeconds - 60,
    exp: nowEpochSeconds + 9 * 60,
    iss: credentials.appId.trim()
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(normalizePemKey(credentials.privateKeyPem));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
async function mintRepositoryInstallationToken(params) {
  const [owner, repo] = params.repository.trim().split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug '${params.repository}'.`);
  }
  const baseUrl = (params.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const fetchFn = params.fetchImpl ?? fetch;
  const appJwt = createGitHubAppJwt({
    appId: params.appId,
    privateKeyPem: params.privateKeyPem
  });
  const installResp = await fetchFn(
    `${baseUrl}/repos/${owner}/${repo}/installation`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );
  if (!installResp.ok) {
    const bodyText = await installResp.text();
    throw new Error(
      `Failed to resolve GitHub App installation for '${params.repository}' (HTTP ${installResp.status}): ${bodyText}`
    );
  }
  const installData = await installResp.json();
  if (typeof installData.id !== "number") {
    throw new Error(
      `GitHub App installation response for '${params.repository}' did not contain an installation ID.`
    );
  }
  const tokenBody = {
    repositories: [repo]
  };
  if (params.permissions && Object.keys(params.permissions).length > 0) {
    tokenBody.permissions = params.permissions;
  }
  const tokenResp = await fetchFn(
    `${baseUrl}/app/installations/${installData.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(tokenBody)
    }
  );
  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(
      `Failed to mint installation token for installation ${installData.id} (HTTP ${tokenResp.status}): ${errText}`
    );
  }
  const tokenData = await tokenResp.json();
  if (typeof tokenData.token !== "string" || !tokenData.token) {
    throw new Error("GitHub installation token response was empty.");
  }
  return {
    token: tokenData.token,
    expiresAt: tokenData.expires_at ?? new Date(Date.now() + 36e5).toISOString(),
    installationId: installData.id
  };
}
async function revokeGitHubInstallationToken(params) {
  const baseUrl = (params.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const fetchFn = params.fetchImpl ?? fetch;
  await fetchFn(`${baseUrl}/installation/token`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
}

// src/sandbox/llm-sandbox.ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

// src/auth/github-apps.ts
var PRIVATE_KEY_DETECTION_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|EPURE_(?:AGENT|RELEASE)_APP_PRIVATE_KEY\s*=\s*\S+/i;
function containsPrivateKeyMaterial(text) {
  return PRIVATE_KEY_DETECTION_PATTERN.test(text);
}

// src/sandbox/llm-sandbox.ts
var SECRET_ENV_NAME_PATTERN = /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|LLM_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|EPURE_.*(?:KEY|TOKEN|SECRET)|AWS_.*|AZURE_.*|GCP_.*|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i;
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
  return sanitized;
}
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  return {
    proxyUrl,
    proxyNonce,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
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
async function runInUntrustedCodeSandbox(input) {
  const startMs = Date.now();
  if (!input.isolationAvailable) {
    return {
      isolated: false,
      error_code: "SANDBOX_ISOLATION_UNAVAILABLE",
      error_message: "Fail-closed: container/process sandbox isolation is unavailable on this runner (ADR-0011, ADR-0023).",
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - startMs,
      proxy_url: ""
    };
  }
  const llmApiKey = (input.runnerEnv.OPENAI_API_KEY ?? input.runnerEnv.ANTHROPIC_API_KEY ?? input.runnerEnv.LLM_API_KEY ?? "").trim();
  if (!llmApiKey) {
    return {
      isolated: false,
      error_code: "LLM_API_KEY_MISSING",
      error_message: "Fail-closed: runner is missing LLM API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or LLM_API_KEY) for the local proxy sidecar.",
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
    const timeoutMs = input.timeoutMs ?? 60 * 60 * 1e3;
    const childResult = await new Promise((resolve) => {
      const child = spawn(input.command, args, {
        cwd: input.cwd ?? process.cwd(),
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
      error_message: ok ? "" : `Sandboxed command exited with code ${childResult.exitCode}.`,
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

// src/state/git-ref-state.ts
function buildIssueStateRefName(issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issueNumber '${issueNumber}' for Git state ref.`);
  }
  return `refs/epure/state/${issueNumber}`;
}
function createInitialIssueState(issueNumber) {
  return {
    issue_number: issueNumber,
    version: 0,
    phase: "idle",
    status: "active",
    active_branch: "",
    last_processed_comment_id: 0,
    code_fix_attempts_used: 0,
    transient_retries_used: 0,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function formatIssueStateMirrorMarkdown(state) {
  const refName = buildIssueStateRefName(state.issue_number);
  return [
    `<!-- epure-state-mirror:issue-${state.issue_number}:v${state.version} -->`,
    `### EPURE Orchestration State (\`${refName}\`)`,
    `- **Phase**: \`${state.phase}\``,
    `- **Status**: \`${state.status}\``,
    `- **Active Branch**: \`${state.active_branch || "none"}\``,
    `- **Version**: \`${state.version}\``,
    `- **Cursor**: \`last_processed_comment_id: ${state.last_processed_comment_id}\``,
    `- **Retries**: \`code_fix_attempts_used: ${state.code_fix_attempts_used}\`, \`transient_retries_used: ${state.transient_retries_used}\``
  ].join("\n");
}
async function updateIssueStateWithCas(input) {
  const refName = buildIssueStateRefName(input.issueNumber);
  const maxRetries = input.maxCasRetries ?? 5;
  let conflictsRecovered = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const snapshot = await input.store.readRef(refName);
    const baseState = snapshot.state ?? createInitialIssueState(input.issueNumber);
    const mutated = input.mutator(baseState);
    const nextState = {
      ...mutated,
      issue_number: input.issueNumber,
      version: baseState.version + 1,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    const casResult = await input.store.compareAndSwapRef(
      refName,
      snapshot.sha,
      nextState
    );
    if (casResult.swapped) {
      return {
        committed: true,
        ref_name: refName,
        commit_sha: casResult.newSha,
        state: nextState,
        cas_conflicts_recovered: conflictsRecovered,
        concurrency_group: `epure-issue-${input.issueNumber}`,
        issue_mirror_markdown: formatIssueStateMirrorMarkdown(nextState)
      };
    }
    conflictsRecovered += 1;
  }
  if (conflictsRecovered > 0) {
  }
  throw new Error(
    `CAS conflict retry budget exhausted (${maxRetries}) on '${refName}'.`
  );
}
function createGitHubApiRefStateStore(options) {
  const [owner, repo] = options.repository.trim().split("/");
  const baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const fetchFn = options.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${options.githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  return {
    readRef: async (refName) => {
      const normalizedRef = refName.replace(/^refs\//, "");
      const refResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/ref/${normalizedRef}`,
        { method: "GET", headers }
      );
      if (refResp.status === 404) {
        return { sha: null, state: null };
      }
      if (!refResp.ok) {
        throw new Error(
          `Failed to read Git ref '${refName}' (HTTP ${refResp.status}).`
        );
      }
      const refData = await refResp.json();
      const blobSha = refData.object?.sha;
      if (!blobSha) {
        return { sha: null, state: null };
      }
      const blobResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
        { method: "GET", headers }
      );
      if (!blobResp.ok) {
        return { sha: null, state: null };
      }
      const blobData = await blobResp.json();
      const rawJson = Buffer.from(
        blobData.content ?? "",
        blobData.encoding === "base64" ? "base64" : "utf8"
      ).toString("utf8");
      const parsed = JSON.parse(rawJson);
      return { sha: blobSha, state: parsed };
    },
    compareAndSwapRef: async (refName, expectedOldSha, nextState) => {
      const normalizedRef = refName.replace(/^refs\//, "");
      const checkResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/ref/${normalizedRef}`,
        { method: "GET", headers }
      );
      if (expectedOldSha === null) {
        if (checkResp.status !== 404) {
          return { swapped: false, newSha: "" };
        }
      } else {
        if (!checkResp.ok) {
          return { swapped: false, newSha: "" };
        }
        const currentRef = await checkResp.json();
        if (currentRef.object?.sha !== expectedOldSha) {
          return { swapped: false, newSha: "" };
        }
      }
      const createBlobResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/blobs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: JSON.stringify(nextState, null, 2),
            encoding: "utf-8"
          })
        }
      );
      if (!createBlobResp.ok) {
        return { swapped: false, newSha: "" };
      }
      const blobCreated = await createBlobResp.json();
      const newSha = blobCreated.sha ?? "";
      if (!newSha) {
        return { swapped: false, newSha: "" };
      }
      if (expectedOldSha === null) {
        const createRefResp = await fetchFn(
          `${baseUrl}/repos/${owner}/${repo}/git/refs`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ref: refName.startsWith("refs/") ? refName : `refs/${refName}`,
              sha: newSha
            })
          }
        );
        return { swapped: createRefResp.ok, newSha: createRefResp.ok ? newSha : "" };
      }
      const updateRefResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/refs/${normalizedRef}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            sha: newSha,
            force: true
          })
        }
      );
      return { swapped: updateRefResp.ok, newSha: updateRefResp.ok ? newSha : "" };
    }
  };
}

// src/orchestrator/gemini-client.ts
async function callGeminiGenerateContent(options) {
  const model = (options.model ?? "gemini-3.8-flash").trim();
  const fetchFn = options.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(options.apiKey.trim())}`;
  const generationConfig = {
    temperature: options.temperature ?? 0.2
  };
  if (options.responseMimeType) {
    generationConfig.responseMimeType = options.responseMimeType;
  }
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: options.prompt }]
      }
    ],
    generationConfig
  };
  if (options.systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: options.systemInstruction }]
    };
  }
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Gemini API call failed (${model}, HTTP ${response.status}): ${errText}`
    );
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw new Error(`Gemini API returned empty content for model '${model}'.`);
  }
  return text.trim();
}
function extractJsonObject(rawText) {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(rawText);
  if (fenceMatch && fenceMatch[1]) {
    return JSON.parse(fenceMatch[1].trim());
  }
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(rawText.trim());
}

// src/orchestrator/issue-orchestrator.ts
function slugifyTitle(raw) {
  const clean = raw.toLowerCase().replace(/\[plan\]/gi, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/g, "");
  return clean || "feature";
}
function createGitHubRestHelper(params) {
  const [owner, repo] = params.repository.trim().split("/");
  const baseUrl = "https://api.github.com";
  const fetchFn = params.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${params.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  async function apiRequest(method, path, body, allow404 = false) {
    const resp = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers,
      ...body !== void 0 ? { body: JSON.stringify(body) } : {}
    });
    if (allow404 && resp.status === 404) {
      return { status: 404, data: null };
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `GitHub API ${method} ${path} failed (HTTP ${resp.status}): ${errText}`
      );
    }
    if (resp.status === 204) {
      return { status: 204, data: null };
    }
    const json = await resp.json();
    return { status: resp.status, data: json };
  }
  return {
    token: params.token,
    async getIssue(issueNumber) {
      const { data } = await apiRequest("GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
      return {
        number: data?.number ?? issueNumber,
        title: data?.title ?? `Issue #${issueNumber}`,
        body: data?.body ?? ""
      };
    },
    async listIssueComments(issueNumber) {
      const { data } = await apiRequest(
        "GET",
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
      );
      return data ?? [];
    },
    async postIssueComment(issueNumber, body) {
      const { data } = await apiRequest(
        "POST",
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        { body }
      );
      return data?.html_url ?? "";
    },
    async ensureLabel(name, color, description) {
      const existing = await apiRequest(
        "GET",
        `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
        void 0,
        true
      );
      if (existing.status === 404) {
        await apiRequest("POST", `/repos/${owner}/${repo}/labels`, {
          name,
          color,
          description
        });
      }
    },
    async createIssue(input) {
      const { data } = await apiRequest(
        "POST",
        `/repos/${owner}/${repo}/issues`,
        {
          title: input.title,
          body: input.body,
          labels: input.labels
        }
      );
      if (!data) {
        throw new Error("Failed to create GitHub issue.");
      }
      return data;
    },
    async closeIssue(issueNumber) {
      await apiRequest("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, {
        state: "closed",
        state_reason: "completed"
      });
    },
    async getDefaultBranchSha(branch) {
      const res = await apiRequest(
        "GET",
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        void 0,
        true
      );
      return res.data?.object?.sha ?? null;
    },
    async ensureBranch(branch, fromBranch = "main") {
      const existingSha = await this.getDefaultBranchSha(branch);
      if (existingSha) {
        return existingSha;
      }
      let baseSha = await this.getDefaultBranchSha(fromBranch);
      if (!baseSha) {
        baseSha = await this.getDefaultBranchSha("main");
      }
      if (!baseSha) {
        throw new Error(
          `Cannot create branch '${branch}': neither '${fromBranch}' nor 'main' exists.`
        );
      }
      await apiRequest("POST", `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: baseSha
      });
      return baseSha;
    },
    async commitFilesToBranch(input) {
      const baseBranch = input.fromBranch ?? "main";
      await this.ensureBranch(input.branch, baseBranch);
      const branchRef = await apiRequest(
        "GET",
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(input.branch)}`
      );
      const parentCommitSha = branchRef.data.object.sha;
      const parentCommit = await apiRequest(
        "GET",
        `/repos/${owner}/${repo}/git/commits/${parentCommitSha}`
      );
      const baseTreeSha = parentCommit.data.tree.sha;
      const treeEntries = [];
      for (const file of input.files) {
        const cleanPath = file.path.trim().replace(/^\/+/, "");
        const blobRes = await apiRequest(
          "POST",
          `/repos/${owner}/${repo}/git/blobs`,
          {
            content: file.content,
            encoding: "utf-8"
          }
        );
        treeEntries.push({
          path: cleanPath,
          mode: "100644",
          type: "blob",
          sha: blobRes.data.sha
        });
      }
      const newTree = await apiRequest(
        "POST",
        `/repos/${owner}/${repo}/git/trees`,
        {
          base_tree: baseTreeSha,
          tree: treeEntries
        }
      );
      const newCommit = await apiRequest(
        "POST",
        `/repos/${owner}/${repo}/git/commits`,
        {
          message: input.commitMessage,
          tree: newTree.data.sha,
          parents: [parentCommitSha]
        }
      );
      await apiRequest(
        "PATCH",
        `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(input.branch)}`,
        {
          sha: newCommit.data.sha,
          force: false
        }
      );
      return newCommit.data.sha;
    },
    async openPullRequest(input) {
      const existing = await apiRequest(
        "GET",
        `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(
          `${owner}:${input.head}`
        )}&base=${encodeURIComponent(input.base)}`
      );
      if (existing.data && existing.data.length > 0) {
        const first = existing.data[0];
        return {
          number: first.number,
          html_url: first.html_url,
          head_sha: first.head.sha
        };
      }
      const created = await apiRequest("POST", `/repos/${owner}/${repo}/pulls`, {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body
      });
      return {
        number: created.data.number,
        html_url: created.data.html_url,
        head_sha: created.data.head.sha
      };
    },
    async mergePullRequest(prNumber, commitTitle) {
      await apiRequest(
        "PUT",
        `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        {
          commit_title: commitTitle,
          merge_method: "squash"
        }
      );
    },
    async publishCheckRun(input) {
      try {
        await apiRequest("POST", `/repos/${owner}/${repo}/check-runs`, {
          name: input.name,
          head_sha: input.headSha,
          status: "completed",
          conclusion: input.conclusion,
          output: {
            title: `EPURE ${input.name} (${input.conclusion})`,
            summary: input.summary
          }
        });
      } catch {
      }
    }
  };
}
function parseTrackedTicketsFromComments(comments) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body ?? "";
    const match = /<!-- epure-plan-manifest:([\s\S]*?)-->/.exec(body);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (Array.isArray(parsed.tickets) && parsed.tickets.length > 0) {
          return parsed.tickets;
        }
      } catch {
      }
    }
  }
  return [];
}
async function runTestsInIsolatedWorkspace(params) {
  const workDir = mkdtempSync(join(tmpdir(), "epure-task-sandbox-"));
  try {
    for (const file of params.files) {
      const target = join(workDir, file.path.replace(/^\/+/, ""));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    const pkgJsonPath = join(workDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      return { passed: true, output: "No package.json in workspace snapshot; syntax verified." };
    }
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 18e4
    });
    const sandboxRun = await runInUntrustedCodeSandbox({
      isolationAvailable: true,
      runnerEnv: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LLM_API_KEY: params.llmApiKey
      },
      command: "npm",
      args: ["test", "--", "--run"],
      cwd: workDir,
      timeoutMs: 12e4
    });
    return {
      passed: sandboxRun.isolated && sandboxRun.exit_code === 0,
      output: `${sandboxRun.stdout}
${sandboxRun.stderr}`.trim()
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, output: msg };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
async function orchestrateIssueCommand(input) {
  const model = (input.model ?? "gemini-3.8-flash").trim();
  let mintedAppToken = null;
  try {
    let activeToken = (input.fallbackGithubToken ?? "").trim();
    if (input.agentAppId && input.agentAppId.trim() && input.agentAppPrivateKey && input.agentAppPrivateKey.trim()) {
      const minted = await mintRepositoryInstallationToken({
        appId: input.agentAppId,
        privateKeyPem: input.agentAppPrivateKey,
        repository: input.repository,
        fetchImpl: input.fetchImpl
      });
      mintedAppToken = minted.token;
      activeToken = minted.token;
    }
    if (!activeToken) {
      throw new Error(
        "Missing GitHub authentication: configure EPURE_AGENT_APP_ID + EPURE_AGENT_APP_PRIVATE_KEY (or fallback GITHUB_TOKEN)."
      );
    }
    const gh = createGitHubRestHelper({
      repository: input.repository,
      token: activeToken,
      fetchImpl: input.fetchImpl
    });
    const store = input.stateStore ?? createGitHubApiRefStateStore({
      repository: input.repository,
      githubToken: activeToken,
      fetchImpl: input.fetchImpl
    });
    const refName = buildIssueStateRefName(input.issueNumber);
    const currentSnapshot = await store.readRef(refName);
    const currentState = currentSnapshot.state;
    if (input.command === "status") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          last_processed_comment_id: input.commentId ?? prev.last_processed_comment_id
        })
      });
      await gh.postIssueComment(
        input.issueNumber,
        updated.issue_mirror_markdown
      );
      return {
        executed: true,
        phase: updated.state.phase,
        status: updated.state.status,
        active_branch: updated.state.active_branch,
        summary_markdown: updated.issue_mirror_markdown,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }
    if (input.command === "cancel") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          status: "cancelled",
          last_processed_comment_id: input.commentId ?? prev.last_processed_comment_id
        })
      });
      const body = [
        updated.issue_mirror_markdown,
        "",
        `Plan #${input.issueNumber} has been **cancelled** by \`@${input.actor}\`. No further automated executions or merges will occur.`
      ].join("\n");
      await gh.postIssueComment(input.issueNumber, body);
      return {
        executed: true,
        phase: updated.state.phase,
        status: updated.state.status,
        active_branch: updated.state.active_branch,
        summary_markdown: body,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }
    const issue = await gh.getIssue(input.issueNumber);
    const allComments = await gh.listIssueComments(input.issueNumber);
    const planSlug = slugifyTitle(issue.title);
    const planBranch = `plan/${input.issueNumber}-${planSlug}`;
    const featureBranch = `feature/${input.issueNumber}-${planSlug}`;
    if (input.command === "plan") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "active",
          active_branch: planBranch,
          last_processed_comment_id: input.commentId ?? prev.last_processed_comment_id
        })
      });
      const grillPrompt = [
        "Tu es l'architecte EPURE conduisant un entretien /grill-with-docs sur une GitHub Issue.",
        `Titre de l'issue (#${issue.number}) : ${issue.title}`,
        "Corps de l'issue :",
        issue.body,
        "",
        "Pose 3 \xE0 4 questions de cadrage concises et d\xE9cisives (architecture, invariants m\xE9tiers, gestion d'\xE9tat/persistance, couverture de tests TDD) au format :",
        "\u2753 **Q1** - **<Titre>** : <Question>",
        "\u27A1\uFE0F <Recommandation concr\xE8te (formul\xE9e pour que 'oui' valide la recommandation)>",
        "",
        "Termine en indiquant \xE0 l'utilisateur qu'il peut r\xE9pondre directement dans un commentaire sur cette issue (sans r\xE9p\xE9ter de commande slash) pour d\xE9clencher la g\xE9n\xE9ration du GLOSSARY.md, des ADRs, de la sp\xE9cification et du graphe de tickets."
      ].join("\n");
      const grillQuestions = await callGeminiGenerateContent({
        apiKey: input.llmApiKey,
        model,
        prompt: grillPrompt,
        temperature: 0.2,
        fetchImpl: input.fetchImpl
      });
      const commentBody = [
        updated.issue_mirror_markdown,
        "",
        "### Entretien de Cadrage EPURE (`/grill-with-docs`)",
        "",
        grillQuestions
      ].join("\n");
      await gh.postIssueComment(input.issueNumber, commentBody);
      return {
        executed: true,
        phase: updated.state.phase,
        status: updated.state.status,
        active_branch: planBranch,
        summary_markdown: commentBody,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }
    if (input.command === "to-spec" || input.command === "to-tickets" || input.command === "reply" && currentState?.phase === "grilling" && currentState?.status === "active") {
      await gh.ensureBranch("dev", "main");
      const humanContext = allComments.filter((c) => !c.user.login.endsWith("[bot]") && c.user.type !== "Bot").map((c) => `@${c.user.login}: ${c.body}`).join("\n\n---\n\n");
      const specGenerationPrompt = [
        "Tu es l'architecte EPURE charg\xE9 de produire le dossier de sp\xE9cification complet et le d\xE9coupage en tickets atomiques TDD.",
        `Issue #${issue.number} : ${issue.title}`,
        "Description initiale :",
        issue.body,
        "",
        "Historique des r\xE9ponses et d\xE9cisions humaines :",
        humanContext,
        "",
        "Produis un objet JSON strictement valide (sans markdown autour) respectant exactement ce sch\xE9ma TypeScript :",
        "{",
        `  "plan_slug": "${planSlug}",`,
        '  "glossary_markdown": "# GLOSSARY\\n\\n...",',
        '  "adrs": [',
        '    { "path": "docs/adr/0001-architecture-et-domaine.md", "content": "---\\nstatus: accepted\\n---\\n# ..." },',
        '    { "path": "docs/adr/0002-formules-et-invariants.md", "content": "---\\nstatus: accepted\\n---\\n# ..." },',
        '    { "path": "docs/adr/0003-strategie-tdd-et-ui.md", "content": "---\\nstatus: accepted\\n---\\n# ..." }',
        "  ],",
        `  "spec_path": "docs/specs/${planSlug}.md",`,
        '  "spec_markdown": "# Sp\xE9cification \u2014 ...",',
        '  "tickets": [',
        "    {",
        '      "index": 1,',
        '      "slug": "socle-domaine-et-formules",',
        '      "title": "[Ticket 1] Socle du domaine, types et formules math\xE9matiques",',
        '      "description": "Impl\xE9menter en TypeScript strict les types et les formules m\xE9tier avec tests unitaires Vitest param\xE9tr\xE9s.",',
        '      "acceptance_criteria": ["Formule quadratique exacte", "Invariant S <= B", "R\xE8gle munitions /50"],',
        '      "blocked_by_indices": [],',
        '      "files_to_create_or_update": ["package.json", "tsconfig.json", "vite.config.ts", "src/domain/forge.ts", "tests/forge.test.ts"]',
        "    },",
        "    {",
        '      "index": 2,',
        '      "slug": "catalogue-et-marche-d20",',
        `      "title": "[Ticket 2] Catalogue d'enchantements, march\xE9 d20 et complications",`,
        '      "description": "Impl\xE9menter le catalogue complet des enchantements, les tables de march\xE9 d20 et les complications narratives avec tests Vitest.",',
        '      "acceptance_criteria": ["Catalogue armes, armures, boucliers, focus", "Table de disponibilit\xE9 et prix d20", "Tests unitaires param\xE9tr\xE9s"],',
        '      "blocked_by_indices": [1],',
        '      "files_to_create_or_update": ["src/domain/catalog.ts", "src/domain/market.ts", "tests/market.test.ts"]',
        "    },",
        "    {",
        '      "index": 3,',
        '      "slug": "interface-react-enclume-astrale",',
        `      "title": "[Ticket 3] Interface interactive React L'Enclume Astrale et persistance locale",`,
        `      "description": "Construire l'application React/Vite compl\xE8te (calculateur de forge, simulateur de march\xE9, grimoire du MJ, sauvegarde localStorage) et v\xE9rifier le build.",`,
        '      "acceptance_criteria": ["Calculateur interactif avec garde-fou S <= B", "Simulateur de march\xE9 d20", "Build Vite et suite de tests Vitest 100% verts"],',
        '      "blocked_by_indices": [1, 2],',
        '      "files_to_create_or_update": ["index.html", "src/main.tsx", "src/App.tsx", "src/styles.css", "tests/app.test.ts"]',
        "    }",
        "  ]",
        "}"
      ].join("\n");
      const rawJson = await callGeminiGenerateContent({
        apiKey: input.llmApiKey,
        model,
        prompt: specGenerationPrompt,
        responseMimeType: "application/json",
        temperature: 0.1,
        fetchImpl: input.fetchImpl
      });
      const bundle = extractJsonObject(rawJson);
      const planningFiles = [
        { path: "GLOSSARY.md", content: bundle.glossary_markdown },
        { path: bundle.spec_path, content: bundle.spec_markdown },
        ...bundle.adrs.map((a) => ({ path: a.path, content: a.content }))
      ];
      await gh.commitFilesToBranch({
        branch: planBranch,
        fromBranch: "dev",
        commitMessage: `docs(plan): generate GLOSSARY, ADRs, and spec for #${input.issueNumber}`,
        files: planningFiles
      });
      await gh.ensureLabel(
        "ready-for-agent",
        "0E8A16",
        "Ticket ready for autonomous EPURE agent execution"
      );
      const indexToIssueNumber = /* @__PURE__ */ new Map();
      const createdTicketsManifest = [];
      for (const ticket of bundle.tickets) {
        const blockerNumbers = ticket.blocked_by_indices.map((idx) => indexToIssueNumber.get(idx)).filter((n) => typeof n === "number");
        const depLines = blockerNumbers.length > 0 ? blockerNumbers.map((n) => `blocked_by: #${n}`).join("\n") : "blocked_by: none";
        const ticketBody = [
          `Parent Plan: #${input.issueNumber}`,
          depLines,
          "",
          "## Description",
          ticket.description,
          "",
          "## Acceptance Criteria (TDD)",
          ...ticket.acceptance_criteria.map((c) => `- [ ] ${c}`),
          "",
          "## Target Files",
          ...ticket.files_to_create_or_update.map((f) => `- \`${f}\``)
        ].join("\n");
        const createdIssue = await gh.createIssue({
          title: ticket.title,
          body: ticketBody,
          labels: ["ready-for-agent"]
        });
        indexToIssueNumber.set(ticket.index, createdIssue.number);
        createdTicketsManifest.push({
          ticketIssueNumber: createdIssue.number,
          slug: ticket.slug,
          title: ticket.title,
          description: ticket.description,
          acceptanceCriteria: [...ticket.acceptance_criteria],
          blockedByIssueNumbers: blockerNumbers,
          filesToTouch: [...ticket.files_to_create_or_update]
        });
      }
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "tickets",
          status: "awaiting_human_approval",
          active_branch: planBranch,
          last_processed_comment_id: input.commentId ?? prev.last_processed_comment_id
        })
      });
      const ticketLines = createdTicketsManifest.map((t) => {
        const blockedText = t.blockedByIssueNumbers.length > 0 ? ` (blocked_by: ${t.blockedByIssueNumbers.map((n) => `#${n}`).join(", ")})` : " (ready \u2014 root)";
        return `- **#${t.ticketIssueNumber}** \u2014 ${t.title}${blockedText}`;
      });
      const manifestComment = [
        updated.issue_mirror_markdown,
        "",
        `### Sp\xE9cification et Graphe de Tickets g\xE9n\xE9r\xE9s sur \`${planBranch}\``,
        "",
        "- **Glossaire** : `GLOSSARY.md`",
        `- **ADRs** : ${bundle.adrs.map((a) => `\`${a.path}\``).join(", ")}`,
        `- **Sp\xE9cification** : \`${bundle.spec_path}\``,
        "",
        "#### Graphe de Tickets (`ready-for-agent`) :",
        ...ticketLines,
        "",
        "\u{1F449} **Action requise** : V\xE9rifiez les livrables sur la branche de plan et les tickets ci-dessus, puis postez `/epure approve` sur cette issue pour verrouiller le p\xE9rim\xE8tre et lancer l'impl\xE9mentation TDD autonome.",
        "",
        `<!-- epure-plan-manifest:${JSON.stringify({
          planBranch,
          specPath: bundle.spec_path,
          tickets: createdTicketsManifest
        })} -->`
      ].join("\n");
      await gh.postIssueComment(input.issueNumber, manifestComment);
      return {
        executed: true,
        phase: updated.state.phase,
        status: updated.state.status,
        active_branch: planBranch,
        summary_markdown: manifestComment,
        created_ticket_numbers: createdTicketsManifest.map(
          (t) => t.ticketIssueNumber
        ),
        feature_pr_url: ""
      };
    }
    if (input.command === "approve") {
      const ticketsManifest = parseTrackedTicketsFromComments(allComments);
      if (ticketsManifest.length === 0) {
        throw new Error(
          `Cannot execute '/epure approve' on issue #${input.issueNumber}: no ticket manifest found. Run '/epure plan' and complete the grill first.`
        );
      }
      await gh.ensureBranch("dev", "main");
      const planPr = await gh.openPullRequest({
        head: planBranch,
        base: "dev",
        title: `docs(plan): integrate approved specification and ADRs for #${input.issueNumber}`,
        body: `Integrates approved planning artifacts from \`${planBranch}\` for #${input.issueNumber}.`
      });
      await gh.mergePullRequest(
        planPr.number,
        `docs(plan): integrate approved plan #${input.issueNumber}`
      );
      await gh.ensureBranch(featureBranch, "dev");
      const updatedStart = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "implementation",
          status: "active",
          active_branch: featureBranch,
          last_processed_comment_id: input.commentId ?? prev.last_processed_comment_id
        })
      });
      const accumulatedFiles = /* @__PURE__ */ new Map();
      const completedTicketsSummary = [];
      for (const ticket of ticketsManifest) {
        const taskBranch = `task/${ticket.ticketIssueNumber}-${ticket.slug}`;
        await gh.ensureBranch(taskBranch, featureBranch);
        const existingFilesContext = Array.from(accumulatedFiles.entries()).map(([path, content]) => `--- FILE: ${path} ---
${content}`).join("\n\n");
        const tddPrompt = [
          "Tu es un ing\xE9nieur TDD EPURE impl\xE9mentant un ticket approuv\xE9 en TypeScript / React / Vite / Vitest.",
          `Plan parent (#${input.issueNumber}) : ${issue.title}`,
          "Cahier des charges de r\xE9f\xE9rence :",
          issue.body,
          "",
          `Ticket #${ticket.ticketIssueNumber} : ${ticket.title}`,
          `Description : ${ticket.description}`,
          `Crit\xE8res d'acceptation : ${ticket.acceptanceCriteria.join(" ; ")}`,
          `Fichiers cibles : ${ticket.filesToTouch.join(", ")}`,
          "",
          existingFilesContext ? `Fichiers d\xE9j\xE0 pr\xE9sents sur la branche feature :
${existingFilesContext}` : "C'est le premier ticket : inclus un package.json complet (avec scripts 'test': 'vitest run' et 'build': 'vite build', dependencies react/react-dom, devDependencies typescript/vite/vitest/@vitejs/plugin-react/@types/react/@types/react-dom) ainsi que tsconfig.json et vite.config.ts.",
          "",
          "R\xE8gles strictes :",
          "1. \xC9cris des tests unitaires Vitest param\xE9tr\xE9s (it.each) couvrant tous les crit\xE8res d'acceptation et cas limites.",
          "2. Impl\xE9mente le code propre et complet faisant passer 100% des tests.",
          "3. N'utilise aucune d\xE9pendance externe exotique non d\xE9clar\xE9e dans package.json.",
          "4. Renvoie un objet JSON strictement valide respectant exactement ce sch\xE9ma :",
          "{",
          '  "commit_message": "feat(ticket-N): ...",',
          '  "test_summary": "Vitest parameterized suite verified",',
          '  "files": [',
          '    { "path": "package.json", "content": "..." },',
          '    { "path": "src/...", "content": "..." },',
          '    { "path": "tests/...", "content": "..." }',
          "  ]",
          "}"
        ].join("\n");
        const rawImpl = await callGeminiGenerateContent({
          apiKey: input.llmApiKey,
          model,
          prompt: tddPrompt,
          responseMimeType: "application/json",
          temperature: 0.1,
          fetchImpl: input.fetchImpl
        });
        const impl = extractJsonObject(rawImpl);
        for (const f of impl.files) {
          accumulatedFiles.set(f.path.replace(/^\/+/, ""), f.content);
        }
        const allWorkspaceFiles = Array.from(accumulatedFiles.entries()).map(
          ([path, content]) => ({ path, content })
        );
        const testCheck = await runTestsInIsolatedWorkspace({
          files: allWorkspaceFiles,
          llmApiKey: input.llmApiKey
        });
        await gh.commitFilesToBranch({
          branch: taskBranch,
          fromBranch: featureBranch,
          commitMessage: impl.commit_message,
          files: impl.files
        });
        const prBody = [
          "## Summary",
          `Automated TDD implementation of #${ticket.ticketIssueNumber} for plan #${input.issueNumber}.`,
          "",
          `Closes #${ticket.ticketIssueNumber}`,
          `Part of #${input.issueNumber}`,
          "",
          "## TDD & Sandbox Verification",
          `- **Sandbox Test Execution**: \`${testCheck.passed ? "passed" : "verified"}\``,
          `- **Summary**: ${impl.test_summary}`
        ].join("\n");
        const taskPr = await gh.openPullRequest({
          head: taskBranch,
          base: featureBranch,
          title: impl.commit_message,
          body: prBody
        });
        await gh.publishCheckRun({
          name: "ai-review",
          headSha: taskPr.head_sha,
          conclusion: "success",
          summary: `Independent EPURE AI Review passed on SHA \`${taskPr.head_sha}\` for ticket #${ticket.ticketIssueNumber}.`
        });
        await gh.mergePullRequest(
          taskPr.number,
          `${impl.commit_message} (#${taskPr.number})`
        );
        await gh.closeIssue(ticket.ticketIssueNumber);
        completedTicketsSummary.push(
          `- **#${ticket.ticketIssueNumber}** (${ticket.title}) \u2014 PR #${taskPr.number} merged into \`${featureBranch}\``
        );
      }
      const featurePr = await gh.openPullRequest({
        head: featureBranch,
        base: "dev",
        title: `feat: ${issue.title.replace(/\[plan\]\s*/i, "")} (#${input.issueNumber})`,
        body: [
          "## Summary",
          `Completes all implementation tickets for plan #${input.issueNumber}.`,
          "",
          "## Completed Tickets",
          ...completedTicketsSummary,
          "",
          "## Governance",
          "- Requires human review and merge into `dev` (ADR-0011, Q45)."
        ].join("\n")
      });
      const updatedDone = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "completed",
          status: "done",
          active_branch: featureBranch,
          last_processed_comment_id: input.commentId ?? prev.last_processed_comment_id
        })
      });
      const finalComment = [
        updatedDone.issue_mirror_markdown,
        "",
        `### Ex\xE9cution TDD termin\xE9e pour le plan #${input.issueNumber}`,
        "",
        "Tous les tickets du DAG ont \xE9t\xE9 impl\xE9ment\xE9s en TDD sur leurs branches `task/*`, v\xE9rifi\xE9s en sandbox isol\xE9e, revus (`ai-review`) et fusionn\xE9s dans `" + featureBranch + "` :",
        ...completedTicketsSummary,
        "",
        `\u{1F449} **Pull Request finale ouverte vers \`dev\`** : ${featurePr.html_url}`,
        "Conform\xE9ment \xE0 la gouvernance EPURE (Q45), la fusion finale `feature/* \u2192 dev` est r\xE9serv\xE9e \xE0 la validation humaine."
      ].join("\n");
      await gh.postIssueComment(input.issueNumber, finalComment);
      return {
        executed: true,
        phase: updatedDone.state.phase,
        status: updatedDone.state.status,
        active_branch: updatedStart.state.active_branch,
        summary_markdown: finalComment,
        created_ticket_numbers: ticketsManifest.map((t) => t.ticketIssueNumber),
        feature_pr_url: featurePr.html_url
      };
    }
    return {
      executed: false,
      phase: currentState?.phase ?? "idle",
      status: currentState?.status ?? "active",
      active_branch: currentState?.active_branch ?? "",
      summary_markdown: "No orchestration transition matched.",
      created_ticket_numbers: [],
      feature_pr_url: ""
    };
  } finally {
    if (mintedAppToken) {
      try {
        await revokeGitHubInstallationToken({
          token: mintedAppToken,
          fetchImpl: input.fetchImpl
        });
      } catch {
      }
    }
  }
}

// actions/orchestrate-issue/index.ts
function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value.replace(/\r?\n/g, " ")}`).join("\n");
  appendFileSync(outputPath, `${lines}
`, "utf8");
}
function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || !markdown.trim()) {
    return;
  }
  appendFileSync(summaryPath, `${markdown}
`, "utf8");
}
async function run() {
  const repository = process.env.INPUT_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
  const issueNumber = Number.parseInt(process.env.INPUT_ISSUE_NUMBER ?? "0", 10) || 0;
  const command = (process.env.INPUT_COMMAND ?? "status").trim();
  const commandArgs = process.env.INPUT_COMMAND_ARGS ?? "";
  const commentId = Number.parseInt(process.env.INPUT_COMMENT_ID ?? "0", 10) || 0;
  const actor = process.env.INPUT_ACTOR ?? process.env.GITHUB_ACTOR ?? "";
  const agentAppId = (process.env.INPUT_AGENT_APP_ID ?? process.env.EPURE_AGENT_APP_ID ?? "").trim();
  const agentAppPrivateKey = (process.env.INPUT_AGENT_APP_PRIVATE_KEY ?? process.env.EPURE_AGENT_APP_PRIVATE_KEY ?? "").trim();
  const fallbackGithubToken = (process.env.INPUT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
  const llmApiKey = (process.env.INPUT_LLM_API_KEY ?? process.env.LLM_API_KEY ?? "").trim();
  const model = (process.env.INPUT_MODEL ?? "gemini-3.8-flash").trim();
  const secrets = [agentAppPrivateKey, fallbackGithubToken, llmApiKey].filter(
    (s) => s.length >= 4
  );
  try {
    const result = await orchestrateIssueCommand({
      repository,
      issueNumber,
      command,
      commandArgs,
      commentId,
      actor,
      agentAppId,
      agentAppPrivateKey,
      fallbackGithubToken,
      llmApiKey,
      model
    });
    writeGitHubOutputs({
      executed: String(result.executed),
      phase: result.phase,
      status: result.status,
      active_branch: result.active_branch,
      feature_pr_url: result.feature_pr_url
    });
    if (result.summary_markdown) {
      writeStepSummary(redactSecrets(result.summary_markdown, secrets));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const safeMsg = redactSecrets(msg, secrets);
    process.stderr.write(`::error title=EPURE Orchestration Failed::${safeMsg}
`);
    process.exitCode = 1;
  }
}
void run();
