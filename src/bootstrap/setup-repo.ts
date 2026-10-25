import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildConsumerAppManifests } from "../auth/github-apps.js";
import { EPURE_PUBLIC_VERSION } from "../contract/epure-contract.js";
import {
  buildDefaultReviewerRosterFiles,
  type ReviewerAgentName
} from "../review/reviewer-roster.js";

export const DEFAULT_EPURE_PINNED_SHA =
  "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export { EPURE_PUBLIC_VERSION };

export const CONVENTIONAL_COMMIT_PATTERN_REGEX =
  "^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\\([a-z0-9/-]+\\))?(!)?: .+";

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

export interface PlannedReviewerRosterFile {
  readonly name: ReviewerAgentName;
  readonly path: string;
  readonly action: ResourcePlanAction;
  readonly content: string;
}

export interface RepositoryMergeSettingsSpec {
  readonly allow_squash_merge: true;
  readonly allow_merge_commit: false;
  readonly allow_rebase_merge: false;
  readonly delete_branch_on_merge: true;
  readonly squash_merge_commit_title: "PR_TITLE";
  readonly squash_merge_commit_message: "PR_BODY";
}

export interface BranchProtectionSpec {
  readonly pattern: string;
  readonly requirePullRequest: boolean;
  readonly requireStatusChecks: boolean;
  readonly requiredChecks: readonly string[];
  readonly requireHumanApproval: boolean;
  readonly allowedMergeMethods: readonly "squash"[];
  readonly allowMergeCommit: false;
  readonly allowRebaseMerge: false;
}

export interface RulesetBypassActorSpec {
  readonly appRole: "agent" | "release";
  readonly appName: string;
  readonly mode: "always" | "pull_request";
}

export interface RepositoryRulesetSpec {
  readonly name: string;
  readonly enforcement: "active";
  readonly targetRefs: readonly string[];
  readonly blockDirectPushes: boolean;
  readonly blockForcePushes: boolean;
  readonly blockDeletions: boolean;
  readonly requiredLinearHistory?: boolean | undefined;
  readonly allowedMergeMethods?: readonly "squash"[] | undefined;
  readonly requiredApprovingReviewCount?: number | undefined;
  readonly requiredStatusChecks?: readonly string[] | undefined;
  readonly commitMessagePattern?: string | undefined;
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
  readonly requirePrApprovalsOnDev?: number | undefined;
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
  readonly planned_reviewer_roster: readonly PlannedReviewerRosterFile[];
  readonly expected_secrets: readonly ExpectedSecretSpec[];
  readonly repository_merge_settings: RepositoryMergeSettingsSpec;
  readonly branch_protections: readonly BranchProtectionSpec[];
  readonly ruleset_spec: RepositoryRulesetSpec;
  readonly governance_rulesets: readonly RepositoryRulesetSpec[];
  readonly ruleset_action: ResourcePlanAction;
  readonly apps_action: ResourcePlanAction;
  readonly release_environment: ReleaseEnvironmentSpec;
  readonly task_auto_merge_enabled: boolean;
  readonly auto_merge_warning_code: AutoMergeWarningCode;
  readonly human_interventions: readonly HumanInterventionStep[];
  readonly mutated_files: readonly string[];
  readonly summary_markdown: string;
}

