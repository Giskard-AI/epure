import { redactSecrets } from "./issue-command-gate.js";

export type EpureAppRole = "agent" | "release";

export type EpureAppOperation =
  | "issue_comment"
  | "push_branch"
  | "create_pull_request"
  | "create_check_run"
  | "promote_dev_to_main"
  | "create_release_tag"
  | "publish_github_release"
  | "grant_elevated_permission";

export type AppRoleVerificationErrorCode =
  | "NONE"
  | "PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD"
  | "IDENTICAL_APP_IDENTITY_FORBIDDEN"
  | "AGENT_APP_RELEASE_OPERATION_FORBIDDEN"
  | "AGENT_APP_PROTECTED_REF_FORBIDDEN"
  | "RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN"
  | "RELEASE_APP_NON_RELEASE_OPERATION_FORBIDDEN"
  | "HUMAN_CONFIRMATION_REQUIRED"
  | "INVALID_APP_ROLE"
  | "INVALID_TARGET_REF";

export interface GitHubAppSecretNames {
  readonly appId: string;
  readonly privateKey: string;
}

export interface GitHubAppManifestSpec {
  readonly role: EpureAppRole;
  readonly name: string;
  readonly description: string;
  readonly public: boolean;
  readonly default_permissions: Readonly<Record<string, "read" | "write">>;
  readonly default_events: readonly string[];
  readonly secretNames: GitHubAppSecretNames;
  readonly allowedOperations: readonly EpureAppOperation[];
  readonly forbiddenOperations: readonly EpureAppOperation[];
  readonly allowedRefPatterns: readonly string[];
  readonly requiredWorkflow?: string | undefined;
  readonly requiredEnvironment?: string | undefined;
}

export interface ConsumerAppManifestPair {
  readonly agentApp: GitHubAppManifestSpec;
  readonly releaseApp: GitHubAppManifestSpec;
}

export interface AppSetupGuideResult {
  readonly status: "ready" | "awaiting_human_confirmation" | "error";
  readonly error_code: AppRoleVerificationErrorCode;
  readonly human_confirmed: boolean;
  readonly manifests: ConsumerAppManifestPair;
  readonly guide_markdown: string;
}

export interface AppRoleBoundaryInput {
  readonly appRole: string;
  readonly operation: string;
  readonly targetRef?: string | undefined;
  readonly workflowPath?: string | undefined;
  readonly environmentName?: string | undefined;
  readonly agentAppId?: string | undefined;
  readonly releaseAppId?: string | undefined;
  readonly humanConfirmed?: boolean | undefined;
  readonly publicPayloadText?: string | undefined;
}

export interface AppRoleBoundaryResult {
  readonly allowed: boolean;
  readonly app_role: string;
  readonly operation: string;
  readonly error_code: AppRoleVerificationErrorCode;
  readonly error_message: string;
  readonly summary_markdown: string;
}

const PRIVATE_KEY_DETECTION_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|EPURE_(?:AGENT|RELEASE)_APP_PRIVATE_KEY\s*=\s*\S+/i;

const AGENT_ALLOWED_OPERATIONS = new Set<EpureAppOperation>([
  "issue_comment",
  "push_branch",
  "create_pull_request",
  "create_check_run"
]);

const RELEASE_OPERATIONS = new Set<EpureAppOperation>([
  "promote_dev_to_main",
  "create_release_tag",
  "publish_github_release"
]);

const AGENT_BRANCH_REF_PATTERN =
  /^(?:refs\/heads\/)?(?:plan|task|feature)\/[A-Za-z0-9._/-]+$/;
const RELEASE_TAG_REF_PATTERN = /^(?:refs\/tags\/)?v\d+\.\d+\.\d+$/;
const RELEASE_WORKFLOW_PATTERN = /(?:^|\/)release\.ya?ml$/;

export function containsPrivateKeyMaterial(text: string): boolean {
  return PRIVATE_KEY_DETECTION_PATTERN.test(text);
}

export function buildConsumerAppManifests(params: {
  readonly ownerSlug: string;
  readonly repository?: string | undefined;
}): ConsumerAppManifestPair {
  const cleanOwner = params.ownerSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");

  const agentApp: GitHubAppManifestSpec = {
    role: "agent",
    name: `${cleanOwner}-epure-agent`,
    description:
      "EPURE Consumer Agent App — scoped to issue comments, plan/task/feature branches, PRs, and checks. Forbidden from release promotion.",
    public: false,
    default_permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "write",
      metadata: "read"
    },
    default_events: ["issue_comment", "issues", "pull_request", "check_run"],
    secretNames: {
      appId: "EPURE_AGENT_APP_ID",
      privateKey: "EPURE_AGENT_APP_PRIVATE_KEY"
    },
    allowedOperations: [
      "issue_comment",
      "push_branch",
      "create_pull_request",
      "create_check_run"
    ],
    forbiddenOperations: [
      "promote_dev_to_main",
      "create_release_tag",
      "publish_github_release"
    ],
    allowedRefPatterns: [
      "refs/heads/plan/*",
      "refs/heads/task/*",
      "refs/heads/feature/*"
    ]
  };

  const releaseApp: GitHubAppManifestSpec = {
    role: "release",
    name: `${cleanOwner}-epure-release`,
    description:
      "EPURE Consumer Release App — strictly isolated to the protected release workflow and 'release' environment for dev->main promotion, vX.Y.Z tags, and GitHub Releases.",
    public: false,
    default_permissions: {
      contents: "write",
      metadata: "read"
    },
    default_events: [],
    secretNames: {
      appId: "EPURE_RELEASE_APP_ID",
      privateKey: "EPURE_RELEASE_APP_PRIVATE_KEY"
    },
    allowedOperations: [
      "promote_dev_to_main",
      "create_release_tag",
      "publish_github_release"
    ],
    forbiddenOperations: [
      "issue_comment",
      "create_pull_request",
      "create_check_run"
    ],
    allowedRefPatterns: ["refs/heads/main", "refs/tags/v*"],
    requiredWorkflow: ".github/workflows/release.yml",
    requiredEnvironment: "release"
  };

  return { agentApp, releaseApp };
}

