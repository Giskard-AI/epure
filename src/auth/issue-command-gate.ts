export type EpureCommandName =
  | "status"
  | "plan"
  | "to-spec"
  | "to-tickets"
  | "approve"
  | "sync"
  | "rebase"
  | "continue"
  | "cancel"
  | "reply";

export interface ParsedEpureCommand {
  readonly command: EpureCommandName;
  readonly args: string;
}

export type IssueCommandErrorCode =
  | "NONE"
  | "BOT_ACTOR_IGNORED"
  | "NO_COMMAND_FOUND"
  | "UNSUPPORTED_COMMAND"
  | "INVALID_REPOSITORY_SLUG"
  | "INSUFFICIENT_EFFECTIVE_PERMISSION"
  | "PERMISSION_CHECK_FAILED";

export type IssueCommandDecision =
  | "authorized"
  | "ignored_bot"
  | "ignored_no_command"
  | "denied_unsupported_command"
  | "denied_invalid_repository"
  | "denied_insufficient_permission";

export interface CollaboratorPermissionResponse {
  readonly permission?: string | undefined;
  readonly role_name?: string | undefined;
}

export interface IssueCommandActor {
  readonly login: string;
  readonly type?: string | undefined;
}

export interface IssueCommandGateInput {
  readonly repository: string;
  readonly issueNumber: number;
  readonly commentBody: string;
  readonly actor: IssueCommandActor;
  readonly authorAssociation?: string | undefined;
  readonly issueLabels?: readonly string[] | undefined;
  readonly knownBotActors?: readonly string[] | undefined;
  readonly effectivePermission?: CollaboratorPermissionResponse | null | undefined;
  readonly verifyPermission?:
    | ((
        repository: string,
        username: string
      ) => Promise<CollaboratorPermissionResponse>)
    | undefined;
  readonly secretsToRedact?: readonly string[] | undefined;
  readonly allowImplicitPlanningReply?: boolean | undefined;
}

export interface IssueCommandGateResult {
  readonly authorized: boolean;
  readonly decision: IssueCommandDecision;
  readonly error_code: IssueCommandErrorCode;
  readonly command: EpureCommandName | null;
  readonly command_args: string;
  readonly effective_permission: string;
  readonly privileged_action_allowed: boolean;
  readonly llm_call_allowed: boolean;
  readonly should_post_response: boolean;
  readonly error_message: string;
  readonly response_markdown: string;
}

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUPPORTED_COMMANDS = new Set<EpureCommandName>([
  "status",
  "plan",
  "to-spec",
  "to-tickets",
  "approve",
  "sync",
  "rebase",
  "continue",
  "cancel",
  "reply"
]);
const AUTHORIZED_PERMISSIONS = new Set(["write", "admin"]);
const AUTHORIZED_ROLES = new Set(["write", "maintain", "admin"]);

const DEFAULT_KNOWN_BOT_ACTORS = [
  "github-actions",
  "epure-agent",
  "epure-release",
  "renovate",
  "dependabot"
] as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,255}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bAuthorization:\s*(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,512}\b/gi
];

export function redactSecrets(
  text: string,
  extraSecrets: readonly string[] = []
): string {
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

function stripFencedCodeBlocks(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "");
}

