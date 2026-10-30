import type { EpureCommandName } from "../auth/issue-command-gate.js";
import type { AgentsConfig } from "../bootstrap/setup-repo.js";
import type {
  CheckRunAnnotationRecord,
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
  CONFLICT_RESOLUTION_SCHEMA,
  GENERATED_PLANNING_BUNDLE_SCHEMA,
  GENERATED_SPEC_ARTIFACTS_SCHEMA,
  GENERATED_TICKET_DAG_SCHEMA,
  GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
  GOLDFISH_SPEC_AUDIT_SCHEMA,
  GRILL_ROUND_EVALUATION_SCHEMA,
  REVIEWER_FINDINGS_SCHEMA,
  SQUASH_COMMIT_SCHEMA,
  USER_ADVOCATE_SCHEMA,
  type ConflictResolutionPayload,
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

export type OrchestratorCommand = EpureCommandName;

export interface IssueCommentRecord {
  readonly id: number;
  readonly body: string;
  readonly user: {
    readonly login: string;
    readonly type?: string | undefined;
  };
  readonly created_at: string;
}

export type IssueCommentSummary = IssueCommentRecord;

export interface IssueMetadata {
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
}

export interface TrackedTicketCommentMetadata {
  ticketIssueNumber: number;
  slug: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  blockedByIssueNumbers: number[];
  filesToTouch: string[];
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
  readonly command: EpureCommandName;
  readonly commandArgs: string;
  readonly commentId?: number | undefined;
  readonly actor: string;
  readonly agentAppId?: string | undefined;
  readonly agentAppPrivateKey?: string | undefined;
  readonly fallbackGithubToken?: string | undefined;
  readonly llmApiKey: string;
  readonly model?: string | undefined;
  readonly geminiModel?: string | undefined;
  readonly stateStore?: GitRefStateStore | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly asyncCiContinuation?: boolean | undefined;
  readonly triggerHeadSha?: string | undefined;
  readonly triggerBranch?: string | undefined;
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

export interface GitHubRestHelper {
  readonly token: string;
  getIssue(issueNumber: number): Promise<IssueMetadata>;
  listIssueComments(issueNumber: number): Promise<IssueCommentRecord[]>;
  postIssueComment(issueNumber: number, body: string): Promise<string>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  addIssueLabels(issueNumber: number, labels: readonly string[]): Promise<void>;
  removeIssueLabel?(issueNumber: number, label: string): Promise<void>;
  createIssue(params: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; html_url: string }>;
  closeIssue(issueNumber: number): Promise<void>;
  getDefaultBranchSha(branch: string): Promise<string | null>;
  listBranchPaths(branch: string): Promise<string[]>;
  readSingleBranchFile(
    branch: string,
    filePath: string
  ): Promise<string | null>;
  readBranchWorkspaceFiles(
    branch: string,
    hintText?: string
  ): Promise<Map<string, string>>;
  readTrustedBaseRosterFiles(branch: string): Promise<Map<string, string>>;
  readDevWorkflowsMap(branch: string): Promise<Map<string, string>>;
  ensureBranch(branch: string, fromBranch?: string): Promise<string>;
  commitFilesToBranch(params: {
    branch: string;
    fromBranch?: string;
    commitMessage: string;
    files: ReadonlyArray<{ path: string; content: string }>;
    readonly deletedFiles?: readonly string[] | undefined;
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
  compareCommits?(
    base: string,
    head: string
  ): Promise<{
    mergeBaseSha: string;
    changedFiles: readonly string[];
  }>;
  postPullRequestReview(
    prNumber: number,
    params: { commitId: string; body: string }
  ): Promise<void>;
  mergePullRequest(
    prNumber: number,
    params: {
      headBranch: string;
      baseBranch: string;
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
  failedChecks?: WaitForExternalCiChecksResult["failedChecks"] | undefined;
  mustFixFindings?: ReadonlyArray<ReviewerFinding> | undefined;
  sensitivePaths?: ReadonlyArray<string> | undefined;
  traversalPaths?: ReadonlyArray<string> | undefined;
  diagnosticExcerpt?: string | undefined;
}

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

function canUsePhaseModelFromConfig(
  candidateModel: string | undefined,
  hasProvidersMap: boolean
): boolean {
  if (!candidateModel || candidateModel.trim().length === 0) {
    return false;
  }
  const clean = candidateModel.trim();
  if (hasProvidersMap || clean.includes("/")) {
    return true;
  }
  const lower = clean.toLowerCase();
  if (lower.startsWith("gemini-")) {
    return true;
  }
  if (lower.startsWith("claude-")) {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  }
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  }
  return false;
}

export function resolvePhaseModels(
  inputModel: string | undefined,
  agentsConfig: AgentsConfig | null | undefined
): ResolvedPhaseModels {
  const fallbackModel = inputModel?.trim() || "gemini-3.8-flash";
  const explicitOverride = Boolean(inputModel && inputModel.trim().length > 0);
  const providers = agentsConfig?.providers;
  const maxTransientRetries = agentsConfig?.max_transient_api_retries;
  const transientRetryBackoffSeconds =
    agentsConfig?.transient_retry_backoff_seconds;
  const requestTimeoutMs =
    agentsConfig?.llm_request_timeout_seconds !== undefined &&
    agentsConfig.llm_request_timeout_seconds > 0
      ? agentsConfig.llm_request_timeout_seconds * 1000
      : 900_000;
  const hasProvidersMap = Boolean(
    providers && Object.keys(providers).length > 0
  );

  if (explicitOverride || !agentsConfig) {
    return {
      planningModel: fallbackModel,
      implementationModel: fallbackModel,
      reviewModel: fallbackModel,
      requestTimeoutMs,
      ...(providers ? { providers } : {}),
      ...(maxTransientRetries !== undefined ? { maxTransientRetries } : {}),
      ...(transientRetryBackoffSeconds !== undefined
        ? { transientRetryBackoffSeconds }
        : {})
    };
  }

  const pickModel = (phaseCandidate: string | undefined): string =>
    canUsePhaseModelFromConfig(phaseCandidate, hasProvidersMap)
      ? phaseCandidate!.trim()
      : fallbackModel;

  return {
    planningModel: pickModel(agentsConfig.models?.planning),
    implementationModel: pickModel(agentsConfig.models?.implementation),
    reviewModel: pickModel(agentsConfig.models?.review),
    requestTimeoutMs,
    ...(providers ? { providers } : {}),
    ...(maxTransientRetries !== undefined ? { maxTransientRetries } : {}),
    ...(transientRetryBackoffSeconds !== undefined
      ? { transientRetryBackoffSeconds }
      : {})
  };
}

export type { EpureIssueState, GitRefStateStore };