export interface ApplyGitHubRepositoryGovernanceInput {
  readonly repository: string;
  readonly githubToken: string;
  readonly governanceRulesets: readonly RepositoryRulesetSpec[];
  readonly agentAppIntegrationId?: number | undefined;
  readonly releaseAppIntegrationId?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface ApplyGitHubRepositoryGovernanceResult {
  readonly applied: boolean;
  readonly merge_settings_updated: boolean;
  readonly rulesets_applied: ReadonlyArray<{
    readonly name: string;
    readonly action: "created" | "updated";
    readonly id: number;
  }>;
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

export const DEFAULT_REPOSITORY_MERGE_SETTINGS: RepositoryMergeSettingsSpec = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  delete_branch_on_merge: true,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY"
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
        "  authorize-command:",
        '    name: "Authorize /epure Issue Command"',
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 10",
        "    permissions:",
        "      contents: read",
        "      issues: write",
        "    outputs:",
        "      authorized: ${{ steps.gate.outputs.authorized }}",
        "      decision: ${{ steps.gate.outputs.decision }}",
        "      command: ${{ steps.gate.outputs.command }}",
        "      command_args: ${{ steps.gate.outputs.command_args }}",
        "    steps:",
        "      - name: Run pre-bundled EPURE authorization gate",
        "        id: gate",
        `        uses: Giskard-AI/epure/actions/authorize-command@${pinnedSha} # v1.1.0`,
        "        with:",
        "          repository: ${{ github.repository }}",
        "          issue_number: ${{ github.event.issue.number }}",
        "          comment_body: ${{ github.event.comment.body }}",
        "          actor: ${{ github.event.comment.user.login }}",
        "          actor_type: ${{ github.event.comment.user.type }}",
        '          allow_implicit_planning_reply: "true"',
        "          github_token: ${{ secrets.GITHUB_TOKEN }}",
        "",
        "  orchestrate-command:",
        '    name: "Orchestrate Authorized /epure Lifecycle"',
        "    needs: authorize-command",
        "    if: ${{ needs.authorize-command.outputs.authorized == 'true' }}",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 60",
        "    environment: gemini",
        "    concurrency:",
        "      group: epure-issue-${{ github.event.issue.number }}",
        "      cancel-in-progress: false",
        "    permissions:",
        "      contents: write",
        "      issues: write",
        "      pull-requests: write",
        "      checks: write",
        "    steps:",
        "      - name: Run pre-bundled EPURE issue orchestrator",
        "        id: orchestrate",
        `        uses: Giskard-AI/epure/actions/orchestrate-issue@${pinnedSha} # v1.1.0`,
        "        with:",
        "          repository: ${{ github.repository }}",
        "          issue_number: ${{ github.event.issue.number }}",
        "          command: ${{ needs.authorize-command.outputs.command }}",
        "          command_args: ${{ needs.authorize-command.outputs.command_args }}",
        "          comment_id: ${{ github.event.comment.id }}",
        "          actor: ${{ github.event.comment.user.login }}",
        "          agent_app_id: ${{ secrets.EPURE_AGENT_APP_ID }}",
        "          agent_app_private_key: ${{ secrets.EPURE_AGENT_APP_PRIVATE_KEY }}",
        "          github_token: ${{ secrets.GITHUB_TOKEN }}",
        "          llm_api_key: ${{ secrets.LLM_API_KEY }}",
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
      path: ".github/workflows/pr-title.yml",
      content: [
        `# Managed by Giskard-AI/epure@${pinnedSha} # v1.1.0`,
        'name: "Conventional Commit PR Title"',
        "on:",
        "  pull_request:",
        "    types: [opened, edited, synchronize, reopened]",
        "    branches: [dev, main, 'feature/**']",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  pr-title:",
        '    name: "PR title"',
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 5",
        "    steps:",
        "      - name: Validate Conventional Commit PR title",
        "        env:",
        "          PR_TITLE: ${{ github.event.pull_request.title }}",
        "        run: |",
        `          PATTERN='${CONVENTIONAL_COMMIT_PATTERN_REGEX}'`,
        '          if [[ ! "$PR_TITLE" =~ $PATTERN ]]; then',
        '            echo "::error::PR title must follow Conventional Commits: $PATTERN (got: $PR_TITLE)"',
        "            exit 1",
        "          fi",
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

export function buildGovernanceRulesets(params: {
  readonly agentAppName: string;
  readonly releaseAppName: string;
  readonly requirePrApprovalsOnDev?: number | undefined;
}): {
  readonly featureGovernance: RepositoryRulesetSpec;
  readonly devGovernance: RepositoryRulesetSpec;
  readonly releaseImmutability: RepositoryRulesetSpec;
  readonly all: readonly RepositoryRulesetSpec[];
} {
  const requiredChecks = [
    "verify-contract / Verify EPURE Consumer Contract",
    "PR title",
    "ai-review"
  ] as const;

  const featureGovernance: RepositoryRulesetSpec = {
    name: "epure-feature-governance",
    enforcement: "active",
    targetRefs: ["refs/heads/feature/*"],
    blockDirectPushes: true,
    blockForcePushes: true,
    blockDeletions: true,
    requiredLinearHistory: true,
    allowedMergeMethods: ["squash"],
    requiredApprovingReviewCount: 0,
    requiredStatusChecks: requiredChecks,
    commitMessagePattern: CONVENTIONAL_COMMIT_PATTERN_REGEX,
    bypassActors: [
      {
        appRole: "agent",
        appName: params.agentAppName,
        mode: "pull_request"
      }
    ]
  };

  const devGovernance: RepositoryRulesetSpec = {
    name: "epure-dev-governance",
    enforcement: "active",
    targetRefs: ["refs/heads/dev"],
    blockDirectPushes: true,
    blockForcePushes: true,
    blockDeletions: true,
    requiredLinearHistory: true,
    allowedMergeMethods: ["squash"],
    requiredApprovingReviewCount: params.requirePrApprovalsOnDev ?? 0,
    requiredStatusChecks: requiredChecks,
    commitMessagePattern: CONVENTIONAL_COMMIT_PATTERN_REGEX,
    bypassActors: []
  };

  const releaseImmutability: RepositoryRulesetSpec = {
    name: "epure-release-immutability",
    enforcement: "active",
    targetRefs: ["refs/heads/main", "refs/tags/v*"],
    blockDirectPushes: true,
    blockForcePushes: true,
    blockDeletions: true,
    bypassActors: [
      {
        appRole: "release",
        appName: params.releaseAppName,
        mode: "always"
      }
    ]
  };

  return {
    featureGovernance,
    devGovernance,
    releaseImmutability,
    all: [featureGovernance, devGovernance, releaseImmutability]
  };
}

export function planAndApplyRepoSetup(input: SetupRepoInput): SetupRepoResult {
  const repository = input.repository.trim();
  const dryRun = input.dryRun ?? true;
  const pinnedSha = (input.epurePinnedSha ?? DEFAULT_EPURE_PINNED_SHA).trim();

  const resolvedConfig = resolveAgentsConfig(input.agentsOverrides);
  const ownerSlug = repository.split("/")[0] ?? "consumer";
  const manifests = buildConsumerAppManifests({ ownerSlug, repository });

  const rulesetBundle = buildGovernanceRulesets({
    agentAppName: manifests.agentApp.name,
    releaseAppName: manifests.releaseApp.name,
    requirePrApprovalsOnDev: input.requirePrApprovalsOnDev
  });
  const rulesetSpec = rulesetBundle.releaseImmutability;
  const governanceRulesets = rulesetBundle.all;

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
      requiredChecks: ["verify-contract", "PR title", "ai-review"],
      requireHumanApproval: true,
      allowedMergeMethods: ["squash"],
      allowMergeCommit: false,
      allowRebaseMerge: false
    },
    {
      pattern: "feature/*",
      requirePullRequest: true,
      requireStatusChecks: true,
      requiredChecks: ["verify-contract", "PR title", "ai-review"],
      requireHumanApproval: false,
      allowedMergeMethods: ["squash"],
      allowMergeCommit: false,
      allowRebaseMerge: false
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
      planned_reviewer_roster: [],
      expected_secrets: expectedSecrets,
      repository_merge_settings: DEFAULT_REPOSITORY_MERGE_SETTINGS,
      branch_protections: branchProtections,
      ruleset_spec: rulesetSpec,
      governance_rulesets: governanceRulesets,
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
      planned_reviewer_roster: [],
      expected_secrets: expectedSecrets,
      repository_merge_settings: DEFAULT_REPOSITORY_MERGE_SETTINGS,
      branch_protections: branchProtections,
      ruleset_spec: rulesetSpec,
      governance_rulesets: governanceRulesets,
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

  const rosterTemplates = buildDefaultReviewerRosterFiles({ repository });
  const plannedReviewerRoster: PlannedReviewerRosterFile[] = rosterTemplates.map(
    (item) => ({
      name: item.name,
      path: item.path,
      action: computeFilePlanAction(input.repoRootDir, item.path, item.content),
      content: item.content
    })
  );

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
    for (const agentFile of plannedReviewerRoster) {
      if (agentFile.action !== "noop") {
        const targetPath = join(input.repoRootDir, agentFile.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, agentFile.content, "utf8");
        mutatedFiles.push(agentFile.path);
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
      title: "Confirm 3 Repository Rulesets (feature/*, dev, main+v*) and squash-only merge settings",
      details: `Run 'setup-repo --apply --apply-github-settings' to enforce squash-only merges and provision 'epure-feature-governance', 'epure-dev-governance', and '${rulesetSpec.name}'.`
    }
  ];

  const summaryMarkdown = [
    `### EPURE setup-repo (${dryRun ? "Dry-Run Simulation" : "Guided Application"})`,
    `- **Repository**: \`${repository}\``,
    `- **Merge Governance**: \`squash-only\` (\`allow_merge_commit=false\`, \`allow_rebase_merge=false\`, \`delete_branch_on_merge=true\`)`,
    `- **Agents Config (\`.github/agents.yml\`)**: \`${agentsConfigAction}\` (harness=\`${resolvedConfig.config.harness}\`, merge_policy=\`${resolvedConfig.config.merge_policy}\`)`,
    `- **Reviewer Roster (\`.cursor/agents/*.md\`)**: \`${plannedReviewerRoster.length}\` agents (specialists + cross-cutting + \`user-advocate\`)`,
    `- **Task Auto-Merge Enabled**: \`${taskAutoMergeEnabled}\` (${autoMergeWarningCode})`,
    `- **Governance Rulesets**: ${governanceRulesets.map((r) => `\`${r.name}\``).join(", ")}`,
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
    planned_reviewer_roster: plannedReviewerRoster,
    expected_secrets: expectedSecrets,
    repository_merge_settings: DEFAULT_REPOSITORY_MERGE_SETTINGS,
    branch_protections: branchProtections,
    ruleset_spec: rulesetSpec,
    governance_rulesets: governanceRulesets,
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

function buildGitHubRulesetApiPayload(
  spec: RepositoryRulesetSpec,
  appIntegrationIds: {
    readonly agentAppIntegrationId?: number | undefined;
    readonly releaseAppIntegrationId?: number | undefined;
  }
): Record<string, unknown> {
  const bypassActors: Array<Record<string, unknown>> = [];
  for (const actor of spec.bypassActors) {
    const actorId =
      actor.appRole === "agent"
        ? appIntegrationIds.agentAppIntegrationId
        : appIntegrationIds.releaseAppIntegrationId;
    if (typeof actorId === "number" && actorId > 0) {
      bypassActors.push({
        actor_id: actorId,
        actor_type: "Integration",
        bypass_mode: actor.mode
      });
    }
  }

  const rules: Array<Record<string, unknown>> = [];
  if (spec.blockDeletions) {
    rules.push({ type: "deletion" });
  }
  if (spec.blockForcePushes) {
    rules.push({ type: "non_fast_forward" });
  }
  if (spec.requiredLinearHistory) {
    rules.push({ type: "required_linear_history" });
  }
  if (spec.blockDirectPushes) {
    rules.push({
      type: "pull_request",
      parameters: {
        allowed_merge_methods: spec.allowedMergeMethods ?? ["squash"],
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: spec.requiredApprovingReviewCount ?? 0,
        required_review_thread_resolution: true
      }
    });
  }
  if (spec.commitMessagePattern) {
    rules.push({
      type: "commit_message_pattern",
      parameters: {
        name: "Conventional Commit format",
        negate: false,
        operator: "regex",
        pattern: spec.commitMessagePattern
      }
    });
  }

  return {
    name: spec.name,
    target: "branch",
    enforcement: spec.enforcement,
    bypass_actors: bypassActors,
    conditions: {
      ref_name: {
        include: [...spec.targetRefs],
        exclude: []
      }
    },
    rules
  };
}

export async function applyGitHubRepositoryGovernance(
  input: ApplyGitHubRepositoryGovernanceInput
): Promise<ApplyGitHubRepositoryGovernanceResult> {
  const [owner, repo] = input.repository.trim().split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug '${input.repository}'.`);
  }

