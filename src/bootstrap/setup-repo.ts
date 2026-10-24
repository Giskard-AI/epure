import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildConsumerAppManifests } from "../auth/github-apps.js";
import { EPURE_PUBLIC_VERSION } from "../contract/epure-contract.js";

export const DEFAULT_EPURE_PINNED_SHA =
  "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export { EPURE_PUBLIC_VERSION };

export type AgentHarness = "pi" | "codex";
export type StaleBaseMergePolicy = "strict" | "relaxed";

export type SetupRepoErrorCode =
  | "NONE"
  | "INVALID_REPOSITORY_SLUG"
  | "SECURITY_INVARIANT_VIOLATION"
  | "PAGES_PREVIEW_CONSENT_OR_ORIGIN_REQUIRED"
  | "CROSS_REPO_TOKEN_SCOPE_FORBIDDEN";

export type AutoMergeWarningCode =
  | "NONE"
  | "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS";

export type ResourcePlanAction = "create" | "update" | "noop";

export interface AgentsModelsConfig {
  readonly planning: string;
  readonly implementation: string;
  readonly review: string;
}

export interface AgentsConfig {
  readonly harness: AgentHarness;
  readonly models: AgentsModelsConfig;
  readonly merge_policy: StaleBaseMergePolicy;
  readonly max_code_fix_attempts: number;
  readonly max_transient_api_retries: number;
  readonly transient_retry_backoff_seconds: readonly [number, number, number, number];
  readonly job_timeout_minutes: number;
  readonly review_timeout_minutes: number;
  readonly max_concurrent_tasks_per_feature: number;
  readonly trace_retention_days: number;
  readonly preview_retention_days: number;
  readonly github_pages_previews: boolean;
}

export interface SecurityOverridesAttempt {
  readonly require_write_permission?: boolean | undefined;
  readonly sandbox_isolation?: boolean | undefined;
  readonly allow_agent_release?: boolean | undefined;
  readonly auto_merge_dev?: boolean | undefined;
  readonly auto_merge_main?: boolean | undefined;
}

export interface AgentsConfigOverrides {
  readonly harness?: AgentHarness | undefined;
  readonly models?: Partial<AgentsModelsConfig> | undefined;
  readonly merge_policy?: StaleBaseMergePolicy | undefined;
  readonly max_code_fix_attempts?: number | undefined;
  readonly max_transient_api_retries?: number | undefined;
  readonly job_timeout_minutes?: number | undefined;
  readonly review_timeout_minutes?: number | undefined;
  readonly max_concurrent_tasks_per_feature?: number | undefined;
  readonly trace_retention_days?: number | undefined;
  readonly preview_retention_days?: number | undefined;
  readonly github_pages_previews?: boolean | undefined;
  readonly github_pages_human_consent?: boolean | undefined;
  readonly preview_separate_origin?: boolean | undefined;
  readonly security_overrides?: SecurityOverridesAttempt | undefined;
}

export interface ResolvedAgentsConfigResult {
  readonly valid: boolean;
  readonly error_code: SetupRepoErrorCode;
  readonly error_message: string;
  readonly config: AgentsConfig;
}

export interface ExpectedSecretSpec {
  readonly name: string;
  readonly scope: "repository_or_org" | "release_environment";
  readonly description: string;
}

export interface PlannedWorkflowFile {
  readonly path: string;
  readonly action: ResourcePlanAction;
  readonly content: string;
}

export interface BranchProtectionSpec {
  readonly pattern: string;
  readonly requirePullRequest: boolean;
  readonly requireStatusChecks: boolean;
  readonly requiredChecks: readonly string[];
  readonly requireHumanApproval: boolean;
  readonly allowedMergeMethods: readonly ("squash" | "rebase")[];
  readonly allowMergeCommit: false;
}

export interface RulesetBypassActorSpec {
  readonly appRole: "release";
  readonly appName: string;
  readonly mode: "always";
}

export interface RepositoryRulesetSpec {
  readonly name: string;
  readonly enforcement: "active";
  readonly targetRefs: readonly string[];
  readonly blockDirectPushes: boolean;
  readonly blockForcePushes: boolean;
  readonly blockDeletions: boolean;
  readonly bypassActors: readonly RulesetBypassActorSpec[];
}

export interface ReleaseEnvironmentSpec {
  readonly name: "release";
  readonly requiredReviewers: boolean;
  readonly boundSecrets: readonly string[];
}

