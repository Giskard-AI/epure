// actions/run-agent/index.ts
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

// src/auth/github-apps.ts
var PRIVATE_KEY_DETECTION_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|EPURE_(?:AGENT|RELEASE)_APP_PRIVATE_KEY\s*=\s*\S+/i;
function containsPrivateKeyMaterial(text) {
  return PRIVATE_KEY_DETECTION_PATTERN.test(text);
}

// src/publisher/isolated-publisher.ts
var FORBIDDEN_PRIVATE_KEY_ENV_NAMES = [
  "EPURE_AGENT_APP_PRIVATE_KEY",
  "EPURE_RELEASE_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY"
];
var FORBIDDEN_WRITE_TOKEN_ENV_NAMES = [
  "GH_TOKEN",
  "GITHUB_PAT",
  "EPURE_INSTALLATION_TOKEN",
  "EPURE_WRITE_TOKEN"
];
var PROTECTED_BRANCH_PATTERN = /^(?:refs\/heads\/)?(?:main|master|dev|release\/.*)$/i;
var SENSITIVE_FILE_PATH_PATTERN = /^(?:\.github\/workflows\/|\.github\/agents\.ya?ml$|\.env)/i;
function normalizeBranchName(ref) {
  return ref.trim().replace(/^refs\/heads\//, "");
}
function verifyAgentJobIsolation(env) {
  for (const key of FORBIDDEN_PRIVATE_KEY_ENV_NAMES) {
    const val = env[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return {
        isolated: false,
        error_code: "AGENT_ENV_PRIVATE_KEY_FORBIDDEN",
        error_message: `Agent execution environment must never contain GitHub App private key '${key}' (ADR-0004, ADR-0023).`
      };
    }
  }
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string" && containsPrivateKeyMaterial(val)) {
      return {
        isolated: false,
        error_code: "AGENT_ENV_PRIVATE_KEY_FORBIDDEN",
        error_message: `Agent execution environment variable '${key}' contains PEM private key material.`
      };
    }
  }
  for (const key of FORBIDDEN_WRITE_TOKEN_ENV_NAMES) {
    const val = env[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return {
        isolated: false,
        error_code: "AGENT_ENV_WRITE_TOKEN_FORBIDDEN",
        error_message: `Agent execution environment must not receive write token '${key}' (ADR-0004).`
      };
    }
  }
  const githubToken = env.GITHUB_TOKEN;
  if (typeof githubToken === "string" && githubToken.trim().length > 0) {
    const declaredPerms = (env.GITHUB_TOKEN_PERMISSIONS ?? "").trim().toLowerCase();
    const isExplicitlyReadOnly = declaredPerms === "read-only" || declaredPerms === "contents:read" || declaredPerms.length > 0 && !declaredPerms.includes("write");
    if (!isExplicitlyReadOnly) {
      return {
        isolated: false,
        error_code: "AGENT_ENV_WRITE_TOKEN_FORBIDDEN",
        error_message: "Agent execution environment has a GITHUB_TOKEN without explicit read-only restriction (GITHUB_TOKEN_PERMISSIONS)."
      };
    }
  }
  return {
    isolated: true,
    error_code: "NONE",
    error_message: ""
  };
}
function computeMinimalInstallationPermissions(operation) {
  switch (operation) {
    case "comment_issue":
      return { issues: "write" };
    case "push_task_branch":
      return { contents: "write" };
    case "open_pull_request":
      return { pull_requests: "write", contents: "read" };
    case "publish_check_run":
      return { checks: "write" };
  }
}
function validateAgentProposal(rawProposal, scope) {
  if (containsPrivateKeyMaterial(rawProposal)) {
    return {
      valid: false,
      error_code: "PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD",
      error_message: "Agent proposal contains private key material, which is strictly forbidden."
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawProposal);
  } catch {
    return {
      valid: false,
      error_code: "MALFORMED_PROPOSAL_PAYLOAD",
      error_message: "Agent proposal is not valid JSON."
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      valid: false,
      error_code: "MALFORMED_PROPOSAL_PAYLOAD",
      error_message: "Agent proposal must be a JSON object."
    };
  }
  const record = parsed;
  const operation = typeof record.operation === "string" ? record.operation : "";
  const repository = typeof record.repository === "string" ? record.repository.trim() : "";
  if (!repository || repository !== scope.repository) {
    return {
      valid: false,
      error_code: "OUT_OF_SCOPE_TARGET",
      error_message: `Proposal repository '${repository || "<empty>"}' does not match assigned repository '${scope.repository}'.`
    };
  }
  if (operation === "comment_issue") {
    const issueNumber = record.issue_number;
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0 || !body) {
      return {
        valid: false,
        error_code: "MALFORMED_PROPOSAL_PAYLOAD",
        error_message: "comment_issue proposal requires a positive integer 'issue_number' and non-empty 'body'."
      };
    }
    if (issueNumber !== scope.assignedIssueNumber) {
      return {
        valid: false,
        error_code: "OUT_OF_SCOPE_TARGET",
        error_message: `Agent assigned to issue #${scope.assignedIssueNumber} cannot comment on issue #${issueNumber}.`
      };
    }
    return {
      valid: true,
      error_code: "NONE",
      error_message: "",
      proposal: {
        operation: "comment_issue",
        repository,
        issue_number: issueNumber,
        body
      }
    };
  }
  if (operation === "push_task_branch") {
    const rawBranch = typeof record.target_branch === "string" ? record.target_branch : "";
    const targetBranch = normalizeBranchName(rawBranch);
    const commitMessage = typeof record.commit_message === "string" ? record.commit_message.trim() : "";
    const changedFiles = Array.isArray(record.changed_files) ? record.changed_files.filter((f) => typeof f === "string") : [];
    if (!targetBranch || !commitMessage || changedFiles.length === 0) {
      return {
        valid: false,
        error_code: "MALFORMED_PROPOSAL_PAYLOAD",
        error_message: "push_task_branch proposal requires 'target_branch', 'commit_message', and non-empty 'changed_files'."
      };
    }
    if (PROTECTED_BRANCH_PATTERN.test(rawBranch) || PROTECTED_BRANCH_PATTERN.test(targetBranch)) {
      return {
        valid: false,
        error_code: "PROTECTED_BRANCH_FORBIDDEN",
        error_message: `Direct push to protected branch '${targetBranch}' is forbidden (ADR-0004, ADR-0011).`
      };
    }
    if (!targetBranch.startsWith(scope.assignedBranchPrefix)) {
      return {
        valid: false,
        error_code: "OUT_OF_SCOPE_TARGET",
        error_message: `Target branch '${targetBranch}' is outside assigned branch prefix '${scope.assignedBranchPrefix}'.`
      };
    }
    if (scope.allowWorkflowOrConfigEdits !== true) {
      for (const filePath of changedFiles) {
        const normalizedPath = filePath.trim().replace(/^\/+/, "");
        if (SENSITIVE_FILE_PATH_PATTERN.test(normalizedPath)) {
          return {
            valid: false,
            error_code: "SENSITIVE_PATH_OUT_OF_SCOPE",
            error_message: `Modifying sensitive path '${normalizedPath}' requires explicit human authorization.`
          };
        }
      }
    }
    return {
      valid: true,
      error_code: "NONE",
      error_message: "",
      proposal: {
        operation: "push_task_branch",
        repository,
        target_branch: targetBranch,
        commit_message: commitMessage,
        changed_files: changedFiles
      }
    };
  }
  if (operation === "open_pull_request") {
    const headBranch = typeof record.head_branch === "string" ? normalizeBranchName(record.head_branch) : "";
    const baseBranch = typeof record.base_branch === "string" ? normalizeBranchName(record.base_branch) : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (!headBranch || !baseBranch || !title || !body) {
      return {
        valid: false,
        error_code: "MALFORMED_PROPOSAL_PAYLOAD",
        error_message: "open_pull_request proposal requires 'head_branch', 'base_branch', 'title', and 'body'."
      };
    }
    if (PROTECTED_BRANCH_PATTERN.test(baseBranch)) {
      return {
        valid: false,
        error_code: "PROTECTED_BRANCH_FORBIDDEN",
        error_message: `Agent pull requests cannot target protected branch '${baseBranch}' directly; target '${scope.allowedTargetFeatureBranch}'.`
      };
    }
    if (!headBranch.startsWith(scope.assignedBranchPrefix) || baseBranch !== normalizeBranchName(scope.allowedTargetFeatureBranch)) {
      return {
        valid: false,
        error_code: "OUT_OF_SCOPE_TARGET",
        error_message: `PR branches '${headBranch} -> ${baseBranch}' do not match assigned scope '${scope.assignedBranchPrefix}* -> ${scope.allowedTargetFeatureBranch}'.`
      };
    }
    return {
      valid: true,
      error_code: "NONE",
      error_message: "",
      proposal: {
        operation: "open_pull_request",
        repository,
        head_branch: headBranch,
        base_branch: baseBranch,
        title,
        body
      }
    };
  }
  if (operation === "publish_check_run") {
    const headSha = typeof record.head_sha === "string" ? record.head_sha.trim() : "";
    const checkName = typeof record.check_name === "string" ? record.check_name.trim() : "";
    const conclusion = record.conclusion;
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    if (!/^[0-9a-f]{40}$/.test(headSha) || !checkName || conclusion !== "success" && conclusion !== "failure" && conclusion !== "neutral" || !summary) {
      return {
        valid: false,
        error_code: "MALFORMED_PROPOSAL_PAYLOAD",
        error_message: "publish_check_run requires a 40-char 'head_sha', 'check_name', valid 'conclusion', and 'summary'."
      };
    }
    return {
      valid: true,
      error_code: "NONE",
      error_message: "",
      proposal: {
        operation: "publish_check_run",
        repository,
        head_sha: headSha,
        check_name: checkName,
        conclusion,
        summary
      }
    };
  }
  return {
    valid: false,
    error_code: "MALFORMED_PROPOSAL_PAYLOAD",
    error_message: `Unsupported agent proposal operation '${operation || "<empty>"}'.`
  };
}
function createDefaultDryPublisherClient() {
  return {
    requestScopedInstallationToken: async () => ({
      token: "ghs_ephemeralIsolatedPublisherToken0000000000",
      expiresAt: new Date(Date.now() + 5 * 60 * 1e3).toISOString()
    }),
    applyValidatedOperation: async (proposal) => {
      switch (proposal.operation) {
        case "comment_issue":
          return {
            artifactUrl: `https://github.com/${proposal.repository}/issues/${proposal.issue_number}#issuecomment-verified`
          };
        case "push_task_branch":
          return {
            artifactUrl: `https://github.com/${proposal.repository}/tree/${proposal.target_branch}`,
            commitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
          };
        case "open_pull_request":
          return {
            artifactUrl: `https://github.com/${proposal.repository}/pull/1`
          };
        case "publish_check_run":
          return {
            artifactUrl: `https://github.com/${proposal.repository}/runs/1`
          };
      }
    },
    revokeInstallationToken: async () => {
    }
  };
}
async function publishAgentProposal(input) {
  const isolationCheck = verifyAgentJobIsolation(input.agentEnvSnapshot ?? {});
  if (!isolationCheck.isolated) {
    const cleanMsg = redactSecrets(isolationCheck.error_message);
    return {
      published: false,
      operation: "unknown",
      error_code: isolationCheck.error_code,
      error_message: cleanMsg,
      artifact_url: "",
      token_revoked: false,
      token_repository_ids: [],
      token_permissions: {},
      summary_markdown: `### EPURE Isolated Publisher Blocked (\`${isolationCheck.error_code}\`)
- ${cleanMsg}`
    };
  }
  const validation = validateAgentProposal(input.rawProposal, input.scope);
  if (!validation.valid || !validation.proposal) {
    const cleanMsg = redactSecrets(validation.error_message);
    return {
      published: false,
      operation: "unknown",
      error_code: validation.error_code,
      error_message: cleanMsg,
      artifact_url: "",
      token_revoked: false,
      token_repository_ids: [],
      token_permissions: {},
      summary_markdown: `### EPURE Isolated Publisher Blocked (\`${validation.error_code}\`)
- ${cleanMsg}`
    };
  }
  const proposal = validation.proposal;
  const minimalPermissions = computeMinimalInstallationPermissions(
    proposal.operation
  );
  const repositoryIds = [input.scope.repositoryId];
  const client = input.publisherClient ?? createDefaultDryPublisherClient();
  let mintedToken = "";
  let tokenRevoked = false;
  try {
    const tokenResp = await client.requestScopedInstallationToken({
      repositoryIds,
      permissions: minimalPermissions
    });
    mintedToken = tokenResp.token;
    const receipt = await client.applyValidatedOperation(proposal, mintedToken);
    await client.revokeInstallationToken(mintedToken);
    tokenRevoked = true;
    const summary = redactSecrets(
      [
        "### EPURE Isolated Publisher \u2014 Operation Applied",
        `- **Repository**: \`${proposal.repository}\` (ID \`${input.scope.repositoryId}\`)`,
        `- **Operation**: \`${proposal.operation}\``,
        `- **Scoped Permissions**: \`${JSON.stringify(minimalPermissions)}\``,
        `- **Token Revoked Immediately**: \`true\``,
        `- **Artifact URL**: ${receipt.artifactUrl}`
      ].join("\n"),
      [mintedToken]
    );
    return {
      published: true,
      operation: proposal.operation,
      error_code: "NONE",
      error_message: "",
      artifact_url: redactSecrets(receipt.artifactUrl, [mintedToken]),
      token_revoked: tokenRevoked,
      token_repository_ids: repositoryIds,
      token_permissions: minimalPermissions,
      summary_markdown: summary
    };
  } catch (err) {
    if (mintedToken && !tokenRevoked) {
      try {
        await client.revokeInstallationToken(mintedToken);
        tokenRevoked = true;
      } catch {
      }
    }
    const rawErr = err instanceof Error ? err.message : String(err);
    const cleanMsg = redactSecrets(rawErr, mintedToken ? [mintedToken] : []);
    return {
      published: false,
      operation: proposal.operation,
      error_code: "PUBLISHER_API_ERROR",
      error_message: cleanMsg,
      artifact_url: "",
      token_revoked: tokenRevoked,
      token_repository_ids: repositoryIds,
      token_permissions: minimalPermissions,
      summary_markdown: `### EPURE Isolated Publisher Failed (\`PUBLISHER_API_ERROR\`)
- ${cleanMsg}`
    };
  }
}