  const fetchFn = input.fetchImpl ?? fetch;
  const baseUrl = "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${input.githubToken.trim()}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  // 1. Configure Squash-Only & automatic head branch deletion on the repository
  const patchRepoResp = await fetchFn(`${baseUrl}/repos/${owner}/${repo}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(DEFAULT_REPOSITORY_MERGE_SETTINGS)
  });
  if (!patchRepoResp.ok) {
    const errText = await patchRepoResp.text();
    throw new Error(
      `Failed to configure squash-only settings on ${input.repository} (HTTP ${patchRepoResp.status}): ${errText}`
    );
  }

  // 2. Fetch existing rulesets for idempotent create-or-update
  const listRulesetsResp = await fetchFn(
    `${baseUrl}/repos/${owner}/${repo}/rulesets`,
    {
      method: "GET",
      headers
    }
  );
  if (!listRulesetsResp.ok) {
    const errText = await listRulesetsResp.text();
    throw new Error(
      `Failed to list rulesets on ${input.repository} (HTTP ${listRulesetsResp.status}): ${errText}`
    );
  }
  const existingRulesets = (await listRulesetsResp.json()) as Array<{
    id: number;
    name: string;
  }>;
  const existingByName = new Map<string, number>();
  for (const r of existingRulesets) {
    existingByName.set(r.name, r.id);
  }

  const rulesetsApplied: Array<{
    name: string;
    action: "created" | "updated";
    id: number;
  }> = [];

  for (const spec of input.governanceRulesets) {
    const payload = buildGitHubRulesetApiPayload(spec, {
      agentAppIntegrationId: input.agentAppIntegrationId,
      releaseAppIntegrationId: input.releaseAppIntegrationId
    });
    const existingId = existingByName.get(spec.name);

    if (typeof existingId === "number") {
      const updateResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/rulesets/${existingId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify(payload)
        }
      );
      if (!updateResp.ok) {
        const errText = await updateResp.text();
        throw new Error(
          `Failed to update ruleset '${spec.name}' on ${input.repository} (HTTP ${updateResp.status}): ${errText}`
        );
      }
      rulesetsApplied.push({
        name: spec.name,
        action: "updated",
        id: existingId
      });
    } else {
      const createResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/rulesets`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        }
      );
      if (!createResp.ok) {
        const errText = await createResp.text();
        throw new Error(
          `Failed to create ruleset '${spec.name}' on ${input.repository} (HTTP ${createResp.status}): ${errText}`
        );
      }
      const createdData = (await createResp.json()) as { id?: number };
      rulesetsApplied.push({
        name: spec.name,
        action: "created",
        id: createdData.id ?? 0
      });
    }
  }

  return {
    applied: true,
    merge_settings_updated: true,
    rulesets_applied: rulesetsApplied
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