export interface HumanInterventionStep {
  readonly id:
    | "provision_dual_github_apps"
    | "configure_repository_or_org_secrets"
    | "apply_branch_protections_and_release_ruleset";
  readonly title: string;
  readonly details: string;
}

export interface ExistingRepositoryState {
  readonly hasRequiredCiChecks?: boolean | undefined;
  readonly hasBranchProtection?: boolean | undefined;
  readonly existingAppNames?: readonly string[] | undefined;
  readonly existingRulesetNames?: readonly string[] | undefined;
}

export interface SetupRepoInput {
  readonly repository: string;
  readonly repoRootDir?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly epurePinnedSha?: string | undefined;
  readonly agentsOverrides?: AgentsConfigOverrides | undefined;
  readonly existingState?: ExistingRepositoryState | undefined;
}

export interface SetupRepoResult {
  readonly status: "dry_run" | "applied" | "error";
  readonly dry_run: boolean;
  readonly error_code: SetupRepoErrorCode;
  readonly error_message: string;
  readonly repository: string;
  readonly agents_config: AgentsConfig;
  readonly agents_config_action: ResourcePlanAction;
  readonly planned_workflows: readonly PlannedWorkflowFile[];
  readonly expected_secrets: readonly ExpectedSecretSpec[];
  readonly branch_protections: readonly BranchProtectionSpec[];
  readonly ruleset_spec: RepositoryRulesetSpec;
  readonly ruleset_action: ResourcePlanAction;
  readonly apps_action: ResourcePlanAction;
  readonly release_environment: ReleaseEnvironmentSpec;
  readonly task_auto_merge_enabled: boolean;
  readonly auto_merge_warning_code: AutoMergeWarningCode;
  readonly human_interventions: readonly HumanInterventionStep[];
  readonly mutated_files: readonly string[];
  readonly summary_markdown: string;
}

export interface OrgSecretSharingInput {
  readonly organization: string;
  readonly targetRepository: string;
  readonly sharedOrgSecrets: readonly string[];
  readonly sharedOrgVariables: readonly string[];
  readonly installationRepositorySelection: "selected" | "all";
  readonly tokenScopedRepositories: readonly string[];
}

export interface OrgSecretSharingValidationResult {
  readonly allowed: boolean;
  readonly error_code: SetupRepoErrorCode;
  readonly error_message: string;
  readonly effective_token_repositories: readonly string[];
}