export function generateAppSetupGuide(params: {
  readonly ownerSlug: string;
  readonly repository: string;
  readonly humanConfirmed: boolean;
  readonly extraTextToScan?: string | undefined;
}): AppSetupGuideResult {
  const manifests = buildConsumerAppManifests({
    ownerSlug: params.ownerSlug,
    repository: params.repository
  });

  if (params.extraTextToScan && containsPrivateKeyMaterial(params.extraTextToScan)) {
    const scrubbedNote = redactSecrets(params.extraTextToScan);
    return {
      status: "error",
      error_code: "PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD",
      human_confirmed: params.humanConfirmed,
      manifests,
      guide_markdown: [
        "### EPURE GitHub App Setup Blocked (`PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD`)",
        "Private keys must never be pasted into issues, comments, or LLM prompts.",
        `Scrubbed payload: \`${scrubbedNote}\``
      ].join("\n")
    };
  }

  if (!params.humanConfirmed) {
    return {
      status: "awaiting_human_confirmation",
      error_code: "HUMAN_CONFIRMATION_REQUIRED",
      human_confirmed: false,
      manifests,
      guide_markdown: [
        "### EPURE Dual GitHub App Setup — Human Confirmation Required",
        `- **Target Repository**: \`${params.repository}\``,
        `- **Agent App**: \`${manifests.agentApp.name}\` (\`EPURE_AGENT_APP_ID\`, \`EPURE_AGENT_APP_PRIVATE_KEY\`)`,
        `- **Release App**: \`${manifests.releaseApp.name}\` (\`EPURE_RELEASE_APP_ID\`, \`EPURE_RELEASE_APP_PRIVATE_KEY\` in environment \`release\`)`,
        "- **Action Required**: Explicit human confirmation (`human_confirmed: true`) is required before granting or provisioning elevated repository/App permissions.",
        "- **Security Rule**: Never paste private keys into issues, PRs, or prompts; inject them locally via `gh secret set <NAME> < private-key.pem`."
      ].join("\n")
    };
  }

  return {
    status: "ready",
    error_code: "NONE",
    human_confirmed: true,
    manifests,
    guide_markdown: [
      "### EPURE Dual GitHub App Provisioning Guide (Confirmed)",
      `- **Repository**: \`${params.repository}\``,
      `1. **Create & Install Agent App (\`${manifests.agentApp.name}\`)**:`,
      "   - Permissions: `contents: write`, `issues: write`, `pull_requests: write`, `checks: write`, `metadata: read`.",
      "   - Store secrets locally without echoing private keys: `gh secret set EPURE_AGENT_APP_ID --repo " +
        params.repository +
        "` and `gh secret set EPURE_AGENT_APP_PRIVATE_KEY --repo " +
        params.repository +
        " < agent-app.pem`.",
      `2. **Create & Install Release App (\`${manifests.releaseApp.name}\`)**:`,
      "   - Permissions: `contents: write`, `metadata: read`.",
      "   - Bind secrets strictly to the protected `release` environment: `gh secret set EPURE_RELEASE_APP_ID --env release --repo " +
        params.repository +
        "` and `gh secret set EPURE_RELEASE_APP_PRIVATE_KEY --env release --repo " +
        params.repository +
        " < release-app.pem`."
    ].join("\n")
  };
}

