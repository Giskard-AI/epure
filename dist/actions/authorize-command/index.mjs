// actions/authorize-command/index.ts
import { appendFileSync } from "node:fs";

// src/auth/issue-command-gate.ts
var REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var SUPPORTED_COMMANDS = /* @__PURE__ */ new Set([
  "status",
  "plan",
  "to-spec",
  "to-tickets",
  "approve",
  "cancel",
  "reply"
]);
var AUTHORIZED_PERMISSIONS = /* @__PURE__ */ new Set(["write", "admin"]);
var AUTHORIZED_ROLES = /* @__PURE__ */ new Set(["write", "maintain", "admin"]);
var DEFAULT_KNOWN_BOT_ACTORS = [
  "github-actions",
  "epure-agent",
  "epure-release",
  "renovate",
  "dependabot"
];
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
function stripFencedCodeBlocks(body) {
  return body.replace(/```[\s\S]*?```/g, "");
}
function extractRawSlashEpureLine(commentBody) {
  const cleaned = stripFencedCodeBlocks(commentBody);
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^\/epure(?:\s+([A-Za-z0-9_-]+))?(?:\s+(.*))?$/.exec(line);
    if (match) {
      return {
        subcommand: (match[1] ?? "").toLowerCase(),
        args: (match[2] ?? "").trim()
      };
    }
  }
  return null;
}
function parseEpureCommand(commentBody) {
  const extracted = extractRawSlashEpureLine(commentBody);
  if (!extracted) {
    return null;
  }
  if (!SUPPORTED_COMMANDS.has(extracted.subcommand)) {
    return null;
  }
  return {
    command: extracted.subcommand,
    args: extracted.args
  };
}
function isBotActor(actor, knownBotActors = DEFAULT_KNOWN_BOT_ACTORS) {
  const loginLower = actor.login.trim().toLowerCase();
  const typeLower = (actor.type ?? "").trim().toLowerCase();
  if (typeLower === "bot" || loginLower.endsWith("[bot]")) {
    return true;
  }
  const normalizedBotSet = new Set(
    [...DEFAULT_KNOWN_BOT_ACTORS, ...knownBotActors].map(
      (name) => name.trim().toLowerCase().replace(/\[bot\]$/, "")
    )
  );
  return normalizedBotSet.has(loginLower);
}
async function fetchEffectiveRepositoryPermission(params) {
  const repository = params.repository.trim();
  if (!REPO_SLUG_PATTERN.test(repository)) {
    throw new Error(`Invalid repository slug '${repository}'.`);
  }
  const [owner, repo] = repository.split("/");
  const baseUrl = (params.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const url = `${baseUrl}/repos/${owner}/${repo}/collaborators/${encodeURIComponent(params.username)}/permission`;
  const fetchFn = params.fetchImpl ?? fetch;
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) {
    throw new Error(
      `GitHub Collaborators Permission API returned HTTP ${response.status} for user '${params.username}'.`
    );
  }
  const data = await response.json();
  return {
    permission: typeof data.permission === "string" ? data.permission : void 0,
    role_name: typeof data.role_name === "string" ? data.role_name : void 0
  };
}
function resolveEffectiveRoleLabel(perm) {
  const permission = (perm.permission ?? "").trim().toLowerCase();
  const roleName = (perm.role_name ?? "").trim().toLowerCase();
  const isAuthorized = AUTHORIZED_PERMISSIONS.has(permission) || AUTHORIZED_ROLES.has(roleName);
  const effectiveLabel = roleName || permission || "none";
  return { isAuthorized, effectiveLabel };
}
async function evaluateIssueCommandGate(input) {
  const secrets = input.secretsToRedact ?? [];
  const actorLogin = input.actor.login.trim();
  if (isBotActor(input.actor, input.knownBotActors)) {
    const msg = redactSecrets(
      `Ignored comment from bot or automation actor '${actorLogin}' to prevent command loops.`,
      secrets
    );
    return {
      authorized: false,
      decision: "ignored_bot",
      error_code: "BOT_ACTOR_IGNORED",
      command: null,
      command_args: "",
      effective_permission: "bot_ignored",
      privileged_action_allowed: false,
      llm_call_allowed: false,
      should_post_response: false,
      error_message: msg,
      response_markdown: ""
    };
  }
  const rawSlash = extractRawSlashEpureLine(input.commentBody);
  let parsedCommand = null;
  if (!rawSlash) {
    if (input.allowImplicitPlanningReply && input.commentBody.trim().length > 0) {
      parsedCommand = {
        command: "reply",
        args: input.commentBody.trim()
      };
    } else {
      return {
        authorized: false,
        decision: "ignored_no_command",
        error_code: "NO_COMMAND_FOUND",
        command: null,
        command_args: "",
        effective_permission: "not_checked",
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: false,
        error_message: "",
        response_markdown: ""
      };
    }
  } else {
    parsedCommand = parseEpureCommand(input.commentBody);
  }
  if (!parsedCommand) {
    const errMsg = redactSecrets(
      `Unsupported EPURE command '/epure ${rawSlash?.subcommand ?? ""}'. Supported commands: status, plan, to-spec, to-tickets, approve, cancel.`,
      secrets
    );
    const md2 = redactSecrets(
      [
        "### EPURE Command Rejected (`UNSUPPORTED_COMMAND`)",
        `- **Actor**: \`@${actorLogin}\``,
        `- **Issue**: \`#${input.issueNumber}\``,
        `- **Reason**: ${errMsg}`
      ].join("\n"),
      secrets
    );
    return {
      authorized: false,
      decision: "denied_unsupported_command",
      error_code: "UNSUPPORTED_COMMAND",
      command: null,
      command_args: "",
      effective_permission: "not_checked",
      privileged_action_allowed: false,
      llm_call_allowed: false,
      should_post_response: true,
      error_message: errMsg,
      response_markdown: md2
    };
  }
  const repository = input.repository.trim();
  if (!REPO_SLUG_PATTERN.test(repository)) {
    const errMsg = redactSecrets(
      `Invalid repository slug '${repository}'; expected '<owner>/<repo>'.`,
      secrets
    );
    return {
      authorized: false,
      decision: "denied_invalid_repository",
      error_code: "INVALID_REPOSITORY_SLUG",
      command: parsedCommand.command,
      command_args: redactSecrets(parsedCommand.args, secrets),
      effective_permission: "none",
      privileged_action_allowed: false,
      llm_call_allowed: false,
      should_post_response: false,
      error_message: errMsg,
      response_markdown: ""
    };
  }
  let permissionResponse;
  try {
    if (input.verifyPermission) {
      permissionResponse = await input.verifyPermission(repository, actorLogin);
    } else if (input.effectivePermission) {
      permissionResponse = input.effectivePermission;
    } else {
      permissionResponse = { permission: "none", role_name: "none" };
    }
  } catch (err) {
    const rawErr = err instanceof Error ? err.message : String(err);
    const safeErr = redactSecrets(
      `Failed to verify effective repository permission for '@${actorLogin}': ${rawErr}`,
      secrets
    );
    const md2 = redactSecrets(
      [
        "### EPURE Command Refused (`PERMISSION_CHECK_FAILED`)",
        `- **Actor**: \`@${actorLogin}\``,
        `- **Command**: \`/epure ${parsedCommand.command}\``,
        `- **Reason**: ${safeErr}`
      ].join("\n"),
      secrets
    );
    return {
      authorized: false,
      decision: "denied_insufficient_permission",
      error_code: "PERMISSION_CHECK_FAILED",
      command: parsedCommand.command,
      command_args: redactSecrets(parsedCommand.args, secrets),
      effective_permission: "unknown",
      privileged_action_allowed: false,
      llm_call_allowed: false,
      should_post_response: true,
      error_message: safeErr,
      response_markdown: md2
    };
  }
  const { isAuthorized, effectiveLabel } = resolveEffectiveRoleLabel(permissionResponse);
  if (!isAuthorized) {
    const errMsg = redactSecrets(
      `Actor '@${actorLogin}' has effective permission '${effectiveLabel}' on '${repository}'. Effective 'write' or 'admin' permission is required (author_association and issue labels are not trusted).`,
      secrets
    );
    const md2 = redactSecrets(
      [
        "### EPURE Command Refused (`INSUFFICIENT_EFFECTIVE_PERMISSION`)",
        `- **Repository**: \`${repository}\``,
        `- **Issue**: \`#${input.issueNumber}\``,
        `- **Actor**: \`@${actorLogin}\``,
        `- **Command**: \`/epure ${parsedCommand.command}\``,
        `- **Effective Permission**: \`${effectiveLabel}\``,
        "- **Privileged Action**: `blocked`",
        "- **LLM Invocation**: `blocked`",
        `- **Detail**: ${errMsg}`
      ].join("\n"),
      secrets
    );
    return {
      authorized: false,
      decision: "denied_insufficient_permission",
      error_code: "INSUFFICIENT_EFFECTIVE_PERMISSION",
      command: parsedCommand.command,
      command_args: redactSecrets(parsedCommand.args, secrets),
      effective_permission: effectiveLabel,
      privileged_action_allowed: false,
      llm_call_allowed: false,
      should_post_response: true,
      error_message: errMsg,
      response_markdown: md2
    };
  }
  const safeArgs = redactSecrets(parsedCommand.args, secrets);
  const llmAllowed = parsedCommand.command === "plan" || parsedCommand.command === "to-spec" || parsedCommand.command === "to-tickets" || parsedCommand.command === "approve" || parsedCommand.command === "reply";
  const md = redactSecrets(
    [
      "### EPURE Command Authorized",
      `- **Repository**: \`${repository}\``,
      `- **Issue**: \`#${input.issueNumber}\``,
      `- **Actor**: \`@${actorLogin}\``,
      `- **Command**: \`/epure ${parsedCommand.command}\``,
      `- **Effective Permission**: \`${effectiveLabel}\``,
      `- **Privileged Action Allowed**: \`true\``,
      `- **LLM Call Allowed**: \`${String(llmAllowed)}\``
    ].join("\n"),
    secrets
  );
  return {
    authorized: true,
    decision: "authorized",
    error_code: "NONE",
    command: parsedCommand.command,
    command_args: safeArgs,
    effective_permission: effectiveLabel,
    privileged_action_allowed: true,
    llm_call_allowed: llmAllowed,
    should_post_response: true,
    error_message: "",
    response_markdown: md
  };
}

