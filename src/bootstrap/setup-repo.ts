import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildConsumerAppManifests } from "../auth/github-apps.js";
import { EPURE_PUBLIC_VERSION } from "../contract/epure-contract.js";
import type { ProviderConfig, ProviderKind } from "../llm/types.js";
import {
  buildDefaultReviewerRosterFiles,
  DEFAULT_REVIEWERS_DIR,
  type CustomDomainReviewerSpec,
  type ReviewerAgentName
} from "../review/reviewer-roster.js";
import {
  buildRenovateConfigJson,
  buildSandboxToolingSetupSteps,
  buildStackAwareCiWorkflowYaml,
  buildZizmorConfigYaml,
  detectRepositoryStack,
  discoverVerificationProfile,
  type DetectedStackProfile,
  type VerificationProfile,
  type VerificationTargetKind,
  type VerificationTargetSpec
} from "./ci-and-renovate.js";

export {
  discoverVerificationProfile,
  type ProviderConfig,
  type ProviderKind,
  type VerificationProfile,
  type VerificationTargetKind,
  type VerificationTargetSpec
};

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

export interface WebToolsConfig {
  readonly enabled: boolean;
  readonly phases: readonly ("plan" | "spec" | "implementation" | "review")[];
  readonly max_requests_per_turn?: number | undefined;
  readonly max_requests_per_run?: number | undefined;
  readonly max_bytes_per_response?: number | undefined;
  readonly max_fetch_bytes?: number | undefined;
  readonly timeout_ms?: number | undefined;
}

export interface AgentsConfig {
  readonly harness: AgentHarness;
  readonly models: AgentsModelsConfig;
  readonly providers?: Readonly<Record<string, ProviderConfig>> | undefined;
  readonly reviewers_dir: string;
  readonly llm_environment: string;
  readonly merge_policy: StaleBaseMergePolicy;
  readonly max_code_fix_attempts: number;
  readonly max_epic_phases?: number | undefined;
  readonly max_transient_api_retries: number;
  readonly transient_retry_backoff_seconds: readonly [number, number, number, number];
  readonly llm_request_timeout_seconds: number;
  readonly job_timeout_minutes: number;
  readonly review_timeout_minutes: number;
  readonly max_concurrent_tasks_per_feature: number;
  readonly trace_retention_days: number;
  readonly preview_retention_days: number;
  readonly github_pages_previews: boolean;
  readonly verification?: VerificationProfile | undefined;
  readonly web_tools?: WebToolsConfig | undefined;
}

export type AgentsYmlConfig = AgentsConfig;

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
  readonly providers?: Readonly<Record<string, ProviderConfig>> | undefined;
  readonly reviewers_dir?: string | undefined;
  readonly llm_environment?: string | undefined;
  readonly merge_policy?: StaleBaseMergePolicy | undefined;
  readonly max_code_fix_attempts?: number | undefined;
  readonly max_epic_phases?: number | undefined;
  readonly max_transient_api_retries?: number | undefined;
  readonly transient_retry_backoff_seconds?:
    | readonly [number, number, number, number]
    | undefined;
  readonly llm_request_timeout_seconds?: number | undefined;
  readonly job_timeout_minutes?: number | undefined;
  readonly review_timeout_minutes?: number | undefined;
  readonly max_concurrent_tasks_per_feature?: number | undefined;
  readonly trace_retention_days?: number | undefined;
  readonly preview_retention_days?: number | undefined;
  readonly github_pages_previews?: boolean | undefined;
  readonly github_pages_human_consent?: boolean | undefined;
  readonly preview_separate_origin?: boolean | undefined;
  readonly verification?: Partial<VerificationProfile> | undefined;
  readonly web_tools?: Partial<WebToolsConfig> | undefined;
  readonly reset_verification_targets?: boolean | undefined;
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
  readonly includeFrontendReviewers?: boolean | undefined;
  readonly customDomainSpecialists?: readonly CustomDomainReviewerSpec[] | undefined;
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

export const DEFAULT_VERIFICATION_PROFILE: VerificationProfile = {
  wait_for_external_ci: true,
  external_ci_timeout_minutes: 15,
  grace_window_seconds: 45,
  targets: []
};