export function verifyAppRoleBoundary(
  input: AppRoleBoundaryInput
): AppRoleBoundaryResult {
  const role = input.appRole.trim().toLowerCase();
  const operation = input.operation.trim().toLowerCase();
  const targetRef = (input.targetRef ?? "").trim();
  const workflowPath = (input.workflowPath ?? "").trim();
  const environmentName = (input.environmentName ?? "").trim();
  const agentAppId = (input.agentAppId ?? "").trim();
  const releaseAppId = (input.releaseAppId ?? "").trim();

  // 1. Reject any private key material in public payloads
  if (
    input.publicPayloadText &&
    containsPrivateKeyMaterial(input.publicPayloadText)
  ) {
    const msg =
      "Private key material detected in public payload (issue, comment, or prompt). Private keys must remain strictly in encrypted GitHub Secrets.";
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD\`)\n- ${msg}`
    };
  }

  // 2. Ensure Agent App and Release App do not share the same App ID
  if (agentAppId && releaseAppId && agentAppId === releaseAppId) {
    const msg = `Agent App ID ('${agentAppId}') and Release App ID ('${releaseAppId}') must be two distinct GitHub Apps (ADR-0009, ADR-0010).`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "IDENTICAL_APP_IDENTITY_FORBIDDEN",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`IDENTICAL_APP_IDENTITY_FORBIDDEN\`)\n- ${msg}`
    };
  }

  // 3. Validate role name
  if (role !== "agent" && role !== "release") {
    const msg = `Unknown EPURE App role '${role}'; expected 'agent' or 'release'.`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "INVALID_APP_ROLE",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`INVALID_APP_ROLE\`)\n- ${msg}`
    };
  }

  // 4. Require explicit human confirmation for any elevated permission grant
  if (operation === "grant_elevated_permission") {
    if (input.humanConfirmed !== true) {
      const msg =
        "Granting or modifying elevated repository/App permissions requires explicit human confirmation ('human_confirmed: true').";
      return {
        allowed: false,
        app_role: role,
        operation,
        error_code: "HUMAN_CONFIRMATION_REQUIRED",
        error_message: msg,
        summary_markdown: `### EPURE App Role Check Failed (\`HUMAN_CONFIRMATION_REQUIRED\`)\n- ${msg}`
      };
    }

    return {
      allowed: true,
      app_role: role,
      operation,
      error_code: "NONE",
      error_message: "",
      summary_markdown: `### EPURE App Role Check Passed\n- **Role**: \`${role}\`\n- **Operation**: \`${operation}\` (Human confirmed)`
    };
  }

  // 5. Enforce Agent App boundaries
  if (role === "agent") {
    if (RELEASE_OPERATIONS.has(operation as EpureAppOperation)) {
      const msg = `Agent App is strictly forbidden from executing release operation '${operation}' (dev->main promotion, release tags, and GitHub Releases require Release App).`;
      return {
        allowed: false,
        app_role: role,
        operation,
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN",
        error_message: msg,
        summary_markdown: `### EPURE App Role Check Failed (\`AGENT_APP_RELEASE_OPERATION_FORBIDDEN\`)\n- ${msg}`
      };
    }

    if (!AGENT_ALLOWED_OPERATIONS.has(operation as EpureAppOperation)) {
      const msg = `Operation '${operation}' is not permitted for Agent App.`;
      return {
        allowed: false,
        app_role: role,
        operation,
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN",
        error_message: msg,
        summary_markdown: `### EPURE App Role Check Failed (\`AGENT_APP_RELEASE_OPERATION_FORBIDDEN\`)\n- ${msg}`
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
          summary_markdown: `### EPURE App Role Check Failed (\`AGENT_APP_PROTECTED_REF_FORBIDDEN\`)\n- ${msg}`
        };
      }
    }

    return {
      allowed: true,
      app_role: role,
      operation,
      error_code: "NONE",
      error_message: "",
      summary_markdown: `### EPURE App Role Check Passed\n- **Role**: \`agent\`\n- **Operation**: \`${operation}\``
    };
  }

  // 6. Enforce Release App boundaries
  const isProtectedReleaseWorkflow =
    RELEASE_WORKFLOW_PATTERN.test(workflowPath) &&
    environmentName === "release";

  if (!isProtectedReleaseWorkflow) {
    const msg = `Release App is restricted exclusively to '.github/workflows/release.yml' within the protected 'release' environment (got workflow='${workflowPath || "<none>"}', environment='${environmentName || "<none>"}').`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN\`)\n- ${msg}`
    };
  }

  if (!RELEASE_OPERATIONS.has(operation as EpureAppOperation)) {
    const msg = `Release App cannot execute ordinary agent operation '${operation}'; it is restricted to release promotion, tagging, and publication.`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "RELEASE_APP_NON_RELEASE_OPERATION_FORBIDDEN",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`RELEASE_APP_NON_RELEASE_OPERATION_FORBIDDEN\`)\n- ${msg}`
    };
  }

  if (
    operation === "create_release_tag" &&
    (!targetRef || !RELEASE_TAG_REF_PATTERN.test(targetRef))
  ) {
    const msg = `Release App tag operation requires an immutable SemVer tag 'refs/tags/vMAJOR.MINOR.PATCH' (got '${targetRef || "<empty>"}').`;
    return {
      allowed: false,
      app_role: role,
      operation,
      error_code: "INVALID_TARGET_REF",
      error_message: msg,
      summary_markdown: `### EPURE App Role Check Failed (\`INVALID_TARGET_REF\`)\n- ${msg}`
    };
  }

  return {
    allowed: true,
    app_role: role,
    operation,
    error_code: "NONE",
    error_message: "",
    summary_markdown: `### EPURE App Role Check Passed\n- **Role**: \`release\`\n- **Operation**: \`${operation}\`\n- **Environment**: \`${environmentName}\``
  };
}