function extractRawSlashEpureLine(
  commentBody: string
): { subcommand: string; args: string } | null {
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

export function parseEpureCommand(commentBody: string): ParsedEpureCommand | null {
  const extracted = extractRawSlashEpureLine(commentBody);
  if (!extracted) {
    return null;
  }
  if (!SUPPORTED_COMMANDS.has(extracted.subcommand as EpureCommandName)) {
    return null;
  }
  const normalizedCommand: EpureCommandName =
    extracted.subcommand === "rebase"
      ? "sync"
      : (extracted.subcommand as EpureCommandName);
  return {
    command: normalizedCommand,
    args: extracted.args
  };
}

export const parseSlashCommand = parseEpureCommand;

export function isBotActor(
  actor: IssueCommandActor,
  knownBotActors: readonly string[] = DEFAULT_KNOWN_BOT_ACTORS
): boolean {
  const loginLower = actor.login.trim().toLowerCase();
  const typeLower = (actor.type ?? "").trim().toLowerCase();

  if (typeLower === "bot" || loginLower.endsWith("[bot]")) {
    return true;
  }

  const normalizedBotSet = new Set(
    [...DEFAULT_KNOWN_BOT_ACTORS, ...knownBotActors].map((name) =>
      name.trim().toLowerCase().replace(/\[bot\]$/, "")
    )
  );

  return normalizedBotSet.has(loginLower);
}

export async function fetchEffectiveRepositoryPermission(params: {
  readonly repository: string;
  readonly username: string;
  readonly githubToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<CollaboratorPermissionResponse> {
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

  const data = (await response.json()) as CollaboratorPermissionResponse;
  return {
    permission: typeof data.permission === "string" ? data.permission : undefined,
    role_name: typeof data.role_name === "string" ? data.role_name : undefined
  };
}

function resolveEffectiveRoleLabel(perm: CollaboratorPermissionResponse): {
  isAuthorized: boolean;
  effectiveLabel: string;
} {
  const permission = (perm.permission ?? "").trim().toLowerCase();
  const roleName = (perm.role_name ?? "").trim().toLowerCase();

  const isAuthorized =
    AUTHORIZED_PERMISSIONS.has(permission) || AUTHORIZED_ROLES.has(roleName);

  const effectiveLabel = roleName || permission || "none";
  return { isAuthorized, effectiveLabel };
}

export async function evaluateIssueCommandGate(
  input: IssueCommandGateInput
): Promise<IssueCommandGateResult> {
  const secrets = input.secretsToRedact ?? [];
  const actorLogin = input.actor.login.trim();

  // 1. Ignore bot comments first to prevent infinite loops (ADR-0017 Q52)
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

  // 2. Parse slash command (or implicit reply when allowImplicitPlanningReply is enabled)
  const rawSlash = extractRawSlashEpureLine(input.commentBody);
  let parsedCommand: ParsedEpureCommand | null = null;

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
      `Unsupported EPURE command '/epure ${rawSlash?.subcommand ?? ""}'. Supported commands: status, plan, to-spec, to-tickets, approve, sync, rebase, continue, cancel.`,
      secrets
    );
    const md = redactSecrets(
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
      response_markdown: md
    };
  }

  // 3. Validate repository slug
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

  // 4. Verify effective permission via Collaborators Permission API (ADR-0004 Q44)
  // Never trust author_association or issueLabels!
  let permissionResponse: CollaboratorPermissionResponse;
  try {
    if (input.verifyPermission) {
      permissionResponse = await input.verifyPermission(repository, actorLogin);
    } else if (input.effectivePermission) {
      permissionResponse = input.effectivePermission;
    } else {
      permissionResponse = { permission: "none", role_name: "none" };
    }
  } catch (err: unknown) {
    const rawErr = err instanceof Error ? err.message : String(err);
    const safeErr = redactSecrets(
      `Failed to verify effective repository permission for '@${actorLogin}': ${rawErr}`,
      secrets
    );
    const md = redactSecrets(
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
      response_markdown: md
    };
  }

  const { isAuthorized, effectiveLabel } =
    resolveEffectiveRoleLabel(permissionResponse);

  if (!isAuthorized) {
    const errMsg = redactSecrets(
      `Actor '@${actorLogin}' has effective permission '${effectiveLabel}' on '${repository}'. Effective 'write' or 'admin' permission is required (author_association and issue labels are not trusted).`,
      secrets
    );
    const md = redactSecrets(
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
      response_markdown: md
    };
  }

  const safeArgs = redactSecrets(parsedCommand.args, secrets);
  const llmAllowed =
    parsedCommand.command === "plan" ||
    parsedCommand.command === "to-spec" ||
    parsedCommand.command === "to-tickets" ||
    parsedCommand.command === "approve" ||
    parsedCommand.command === "sync" ||
    parsedCommand.command === "rebase" ||
    parsedCommand.command === "continue" ||
    parsedCommand.command === "reply";
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
