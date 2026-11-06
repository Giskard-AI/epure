import type { EpureCommandName } from "../auth/issue-command-gate.js";
import type {
  AgentsConfig,
  AgentsModelsConfig,
  ParsedAgentsConfig
} from "../bootstrap/setup-repo.js";
import type {
  CheckRunAnnotationRecord,
  EpicConvergenceEscalationDetails,
  ExternalCheckRunRecord,
  ExternalWorkflowRunRecord,
  NeedsHumanEscalationReason,
  WaitForExternalCiChecksResult
} from "../execution/external-ci-gate.js";
import type { ReviewerFinding } from "../review/multi-agent-pr-review.js";
import type {
  SandboxExecutionInput,
  SandboxExecutionResult
} from "../sandbox/llm-sandbox.js";
import type {
  EpureIssueState,
  GitRefStateStore
} from "../state/git-ref-state.js";

export {
  ADR_COHERENCE_RECONCILIATION_SCHEMA,
  CONFLICT_RESOLUTION_SCHEMA,
  EPIC_CONVERGENCE_AUDIT_SCHEMA,
  GENERATED_PLANNING_BUNDLE_SCHEMA,
  GENERATED_SPEC_ARTIFACTS_SCHEMA,
  GENERATED_TICKET_DAG_SCHEMA,
  GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
  GOLDFISH_SPEC_AUDIT_SCHEMA,
  GRILL_ROUND_EVALUATION_SCHEMA,
  REVIEWER_FINDINGS_SCHEMA,
  SQUASH_COMMIT_SCHEMA,
  USER_ADVOCATE_SCHEMA,
  createGeneratedTicketImplementationSchema,
  parseOptionalEpicGoalContract,
  type AdrCoherenceReconciliationPayload,
  type ConflictResolutionPayload,
  type CreateGeneratedTicketImplementationSchemaOptions,
  type EpicConvergenceAuditPayload,
  type EpicGoalContract,
  type GeneratedAdrDocument,
  type GeneratedFileChange,
  type GeneratedFilePatch,
  type GeneratedFilePatchEdit,
  type GeneratedPlanningBundle,
  type GeneratedSpecArtifacts,
  type GeneratedTicketDag,
  type GeneratedTicketFilePatch,
  type GeneratedTicketImplementation,
  type GeneratedTicketPatchEdit,
  type GeneratedTicketSpec,
  type GoldfishSpecAuditPayload,
  type GrillRoundEvaluation,
  type PlannedTicketDefinition,
  type ReviewerFindingPayloadItem,
  type ReviewerFindingsPayload,
  type ReviewerLlmFindingItem,
  type SquashCommitLlmPayload,
  type SquashCommitPayload,
  type UserAdvocateLlmPayload,
  type UserAdvocatePayload
} from "./prompts/schemas.js";

/** `closed` is the internal command for an `issues: closed` event, never a `/epure` comment. */
export type OrchestratorCommand = EpureCommandName | "closed";

export interface IssueCommentRecord {
  readonly id: number;
  readonly body: string;
  readonly user: {
    readonly login: string;
    readonly type?: string | undefined;
  };
  readonly created_at: string;
  readonly author_association?: string | undefined;
  readonly performed_via_github_app?: GitHubAppRef | null | undefined;
}

export interface GitHubAppRef {
  readonly id?: number | undefined;
  readonly slug?: string | undefined;
}

export type IssueCommentSummary = IssueCommentRecord;

export type CollaboratorPermission =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none";

export interface IssueMetadata {
  readonly id?: number | undefined;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state?: string | undefined;
  readonly state_reason?:
    | "completed"
    | "not_planned"
    | "reopened"
    | null
    | undefined;
  readonly user?: { readonly login: string } | undefined;
  readonly performed_via_github_app?: GitHubAppRef | null | undefined;
  readonly is_pull_request?: boolean | undefined;
}

export interface TrackedTicketCommentMetadata {
  ticketIssueNumber: number;
  slug: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  blockedByIssueNumbers: number[];
  filesToTouch: string[];
  phase?: number | undefined;
}

export interface CreatedTicketRecord {
  readonly ticketIssueNumber: number;
  readonly slug: string;
  readonly title: string;
}

export interface ExecutedTicketRecord {
  readonly ticketIssueNumber: number;
  readonly prNumber: number;
  readonly merged: boolean;
}

export interface OrchestrateIssueInput {
  readonly repository: string;
  readonly issueNumber: number;
  readonly command: OrchestratorCommand;
  readonly commandArgs: string;
  readonly commentId?: number | undefined;
  readonly actor: string;
  readonly agentAppId?: string | undefined;
  readonly agentAppPrivateKey?: string | undefined;
  readonly fallbackGithubToken?: string | undefined;
  readonly llmApiKey: string;
  readonly model?: string | undefined;
  readonly stateStore?: GitRefStateStore | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly asyncCiContinuation?: boolean | undefined;
  readonly triggerHeadSha?: string | undefined;
  // Identifies this run in the plan's lease (`claimed_by_run_id`); a random id when absent.
  readonly runId?: string | undefined;
  // The Actions job running this command: the lease lasts the `timeout-minutes` GitHub enforces on it.
  readonly workflowJob?: WorkflowJobRef | undefined;
}

