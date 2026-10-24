// actions/verify-app-role/index.ts
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
var AGENT_ALLOWED_OPERATIONS = /* @__PURE__ */ new Set([
  "issue_comment",
  "push_branch",
  "create_pull_request",
  "create_check_run"
]);
var RELEASE_OPERATIONS = /* @__PURE__ */ new Set([
  "promote_dev_to_main",
  "create_release_tag",
  "publish_github_release"
]);
var AGENT_BRANCH_REF_PATTERN = /^(?:refs\/heads\/)?(?:plan|task|feature)\/[A-Za-z0-9._/-]+$/;
var RELEASE_TAG_REF_PATTERN = /^(?:refs\/tags\/)?v\d+\.\d+\.\d+$/;
var RELEASE_WORKFLOW_PATTERN = /(?:^|\/)release(?:-promote)?\.ya?ml$/;
function containsPrivateKeyMaterial(text) {
  return PRIVATE_KEY_DETECTION_PATTERN.test(text);
}
function verifyAppRoleBoundary(input) {
  const role = input.appRole.trim().toLowerCase();
  const operation = input.operation.trim().toLowerCase();
  const targetRef = (input.targetRef ?? "").trim();
  const workflowPath = (input.workflowPath ?? "").trim();
  const environmentName = (input.environmentName ?? "").trim();
  const agentAppId = (input.agentAppId ?? "").trim();
  const releaseAppId = (input.releaseAppId ?? "").trim();
  if (input.publicPayloadText && containsPrivateKeyMaterial(input.publicPayloadText)) {
    const msg = "Private key material detected in public payload (issue, comment, or prompt). Private keys must remain strictly in encrypted GitHub Secrets.";
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD\`)
- ${msg}`
    };
  }
  if (agentAppId && releaseAppId && agentAppId === releaseAppId) {
    const msg = `Agent App ID ('${agentAppId}') and Release App ID ('${releaseAppId}') must be two distinct GitHub Apps (ADR-0009, ADR-0010).`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "IDENTICAL_APP_IDENTITY_FORBIDDEN",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`IDENTICAL_APP_IDENTITY_FORBIDDEN\`)
- ${msg}`
    };
  }
  if (role !== "agent" && role !== "release") {
    const msg = `Unknown EPURE App role '${role}'; expected 'agent' or 'release'.`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "INVALID_APP_ROLE",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`INVALID_APP_ROLE\`)
- ${msg}`
    };
  }
  if (operation === "grant_elevated_permission") {
    if (input.humanConfirmed !== true) {
      const msg = "Granting or modifying elevated repository/App permissions requires explicit human confirmation ('human_confirmed: true').";
      return {
        allowed: false,
        app_role: role,
        operation,
        error_code: "HUMAN_CONFIRMATION_REQUIRED",
        error_message: msg,
        summary_markdown: `### EPURE App Role Check Failed (\`HUMAN_CONFIRMATION_REQUIRED\`)
- ${msg}`
      };
    }
    return {
      allowed: true,
      app_role: role,
      operation,
      error_code: "NONE",
      error_message: "",
      summary_markdown: `### EPURE App Role Check Passed
- **Role**: \`${role}\`
- **Operation**: \`${operation}\` (Human confirmed)`
    };
  }
  if (role === "agent") {
    if (RELEASE_OPERATIONS.has(operation)) {
      const msg = `Agent App is strictly forbidden from executing release operation '${operation}' (dev->main promotion, release tags, and GitHub Releases require Release App).`;
      return {
        allowed: false,
        app_role: role,
        operation,
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN",
        error_message: msg,
        summary_markdown: `### EPURE App Role Check Failed (\`AGENT_APP_RELEASE_OPERATION_FORBIDDEN\`)
- ${msg}`
      };
    }
    if (!AGENT_ALLOWED_OPERATIONS.has(operation)) {
      const msg = `Operation '${operation}' is not permitted for Agent App.`;
      return {
        allowed: false,
        app_role: role,
        operation,
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN",
        error_message: msg,
        summary_markdown: `### EPURE App Role Check Failed (\`AGENT_APP_RELEASE_OPERATION_FORBIDDEN\`)
- ${msg}`
      };
    }
    if (operation === "push_branch") {
      if (!targetRef || !AGENT_BRANCH_REF_PATTERN.test(targetRef)) {
        const msg = `Agent App cannot push to '${targetRef || "<empty>"}'; only 'plan/*', 'task/*', and 'feature/*' branches are permitted.`;
        return {
          allowed: false,
          app_role: role,
          operation,
          error_code: "AGENT_APP_PROTECTED_REF_FORBIDDEN",
          error_message: msg,
          summary_markdown: `### EPURE App Role Check Failed (\`AGENT_APP_PROTECTED_REF_FORBIDDEN\`)
- ${msg}`
        };
      }
    }
    return {
      allowed: true,
      app_role: role,
      operation,
      error_code: "NONE",
      error_message: "",
      summary_markdown: `### EPURE App Role Check Passed
- **Role**: \`agent\`
- **Operation**: \`${operation}\``
    };
  }
  const isProtectedReleaseWorkflow = RELEASE_WORKFLOW_PATTERN.test(workflowPath) && environmentName === "release";
  if (!isProtectedReleaseWorkflow) {
    const msg = `Release App is restricted exclusively to '.github/workflows/release.yml' within the protected 'release' environment (got workflow='${workflowPath || "<none>"}', environment='${environmentName || "<none>"}').`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN\`)
- ${msg}`
    };
  }
  if (!RELEASE_OPERATIONS.has(operation)) {
    const msg = `Release App cannot execute ordinary agent operation '${operation}'; it is restricted to release promotion, tagging, and publication.`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "RELEASE_APP_NON_RELEASE_OPERATION_FORBIDDEN",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`RELEASE_APP_NON_RELEASE_OPERATION_FORBIDDEN\`)
- ${msg}`
    };
  }
  if (operation === "create_release_tag" && (!targetRef || !RELEASE_TAG_REF_PATTERN.test(targetRef))) {
    const msg = `Release App tag operation requires an immutable SemVer tag 'refs/tags/vMAJOR.MINOR.PATCH' (got '${targetRef || "<empty>"}').`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "INVALID_TARGET_REF",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`INVALID_TARGET_REF\`)
- ${msg}`
    };
  }
  return {
    allowed: true,
    app_role: role,
    operation,
    error_code: "NONE",
    error_message: "",
    summary_markdown: `### EPURE App Role Check Passed
- **Role**: \`release\`
- **Operation**: \`${operation}\`
- **Environment**: \`${environmentName}\``
  };
}

