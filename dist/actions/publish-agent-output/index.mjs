// actions/publish-agent-output/index.ts
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

// actions/publish-agent-output/index.ts
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
  const repository = process.env.INPUT_REPOSITORY ?? "";
  const repositoryId = Number.parseInt(
    process.env.INPUT_REPOSITORY_ID ?? "0",
    10
  );
  const assignedIssueNumber = Number.parseInt(
    process.env.INPUT_ASSIGNED_ISSUE_NUMBER ?? "0",
    10
  );
  const assignedBranchPrefix = process.env.INPUT_ASSIGNED_BRANCH_PREFIX ?? "";
  const allowedTargetFeatureBranch = process.env.INPUT_ALLOWED_TARGET_FEATURE_BRANCH ?? "";
  const rawProposal = process.env.INPUT_PROPOSAL_JSON ?? "";
  const allowWorkflowOrConfigEdits = (process.env.INPUT_ALLOW_WORKFLOW_OR_CONFIG_EDITS ?? "false").trim().toLowerCase() === "true";
  let agentEnvSnapshot = {};
  try {
    const rawEnv = process.env.INPUT_AGENT_ENV_JSON ?? "{}";
    const parsedEnv = JSON.parse(rawEnv);
    if (typeof parsedEnv === "object" && parsedEnv !== null) {
      agentEnvSnapshot = parsedEnv;
    }
  } catch {
  }
  const result = await publishAgentProposal({
    rawProposal,
    scope: {
      repository,
      repositoryId,
      assignedIssueNumber,
      assignedBranchPrefix,
      allowedTargetFeatureBranch,
      allowWorkflowOrConfigEdits
    },
    agentEnvSnapshot
  });
  writeGitHubOutputs({
    published: String(result.published),
    operation: result.operation,
    artifact_url: result.artifact_url,
    token_revoked: String(result.token_revoked),
    error_code: result.error_code,
    error_message: redactSecrets(result.error_message)
  });
  writeStepSummary(redactSecrets(result.summary_markdown));
  if (!result.published) {
    process.stderr.write(
      `::error title=EPURE Isolated Publisher Rejected (${result.error_code})::${redactSecrets(result.error_message)}
`
    );
    process.exitCode = 1;
  }
}
void run();