export const DEFAULT_AGENTS_CONFIG: AgentsConfig = {
  harness: "pi",
  models: {
    planning: "claude-sonnet-4-20250514",
    implementation: "claude-sonnet-4-20250514",
    review: "gpt-4.1"
  },
  merge_policy: "strict",
  max_code_fix_attempts: 3,
  max_transient_api_retries: 4,
  transient_retry_backoff_seconds: [5, 15, 45, 120],
  job_timeout_minutes: 60,
  review_timeout_minutes: 30,
  max_concurrent_tasks_per_feature: 3,
  trace_retention_days: 30,
  preview_retention_days: 14,
  github_pages_previews: false
};

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function resolveAgentsConfig(
  overrides: AgentsConfigOverrides = {}
): ResolvedAgentsConfigResult {
  const sec = overrides.security_overrides;
  if (sec) {
    if (sec.require_write_permission === false) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message:
          "Local .github/agents.yml cannot disable effective write permission verification (ADR-0004, ADR-0010).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
    if (sec.sandbox_isolation === false) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message:
          "Local .github/agents.yml cannot disable untrusted code sandbox isolation (ADR-0011, ADR-0023).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
    if (sec.allow_agent_release === true) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message:
          "Local .github/agents.yml cannot grant release authority to the Agent App (ADR-0009, ADR-0010).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
    if (sec.auto_merge_dev === true || sec.auto_merge_main === true) {
      return {
        valid: false,
        error_code: "SECURITY_INVARIANT_VIOLATION",
        error_message:
          "Local .github/agents.yml cannot enable automatic merging into 'dev' or 'main' (ADR-0011).",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
  }

  const pagesPreviews =
    overrides.github_pages_previews ?? DEFAULT_AGENTS_CONFIG.github_pages_previews;
  if (pagesPreviews) {
    if (
      overrides.github_pages_human_consent !== true ||
      overrides.preview_separate_origin !== true
    ) {
      return {
        valid: false,
        error_code: "PAGES_PREVIEW_CONSENT_OR_ORIGIN_REQUIRED",
        error_message:
          "GitHub Pages previews require explicit human consent (github_pages_human_consent: true) and an isolated non-production origin (preview_separate_origin: true) per Q70/Q73.",
        config: DEFAULT_AGENTS_CONFIG
      };
    }
  }

  const config: AgentsConfig = {
    harness: overrides.harness ?? DEFAULT_AGENTS_CONFIG.harness,
    models: {
      planning:
        overrides.models?.planning ?? DEFAULT_AGENTS_CONFIG.models.planning,
      implementation:
        overrides.models?.implementation ??
        DEFAULT_AGENTS_CONFIG.models.implementation,
      review: overrides.models?.review ?? DEFAULT_AGENTS_CONFIG.models.review
    },
    merge_policy: overrides.merge_policy ?? DEFAULT_AGENTS_CONFIG.merge_policy,
    max_code_fix_attempts:
      overrides.max_code_fix_attempts ??
      DEFAULT_AGENTS_CONFIG.max_code_fix_attempts,
    max_transient_api_retries:
      overrides.max_transient_api_retries ??
      DEFAULT_AGENTS_CONFIG.max_transient_api_retries,
    transient_retry_backoff_seconds:
      DEFAULT_AGENTS_CONFIG.transient_retry_backoff_seconds,
    job_timeout_minutes:
      overrides.job_timeout_minutes ??
      DEFAULT_AGENTS_CONFIG.job_timeout_minutes,
    review_timeout_minutes:
      overrides.review_timeout_minutes ??
      DEFAULT_AGENTS_CONFIG.review_timeout_minutes,
    max_concurrent_tasks_per_feature:
      overrides.max_concurrent_tasks_per_feature ??
      DEFAULT_AGENTS_CONFIG.max_concurrent_tasks_per_feature,
    trace_retention_days:
      overrides.trace_retention_days ??
      DEFAULT_AGENTS_CONFIG.trace_retention_days,
    preview_retention_days:
      overrides.preview_retention_days ??
      DEFAULT_AGENTS_CONFIG.preview_retention_days,
    github_pages_previews: pagesPreviews
  };

  return {
    valid: true,
    error_code: "NONE",
    error_message: "",
    config
  };
}

export function serializeAgentsConfigYaml(
  config: AgentsConfig,
  taskAutoMergeEnabled: boolean
): string {
  return [
    "# EPURE Consumer Repository Configuration (.github/agents.yml)",
    "# Generated by setup-repo — security boundaries are enforced by shared workflows (ADR-0010, ADR-0023).",
    `harness: ${config.harness}`,
    "models:",
    `  planning: ${config.models.planning}`,
    `  implementation: ${config.models.implementation}`,
    `  review: ${config.models.review}`,
    `merge_policy: ${config.merge_policy}`,
    `task_auto_merge_enabled: ${taskAutoMergeEnabled}`,
    `max_code_fix_attempts: ${config.max_code_fix_attempts}`,
    `max_transient_api_retries: ${config.max_transient_api_retries}`,
    `transient_retry_backoff_seconds: [${config.transient_retry_backoff_seconds.join(", ")}]`,
    `job_timeout_minutes: ${config.job_timeout_minutes}`,
    `review_timeout_minutes: ${config.review_timeout_minutes}`,
    `max_concurrent_tasks_per_feature: ${config.max_concurrent_tasks_per_feature}`,
    `trace_retention_days: ${config.trace_retention_days}`,
    `preview_retention_days: ${config.preview_retention_days}`,
    `github_pages_previews: ${config.github_pages_previews}`,
    "security_invariants:",
    "  require_write_permission: true",
    "  sandbox_isolation: true",
    "  allow_agent_release: false",
    "  auto_merge_dev: false",
    "  auto_merge_main: false",
    ""
  ].join("\n");
}

function buildCallerWorkflows(pinnedSha: string): ReadonlyArray<{
  readonly path: string;
  readonly content: string;
}> {
  return [
    {
      path: ".github/workflows/epure-issue-command.yml",
      content: [
        'name: "EPURE Issue Command Gate"',
        "on:",
        "  issue_comment:",
        "    types: [created]",
        "permissions:",
        "  contents: write",
        "  issues: write",
        "  pull-requests: write",
        "  checks: write",
        "jobs:",
        "  authorize-and-dispatch:",
        `    uses: Giskard-AI/epure/.github/workflows/issue-command.yml@${pinnedSha} # v1.1.0`,
        "    with:",
        "      repository: ${{ github.repository }}",
        "      issue_number: ${{ github.event.issue.number }}",
        "      comment_id: ${{ github.event.comment.id }}",
        "      comment_body: ${{ github.event.comment.body }}",
        "      actor: ${{ github.event.comment.user.login }}",
        "      actor_type: ${{ github.event.comment.user.type }}",
        "    secrets: inherit",
        ""
      ].join("\n")
    },
    {
      path: ".github/workflows/epure-check.yml",
      content: [
        'name: "EPURE Contract Verification"',
        "on:",
        "  pull_request:",
        "    branches: [dev, main, 'feature/**']",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  verify-contract:",
        `    uses: Giskard-AI/epure/.github/workflows/epure-check.yml@${pinnedSha} # v1.1.0`,
        "    with:",
        "      repository: ${{ github.repository }}",
        `      pinned_ref: "Giskard-AI/epure/.github/workflows/epure-check.yml@${pinnedSha} # v1.1.0"`,
        "      strict_sha_pinning: true",
        ""
      ].join("\n")
    },
    {
      path: ".github/workflows/release.yml",
      content: [
        'name: "EPURE Controlled Release (dev -> main)"',
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      version_tag:",
        '        description: "Immutable SemVer tag (vMAJOR.MINOR.PATCH)"',
        "        required: true",
        "        type: string",
        "permissions:",
        "  contents: write",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 30",
        "    environment: release",
        "    steps:",
        "      - name: Verify Release App boundary",
        `        uses: Giskard-AI/epure/actions/verify-app-role@${pinnedSha} # v1.1.0`,
        "        with:",
        '          app_role: "release"',
        '          operation: "promote_dev_to_main"',
        '          target_ref: "refs/heads/main"',
        '          workflow_path: ".github/workflows/release.yml"',
        '          environment_name: "release"',
        ""
      ].join("\n")
    }
  ];
}

function computeFilePlanAction(
  repoRootDir: string | undefined,
  relPath: string,
  desiredContent: string
): ResourcePlanAction {
  if (!repoRootDir) {
    return "create";
  }
  const fullPath = join(repoRootDir, relPath);
  if (!existsSync(fullPath)) {
    return "create";
  }
  const existing = readFileSync(fullPath, "utf8");
  return existing === desiredContent ? "noop" : "update";
}

export function planAndApplyRepoSetup(input: SetupRepoInput): SetupRepoResult {
  const repository = input.repository.trim();
  const dryRun = input.dryRun ?? true;
  const pinnedSha = (input.epurePinnedSha ?? DEFAULT_EPURE_PINNED_SHA).trim();

  const resolvedConfig = resolveAgentsConfig(input.agentsOverrides);
  const ownerSlug = repository.split("/")[0] ?? "consumer";
  const manifests = buildConsumerAppManifests({ ownerSlug, repository });

  const rulesetSpec: RepositoryRulesetSpec = {
    name: "epure-release-immutability",
    enforcement: "active",
    targetRefs: ["refs/heads/main", "refs/tags/v*"],
    blockDirectPushes: true,
    blockForcePushes: true,
    blockDeletions: true,
    bypassActors: [
      {
        appRole: "release",
        appName: manifests.releaseApp.name,
        mode: "always"
      }
    ]
  };

  const releaseEnvironment: ReleaseEnvironmentSpec = {
    name: "release",
    requiredReviewers: true,
    boundSecrets: ["EPURE_RELEASE_APP_ID", "EPURE_RELEASE_APP_PRIVATE_KEY"]
  };

  const branchProtections: readonly BranchProtectionSpec[] = [
    {
      pattern: "dev",
      requirePullRequest: true,
      requireStatusChecks: true,
      requiredChecks: ["ci", "ai-review"],
      requireHumanApproval: true,
      allowedMergeMethods: ["squash", "rebase"],
      allowMergeCommit: false
    },
    {
      pattern: "feature/*",
      requirePullRequest: true,
      requireStatusChecks: true,
      requiredChecks: ["ci", "ai-review"],
      requireHumanApproval: false,
      allowedMergeMethods: ["squash", "rebase"],
      allowMergeCommit: false
    }
  ];

  const expectedSecrets: readonly ExpectedSecretSpec[] = [
    {
      name: "EPURE_AGENT_APP_ID",
      scope: "repository_or_org",
      description: "Consumer Agent App ID for development operations"
    },
    {
      name: "EPURE_AGENT_APP_PRIVATE_KEY",
      scope: "repository_or_org",
      description: "Consumer Agent App PEM private key (never exposed to agent sandbox)"
    },
    {
      name: "EPURE_RELEASE_APP_ID",
      scope: "release_environment",
      description: "Consumer Release App ID bound to the protected 'release' environment"
    },
    {
      name: "EPURE_RELEASE_APP_PRIVATE_KEY",
      scope: "release_environment",
      description: "Consumer Release App PEM private key bound to the 'release' environment"
    },
    {
      name: "LLM_API_KEY",
      scope: "repository_or_org",
      description: "LLM provider API key held exclusively by the runner-local proxy sidecar"
    }
  ];

  if (!REPO_SLUG_PATTERN.test(repository)) {
    return {
      status: "error",
      dry_run: dryRun,
      error_code: "INVALID_REPOSITORY_SLUG",
      error_message: `Invalid repository slug '${repository}'; expected '<owner>/<repo>'.`,
      repository,
      agents_config: resolvedConfig.config,
      agents_config_action: "noop",
      planned_workflows: [],
      expected_secrets: expectedSecrets,
      branch_protections: branchProtections,
      ruleset_spec: rulesetSpec,
      ruleset_action: "noop",
      apps_action: "noop",
      release_environment: releaseEnvironment,
      task_auto_merge_enabled: false,
      auto_merge_warning_code: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS",
      human_interventions: [],
      mutated_files: [],
      summary_markdown: "### EPURE setup-repo Error (`INVALID_REPOSITORY_SLUG`)"
    };
  }

  if (!resolvedConfig.valid) {
    return {
      status: "error",
      dry_run: dryRun,
      error_code: resolvedConfig.error_code,
      error_message: resolvedConfig.error_message,
      repository,
      agents_config: resolvedConfig.config,
      agents_config_action: "noop",
      planned_workflows: [],
      expected_secrets: expectedSecrets,
      branch_protections: branchProtections,
      ruleset_spec: rulesetSpec,
      ruleset_action: "noop",
      apps_action: "noop",
      release_environment: releaseEnvironment,
      task_auto_merge_enabled: false,
      auto_merge_warning_code: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS",
      human_interventions: [],
      mutated_files: [],
      summary_markdown: `### EPURE setup-repo Blocked (\`${resolvedConfig.error_code}\`)\n- ${resolvedConfig.error_message}`
    };
  }

  const hasCi = input.existingState?.hasRequiredCiChecks === true;
  const hasProtection = input.existingState?.hasBranchProtection === true;
  const taskAutoMergeEnabled = hasCi && hasProtection;
  const autoMergeWarningCode: AutoMergeWarningCode = taskAutoMergeEnabled
    ? "NONE"
    : "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS";

  const agentsYamlContent = serializeAgentsConfigYaml(
    resolvedConfig.config,
    taskAutoMergeEnabled
  );
  const agentsConfigAction = computeFilePlanAction(
    input.repoRootDir,
    ".github/agents.yml",
    agentsYamlContent
  );

  const workflowTemplates = buildCallerWorkflows(pinnedSha);
  const plannedWorkflows: PlannedWorkflowFile[] = workflowTemplates.map((wf) => ({
    path: wf.path,
    action: computeFilePlanAction(input.repoRootDir, wf.path, wf.content),
    content: wf.content
  }));

  const existingApps = new Set(input.existingState?.existingAppNames ?? []);
  const appsAction: ResourcePlanAction =
    existingApps.has(manifests.agentApp.name) &&
    existingApps.has(manifests.releaseApp.name)
      ? "noop"
      : "create";

  const existingRulesets = new Set(
    input.existingState?.existingRulesetNames ?? []
  );
  const rulesetAction: ResourcePlanAction = existingRulesets.has(
    rulesetSpec.name
  )
    ? "noop"
    : "create";

  const mutatedFiles: string[] = [];
  if (!dryRun && input.repoRootDir) {
    if (agentsConfigAction !== "noop") {
      const targetPath = join(input.repoRootDir, ".github/agents.yml");
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, agentsYamlContent, "utf8");
      mutatedFiles.push(".github/agents.yml");
    }
    for (const wf of plannedWorkflows) {
      if (wf.action !== "noop") {
        const targetPath = join(input.repoRootDir, wf.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, wf.content, "utf8");
        mutatedFiles.push(wf.path);
      }
    }
  }

  const humanInterventions: HumanInterventionStep[] = [
    {
      id: "provision_dual_github_apps",
      title: "Register & install consumer Agent App and Release App",
      details: `Create '${manifests.agentApp.name}' and '${manifests.releaseApp.name}' scoped strictly to '${repository}'.`
    },
    {
      id: "configure_repository_or_org_secrets",
      title: "Provision encrypted GitHub Secrets & LLM key locally",
      details:
        "Use 'gh secret set' locally for EPURE_AGENT_APP_ID, EPURE_AGENT_APP_PRIVATE_KEY, LLM_API_KEY, and environment-scoped EPURE_RELEASE_APP_ID / EPURE_RELEASE_APP_PRIVATE_KEY."
    },
    {
      id: "apply_branch_protections_and_release_ruleset",
      title: "Confirm branch protections on dev/feature/* and Repository Ruleset on main & refs/tags/v*",
      details: `Ensure only '${manifests.releaseApp.name}' is listed as Bypass Actor on '${rulesetSpec.name}' and configure required reviewers on the 'release' environment.`
    }
  ];

  const summaryMarkdown = [
    `### EPURE setup-repo (${dryRun ? "Dry-Run Simulation" : "Guided Application"})`,
    `- **Repository**: \`${repository}\``,
    `- **Agents Config (\`.github/agents.yml\`)**: \`${agentsConfigAction}\` (harness=\`${resolvedConfig.config.harness}\`, merge_policy=\`${resolvedConfig.config.merge_policy}\`)`,
    `- **Task Auto-Merge Enabled**: \`${taskAutoMergeEnabled}\` (${autoMergeWarningCode})`,
    `- **Ruleset (\`${rulesetSpec.name}\`)**: \`${rulesetAction}\` on \`main\` & \`refs/tags/v*\` (Bypass Actor: \`${manifests.releaseApp.name}\`)`,
    `- **Mutated Files**: ${mutatedFiles.length > 0 ? mutatedFiles.map((f) => `\`${f}\``).join(", ") : "none"}`
  ].join("\n");

  return {
    status: dryRun ? "dry_run" : "applied",
    dry_run: dryRun,
    error_code: "NONE",
    error_message: "",
    repository,
    agents_config: resolvedConfig.config,
    agents_config_action: agentsConfigAction,
    planned_workflows: plannedWorkflows,
    expected_secrets: expectedSecrets,
    branch_protections: branchProtections,
    ruleset_spec: rulesetSpec,
    ruleset_action: rulesetAction,
    apps_action: appsAction,
    release_environment: releaseEnvironment,
    task_auto_merge_enabled: taskAutoMergeEnabled,
    auto_merge_warning_code: autoMergeWarningCode,
    human_interventions: humanInterventions,
    mutated_files: mutatedFiles,
    summary_markdown: summaryMarkdown
  };
}

export function validateOrgSecretSharingScope(
  input: OrgSecretSharingInput
): OrgSecretSharingValidationResult {
  const targetRepo = input.targetRepository.trim();

  if (input.installationRepositorySelection === "all") {
    return {
      allowed: false,
      error_code: "CROSS_REPO_TOKEN_SCOPE_FORBIDDEN",
      error_message:
        "Organization-level secrets may be shared with a second repository, but the GitHub App installation token must not use 'all' repository selection (ADR-0010).",
      effective_token_repositories: []
    };
  }

  if (
    input.tokenScopedRepositories.length !== 1 ||
    input.tokenScopedRepositories[0] !== targetRepo
  ) {
    return {
      allowed: false,
      error_code: "CROSS_REPO_TOKEN_SCOPE_FORBIDDEN",
      error_message: `Installation token scope must be restricted strictly to the single target repository '${targetRepo}' (got [${input.tokenScopedRepositories.join(", ")}]).`,
      effective_token_repositories: []
    };
  }

  return {
    allowed: true,
    error_code: "NONE",
    error_message: "",
    effective_token_repositories: [targetRepo]
  };
}