// actions/authorize-command/index.ts
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
  const issueNumberRaw = process.env.INPUT_ISSUE_NUMBER ?? "0";
  const issueNumber = Number.parseInt(issueNumberRaw, 10) || 0;
  const commentBody = process.env.INPUT_COMMENT_BODY ?? "";
  const actorLogin = process.env.INPUT_ACTOR ?? process.env.GITHUB_ACTOR ?? "";
  const actorType = process.env.INPUT_ACTOR_TYPE ?? "User";
  const authorAssociation = process.env.INPUT_AUTHOR_ASSOCIATION ?? "NONE";
  const issueLabelsRaw = process.env.INPUT_ISSUE_LABELS ?? "";
  const issueLabels = issueLabelsRaw.split(",").map((label) => label.trim()).filter(Boolean);
  const preFetchedPermission = (process.env.INPUT_EFFECTIVE_PERMISSION ?? "").trim();
  const githubToken = (process.env.INPUT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
  const allowImplicitPlanningReply = (process.env.INPUT_ALLOW_IMPLICIT_PLANNING_REPLY ?? "false").trim().toLowerCase() === "true";
  const secretsToRedact = [githubToken].filter((val) => val.length > 0);
  const result = await evaluateIssueCommandGate({
    repository,
    issueNumber,
    commentBody,
    actor: {
      login: actorLogin,
      type: actorType
    },
    authorAssociation,
    issueLabels,
    effectivePermission: preFetchedPermission ? { permission: preFetchedPermission, role_name: preFetchedPermission } : void 0,
    verifyPermission: !preFetchedPermission && githubToken ? (repo, username) => fetchEffectiveRepositoryPermission({
      repository: repo,
      username,
      githubToken
    }) : void 0,
    secretsToRedact,
    allowImplicitPlanningReply
  });
  writeGitHubOutputs({
    authorized: String(result.authorized),
    decision: result.decision,
    command: result.command ?? "",
    command_args: result.command_args,
    effective_permission: result.effective_permission,
    privileged_action_allowed: String(result.privileged_action_allowed),
    llm_call_allowed: String(result.llm_call_allowed),
    should_post_response: String(result.should_post_response),
    error_code: result.error_code,
    error_message: result.error_message,
    response_markdown: result.response_markdown
  });
  if (result.response_markdown) {
    writeStepSummary(redactSecrets(result.response_markdown, secretsToRedact));
  }
  if (result.decision === "denied_insufficient_permission" || result.decision === "denied_unsupported_command" || result.decision === "denied_invalid_repository") {
    process.stderr.write(
      `::error title=EPURE Command Denied (${result.error_code})::${result.error_message}
`
    );
    process.exitCode = 1;
  }
}
void run();