export interface WorkflowJobRef {
  readonly path: string;
  readonly ref: string;
  readonly jobId: string;
}

export type IssueOrchestratorInput = OrchestrateIssueInput;

export interface OrchestrateIssueResult {
  readonly executed: boolean;
  readonly phase: string;
  readonly status: string;
  readonly active_branch: string;
  readonly summary_markdown: string;
  readonly created_ticket_numbers: readonly number[];
  readonly feature_pr_url: string;
}

export type IssueOrchestratorResult = OrchestrateIssueResult;

export interface GitBlobRef {
  readonly sha: string;
  readonly mode: string;
}

export interface GitHubRestHelper {
  readonly token: string;
  getIssue(issueNumber: number): Promise<IssueMetadata>;
  listIssueComments(issueNumber: number): Promise<IssueCommentRecord[]>;
  getCollaboratorPermission(username: string): Promise<CollaboratorPermission>;
  postIssueComment(issueNumber: number, body: string): Promise<string>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  addIssueLabels(issueNumber: number, labels: readonly string[]): Promise<void>;
  removeIssueLabel?(issueNumber: number, label: string): Promise<void>;
  createIssue(params: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ id?: number | undefined; number: number; html_url: string }>;
  updateIssue?(
    issueNumber: number,
    params: {
      title?: string | undefined;
      body?: string | undefined;
      state?: "open" | "closed" | undefined;
    }
  ): Promise<void>;
  addSubIssue?(
    parentIssueNumber: number,
    subIssueDatabaseId: number
  ): Promise<void>;
  listSubIssueNumbers?(parentIssueNumber: number): Promise<number[]>;
  addIssueBlockedByDependency?(
    issueNumber: number,
    blockerDatabaseId: number
  ): Promise<void>;
  closeIssue(
    issueNumber: number,
    stateReason?: "completed" | "not_planned"
  ): Promise<void>;
  getDefaultBranchSha(branch: string): Promise<string | null>;
  listBranchPaths(branch: string): Promise<string[]>;
  // Partial (with a warning) when GitHub truncates the tree: hints and prompt context only, never absence checks.
  listBranchPathHints(branch: string): Promise<string[]>;
  // Path -> blob of every file at a branch or commit SHA (empty when the ref does not exist).
  listBranchBlobs(
    branchOrSha: string
  ): Promise<ReadonlyMap<string, GitBlobRef>>;
  readSingleBranchFile(
    branch: string,
    filePath: string
  ): Promise<string | null>;
  readBranchWorkspaceFiles(
    branch: string,
    hintText?: string,
    pinnedPaths?: readonly string[],
    reviewersDir?: string
  ): Promise<Map<string, string>>;
  readTrustedBaseRosterFiles(
    branch: string,
    reviewersDir?: string
  ): Promise<Map<string, string>>;
  readDevWorkflowsMap(branch: string): Promise<Map<string, string>>;
  ensureBranch(branch: string, fromBranch?: string): Promise<string>;
  commitFilesToBranch(params: {
    branch: string;
    fromBranch?: string;
    commitMessage: string;
    files: ReadonlyArray<{ path: string; content: string }>;
    // Files committed as the existing blob (SHA and mode kept), e.g. base-only files carried by a sync merge.
    readonly blobs?: ReadonlyArray<{ readonly path: string } & GitBlobRef> | undefined;
    readonly deletedFiles?: readonly string[] | undefined;
    // Second parent: the commit is then a merge commit, so Git records `mergeParentSha` as merged.
    readonly mergeParentSha?: string | undefined;
  }): Promise<string>;
  listPullRequestFiles(
    prNumber: number
  ): Promise<
    ReadonlyArray<{
      readonly filename: string;
      readonly status: string;
      readonly patch?: string | undefined;
    }>
  >;
  findOpenPullRequestByHead(
    headBranch: string,
    baseBranch: string
  ): Promise<{
    number: number;
    html_url: string;
    head_sha: string;
    title: string;
    body: string;
  } | null>;
  findMergedPullRequestByHead(
    headBranch: string,
    baseBranch: string
  ): Promise<{ number: number; html_url: string } | null>;
  listOpenPullRequestsByBase(
    baseBranch: string
  ): Promise<ReadonlyArray<{ number: number; html_url: string }>>;
  listBranchesByPrefix(prefix: string): Promise<string[]>;
  openPullRequest(params: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; html_url: string; head_sha: string }>;
  updatePullRequest(
    prNumber: number,
    params: {
      title?: string | undefined;
      body?: string | undefined;
      state?: "open" | "closed" | undefined;
    }
  ): Promise<{ head_sha: string }>;
  mergeBranches?(params: {
    base: string;
    head: string;
    commitMessage?: string | undefined;
  }): Promise<{
    status: "merged" | "up_to_date" | "conflict";
    sha: string;
  }>;
  // Throws when GitHub returns no merge base (unknown ref or unrelated histories).
  compareCommits(
    base: string,
    head: string
  ): Promise<{
    mergeBaseSha: string;
    changedFiles: readonly string[];
    aheadBy: number;
  }>;
  postPullRequestReview(
    prNumber: number,
    params: { commitId: string; body: string }
  ): Promise<void>;
  // GitHub `mergeable_state` (`dirty` = merge conflicts; `unknown` while GitHub computes it).
  getPullRequestMergeableState(prNumber: number): Promise<string>;
  // Squash-merges only if the head is still `expectedHeadSha`: throws `PullRequestHeadMovedError` (HTTP 409)
  // otherwise, and `PullRequestNotMergeableError` when GitHub refuses the merge (HTTP 405).
  mergePullRequest(
    prNumber: number,
    params: {
      headBranch: string;
      baseBranch: string;
      expectedHeadSha: string;
      commitTitle: string;
      commitMessage?: string | undefined;
    }
  ): Promise<void>;
  publishCheckRun(params: {
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    summary: string;
  }): Promise<void>;
  listWorkflowRunsForSha(
    headSha: string
  ): Promise<readonly ExternalWorkflowRunRecord[]>;
  listCheckRunsForRef(
    headSha: string
  ): Promise<readonly ExternalCheckRunRecord[]>;
  listCheckRunAnnotations(
    checkRunId: number
  ): Promise<readonly CheckRunAnnotationRecord[]>;
  getActionJobLogs(jobId: number): Promise<string>;
  rerunFailedWorkflowJobs(runId: number): Promise<void>;
}