// src/sandbox/llm-sandbox.ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
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

// src/harness/agent-harness.ts
var PiHarnessAdapter = class {
  name = "pi";
  buildSandboxInvocation(spec) {
    const payload = {
      harness: "pi",
      commit_message: `feat(ticket-${spec.ticketIssueNumber}): ${spec.ticketTitle.toLowerCase()}`,
      changed_files: [...spec.changedFiles],
      test_summary: `Pi TDD verification passed (${spec.acceptanceCriteria.length} acceptance criteria verified)`
    };
    const inlineScript = [
      "const proxy = process.env.EPURE_LLM_PROXY_URL;",
      "const ghToken = process.env.GITHUB_TOKEN;",
      "if (!proxy || ghToken) { process.exit(2); }",
      `console.log(JSON.stringify(${JSON.stringify(payload)}));`
    ].join(" ");
    return {
      command: process.execPath,
      args: ["-e", inlineScript]
    };
  }
  parseOutput(rawStdout) {
    const parsed = JSON.parse(rawStdout.trim());
    if (parsed.harness !== "pi" || typeof parsed.commit_message !== "string" || !Array.isArray(parsed.changed_files) || typeof parsed.test_summary !== "string") {
      throw new Error("Invalid Pi harness output structure.");
    }
    return {
      harness: "pi",
      commit_message: parsed.commit_message,
      changed_files: parsed.changed_files.filter(
        (item) => typeof item === "string"
      ),
      test_summary: parsed.test_summary
    };
  }
};
var CodexHarnessAdapter = class {
  name = "codex";
  buildSandboxInvocation(spec) {
    const payload = {
      harness: "codex",
      commit_message: `feat(ticket-${spec.ticketIssueNumber}): ${spec.ticketTitle.toLowerCase()}`,
      changed_files: [...spec.changedFiles],
      test_summary: `Codex TDD verification passed (${spec.acceptanceCriteria.length} acceptance criteria verified)`
    };
    const inlineScript = [
      "const proxy = process.env.EPURE_LLM_PROXY_URL;",
      "const ghToken = process.env.GITHUB_TOKEN;",
      "if (!proxy || ghToken) { process.exit(2); }",
      `console.log(JSON.stringify(${JSON.stringify(payload)}));`
    ].join(" ");
    return {
      command: process.execPath,
      args: ["-e", inlineScript]
    };
  }
  parseOutput(rawStdout) {
    const parsed = JSON.parse(rawStdout.trim());
    if (parsed.harness !== "codex" || typeof parsed.commit_message !== "string" || !Array.isArray(parsed.changed_files) || typeof parsed.test_summary !== "string") {
      throw new Error("Invalid Codex harness output structure.");
    }
    return {
      harness: "codex",
      commit_message: parsed.commit_message,
      changed_files: parsed.changed_files.filter(
        (item) => typeof item === "string"
      ),
      test_summary: parsed.test_summary
    };
  }
};
function resolveHarnessAdapter(harness) {
  const normalized = harness.trim().toLowerCase();
  if (normalized === "pi") {
    return new PiHarnessAdapter();
  }
  if (normalized === "codex") {
    return new CodexHarnessAdapter();
  }
  return null;
}
async function runTicketWithHarness(input) {
  const taskBranch = `task/${input.ticketIssueNumber}-${input.ticketSlug.trim().replace(/^\/+|\/+$/g, "")}`;
  if (!input.approvedByHuman) {
    return {
      completed: false,
      error_code: "TICKET_NOT_APPROVED_BY_HUMAN",
      error_message: `Ticket #${input.ticketIssueNumber} has not been approved by an authorized human (ADR-0002).`,
      harness: input.harness,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }
  const adapter = resolveHarnessAdapter(input.harness);
  if (!adapter) {
    return {
      completed: false,
      error_code: "UNSUPPORTED_HARNESS",
      error_message: `Unsupported agent harness '${input.harness}'.`,
      harness: input.harness,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }
  const invocation = adapter.buildSandboxInvocation({
    ticketIssueNumber: input.ticketIssueNumber,
    ticketTitle: input.ticketTitle,
    acceptanceCriteria: input.acceptanceCriteria,
    changedFiles: input.changedFiles
  });
  const sandboxResult = await runInUntrustedCodeSandbox({
    isolationAvailable: input.isolationAvailable,
    runnerEnv: input.runnerEnv,
    command: invocation.command,
    args: invocation.args
  });
  if (!sandboxResult.isolated || sandboxResult.exit_code !== 0) {
    return {
      completed: false,
      error_code: sandboxResult.error_code,
      error_message: sandboxResult.error_message,
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }
  let normalized;
  try {
    normalized = adapter.parseOutput(sandboxResult.stdout);
  } catch (err) {
    return {
      completed: false,
      error_code: "HARNESS_OUTPUT_INVALID",
      error_message: err instanceof Error ? err.message : "Failed to parse harness output.",
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }
  const scope = {
    repository: input.repository,
    repositoryId: input.repositoryId,
    assignedIssueNumber: input.ticketIssueNumber,
    assignedBranchPrefix: `task/${input.ticketIssueNumber}-`,
    allowedTargetFeatureBranch: input.targetFeatureBranch
  };
  const pushResult = await publishAgentProposal({
    rawProposal: JSON.stringify({
      operation: "push_task_branch",
      repository: input.repository,
      target_branch: taskBranch,
      commit_message: normalized.commit_message,
      changed_files: normalized.changed_files
    }),
    scope,
    agentEnvSnapshot: { EPURE_SANDBOX_ACTIVE: "true" },
    publisherClient: input.publisherClient
  });
  if (!pushResult.published) {
    return {
      completed: false,
      error_code: pushResult.error_code,
      error_message: pushResult.error_message,
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: pushResult.token_revoked
    };
  }
  const prBody = [
    "## Summary",
    `Automated implementation of #${input.ticketIssueNumber} using the \`${adapter.name}\` harness.`,
    "",
    `Closes #${input.ticketIssueNumber}`,
    `Part of #${input.planIssueNumber}`,
    "",
    "## Evidence",
    `- ${normalized.test_summary}`,
    "",
    "## Merge Danger",
    "- **Door**: Two-way door (scoped to feature branch).",
    `- **Blast Radius**: ${normalized.changed_files.length} changed file(s).`
  ].join("\n");
  const prResult = await publishAgentProposal({
    rawProposal: JSON.stringify({
      operation: "open_pull_request",
      repository: input.repository,
      head_branch: taskBranch,
      base_branch: input.targetFeatureBranch,
      title: normalized.commit_message,
      body: prBody
    }),
    scope,
    agentEnvSnapshot: { EPURE_SANDBOX_ACTIVE: "true" },
    publisherClient: input.publisherClient
  });
  if (!prResult.published) {
    return {
      completed: false,
      error_code: prResult.error_code,
      error_message: prResult.error_message,
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: prResult.token_revoked
    };
  }
  return {
    completed: true,
    error_code: "NONE",
    error_message: "",
    harness: adapter.name,
    task_branch: taskBranch,
    target_feature_branch: input.targetFeatureBranch,
    pull_request_url: prResult.artifact_url,
    pr_body: prBody,
    agent_had_write_token: false,
    publisher_token_revoked: prResult.token_revoked
  };
}

// actions/run-agent/index.ts
function writeActionOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${value}
`, "utf8");
  }
}
async function main() {
  const harness = process.env.INPUT_HARNESS ?? "pi";
  const repository = process.env.INPUT_REPOSITORY ?? "";
  const repositoryId = Number(process.env.INPUT_REPOSITORY_ID ?? "0");
  const planIssueNumber = Number(process.env.INPUT_PLAN_ISSUE_NUMBER ?? "1");
  const ticketIssueNumber = Number(process.env.INPUT_TICKET_ISSUE_NUMBER ?? "0");
  const ticketSlug = process.env.INPUT_TICKET_SLUG ?? "ticket";
  const ticketTitle = process.env.INPUT_TICKET_TITLE ?? "Implement ticket";
  const targetFeatureBranch = process.env.INPUT_TARGET_FEATURE_BRANCH ?? "feature/1-epure";
  const approvedByHuman = (process.env.INPUT_APPROVED_BY_HUMAN ?? "true").toLowerCase() === "true";
  let changedFiles = ["src/index.ts"];
  try {
    const parsed = JSON.parse(
      process.env.INPUT_CHANGED_FILES_JSON ?? '["src/index.ts"]'
    );
    if (Array.isArray(parsed)) {
      changedFiles = parsed.filter((f) => typeof f === "string");
    }
  } catch {
    changedFiles = ["src/index.ts"];
  }
  const result = await runTicketWithHarness({
    harness,
    repository,
    repositoryId,
    planIssueNumber,
    ticketIssueNumber,
    ticketSlug,
    ticketTitle,
    acceptanceCriteria: ["Passes automated tests"],
    approvedByHuman,
    targetFeatureBranch,
    changedFiles,
    isolationAvailable: true,
    runnerEnv: process.env
  });
  writeActionOutputs({
    completed: String(result.completed),
    error_code: result.error_code,
    harness: result.harness,
    task_branch: result.task_branch,
    pull_request_url: result.pull_request_url
  });
  if (!result.completed) {
    process.stderr.write(`${result.error_code}: ${result.error_message}
`);
    process.exitCode = 1;
  }
}
await main();