export const DEFAULT_AGENTS_CONFIG: AgentsConfig = {
  harness: "pi",
  models: {
    planning: "anthropic/claude-sonnet-4-20250514",
    implementation: "anthropic/claude-sonnet-4-20250514",
    review: "openai/gpt-4.1"
  },
  reviewers_dir: DEFAULT_REVIEWERS_DIR,
  llm_environment: "epure-agent",
  merge_policy: "strict",
  max_code_fix_attempts: 3,
  max_transient_api_retries: 4,
  transient_retry_backoff_seconds: [5, 15, 45, 120],
  llm_request_timeout_seconds: 900,
  job_timeout_minutes: 60,
  review_timeout_minutes: 30,
  max_concurrent_tasks_per_feature: 3,
  trace_retention_days: 30,
  preview_retention_days: 14,
  github_pages_previews: false,
  verification: DEFAULT_VERIFICATION_PROFILE
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
const LLM_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function isUnsafeReviewersDir(dir: string): boolean {
  return (
    dir === "" ||
    dir === "." ||
    /^(?:[\\/]|[A-Za-z]:)/.test(dir) ||
    dir.split(/[\\/]/).includes("..") ||
    /^src(?:[\\/]|$)/i.test(dir)
  );
}

function normalizeVerificationTarget(
  target: VerificationTargetSpec
): VerificationTargetSpec {
  return {
    name: target.name,
    working_directory: target.working_directory,
    kind: target.kind,
    path_patterns: [...target.path_patterns],
    ...(target.install_command
      ? { install_command: target.install_command }
      : {}),
    ...(target.codegen_command
      ? { codegen_command: target.codegen_command }
      : {}),
    ...(target.typecheck_command
      ? { typecheck_command: target.typecheck_command }
      : {}),
    ...(target.lint_command ? { lint_command: target.lint_command } : {}),
    ...(target.test_command ? { test_command: target.test_command } : {}),
    ...(target.build_command ? { build_command: target.build_command } : {})
  };
}

function attachDualProviderConfigGetters(
  entry: Record<string, unknown>
): ProviderConfig {
  const definePair = (snakeKey: string, camelKey: string): void => {
    const hasSnake = Object.prototype.hasOwnProperty.call(entry, snakeKey);
    const hasCamel = Object.prototype.hasOwnProperty.call(entry, camelKey);
    if (hasSnake && !hasCamel) {
      Object.defineProperty(entry, camelKey, {
        get() {
          return entry[snakeKey];
        },
        enumerable: false,
        configurable: true
      });
    } else if (hasCamel && !hasSnake) {
      Object.defineProperty(entry, snakeKey, {
        get() {
          return entry[camelKey];
        },
        enumerable: false,
        configurable: true
      });
    }
  };

  definePair("api_key", "apiKey");
  definePair("base_url", "baseUrl");
  definePair("api_version", "apiVersion");
  definePair("default_headers", "defaultHeaders");

  return entry as ProviderConfig;
}

function normalizeAgentsProvidersMap(
  providers?: Readonly<Record<string, ProviderConfig>> | undefined,
  preferSnakeCase: boolean = false
): Readonly<Record<string, ProviderConfig>> | undefined {
  if (!providers) {
    return undefined;
  }
  const keys = Object.keys(providers);
  if (keys.length === 0) {
    return undefined;
  }

  const out: Record<string, ProviderConfig> = {};
  for (const [alias, raw] of Object.entries(providers)) {
    const cleanAlias = alias.trim();
    if (!cleanAlias || !raw) {
      continue;
    }

    const entry: Record<string, unknown> = {};
    if (raw.provider) {
      entry.provider = raw.provider;
    }

    const apiKeyVal = raw.api_key ?? raw.apiKey;
    const baseUrlVal = raw.base_url ?? raw.baseUrl;
    const apiVersionVal = raw.api_version ?? raw.apiVersion;
    const defaultHeadersVal = raw.default_headers ?? raw.defaultHeaders;

    const useSnake =
      preferSnakeCase ||
      raw.api_key !== undefined ||
      raw.base_url !== undefined ||
      raw.api_version !== undefined ||
      raw.default_headers !== undefined;

    if (apiKeyVal !== undefined) {
      entry[useSnake ? "api_key" : "apiKey"] = apiKeyVal;
    }
    if (baseUrlVal !== undefined) {
      entry[useSnake ? "base_url" : "baseUrl"] = baseUrlVal;
    }
    if (apiVersionVal !== undefined) {
      entry[useSnake ? "api_version" : "apiVersion"] = apiVersionVal;
    }
    if (defaultHeadersVal !== undefined) {
      entry[useSnake ? "default_headers" : "defaultHeaders"] = {
        ...defaultHeadersVal
      };
    }

    out[cleanAlias] = attachDualProviderConfigGetters(entry);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

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

  const reviewersDir = (
    overrides.reviewers_dir ?? DEFAULT_AGENTS_CONFIG.reviewers_dir
  )
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  if (isUnsafeReviewersDir(reviewersDir)) {
    return {
      valid: false,
      error_code: "SECURITY_INVARIANT_VIOLATION",
      error_message: `Local .github/agents.yml reviewers_dir '${overrides.reviewers_dir ?? ""}' must be a relative directory outside 'src/' without '..' segments.`,
      config: DEFAULT_AGENTS_CONFIG
    };
  }

  const llmEnvironment = (
    overrides.llm_environment ?? DEFAULT_AGENTS_CONFIG.llm_environment
  ).trim();
  if (!LLM_ENVIRONMENT_NAME_PATTERN.test(llmEnvironment)) {
    return {
      valid: false,
      error_code: "SECURITY_INVARIANT_VIOLATION",
      error_message: `Local .github/agents.yml llm_environment '${overrides.llm_environment ?? ""}' must match ${LLM_ENVIRONMENT_NAME_PATTERN.source}.`,
      config: DEFAULT_AGENTS_CONFIG
    };
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

  const verification: VerificationProfile = overrides.verification
    ? {
        wait_for_external_ci:
          overrides.verification.wait_for_external_ci ??
          DEFAULT_VERIFICATION_PROFILE.wait_for_external_ci,
        external_ci_timeout_minutes:
          overrides.verification.external_ci_timeout_minutes ??
          DEFAULT_VERIFICATION_PROFILE.external_ci_timeout_minutes,
        grace_window_seconds:
          overrides.verification.grace_window_seconds ??
          DEFAULT_VERIFICATION_PROFILE.grace_window_seconds,
        ...(overrides.verification.deferred_external_workflows &&
        overrides.verification.deferred_external_workflows.length > 0
          ? {
              deferred_external_workflows: [
                ...overrides.verification.deferred_external_workflows
              ]
            }
          : {}),
        targets: overrides.verification.targets
          ? overrides.verification.targets.map(normalizeVerificationTarget)
          : DEFAULT_VERIFICATION_PROFILE.targets
      }
    : DEFAULT_VERIFICATION_PROFILE;

  const normalizedProviders = normalizeAgentsProvidersMap(overrides.providers);
  const webTools: WebToolsConfig | undefined = overrides.web_tools
    ? {
        enabled: overrides.web_tools.enabled ?? true,
        phases: overrides.web_tools.phases
          ? [...overrides.web_tools.phases]
          : ["plan", "spec", "implementation"],
        ...(overrides.web_tools.max_requests_per_turn !== undefined
          ? { max_requests_per_turn: overrides.web_tools.max_requests_per_turn }
          : {}),
        ...(overrides.web_tools.max_requests_per_run !== undefined
          ? { max_requests_per_run: overrides.web_tools.max_requests_per_run }
          : {}),
        ...(overrides.web_tools.max_bytes_per_response !== undefined
          ? {
              max_bytes_per_response:
                overrides.web_tools.max_bytes_per_response
            }
          : {}),
        ...(overrides.web_tools.max_fetch_bytes !== undefined
          ? { max_fetch_bytes: overrides.web_tools.max_fetch_bytes }
          : {}),
        ...(overrides.web_tools.timeout_ms !== undefined
          ? { timeout_ms: overrides.web_tools.timeout_ms }
          : {})
      }
    : undefined;

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
    ...(normalizedProviders ? { providers: normalizedProviders } : {}),
    reviewers_dir: reviewersDir,
    llm_environment: llmEnvironment,
    merge_policy: overrides.merge_policy ?? DEFAULT_AGENTS_CONFIG.merge_policy,
    max_code_fix_attempts:
      overrides.max_code_fix_attempts ??
      DEFAULT_AGENTS_CONFIG.max_code_fix_attempts,
    ...(overrides.max_epic_phases !== undefined
      ? {
          max_epic_phases: Math.min(
            3,
            Math.max(1, Math.floor(overrides.max_epic_phases))
          )
        }
      : {}),
    max_transient_api_retries:
      overrides.max_transient_api_retries ??
      DEFAULT_AGENTS_CONFIG.max_transient_api_retries,
    transient_retry_backoff_seconds:
      overrides.transient_retry_backoff_seconds ??
      DEFAULT_AGENTS_CONFIG.transient_retry_backoff_seconds,
    llm_request_timeout_seconds:
      overrides.llm_request_timeout_seconds !== undefined &&
      overrides.llm_request_timeout_seconds > 0
        ? overrides.llm_request_timeout_seconds
        : DEFAULT_AGENTS_CONFIG.llm_request_timeout_seconds,
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
    github_pages_previews: pagesPreviews,
    verification,
    ...(webTools ? { web_tools: webTools } : {})
  };

  return {
    valid: true,
    error_code: "NONE",
    error_message: "",
    config
  };
}

function escapeYamlDoubleQuoted(val: string): string {
  return JSON.stringify(val);
}

function formatYamlProviderScalar(val: string): string {
  if (
    val.length === 0 ||
    /[\r\n#]/.test(val) ||
    /^\s|\s$/.test(val) ||
    val.startsWith('"') ||
    val.startsWith("'")
  ) {
    return escapeYamlDoubleQuoted(val);
  }
  return val;
}

export function serializeAgentsConfigYaml(
  config: AgentsConfig,
  taskAutoMergeEnabled: boolean = false
): string {
  const providerLines: string[] = [];
  if (config.providers && Object.keys(config.providers).length > 0) {
    providerLines.push("providers:");
    for (const [alias, rawEntry] of Object.entries(config.providers)) {
      if (!rawEntry) {
        continue;
      }
      providerLines.push(`  ${alias}:`);
      if (rawEntry.provider) {
        providerLines.push(
          `    provider: ${formatYamlProviderScalar(rawEntry.provider)}`
        );
      }
      const apiKey = rawEntry.api_key ?? rawEntry.apiKey;
      if (apiKey !== undefined) {
        providerLines.push(`    api_key: ${formatYamlProviderScalar(apiKey)}`);
      }
      const baseUrl = rawEntry.base_url ?? rawEntry.baseUrl;
      if (baseUrl !== undefined) {
        providerLines.push(
          `    base_url: ${formatYamlProviderScalar(baseUrl)}`
        );
      }
      const apiVersion = rawEntry.api_version ?? rawEntry.apiVersion;
      if (apiVersion !== undefined) {
        providerLines.push(
          `    api_version: ${formatYamlProviderScalar(apiVersion)}`
        );
      }
      const defaultHeaders =
        rawEntry.default_headers ?? rawEntry.defaultHeaders;
      if (defaultHeaders && Object.keys(defaultHeaders).length > 0) {
        providerLines.push("    default_headers:");
        for (const [hKey, hVal] of Object.entries(defaultHeaders)) {
          providerLines.push(
            `      ${hKey}: ${formatYamlProviderScalar(hVal)}`
          );
        }
      }
    }
  }

  const verification = config.verification ?? DEFAULT_VERIFICATION_PROFILE;
  const verificationLines: string[] = [
    "verification:",
    `  wait_for_external_ci: ${verification.wait_for_external_ci}`,
    `  external_ci_timeout_minutes: ${verification.external_ci_timeout_minutes}`,
    `  grace_window_seconds: ${verification.grace_window_seconds}`
  ];

  if (
    verification.deferred_external_workflows &&
    verification.deferred_external_workflows.length > 0
  ) {
    const formattedDeferred = verification.deferred_external_workflows
      .map((w) => escapeYamlDoubleQuoted(w))
      .join(", ");
    verificationLines.push(
      `  deferred_external_workflows: [${formattedDeferred}]`
    );
  }

  if (verification.targets.length === 0) {
    verificationLines.push("  targets: []");
  } else {
    verificationLines.push("  targets:");
    for (const target of verification.targets) {
      const formattedPatterns = target.path_patterns
        .map((p) => escapeYamlDoubleQuoted(p))
        .join(", ");
      verificationLines.push(`    - name: ${target.name}`);
      verificationLines.push(
        `      working_directory: ${target.working_directory}`
      );
      verificationLines.push(`      kind: ${target.kind}`);
      verificationLines.push(`      path_patterns: [${formattedPatterns}]`);
      if (target.install_command) {
        verificationLines.push(
          `      install_command: ${escapeYamlDoubleQuoted(target.install_command)}`
        );
      }
      if (target.codegen_command) {
        verificationLines.push(
          `      codegen_command: ${escapeYamlDoubleQuoted(target.codegen_command)}`
        );
      }
      if (target.typecheck_command) {
        verificationLines.push(
          `      typecheck_command: ${escapeYamlDoubleQuoted(target.typecheck_command)}`
        );
      }
      if (target.lint_command) {
        verificationLines.push(
          `      lint_command: ${escapeYamlDoubleQuoted(target.lint_command)}`
        );
      }
      if (target.test_command) {
        verificationLines.push(
          `      test_command: ${escapeYamlDoubleQuoted(target.test_command)}`
        );
      }
      if (target.build_command) {
        verificationLines.push(
          `      build_command: ${escapeYamlDoubleQuoted(target.build_command)}`
        );
      }
    }
  }

  const webToolsLines: string[] = [];
  if (config.web_tools) {
    webToolsLines.push("web_tools:");
    webToolsLines.push(`  enabled: ${config.web_tools.enabled}`);
    const formattedPhases = config.web_tools.phases
      .map((p) => escapeYamlDoubleQuoted(p))
      .join(", ");
    webToolsLines.push(`  phases: [${formattedPhases}]`);
    if (config.web_tools.max_requests_per_turn !== undefined) {
      webToolsLines.push(
        `  max_requests_per_turn: ${config.web_tools.max_requests_per_turn}`
      );
    }
    if (config.web_tools.max_requests_per_run !== undefined) {
      webToolsLines.push(
        `  max_requests_per_run: ${config.web_tools.max_requests_per_run}`
      );
    }
    if (config.web_tools.max_bytes_per_response !== undefined) {
      webToolsLines.push(
        `  max_bytes_per_response: ${config.web_tools.max_bytes_per_response}`
      );
    }
    if (config.web_tools.max_fetch_bytes !== undefined) {
      webToolsLines.push(
        `  max_fetch_bytes: ${config.web_tools.max_fetch_bytes}`
      );
    }
    if (config.web_tools.timeout_ms !== undefined) {
      webToolsLines.push(`  timeout_ms: ${config.web_tools.timeout_ms}`);
    }
  }

  return [
    "# EPURE Consumer Repository Configuration (.github/agents.yml)",
    "# Generated by setup-repo — security boundaries are enforced by shared workflows (ADR-0010, ADR-0023).",
    `harness: ${config.harness}`,
    "models:",
    `  planning: ${config.models.planning}`,
    `  implementation: ${config.models.implementation}`,
    `  review: ${config.models.review}`,
    ...providerLines,
    `reviewers_dir: ${formatYamlProviderScalar(config.reviewers_dir)}`,
    `llm_environment: ${config.llm_environment}`,
    `merge_policy: ${config.merge_policy}`,
    `task_auto_merge_enabled: ${taskAutoMergeEnabled}`,
    `max_code_fix_attempts: ${config.max_code_fix_attempts}`,
    `max_transient_api_retries: ${config.max_transient_api_retries}`,
    `transient_retry_backoff_seconds: [${config.transient_retry_backoff_seconds.join(", ")}]`,
    `llm_request_timeout_seconds: ${config.llm_request_timeout_seconds}`,
    `job_timeout_minutes: ${config.job_timeout_minutes}`,
    `review_timeout_minutes: ${config.review_timeout_minutes}`,
    `max_concurrent_tasks_per_feature: ${config.max_concurrent_tasks_per_feature}`,
    `trace_retention_days: ${config.trace_retention_days}`,
    `preview_retention_days: ${config.preview_retention_days}`,
    `github_pages_previews: ${config.github_pages_previews}`,
    ...verificationLines,
    ...webToolsLines,
    "security_invariants:",
    "  require_write_permission: true",
    "  sandbox_isolation: true",
    "  allow_agent_release: false",
    "  auto_merge_dev: false",
    "  auto_merge_main: false",
    ""
  ].join("\n");
}

export const serializeAgentsYml = serializeAgentsConfigYaml;

export function buildDefaultAgentsYaml(
  configOrOptions?:
    | AgentsConfig
    | {
        readonly config?: AgentsConfig | undefined;
        readonly overrides?: AgentsConfigOverrides | undefined;
        readonly taskAutoMergeEnabled?: boolean | undefined;
      },
  taskAutoMergeEnabled: boolean = false
): string {
  if (!configOrOptions) {
    return serializeAgentsConfigYaml(
      DEFAULT_AGENTS_CONFIG,
      taskAutoMergeEnabled
    );
  }
  if ("harness" in configOrOptions && "models" in configOrOptions) {
    return serializeAgentsConfigYaml(configOrOptions, taskAutoMergeEnabled);
  }
  const baseConfig =
    configOrOptions.config ??
    resolveAgentsConfig(configOrOptions.overrides ?? {}).config;
  return serializeAgentsConfigYaml(
    baseConfig,
    configOrOptions.taskAutoMergeEnabled ?? taskAutoMergeEnabled
  );
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseYamlStringArrayInline(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  const items: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuote === '"') {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === inQuote) {
      inQuote = null;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuote) {
      items.push(unquoteYamlScalar(current));
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    items.push(unquoteYamlScalar(current));
  }
  return items;
}

export function parseAgentsYaml(
  yamlContent: string
): AgentsConfig & {
  readonly task_auto_merge_enabled?: boolean | undefined;
  readonly github_pages_human_consent?: boolean | undefined;
  readonly preview_separate_origin?: boolean | undefined;
  readonly security_overrides?: SecurityOverridesAttempt | undefined;
} {
  let harness: AgentHarness | undefined;
  let reviewers_dir: string | undefined;
  let llm_environment: string | undefined;
  const models: Partial< Record<keyof AgentsModelsConfig, string> > = {};
  const providers: Record<string, ProviderConfig> = {};
  let currentProviderAlias: string | null = null;
  let inProviderDefaultHeaders = false;
  let merge_policy: StaleBaseMergePolicy | undefined;
  let task_auto_merge_enabled: boolean | undefined;
  let max_code_fix_attempts: number | undefined;
  let max_epic_phases: number | undefined;
  let max_transient_api_retries: number | undefined;
  let transient_retry_backoff_seconds:
    | readonly [number, number, number, number]
    | undefined;
  let llm_request_timeout_seconds: number | undefined;
  let job_timeout_minutes: number | undefined;
  let review_timeout_minutes: number | undefined;
  let max_concurrent_tasks_per_feature: number | undefined;
  let trace_retention_days: number | undefined;
  let preview_retention_days: number | undefined;
  let github_pages_previews: boolean | undefined;
  let github_pages_human_consent: boolean | undefined;
  let preview_separate_origin: boolean | undefined;

  let wait_for_external_ci: boolean | undefined;
  let external_ci_timeout_minutes: number | undefined;
  let grace_window_seconds: number | undefined;
  let deferred_external_workflows: string[] | undefined;
  let hasTargetsKey = false;
  const targets: Array<{
    name?: string;
    working_directory?: string;
    kind?: VerificationTargetKind;
    path_patterns?: string[];
    install_command?: string;
    codegen_command?: string;
    typecheck_command?: string;
    lint_command?: string;
    test_command?: string;
    build_command?: string;
  }> = [];

  const securityOverrides: {
    require_write_permission?: boolean;
    sandbox_isolation?: boolean;
    allow_agent_release?: boolean;
    auto_merge_dev?: boolean;
    auto_merge_main?: boolean;
  } = {};

  const webToolsOverrides: {
    enabled?: boolean;
    phases?: Array<"plan" | "spec" | "implementation" | "review">;
    max_requests_per_turn?: number;
    max_requests_per_run?: number;
    max_bytes_per_response?: number;
    max_fetch_bytes?: number;
    timeout_ms?: number;
  } = {};

  const lines = yamlContent.split(/\r?\n/);
  let section:
    | "root"
    | "models"
    | "providers"
    | "verification"
    | "web_tools"
    | "security"
    | "other" = "root";
  let inTargets = false;
  let inDeferredWorkflows = false;
  let inCurrentTargetPathPatterns = false;
  let currentTarget: {
    name?: string;
    working_directory?: string;
    kind?: VerificationTargetKind;
    path_patterns?: string[];
    install_command?: string;
    codegen_command?: string;
    typecheck_command?: string;
    lint_command?: string;
    test_command?: string;
    build_command?: string;
  } | null = null;

  const parseBool = (raw: string): boolean | undefined => {
    const v = unquoteYamlScalar(raw).toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    return undefined;
  };

  const parseNum = (raw: string): number | undefined => {
    const n = Number.parseInt(unquoteYamlScalar(raw), 10);
    return Number.isFinite(n) ? n : undefined;
  };

  const assignTargetField = (
    targetObj: NonNullable<typeof currentTarget>,
    key: string,
    rawVal: string
  ): void => {
    const val = unquoteYamlScalar(rawVal);
    if (key === "name") {
      targetObj.name = val;
    } else if (key === "working_directory") {
      targetObj.working_directory = val;
    } else if (key === "kind") {
      targetObj.kind = val as VerificationTargetKind;
    } else if (key === "path_patterns") {
      if (rawVal.trim().startsWith("[")) {
        targetObj.path_patterns = parseYamlStringArrayInline(rawVal);
        inCurrentTargetPathPatterns = false;
      } else {
        targetObj.path_patterns = [];
        inCurrentTargetPathPatterns = true;
      }
    } else if (key === "install_command") {
      targetObj.install_command = val;
    } else if (key === "codegen_command") {
      targetObj.codegen_command = val;
    } else if (key === "typecheck_command") {
      targetObj.typecheck_command = val;
    } else if (key === "lint_command") {
      targetObj.lint_command = val;
    } else if (key === "test_command") {
      targetObj.test_command = val;
    } else if (key === "build_command") {
      targetObj.build_command = val;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = /^(\s*)/.exec(rawLine)?.[1]?.length ?? 0;

    if (indent === 0) {
      inTargets = false;
      inDeferredWorkflows = false;
      inCurrentTargetPathPatterns = false;
      currentTarget = null;
      currentProviderAlias = null;
      inProviderDefaultHeaders = false;

      const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(trimmed);
      if (!kv || !kv[1]) {
        continue;
      }
      const key = kv[1];
      const val = (kv[2] ?? "").replace(/\s+#.*$/, "").trim();

      if (key === "models" && !val) {
        section = "models";
        continue;
      }
      if (key === "providers" && !val) {
        section = "providers";
        continue;
      }
      if (key === "verification" && !val) {
        section = "verification";
        continue;
      }
      if (key === "web_tools" && !val) {
        section = "web_tools";
        continue;
      }
      if (
        (key === "security_invariants" || key === "security_overrides") &&
        !val
      ) {
        section = "security";
        continue;
      }
      section = "root";

      if (key === "harness") {
        const h = unquoteYamlScalar(val);
        if (h === "pi" || h === "codex") {
          harness = h;
        }
      } else if (key === "reviewers_dir") {
        reviewers_dir = unquoteYamlScalar(val);
      } else if (key === "llm_environment") {
        llm_environment = unquoteYamlScalar(val);
      } else if (key === "merge_policy") {
        const mp = unquoteYamlScalar(val);
        if (mp === "strict" || mp === "relaxed") {
          merge_policy = mp;
        }
      } else if (key === "task_auto_merge_enabled") {
        task_auto_merge_enabled = parseBool(val);
      } else if (key === "max_code_fix_attempts") {
        max_code_fix_attempts = parseNum(val);
      } else if (key === "max_epic_phases") {
        max_epic_phases = parseNum(val);
      } else if (key === "max_transient_api_retries") {
        max_transient_api_retries = parseNum(val);
      } else if (key === "transient_retry_backoff_seconds") {
        const nums = parseYamlStringArrayInline(val)
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isFinite(n));
        if (nums.length === 4) {
          transient_retry_backoff_seconds = [
            nums[0]!,
            nums[1]!,
            nums[2]!,
            nums[3]!
          ];
        }
      } else if (key === "llm_request_timeout_seconds") {
        llm_request_timeout_seconds = parseNum(val);
      } else if (key === "job_timeout_minutes") {
        job_timeout_minutes = parseNum(val);
      } else if (key === "review_timeout_minutes") {
        review_timeout_minutes = parseNum(val);
      } else if (key === "max_concurrent_tasks_per_feature") {
        max_concurrent_tasks_per_feature = parseNum(val);
      } else if (key === "trace_retention_days") {
        trace_retention_days = parseNum(val);
      } else if (key === "preview_retention_days") {
        preview_retention_days = parseNum(val);
      } else if (key === "github_pages_previews") {
        github_pages_previews = parseBool(val);
      } else if (key === "github_pages_human_consent") {
        github_pages_human_consent = parseBool(val);
      } else if (key === "preview_separate_origin") {
        preview_separate_origin = parseBool(val);
      }
      continue;
    }

    if (section === "models") {
      const kv = /^([a-zA-Z0-9_]+):\s*(.+)$/.exec(trimmed);
      if (kv && kv[1] && kv[2]) {
        const k = kv[1];
        const v = unquoteYamlScalar(kv[2].replace(/\s+#.*$/, ""));
        if (k === "planning" || k === "implementation" || k === "review") {
          models[k] = v;
        }
      }
      continue;
    }

    if (section === "providers") {
      if (indent === 2) {
        inProviderDefaultHeaders = false;
        const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(trimmed);
        if (kv && kv[1]) {
          currentProviderAlias = kv[1];
          providers[currentProviderAlias] = attachDualProviderConfigGetters({});
        }
        continue;
      }

      if (indent === 4 && currentProviderAlias) {
        const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(trimmed);
        if (kv && kv[1]) {
          const k = kv[1];
          const rawV = (kv[2] ?? "").replace(/\s+#.*$/, "").trim();
          const currentObj = (providers[currentProviderAlias] ?? {}) as Record<
            string,
            unknown
          >;

          if (k === "default_headers" || k === "defaultHeaders") {
            if (rawV === "{}") {
              currentObj.default_headers = {};
              inProviderDefaultHeaders = false;
            } else {
              currentObj.default_headers = {};
              inProviderDefaultHeaders = true;
            }
          } else {
            inProviderDefaultHeaders = false;
            const v = unquoteYamlScalar(rawV);
            if (k === "provider") {
              currentObj.provider = v as ProviderKind;
            } else if (k === "api_key" || k === "apiKey") {
              currentObj.api_key = v;
            } else if (k === "base_url" || k === "baseUrl") {
              currentObj.base_url = v;
            } else if (k === "api_version" || k === "apiVersion") {
              currentObj.api_version = v;
            }
          }
          providers[currentProviderAlias] =
            attachDualProviderConfigGetters(currentObj);
        }
        continue;
      }

      if (indent >= 6 && currentProviderAlias && inProviderDefaultHeaders) {
        const kv = /^([a-zA-Z0-9_.-]+|"[^"]+"|'[^']+'):\s*(.+)$/.exec(trimmed);
        if (kv && kv[1] && kv[2]) {
          const hKey = unquoteYamlScalar(kv[1]);
          const hVal = unquoteYamlScalar(kv[2].replace(/\s+#.*$/, ""));
          const currentObj = (providers[currentProviderAlias] ?? {}) as Record<
            string,
            unknown
          >;
          const headersMap = {
            ...((currentObj.default_headers as Record<string, string>) ?? {}),
            [hKey]: hVal
          };
          currentObj.default_headers = headersMap;
          providers[currentProviderAlias] =
            attachDualProviderConfigGetters(currentObj);
        }
        continue;
      }
      continue;
    }

    if (section === "web_tools") {
      const kv = /^([a-zA-Z0-9_]+):\s*(.+)$/.exec(trimmed);
      if (kv && kv[1] && kv[2]) {
        const k = kv[1];
        const rawV = kv[2].replace(/\s+#.*$/, "").trim();
        if (k === "enabled") {
          const b = parseBool(rawV);
          if (b !== undefined) webToolsOverrides.enabled = b;
        } else if (k === "phases") {
          const arr = parseYamlStringArrayInline(rawV).filter(
            (p): p is "plan" | "spec" | "implementation" | "review" =>
              p === "plan" ||
              p === "spec" ||
              p === "implementation" ||
              p === "review"
          );
          webToolsOverrides.phases = arr;
        } else if (k === "max_requests_per_turn") {
          const n = parseNum(rawV);
          if (n !== undefined) webToolsOverrides.max_requests_per_turn = n;
        } else if (k === "max_requests_per_run") {
          const n = parseNum(rawV);
          if (n !== undefined) webToolsOverrides.max_requests_per_run = n;
        } else if (k === "max_bytes_per_response") {
          const n = parseNum(rawV);
          if (n !== undefined) webToolsOverrides.max_bytes_per_response = n;
        } else if (k === "max_fetch_bytes") {
          const n = parseNum(rawV);
          if (n !== undefined) webToolsOverrides.max_fetch_bytes = n;
        } else if (k === "timeout_ms") {
          const n = parseNum(rawV);
          if (n !== undefined) webToolsOverrides.timeout_ms = n;
        }
      }
      continue;
    }

    if (section === "security") {
      const kv = /^([a-zA-Z0-9_]+):\s*(.+)$/.exec(trimmed);
      if (kv && kv[1] && kv[2]) {
        const k = kv[1];
        const b = parseBool(kv[2].replace(/\s+#.*$/, ""));
        if (b !== undefined) {
          if (k === "require_write_permission") {
            securityOverrides.require_write_permission = b;
          } else if (k === "sandbox_isolation") {
            securityOverrides.sandbox_isolation = b;
          } else if (k === "allow_agent_release") {
            securityOverrides.allow_agent_release = b;
          } else if (k === "auto_merge_dev") {
            securityOverrides.auto_merge_dev = b;
          } else if (k === "auto_merge_main") {
            securityOverrides.auto_merge_main = b;
          }
        }
      }
      continue;
    }

    if (section === "verification") {
      if (indent === 2) {
        inTargets = false;
        inDeferredWorkflows = false;
        inCurrentTargetPathPatterns = false;
        currentTarget = null;

        const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(trimmed);
        if (!kv || !kv[1]) {
          continue;
        }
        const k = kv[1];
        const v = (kv[2] ?? "").replace(/\s+#.*$/, "").trim();
        if (k === "wait_for_external_ci") {
          wait_for_external_ci = parseBool(v);
        } else if (k === "external_ci_timeout_minutes") {
          external_ci_timeout_minutes = parseNum(v);
        } else if (k === "grace_window_seconds") {
          grace_window_seconds = parseNum(v);
        } else if (k === "deferred_external_workflows") {
          if (v.startsWith("[")) {
            deferred_external_workflows = parseYamlStringArrayInline(v);
          } else {
            deferred_external_workflows = [];
            inDeferredWorkflows = true;
          }
        } else if (k === "targets") {
          hasTargetsKey = true;
          if (v === "[]") {
            inTargets = false;
          } else {
            inTargets = true;
          }
        }
        continue;
      }

      if (inDeferredWorkflows && trimmed.startsWith("-")) {
        const item = unquoteYamlScalar(trimmed.replace(/^-\s*/, ""));
        if (item) {
          deferred_external_workflows = deferred_external_workflows ?? [];
          deferred_external_workflows.push(item);
        }
        continue;
      }

      if (inTargets) {
        if (indent === 4 && trimmed.startsWith("-")) {
          inCurrentTargetPathPatterns = false;
          currentTarget = {};
          targets.push(currentTarget);
          const afterDash = trimmed.replace(/^-\s*/, "");
          const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(afterDash);
          if (kv && kv[1]) {
            assignTargetField(
              currentTarget,
              kv[1],
              (kv[2] ?? "").replace(/\s+#.*$/, "").trim()
            );
          }
          continue;
        }

        if (currentTarget) {
          if (inCurrentTargetPathPatterns && trimmed.startsWith("-")) {
            const pat = unquoteYamlScalar(trimmed.replace(/^-\s*/, ""));
            currentTarget.path_patterns = currentTarget.path_patterns ?? [];
            currentTarget.path_patterns.push(pat);
            continue;
          }

          const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(trimmed);
          if (kv && kv[1]) {
            inCurrentTargetPathPatterns = false;
            assignTargetField(
              currentTarget,
              kv[1],
              (kv[2] ?? "").replace(/\s+#.*$/, "").trim()
            );
          }
        }
      }
    }
  }

  const parsedTargets: VerificationTargetSpec[] = targets
    .filter((t) => Boolean(t.name))
    .map((t) => ({
      name: t.name ?? "root",
      working_directory: t.working_directory ?? ".",
      kind: t.kind ?? "node",
      path_patterns:
        t.path_patterns && t.path_patterns.length > 0
          ? t.path_patterns
          : ["**"],
      ...(t.install_command ? { install_command: t.install_command } : {}),
      ...(t.codegen_command ? { codegen_command: t.codegen_command } : {}),
      ...(t.typecheck_command
        ? { typecheck_command: t.typecheck_command }
        : {}),
      ...(t.lint_command ? { lint_command: t.lint_command } : {}),
      ...(t.test_command ? { test_command: t.test_command } : {}),
      ...(t.build_command ? { build_command: t.build_command } : {})
    }));

  const hasVerificationOverrides =
    wait_for_external_ci !== undefined ||
    external_ci_timeout_minutes !== undefined ||
    grace_window_seconds !== undefined ||
    deferred_external_workflows !== undefined ||
    hasTargetsKey ||
    parsedTargets.length > 0;

  const overrides: AgentsConfigOverrides = {
    ...(harness ? { harness } : {}),
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
    ...(reviewers_dir !== undefined ? { reviewers_dir } : {}),
    ...(llm_environment !== undefined ? { llm_environment } : {}),
    ...(merge_policy ? { merge_policy } : {}),
    ...(max_code_fix_attempts !== undefined ? { max_code_fix_attempts } : {}),
    ...(max_epic_phases !== undefined ? { max_epic_phases } : {}),
    ...(max_transient_api_retries !== undefined
      ? { max_transient_api_retries }
      : {}),
    ...(transient_retry_backoff_seconds
      ? { transient_retry_backoff_seconds }
      : {}),
    ...(llm_request_timeout_seconds !== undefined
      ? { llm_request_timeout_seconds }
      : {}),
    ...(job_timeout_minutes !== undefined ? { job_timeout_minutes } : {}),
    ...(review_timeout_minutes !== undefined ? { review_timeout_minutes } : {}),
    ...(max_concurrent_tasks_per_feature !== undefined
      ? { max_concurrent_tasks_per_feature }
      : {}),
    ...(trace_retention_days !== undefined ? { trace_retention_days } : {}),
    ...(preview_retention_days !== undefined ? { preview_retention_days } : {}),
    ...(github_pages_previews !== undefined ? { github_pages_previews } : {}),
    ...(github_pages_human_consent !== undefined
      ? { github_pages_human_consent }
      : {}),
    ...(preview_separate_origin !== undefined
      ? { preview_separate_origin }
      : {}),
    ...(hasVerificationOverrides
      ? {
          verification: {
            ...(wait_for_external_ci !== undefined
              ? { wait_for_external_ci }
              : {}),
            ...(external_ci_timeout_minutes !== undefined
              ? { external_ci_timeout_minutes }
              : {}),
            ...(grace_window_seconds !== undefined
              ? { grace_window_seconds }
              : {}),
            ...(deferred_external_workflows !== undefined
              ? { deferred_external_workflows }
              : {}),
            ...(hasTargetsKey || parsedTargets.length > 0
              ? { targets: parsedTargets }
              : {})
          }
        }
      : {}),
    ...(Object.keys(webToolsOverrides).length > 0
      ? { web_tools: webToolsOverrides }
      : {}),
    ...(Object.keys(securityOverrides).length > 0
      ? { security_overrides: securityOverrides }
      : {})
  };

  const resolved = resolveAgentsConfig(overrides);
  return {
    ...resolved.config,
    max_epic_phases: resolved.config.max_epic_phases ?? 2,
    ...(task_auto_merge_enabled !== undefined
      ? { task_auto_merge_enabled }
      : {}),
    ...(github_pages_human_consent !== undefined
      ? { github_pages_human_consent }
      : {}),
    ...(preview_separate_origin !== undefined
      ? { preview_separate_origin }
      : {}),
    ...(Object.keys(securityOverrides).length > 0
      ? { security_overrides: securityOverrides }
      : {})
  };
}

export const parseAgentsYml = parseAgentsYaml;

function buildCallerWorkflows(
  pinnedSha: string,
  stack: DetectedStackProfile,
  jobTimeoutMinutes: number = DEFAULT_AGENTS_CONFIG.job_timeout_minutes,
  llmEnvironment: string = DEFAULT_AGENTS_CONFIG.llm_environment
): ReadonlyArray<{
  readonly path: string;
  readonly content: string;
}> {
  const ciWorkflow = buildStackAwareCiWorkflowYaml({ pinnedSha, stack });
  return [
    {
      path: ".github/workflows/epure-issue-command.yml",
      content: [
        'name: "EPURE Issue Command Gate"',
        "on:",
        "  issue_comment:",
        "    types: [created]",
        "  check_suite:",
        "    types: [completed]",
        "  workflow_run:",
        '    workflows: ["CI"]',
        "    types: [completed]",
        "concurrency:",
        "  group: epure-issue-gate-${{ github.event.issue.number || github.event.check_suite.head_sha || github.event.workflow_run.head_sha }}-${{ github.event.comment.id || github.run_id }}",
        "  cancel-in-progress: false",
        "permissions: {}",
        "jobs:",
        "  authorize-command:",
        '    name: "Authorize /epure Issue Command"',
        "    if: ${{ github.event_name == 'issue_comment' }}",
        "    runs-on: ubuntu-26.04",
        "    timeout-minutes: 10",
        "    permissions:",
        "      contents: read # read repository metadata and collaborator permission level",
        "      issues: write # post authorization rejection comment when unauthorized",
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
        "    needs: [authorize-command]",
        "    if: ${{ always() && (needs.authorize-command.outputs.authorized == 'true' || ((github.event_name == 'check_suite' || github.event_name == 'workflow_run') && (startsWith(github.event.check_suite.head_branch, 'task/') || startsWith(github.event.check_suite.head_branch, 'feature/') || startsWith(github.event.workflow_run.head_branch, 'task/') || startsWith(github.event.workflow_run.head_branch, 'feature/')))) }}",
        "    runs-on: ubuntu-26.04",
        `    timeout-minutes: ${jobTimeoutMinutes}`,
        `    environment: ${llmEnvironment}`,
        "    concurrency:",
        "      group: epure-issue-${{ github.event.issue.number || github.event.check_suite.head_branch || github.event.workflow_run.head_branch || github.run_id }}",
        "      cancel-in-progress: false",
        "    permissions:",
        "      contents: write # push task/feature branches and update refs/epure/state/*",
        "      issues: write # create child tickets and post state mirror comments",
        "      pull-requests: write # open, review, and squash-merge task PRs",
        "      checks: write # publish ai-review, impeccable-gate, and PR title check runs",
        "    steps:",
        ...buildSandboxToolingSetupSteps(),
        "      - name: Run pre-bundled EPURE issue orchestrator",
        "        id: orchestrate",
        `        uses: Giskard-AI/epure/actions/orchestrate-issue@${pinnedSha} # v1.1.0`,
        "        with:",
        "          repository: ${{ github.repository }}",
        "          issue_number: ${{ github.event.issue.number || 0 }}",
        "          command: ${{ github.event_name == 'issue_comment' && needs.authorize-command.outputs.command || 'continue' }}",
        "          command_args: ${{ needs.authorize-command.outputs.command_args || '' }}",
        "          comment_id: ${{ github.event.comment.id || 0 }}",
        "          actor: ${{ github.event.comment.user.login || github.actor }}",
        "          trigger_head_sha: ${{ github.event.check_suite.head_sha || github.event.workflow_run.head_sha || '' }}",
        "          trigger_branch: ${{ github.event.check_suite.head_branch || github.event.workflow_run.head_branch || '' }}",
        "          async_ci_continuation: 'true'",
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
        "concurrency:",
        "  group: ${{ github.workflow }}-${{ github.ref }}",
        "  cancel-in-progress: true",
        "permissions:",
        "  contents: read # read consumer workflow contract",
        "jobs:",
        "  verify-contract:",
        '    name: "Verify EPURE Consumer Contract"',
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
        "concurrency:",
        "  group: ${{ github.workflow }}-${{ github.ref }}",
        "  cancel-in-progress: true",
        "permissions:",
        "  contents: read # read pull request metadata",
        "jobs:",
        "  pr-title:",
        '    name: "PR title"',
        "    runs-on: ubuntu-26.04",
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
    ciWorkflow,
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
        "concurrency:",
        "  group: epure-release-${{ github.ref }}",
        "  cancel-in-progress: false",
        "permissions: {}",
        "jobs:",
        "  release:",
        '    name: "Release Promotion (dev -> main)"',
        "    runs-on: ubuntu-26.04",
        "    timeout-minutes: 30",
        "    environment: release",
        "    permissions:",
        "      contents: write # promote dev to main and push immutable release tag",
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
    "ai-review",
    "Quality (Format, Lint, Typecheck, Test & Build)",
    "Zizmor"
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
      requiredChecks: ["verify-contract", "PR title", "ai-review", "Quality (Format, Lint, Typecheck, Test & Build)", "Zizmor"],
      requireHumanApproval: true,
      allowedMergeMethods: ["squash"],
      allowMergeCommit: false,
      allowRebaseMerge: false
    },
    {
      pattern: "feature/*",
      requirePullRequest: true,
      requireStatusChecks: true,
      requiredChecks: ["verify-contract", "PR title", "ai-review", "Quality (Format, Lint, Typecheck, Test & Build)", "Zizmor"],
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

  const detectedStack = detectRepositoryStack({
    repoRootDir: input.repoRootDir
  });

  // Load existing .github/agents.yml if present to preserve user-customized verification.targets on re-run
  let existingVerification: VerificationProfile | undefined;
  let existingProviders: Readonly<Record<string, ProviderConfig>> | undefined;
  let existingLlmRequestTimeoutSeconds: number | undefined;
  let existingReviewersDir: string | undefined;
  let existingLlmEnvironment: string | undefined;
  let existingModels: AgentsModelsConfig | undefined;
  if (
    input.repoRootDir &&
    existsSync(join(input.repoRootDir, ".github", "agents.yml"))
  ) {
    try {
      const existingRaw = readFileSync(
        join(input.repoRootDir, ".github", "agents.yml"),
        "utf8"
      );
      const parsedExisting = parseAgentsYaml(existingRaw);
      existingVerification = parsedExisting.verification;
      existingProviders = parsedExisting.providers;
      existingLlmRequestTimeoutSeconds =
        parsedExisting.llm_request_timeout_seconds;
      existingReviewersDir = parsedExisting.reviewers_dir;
      existingLlmEnvironment = parsedExisting.llm_environment;
      existingModels = parsedExisting.models;
    } catch {
      existingVerification = undefined;
      existingProviders = undefined;
      existingLlmRequestTimeoutSeconds = undefined;
      existingReviewersDir = undefined;
      existingLlmEnvironment = undefined;
      existingModels = undefined;
    }
  }

  const resetTargets =
    input.agentsOverrides?.reset_verification_targets === true;
  const overrideVerification = input.agentsOverrides?.verification;
  const discoveredVerification = detectedStack.verification;

  let mergedTargets: VerificationTargetSpec[];
  if (overrideVerification?.targets) {
    if (
      resetTargets ||
      !existingVerification ||
      existingVerification.targets.length === 0
    ) {
      mergedTargets = overrideVerification.targets.map(
        normalizeVerificationTarget
      );
    } else {
      const targetMap = new Map<string, VerificationTargetSpec>();
      for (const t of existingVerification.targets) {
        targetMap.set(t.name, normalizeVerificationTarget(t));
      }
      for (const t of overrideVerification.targets) {
        targetMap.set(t.name, normalizeVerificationTarget(t));
      }
      mergedTargets = Array.from(targetMap.values());
    }
  } else if (
    !resetTargets &&
    existingVerification &&
    existingVerification.targets.length > 0
  ) {
    const targetMap = new Map<string, VerificationTargetSpec>();
    for (const t of existingVerification.targets) {
      targetMap.set(t.name, normalizeVerificationTarget(t));
    }
    for (const t of discoveredVerification.targets) {
      if (!targetMap.has(t.name)) {
        targetMap.set(t.name, normalizeVerificationTarget(t));
      }
    }
    mergedTargets = Array.from(targetMap.values());
  } else {
    mergedTargets = discoveredVerification.targets.map(
      normalizeVerificationTarget
    );
  }

  const deferredSet = new Set<string>();
  if (overrideVerification?.deferred_external_workflows) {
    for (const w of overrideVerification.deferred_external_workflows) {
      deferredSet.add(w);
    }
  } else {
    if (!resetTargets && existingVerification?.deferred_external_workflows) {
      for (const w of existingVerification.deferred_external_workflows) {
        deferredSet.add(w);
      }
    }
    if (discoveredVerification.deferred_external_workflows) {
      for (const w of discoveredVerification.deferred_external_workflows) {
        deferredSet.add(w);
      }
    }
  }

  const effectiveVerification: VerificationProfile = {
    wait_for_external_ci:
      overrideVerification?.wait_for_external_ci ??
      existingVerification?.wait_for_external_ci ??
      discoveredVerification.wait_for_external_ci,
    external_ci_timeout_minutes:
      overrideVerification?.external_ci_timeout_minutes ??
      existingVerification?.external_ci_timeout_minutes ??
      discoveredVerification.external_ci_timeout_minutes,
    grace_window_seconds:
      overrideVerification?.grace_window_seconds ??
      existingVerification?.grace_window_seconds ??
      discoveredVerification.grace_window_seconds,
    ...(deferredSet.size > 0
      ? { deferred_external_workflows: Array.from(deferredSet) }
      : {}),
    targets: mergedTargets
  };

  const effectiveProviders =
    resolvedConfig.config.providers ?? existingProviders;
  const effectiveLlmRequestTimeoutSeconds =
    input.agentsOverrides?.llm_request_timeout_seconds !== undefined
      ? resolvedConfig.config.llm_request_timeout_seconds
      : (existingLlmRequestTimeoutSeconds ??
        resolvedConfig.config.llm_request_timeout_seconds);

  const overrideModels = input.agentsOverrides?.models;
  const effectiveAgentsConfig: AgentsConfig = {
    ...resolvedConfig.config,
    models: {
      planning:
        overrideModels?.planning ??
        existingModels?.planning ??
        resolvedConfig.config.models.planning,
      implementation:
        overrideModels?.implementation ??
        existingModels?.implementation ??
        resolvedConfig.config.models.implementation,
      review:
        overrideModels?.review ??
        existingModels?.review ??
        resolvedConfig.config.models.review
    },
    reviewers_dir:
      input.agentsOverrides?.reviewers_dir !== undefined
        ? resolvedConfig.config.reviewers_dir
        : (existingReviewersDir ?? resolvedConfig.config.reviewers_dir),
    llm_environment:
      input.agentsOverrides?.llm_environment !== undefined
        ? resolvedConfig.config.llm_environment
        : (existingLlmEnvironment ?? resolvedConfig.config.llm_environment),
    llm_request_timeout_seconds: effectiveLlmRequestTimeoutSeconds,
    ...(effectiveProviders ? { providers: effectiveProviders } : {}),
    verification: effectiveVerification
  };

  const agentsYamlContent = serializeAgentsConfigYaml(
    effectiveAgentsConfig,
    taskAutoMergeEnabled
  );
  const agentsConfigAction = computeFilePlanAction(
    input.repoRootDir,
    ".github/agents.yml",
    agentsYamlContent
  );

  const zizmorConfig = buildZizmorConfigYaml();
  const renovateConfig = buildRenovateConfigJson(detectedStack);
  const zizmorAction = computeFilePlanAction(
    input.repoRootDir,
    zizmorConfig.path,
    zizmorConfig.content
  );
  const renovateAction = computeFilePlanAction(
    input.repoRootDir,
    renovateConfig.path,
    renovateConfig.content
  );

  const workflowTemplates = buildCallerWorkflows(
    pinnedSha,
    detectedStack,
    effectiveAgentsConfig.job_timeout_minutes,
    effectiveAgentsConfig.llm_environment
  );
  const plannedWorkflows: PlannedWorkflowFile[] = workflowTemplates.map((wf) => ({
    path: wf.path,
    action: computeFilePlanAction(input.repoRootDir, wf.path, wf.content),
    content: wf.content
  }));

  const rosterTemplates = buildDefaultReviewerRosterFiles({
    repository,
    stackKind: detectedStack.kind,
    includeFrontendReviewers: input.includeFrontendReviewers,
    customDomainSpecialists: input.customDomainSpecialists,
    reviewersDir: effectiveAgentsConfig.reviewers_dir
  });
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
    if (zizmorAction !== "noop") {
      const targetPath = join(input.repoRootDir, zizmorConfig.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, zizmorConfig.content, "utf8");
      mutatedFiles.push(zizmorConfig.path);
    }
    if (renovateAction !== "noop") {
      const targetPath = join(input.repoRootDir, renovateConfig.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, renovateConfig.content, "utf8");
      mutatedFiles.push(renovateConfig.path);
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

  const deferredWorkflowsList =
    effectiveVerification.deferred_external_workflows ?? [];
  const targetTableRows = effectiveVerification.targets.map((t) => {
    const stage1Cmds = [
      t.install_command ? `install: \`${t.install_command}\`` : null,
      t.codegen_command ? `codegen: \`${t.codegen_command}\`` : null,
      t.typecheck_command ? `typecheck: \`${t.typecheck_command}\`` : null,
      t.lint_command ? `lint: \`${t.lint_command}\`` : null,
      t.test_command ? `test: \`${t.test_command}\`` : null,
      t.build_command ? `build: \`${t.build_command}\`` : null
    ]
      .filter((item): item is string => Boolean(item))
      .join(", ");
    const patternsStr = t.path_patterns.map((p) => `\`${p}\``).join(", ");
    return `| \`${t.name}\` | \`${t.kind}\` | \`${t.working_directory}\` | ${patternsStr} | ${stage1Cmds || "none"} |`;
  });

  const summaryMarkdown = [
    `### EPURE setup-repo (${dryRun ? "Dry-Run Simulation" : "Guided Application"})`,
    `- **Repository**: \`${repository}\``,
    `- **Merge Governance**: \`squash-only\` (\`allow_merge_commit=false\`, \`allow_rebase_merge=false\`, \`delete_branch_on_merge=true\`)`,
    `- **Agents Config (\`.github/agents.yml\`)**: \`${agentsConfigAction}\` (harness=\`${effectiveAgentsConfig.harness}\`, merge_policy=\`${effectiveAgentsConfig.merge_policy}\`)`,
    `- **Reviewer Roster (\`${effectiveAgentsConfig.reviewers_dir}/*.md\`)**: \`${plannedReviewerRoster.length}\` agents (specialists + cross-cutting + \`user-advocate\`)`,
    `- **Task Auto-Merge Enabled**: \`${taskAutoMergeEnabled}\` (${autoMergeWarningCode})`,
    `- **Governance Rulesets**: ${governanceRulesets.map((r) => `\`${r.name}\``).join(", ")}`,
    `- **Deferred External Workflows**: ${deferredWorkflowsList.length > 0 ? deferredWorkflowsList.map((w) => `\`${w}\``).join(", ") : "none"}`,
    `- **Mutated Files**: ${mutatedFiles.length > 0 ? mutatedFiles.map((f) => `\`${f}\``).join(", ") : "none"}`,
    "",
    "#### Discovered Verification Targets (`verification.targets`)",
    "| Name | Kind | Working Directory | Path Patterns | Stage 1 Commands |",
    "| :--- | :--- | :--- | :--- | :--- |",
    ...targetTableRows
  ].join("\n");

  return {
    status: dryRun ? "dry_run" : "applied",
    dry_run: dryRun,
    error_code: "NONE",
    error_message: "",
    repository,
    agents_config: effectiveAgentsConfig,
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