// actions/verify-app-role/index.ts
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
function run() {
  const appRole = process.env.INPUT_APP_ROLE ?? "";
  const operation = process.env.INPUT_OPERATION ?? "";
  const targetRef = process.env.INPUT_TARGET_REF ?? "";
  const workflowPath = process.env.INPUT_WORKFLOW_PATH ?? process.env.GITHUB_WORKFLOW_REF ?? "";
  const environmentName = process.env.INPUT_ENVIRONMENT_NAME ?? "";
  const agentAppId = process.env.INPUT_AGENT_APP_ID ?? "";
  const releaseAppId = process.env.INPUT_RELEASE_APP_ID ?? "";
  const humanConfirmed = (process.env.INPUT_HUMAN_CONFIRMED ?? "false").trim().toLowerCase() === "true";
  const publicPayloadText = process.env.INPUT_PUBLIC_PAYLOAD_TEXT ?? "";
  const result = verifyAppRoleBoundary({
    appRole,
    operation,
    targetRef,
    workflowPath,
    environmentName,
    agentAppId,
    releaseAppId,
    humanConfirmed,
    publicPayloadText
  });
  writeGitHubOutputs({
    allowed: String(result.allowed),
    app_role: result.app_role,
    operation: result.operation,
    error_code: result.error_code,
    error_message: redactSecrets(result.error_message)
  });
  writeStepSummary(redactSecrets(result.summary_markdown));
  if (!result.allowed) {
    process.stderr.write(
      `::error title=EPURE App Role Violation (${result.error_code})::${redactSecrets(result.error_message)}
`
    );
    process.exitCode = 1;
  }
}
run();