export interface EscalateToNeedsHumanParams {
  reason: NeedsHumanEscalationReason;
  ticketNumber: number;
  branch: string;
  phase?: EpureIssueState["phase"] | undefined;
  prNumber?: number | undefined;
  prUrl?: string | undefined;
  featurePrUrl?: string | undefined;
  codeFixAttemptsUsed?: number | undefined;
  budgetScope?: "ticket" | "feature" | undefined;
  failedChecks?: WaitForExternalCiChecksResult["failedChecks"] | undefined;
  mustFixFindings?: ReadonlyArray<ReviewerFinding> | undefined;
  sensitivePaths?: ReadonlyArray<string> | undefined;
  traversalPaths?: ReadonlyArray<string> | undefined;
  diagnosticExcerpt?: string | undefined;
  epicConvergenceDetails?: EpicConvergenceEscalationDetails | undefined;
}

export type { EpicConvergenceEscalationDetails };

export type EscalateToNeedsHumanFn = (
  params: EscalateToNeedsHumanParams
) => Promise<OrchestrateIssueResult>;

export interface ResolvedPhaseModels {
  readonly planningModel: string;
  readonly implementationModel: string;
  readonly reviewModel: string;
  readonly providers?: AgentsConfig["providers"] | undefined;
  readonly maxTransientRetries?: number | undefined;
  readonly transientRetryBackoffSeconds?: readonly number[] | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

export type ModelConfigKey = `models.${keyof AgentsModelsConfig}`;

export class MissingModelConfigError extends Error {
  readonly missingKeys: readonly ModelConfigKey[];

  constructor(missingKeys: readonly ModelConfigKey[]) {
    super(
      `Missing LLM model configuration: set ${missingKeys.map((k) => `'${k}'`).join(", ")} in .github/agents.yml (or the action 'model' input). EPURE has no fallback model.`
    );
    this.name = "MissingModelConfigError";
    this.missingKeys = missingKeys;
  }
}

const MODEL_PHASES = [
  "planning",
  "implementation",
  "review"
] as const satisfies readonly (keyof AgentsModelsConfig)[];

export function resolvePhaseModels(
  inputModel: string | undefined,
  agentsConfig: ParsedAgentsConfig | null | undefined
): ResolvedPhaseModels {
  const override = inputModel?.trim();
  const pickModel = (phase: keyof AgentsModelsConfig): string =>
    override || agentsConfig?.models[phase]?.trim() || "";
  const models: AgentsModelsConfig = {
    planning: pickModel("planning"),
    implementation: pickModel("implementation"),
    review: pickModel("review")
  };
  const missingKeys = MODEL_PHASES.filter((phase) => !models[phase]).map(
    (phase) => `models.${phase}` as const
  );
  if (missingKeys.length > 0) {
    throw new MissingModelConfigError(missingKeys);
  }

  const providers = agentsConfig?.providers;
  const maxTransientRetries = agentsConfig?.max_transient_api_retries;
  const transientRetryBackoffSeconds =
    agentsConfig?.transient_retry_backoff_seconds;
  const requestTimeoutMs =
    agentsConfig?.llm_request_timeout_seconds !== undefined &&
    agentsConfig.llm_request_timeout_seconds > 0
      ? agentsConfig.llm_request_timeout_seconds * 1000
      : 900_000;

  return {
    planningModel: models.planning,
    implementationModel: models.implementation,
    reviewModel: models.review,
    requestTimeoutMs,
    ...(providers ? { providers } : {}),
    ...(maxTransientRetries !== undefined ? { maxTransientRetries } : {}),
    ...(transientRetryBackoffSeconds !== undefined
      ? { transientRetryBackoffSeconds }
      : {})
  };
}

export type { EpureIssueState, GitRefStateStore };
