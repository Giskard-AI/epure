import { randomUUID } from "node:crypto";
import {
  mintRepositoryInstallationToken,
  revokeGitHubInstallationToken
} from "../auth/github-app-jwt.js";
import { redactSecrets } from "../auth/issue-command-gate.js";
import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../bootstrap/ci-and-renovate.js";
import {
  DEFAULT_AGENTS_CONFIG,
  type ParsedAgentsConfig
} from "../bootstrap/setup-repo.js";
import {
  discoverExpectedExternalWorkflows,
  evaluateSingleExternalCiSnapshot,
  formatNeedsHumanEscalationComment,
  resolveLlmEscalationReason,
  type NeedsHumanEscalationReason
} from "../execution/external-ci-gate.js";
import { LLMError } from "../llm/errors.js";
import {
  adaptReviewerRosterForDomain,
  DEFAULT_REVIEWERS_DIR
} from "../review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../review/squash-commit-generator.js";
import { formatVerificationToolingGuideMarkdown } from "../sandbox/polyglot-workspace-runner.js";
import {
  buildIssueStateRefName,
  createGitHubApiRefStateStore,
  activeBudgetScope,
  advanceCommentCursor,
  claimForRun,
  formatIssueStateMarker,
  formatIssueStateMirrorMarkdown,
  guardTerminalStates,
  isAbandonedCiClaim,
  isAutomaticallyResumable,
  readActiveCodeFixAttempts,
  readCodeFixAttemptsByTicket,
  readFeatureCodeFixAttempts,
  readHumanBudgetGrants,
  readRunLease,
  resumeAfterEscalation,
  StateTransitionAbortedError,
  toTerminalState,
  updateIssueStateWithCas,
  type CancelledFrom,
  type EpureIssueState,
  type GitRefStateStore
} from "../state/git-ref-state.js";
import {
  formatResumeContextMarkdown,
  selectResumeContextComments
} from "../state/comment-batch-cursor.js";
import { appendEpureCommandsSpoiler } from "./formatting/comments.js";
import {
  createBaseSyncGuard,
  integratePlanBranchIntoFeature,
  mergeGlossaryMarkdownAdditively,
  reconcileAdrsWithLlm,
  renumberCollidingAdrs,
  syncBranchWithBase
} from "./github/branch-sync.js";
import {
  createGitHubRateLimitedFetch,
  GitHubRateLimitError
} from "./github/rate-limit.js";
import {
  BranchUpdateConflictError,
  createGitHubRestHelper,
  describeMergeRefusal,
  isConflictRefusal,
  loadRepoAgentsConfig,
  PullRequestHeadMovedError,
  PullRequestNotMergeableError,
  slugifyTitle,
  verifyPublisherMergeBoundary
} from "./github/rest-client.js";
import {
  AmbiguousFeatureBranchError,
  findExistingFeatureBranch,
  handleEpicClosedByHuman
} from "./phases/epic-closure.js";
import {
  runEpicConvergenceAudit,
  spawnPhase2ConvergenceTickets
} from "./phases/epic-convergence.js";
import { runFeatureIntegrationPhase } from "./phases/feature-integration.js";
import {
  buildParentIssueTicketsTasklistBlock,
  runGoldfishSpecAudit,
  runGrillAndPlanPhase,
  upsertParentIssueTicketsTasklist
} from "./phases/grill-and-plan.js";
import { runTicketExecutionLoop } from "./phases/ticket-execution.js";
import { EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT } from "./prompts/code-discipline.js";
import {
  MissingModelConfigError,
  resolvePhaseModels,
  type AdrCoherenceReconciliationPayload,
  type CreatedTicketRecord,
  type EpicConvergenceAuditPayload,
  type EpicGoalContract,
  type EscalateToNeedsHumanFn,
  type EscalateToNeedsHumanParams,
  type ExecutedTicketRecord,
  type GeneratedAdrDocument,
  type GeneratedFileChange,
  type GeneratedFilePatch,
  type GeneratedFilePatchEdit,
  type GeneratedPlanningBundle,
  type GeneratedTicketFilePatch,
  type GeneratedTicketImplementation,
  type GeneratedTicketPatchEdit,
  type GeneratedTicketSpec,
  type GitHubRestHelper,
  type GrillRoundEvaluation,
  type IssueCommentRecord,
  type IssueCommentSummary,
  type IssueMetadata,
  type IssueOrchestratorInput,
  type IssueOrchestratorResult,
  type OrchestrateIssueInput,
  type OrchestrateIssueResult,
  type OrchestratorCommand,
  type PlannedTicketDefinition,
  type ResolvedPhaseModels,
  type TrackedTicketCommentMetadata
} from "./types.js";
import { resolveJobTimeoutMinutes } from "./job-timeout.js";
import {
  GITHUB_ACTIONS_APP_ID,
  parsePlanManifestFromComments,
  resolvePlanManifest,
  resolveSpecManifest,
  type EpureIdentity
} from "./plan-manifest.js";
import {
  applyTicketImplementationPayload,
  buildCompactWorkspaceFilesContext,
  buildRepoExplorationToolsAndHandlers,
  checkIsBrownfieldSubpackageRepo,
  checkIsExistingRepoWorkspace,
  createStagedTicketImplementationBuffer,
  mergeStagedBufferIntoImplementationPayload,
  runTestsInIsolatedWorkspace,
  validateTicketIntegrityGuard,
  type BuildCompactWorkspaceFilesContextInput,
  type StagedTicketImplementationBuffer,
  type TicketIntegrityCheckResult,
  type TicketIntegrityViolation
} from "./workspace/repo-tools.js";
import {
  buildWebExplorationToolsAndHandlers,
  cleanHtmlToReadableText,
  safePublicHttpsFetch,
  validatePublicHttpsUrlForWebTool
} from "./workspace/web-tools.js";

export {
  EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT,
  applyTicketImplementationPayload,
  buildCompactWorkspaceFilesContext,
  buildParentIssueTicketsTasklistBlock,
  buildRepoExplorationToolsAndHandlers,
  buildWebExplorationToolsAndHandlers,
  checkIsBrownfieldSubpackageRepo,
  checkIsExistingRepoWorkspace,
  cleanHtmlToReadableText,
  createGitHubRestHelper,
  createStagedTicketImplementationBuffer,
  formatIssueStateMirrorMarkdown,
  integratePlanBranchIntoFeature,
  mergeGlossaryMarkdownAdditively,
  mergeStagedBufferIntoImplementationPayload,
  parsePlanManifestFromComments,
  reconcileAdrsWithLlm,
  redactSecrets,
  renumberCollidingAdrs,
  MissingModelConfigError,
  resolvePhaseModels,
  runEpicConvergenceAudit,
  runGoldfishSpecAudit,
  runTestsInIsolatedWorkspace,
  safePublicHttpsFetch,
  slugifyTitle,
  spawnPhase2ConvergenceTickets,
  syncBranchWithBase,
  upsertParentIssueTicketsTasklist,
  validatePublicHttpsUrlForWebTool,
  validateTicketIntegrityGuard,
  verifyPublisherMergeBoundary,
  type AdrCoherenceReconciliationPayload,
  type BuildCompactWorkspaceFilesContextInput,
  type CreatedTicketRecord,
  type EpicConvergenceAuditPayload,
  type EpicGoalContract,
  type EpureIssueState,
  type StagedTicketImplementationBuffer,
  type ExecutedTicketRecord,
  type GeneratedAdrDocument,
  type GeneratedFileChange,
  type GeneratedFilePatch,
  type GeneratedFilePatchEdit,
  type GeneratedPlanningBundle,
  type GeneratedTicketFilePatch,
  type GeneratedTicketImplementation,
  type GeneratedTicketPatchEdit,
  type GeneratedTicketSpec,
  type GitRefStateStore,
  type GrillRoundEvaluation,
  type IssueCommentRecord,
  type IssueCommentSummary,
  type IssueMetadata,
  type IssueOrchestratorInput,
  type IssueOrchestratorResult,
  type OrchestrateIssueInput,
  type OrchestrateIssueResult,
  type OrchestratorCommand,
  type PlannedTicketDefinition,
  type ResolvedPhaseModels,
  type TicketIntegrityCheckResult,
  type TicketIntegrityViolation,
  type TrackedTicketCommentMetadata
};

/** GitHub still throttled the escalation writes: the action surfaces `escalationMarkdown` itself. */
export class EscalationNotRecordedError extends Error {
  override readonly name = "EscalationNotRecordedError";

  constructor(
    readonly issueNumber: number,
    readonly reason: string,
    readonly escalationMarkdown: string,
    readonly resumeCommand: string,
    readonly leaseExpiresAt?: string | undefined
  ) {
    super(
      `GitHub API still rate limited: the \`${reason}\` escalation could not be posted on #${issueNumber}. Post \`${resumeCommand}\` on #${issueNumber} once the limit resets${
        leaseExpiresAt
          ? ` and this run's lease has expired (${leaseExpiresAt}); EPURE refuses the command until then`
          : ""
      }.`
    );
  }
}

/** The `issues: closed` event failed before the cancellation was recorded: the plan is left untouched. */
export class ClosureNotProcessedError extends Error {
  override readonly name = "ClosureNotProcessedError";

  constructor(
    readonly issueNumber: number,
    cause: unknown
  ) {
    super(
      `The closure of #${issueNumber} was not processed (${cause instanceof Error ? cause.message : String(cause)}); the plan state is unchanged. Re-close the issue (reopen it, then close it) or post \`/epure cancel\` on #${issueNumber}.`,
      { cause }
    );
  }
}

/** Command that re-runs the phase a plan was suspended in. */
export function resumeCommandForPhase(phase: EpureIssueState["phase"]): string {
  switch (phase) {
    case "idle":
    case "grilling":
      return "/epure plan";
    case "spec":
      return "/epure to-spec";
    case "tickets":
      return "/epure to-tickets";
    case "implementation":
    case "review":
    case "completed":
      return "/epure continue";
  }
}

const IMPLEMENTATION_PHASES: ReadonlySet<EpureIssueState["phase"]> = new Set([
  "implementation",
  "review",
  "completed"
]);

function manifestArtifactPaths(
  state: Pick<EpureIssueState, "plan_manifest" | "spec_manifest"> | null
): { readonly specPaths: string[]; readonly adrPaths: string[] } {
  return {
    specPaths: [state?.plan_manifest?.specPath, state?.spec_manifest?.specPath].filter(
      (p): p is string => Boolean(p)
    ),
    adrPaths: [...(state?.spec_manifest?.adrPaths ?? [])]
  };
}

/** `/epure continue` re-enters the implementation run (an awaiting or done plan only waits for a human). */
function resumesImplementationRun(
  state: Pick<EpureIssueState, "phase" | "status">
): boolean {
  return (
    IMPLEMENTATION_PHASES.has(state.phase) &&
    (state.status === "active" || state.status === "suspended")
  );
}

// Ticket and branch default to the plan's active element when the caller does not know it (catch-all).
type EscalationRecordInput = Omit<
  EscalateToNeedsHumanParams,
  "ticketNumber" | "branch"
> & {
  readonly ticketNumber?: number | undefined;
  readonly branch?: string | undefined;
  readonly graceWindowSeconds?: number | undefined;
  readonly createdTicketNumbers?: readonly number[] | undefined;
  readonly missingModelKeys?: readonly string[] | undefined;
};

export async function orchestrateIssueCommand(
  input: OrchestrateIssueInput
): Promise<OrchestrateIssueResult> {
  let result = await runIssueCommand(input);
  // A CI completion that landed while this run held the lease was ignored: re-check each head this run left waiting.
  const checkedHeads = new Set<string>();
  while (
    result.waiting_ci_head_sha &&
    !checkedHeads.has(result.waiting_ci_head_sha)
  ) {
    checkedHeads.add(result.waiting_ci_head_sha);
    const resumed = await runIssueCommand({
      ...input,
      command: "continue",
      commentId: 0,
      triggerHeadSha: result.waiting_ci_head_sha
    });
    if (!resumed.executed) {
      break;
    }
    result = resumed;
  }
  return result;
}

async function runIssueCommand(
  input: OrchestrateIssueInput
): Promise<OrchestrateIssueResult> {
  let mintedAppToken: string | null = null;
  let githubRequestCount = 0;

  try {
    let activeToken = (input.fallbackGithubToken ?? "").trim();
    if (
      input.agentAppId &&
      input.agentAppId.trim() &&
      input.agentAppPrivateKey &&
      input.agentAppPrivateKey.trim()
    ) {
      const minted = await mintRepositoryInstallationToken({
        appId: input.agentAppId,
        privateKeyPem: input.agentAppPrivateKey,
        repository: input.repository,
        fetchImpl: input.fetchImpl
      });
      mintedAppToken = minted.token;
      activeToken = minted.token;
    }

    if (!activeToken) {
      throw new Error(
        "Missing GitHub authentication: configure EPURE_AGENT_APP_ID + EPURE_AGENT_APP_PRIVATE_KEY (or fallback GITHUB_TOKEN)."
      );
    }
    const epureIdentity: EpureIdentity = {
      appId: mintedAppToken ? Number(input.agentAppId) : GITHUB_ACTIONS_APP_ID
    };

    const baseFetch = input.fetchImpl ?? fetch;
    const countedFetch: typeof fetch = (url, init) => {
      githubRequestCount += 1;
      return baseFetch(url, init);
    };
    const githubFetch = createGitHubRateLimitedFetch({
      fetchImpl: countedFetch,
      sleepFn: input.sleepFn
    });
    const gh = createGitHubRestHelper({
      repository: input.repository,
      token: activeToken,
      fetchImpl: githubFetch
    });

    const rawStore =
      input.stateStore ??
      createGitHubApiRefStateStore({
        repository: input.repository,
        githubToken: activeToken,
        fetchImpl: githubFetch
      });

    const isAutomaticEntry =
      input.command === "continue" && (input.commentId ?? 0) <= 0;
    const triggerHeadSha = input.triggerHeadSha?.trim() || undefined;
    const runId = input.runId?.trim() || randomUUID();
    const resumableByCiEvent = (state: EpureIssueState): boolean =>
      isAutomaticallyResumable(state) || isAbandonedCiClaim(state);

    let resolvedIssueNumber = input.issueNumber;
    if (resolvedIssueNumber <= 0 && input.command === "continue") {
      const allStates =
        triggerHeadSha && rawStore.listIssueStates
          ? await rawStore.listIssueStates()
          : [];
      const matched = allStates.find(
        (s) => resumableByCiEvent(s) && s.active_head_sha === triggerHeadSha
      );
      if (!matched) {
        return {
          executed: false,
          phase: "idle",
          status: "active",
          active_branch: "",
          summary_markdown:
            "No EPURE issue waiting for external CI continuation.",
          created_ticket_numbers: [],
          feature_pr_url: ""
        };
      }
      resolvedIssueNumber = matched.issue_number;
    }

    const effectiveInput: OrchestrateIssueInput =
      resolvedIssueNumber !== input.issueNumber
        ? { ...input, issueNumber: resolvedIssueNumber }
        : input;

    const refName = buildIssueStateRefName(effectiveInput.issueNumber);
    let planBranch = `plan/${effectiveInput.issueNumber}`;
    let featureBranch = `feature/${effectiveInput.issueNumber}`;
    let leaseExpiresAt: string | undefined;
    let maxCodeFixAttempts = 3;
    let totalTransientRetriesUsed = 0;
    let initialTransientRetriesUsed = 0;
    const cumulativeTransientRetriesUsed = (): number =>
      initialTransientRetriesUsed + totalTransientRetriesUsed;
    // Only an explicit human command may move a plan out of the `cancelled`/`done` state it read at start.
    let allowedTerminalSha: string | null = null;
    let store: GitRefStateStore = guardTerminalStates(rawStore, null);

    const commandPhase: EpureIssueState["phase"] =
      effectiveInput.command === "to-tickets"
        ? "tickets"
        : effectiveInput.command === "to-spec"
          ? "spec"
          : effectiveInput.command === "plan" ||
              effectiveInput.command === "reply"
            ? "grilling"
            : "implementation";
    const formatEscalation = (
      params: EscalationRecordInput,
      context: {
        readonly phase: EpureIssueState["phase"];
        readonly branch: string;
        readonly ticketNumber: number;
        readonly codeFixAttemptsUsed?: number | undefined;
        readonly humanBudgetGrants?: number | undefined;
        readonly resumeCommand?: string | undefined;
      }
    ): string =>
      formatNeedsHumanEscalationComment({
        reason: params.reason,
        issueNumber: effectiveInput.issueNumber,
        ticketIssueNumber: context.ticketNumber,
        prNumber: params.prNumber,
        prUrl: params.prUrl,
        branch: context.branch,
        codeFixAttemptsUsed: context.codeFixAttemptsUsed,
        maxCodeFixAttempts,
        humanBudgetGrants: context.humanBudgetGrants,
        graceWindowSeconds: params.graceWindowSeconds,
        failedChecks: params.failedChecks,
        mustFixFindings: params.mustFixFindings,
        sensitivePaths: params.sensitivePaths,
        traversalPaths: params.traversalPaths,
        diagnosticExcerpt: params.diagnosticExcerpt,
        epicConvergenceDetails: params.epicConvergenceDetails,
        missingModelKeys: params.missingModelKeys,
        resumeCommand:
          context.resumeCommand ??
          (IMPLEMENTATION_PHASES.has(context.phase)
            ? undefined
            : resumeCommandForPhase(context.phase))
      });
    // Single escalation recorder; the catch-all passes its own gh/store when the run's rate-limit budget is spent.
    const recordEscalation = async (
      params: EscalationRecordInput,
      via: {
        readonly gh: GitHubRestHelper;
        readonly store: GitRefStateStore;
      }
    ): Promise<OrchestrateIssueResult> => {
      let duplicateOfLastEscalation = false;
      let ticketNumber: number = effectiveInput.issueNumber;
      const updatedSuspended = await updateIssueStateWithCas({
        issueNumber: effectiveInput.issueNumber,
        store: via.store,
        mutator: (prev) => {
          const lease = readRunLease(prev);
          if (lease && !lease.stale && lease.runId !== runId) {
            throw new StateTransitionAbortedError(
              prev,
              `run \`${lease.runId}\` holds the plan until ${lease.expiresAt}, so this run does not suspend it`
            );
          }
          // An approval that fails before its run starts stays approved: `/epure continue` or `/epure approve` re-enters it.
          const phase =
            params.phase ??
            (effectiveInput.command === "approve"
              ? "implementation"
              : prev.phase !== "idle"
                ? prev.phase
                : commandPhase);
          ticketNumber =
            params.ticketNumber ??
            prev.active_ticket_number ??
            effectiveInput.issueNumber;
          const escalation = {
            reason: params.reason,
            head_sha: prev.active_head_sha ?? "",
            ticket_number: ticketNumber,
            budget_scope: params.budgetScope ?? activeBudgetScope(prev)
          } as const;
          duplicateOfLastEscalation =
            isAutomaticEntry &&
            prev.last_escalation?.reason === escalation.reason &&
            prev.last_escalation?.head_sha === escalation.head_sha;
          return toTerminalState(prev, {
            phase,
            status: "suspended",
            active_branch:
              params.branch ??
              (prev.active_branch ||
                (IMPLEMENTATION_PHASES.has(phase) ? featureBranch : planBranch)),
            code_fix_attempts_used:
              params.codeFixAttemptsUsed ?? prev.code_fix_attempts_used,
            transient_retries_used: cumulativeTransientRetriesUsed(),
            last_escalation: escalation,
            last_processed_comment_id: advanceCommentCursor(
              prev,
              effectiveInput.commentId
            )
          });
        }
      });
      const suspendedState = updatedSuspended.state;
      leaseExpiresAt = suspendedState.claim_expires_at;

      const escalationMarkdown = appendEpureCommandsSpoiler(
        [
          updatedSuspended.issue_mirror_markdown,
          "",
          formatEscalation(params, {
            phase: suspendedState.phase,
            branch: suspendedState.active_branch,
            ticketNumber,
            codeFixAttemptsUsed: suspendedState.code_fix_attempts_used,
            humanBudgetGrants: IMPLEMENTATION_PHASES.has(suspendedState.phase)
              ? readHumanBudgetGrants(suspendedState)
              : undefined
          })
        ].join("\n"),
        {
          phase: "suspended",
          status: "suspended",
          issueNumber: effectiveInput.issueNumber
        }
      );

      if (!duplicateOfLastEscalation) {
        await via.gh.ensureLabel(
          "needs-human",
          "D93F0B",
          "Requires human maintainer intervention"
        );
        await via.gh.addIssueLabels(effectiveInput.issueNumber, ["needs-human"]);
        if (
          params.ticketNumber !== undefined &&
          params.ticketNumber !== effectiveInput.issueNumber
        ) {
          await via.gh.addIssueLabels(params.ticketNumber, ["needs-human"]);
        }
        await via.gh.postIssueComment(
          effectiveInput.issueNumber,
          escalationMarkdown
        );
      }

      return {
        executed: true,
        phase: suspendedState.phase,
        status: suspendedState.status,
        active_branch: suspendedState.active_branch,
        summary_markdown: escalationMarkdown,
        created_ticket_numbers: params.createdTicketNumbers ?? [],
        feature_pr_url: params.featurePrUrl ?? params.prUrl ?? ""
      };
    };
    const escalateSuspension = (
      params: EscalationRecordInput
    ): Promise<OrchestrateIssueResult> =>
      recordEscalation(params, { gh, store });
    const abortedResult = (
      err: StateTransitionAbortedError
    ): OrchestrateIssueResult => ({
      executed: false,
      phase: err.state.phase,
      status: err.state.status,
      active_branch: err.state.active_branch,
      summary_markdown: `Run stopped without writing: ${err.message}`,
      created_ticket_numbers: [],
      feature_pr_url: ""
    });

    try {
      const currentSnapshot = await rawStore.readRef(refName);
      let currentState = currentSnapshot.state;
      if (!isAutomaticEntry) {
        allowedTerminalSha = currentSnapshot.sha;
        store = guardTerminalStates(rawStore, allowedTerminalSha);
      }
      initialTransientRetriesUsed = currentState?.transient_retries_used ?? 0;

      if (isAutomaticEntry) {
        const ignoredReason = !triggerHeadSha
          ? "no trigger head SHA"
          : !currentState
            ? "no orchestration state"
            : !resumableByCiEvent(currentState)
              ? `status \`${currentState.status}\` / subphase \`${currentState.subphase ?? "idle"}\` is not an active wait`
              : triggerHeadSha !== currentState.active_head_sha
                ? `trigger SHA \`${triggerHeadSha}\` is not the active head SHA`
                : undefined;
        if (ignoredReason) {
          return {
            executed: false,
            phase: currentState?.phase ?? "idle",
            status: currentState?.status ?? "active",
            active_branch: currentState?.active_branch ?? "",
            summary_markdown: `Automatic continuation ignored: ${ignoredReason}.`,
            created_ticket_numbers: [],
            feature_pr_url: ""
          };
        }
      }

      const heldLease = currentState ? readRunLease(currentState) : null;
      if (
        !isAutomaticEntry &&
        (effectiveInput.command === "continue" ||
          effectiveInput.command === "approve" ||
          effectiveInput.command === "sync" ||
          effectiveInput.command === "rebase") &&
        heldLease &&
        !heldLease.stale &&
        heldLease.runId !== runId
      ) {
        const body = `⏳ L'exécution EPURE \`${heldLease.runId}\` travaille encore sur le plan #${effectiveInput.issueNumber} (verrou valable jusqu'au ${heldLease.expiresAt}) : \`/epure ${effectiveInput.command}\` est ignoré pour ne pas lancer une seconde exécution en parallèle. Republiez-le une fois cette exécution terminée, ou après l'expiration du verrou si elle a été interrompue.`;
        await gh.postIssueComment(effectiveInput.issueNumber, body);
        return {
          executed: false,
          phase: currentState?.phase ?? "idle",
          status: currentState?.status ?? "active",
          active_branch: currentState?.active_branch ?? "",
          summary_markdown: body,
          created_ticket_numbers: [],
          feature_pr_url: ""
        };
      }

      // 1. Handle /epure status
      if (effectiveInput.command === "status") {
        const updated = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            last_processed_comment_id:
              advanceCommentCursor(prev, effectiveInput.commentId)
          })
        });
        const lease = readRunLease(updated.state);
        const statusBody = appendEpureCommandsSpoiler(
          [
            updated.issue_mirror_markdown,
            ...(lease === null
              ? []
              : lease.stale
                ? [
                    `- **Run Lease**: ⚠️ stale — run \`${lease.runId}\` expired at ${lease.expiresAt} without finishing; \`/epure continue\` takes the plan over.`
                  ]
                : [
                    `- **Run Lease**: run \`${lease.runId}\` in progress until ${lease.expiresAt}`
                  ])
          ].join("\n"),
          {
            phase: updated.state.phase,
            status: updated.state.status,
            issueNumber: effectiveInput.issueNumber
          }
        );
        await gh.postIssueComment(effectiveInput.issueNumber, statusBody);
        return {
          executed: true,
          phase: updated.state.phase,
          status: updated.state.status,
          active_branch: updated.state.active_branch,
          summary_markdown: statusBody,
          created_ticket_numbers: [],
          feature_pr_url: ""
        };
      }

      // 2. Handle /epure cancel
      if (effectiveInput.command === "cancel" && currentState?.status === "done") {
        const body = `ℹ️ Le plan #${effectiveInput.issueNumber} est déjà terminé (\`done\`) : \`/epure cancel\` ne le modifie pas.`;
        await gh.postIssueComment(effectiveInput.issueNumber, body);
        return {
          executed: false,
          phase: currentState.phase,
          status: currentState.status,
          active_branch: currentState.active_branch,
          summary_markdown: body,
          created_ticket_numbers: [],
          feature_pr_url: ""
        };
      }
      if (effectiveInput.command === "cancel") {
        const updated = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) =>
            toTerminalState(prev, {
              status: "cancelled",
              last_processed_comment_id:
                advanceCommentCursor(prev, effectiveInput.commentId)
            })
        });
        const body = appendEpureCommandsSpoiler(
          [
            updated.issue_mirror_markdown,
            "",
            `Plan #${effectiveInput.issueNumber} has been **cancelled** by \`@${effectiveInput.actor}\`. No further automated executions or merges will occur.`
          ].join("\n"),
          {
            phase: "cancelled",
            status: "cancelled",
            issueNumber: effectiveInput.issueNumber
          }
        );
        await gh.postIssueComment(effectiveInput.issueNumber, body);
        return {
          executed: true,
          phase: updated.state.phase,
          status: updated.state.status,
          active_branch: updated.state.active_branch,
          summary_markdown: body,
          created_ticket_numbers: [],
          feature_pr_url: ""
        };
      }

      if (effectiveInput.command === "closed") {
        return await handleEpicClosedByHuman({
          issueNumber: effectiveInput.issueNumber,
          actor: effectiveInput.actor,
          currentState,
          gh,
          store
        });
      }

      const issue = await gh.getIssue(effectiveInput.issueNumber);
      const allComments = await gh.listIssueComments(effectiveInput.issueNumber);
      const planSlug = slugifyTitle(issue.title);
      // The slug follows the current title; a renamed epic keeps the branches it already uses
      // (states written before `plan_branch`/`feature_branch` fall back to `active_branch`).
      planBranch =
        currentState?.plan_branch ??
        (currentState?.active_branch.startsWith(`${planBranch}-`)
          ? currentState.active_branch
          : `plan/${effectiveInput.issueNumber}-${planSlug}`);
      featureBranch =
        (currentState &&
        (currentState.feature_branch ||
          IMPLEMENTATION_PHASES.has(currentState.phase))
          ? await findExistingFeatureBranch(gh, currentState)
          : undefined) ?? `feature/${effectiveInput.issueNumber}-${planSlug}`;

      // `/epure continue` on a cancelled plan restores the phase and status it was cancelled from.
      if (
        effectiveInput.command === "continue" &&
        (effectiveInput.commentId ?? 0) > 0 &&
        currentState?.status === "cancelled"
      ) {
        if (issue.state === "closed") {
          const reopenFirst = `⏸️ Le plan #${effectiveInput.issueNumber} est annulé et son issue est fermée : rouvrez l'issue #${effectiveInput.issueNumber}, puis postez \`/epure continue\`.`;
          await gh.postIssueComment(effectiveInput.issueNumber, reopenFirst);
          return {
            executed: false,
            phase: currentState.phase,
            status: currentState.status,
            active_branch: currentState.active_branch,
            summary_markdown: reopenFirst,
            created_ticket_numbers: [],
            feature_pr_url: ""
          };
        }
        const restored = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => {
            // A cancellation recorded before `cancelled_from` cannot tell whether the phase had finished: suspended asks for its command again.
            const from: CancelledFrom = prev.cancelled_from ?? {
              phase: prev.phase,
              status: "suspended"
            };
            // A generated spec or ticket graph waits for human review again.
            const status =
              from.status === "active" &&
              (from.phase === "spec" || from.phase === "tickets")
                ? "awaiting_human_approval"
                : from.status;
            const restoredState = {
              ...prev,
              phase: from.phase,
              status,
              cancelled_from: undefined
            };
            // The implementation run below advances the cursor once it has read the resume context.
            return resumesImplementationRun(restoredState)
              ? restoredState
              : {
                  ...restoredState,
                  last_processed_comment_id: advanceCommentCursor(
                    prev,
                    effectiveInput.commentId
                  )
                };
          }
        });
        currentState = restored.state;
        if (!resumesImplementationRun(currentState)) {
          const suspended = currentState.status === "suspended";
          if (suspended) {
            await gh.ensureLabel(
              "needs-human",
              "D93F0B",
              "Requires human maintainer intervention"
            );
            await gh.addIssueLabels(effectiveInput.issueNumber, ["needs-human"]);
          }
          const nextStep = suspended
            ? `Le plan reste \`suspended\` : postez \`${resumeCommandForPhase(currentState.phase)}\` pour relancer la phase.`
            : currentState.phase === "grilling"
              ? "Répondez en commentaire pour poursuivre l'entretien, ou postez `/epure to-spec`."
              : currentState.phase === "spec"
                ? "Répondez en commentaire pour réviser la spécification, ou postez `/epure to-tickets`."
                : currentState.phase === "tickets"
                  ? "Postez `/epure approve` pour lancer l'implémentation."
                  : "La Pull Request de fonctionnalité attend la revue humaine et le squash-merge vers `dev`.";
          const body = appendEpureCommandsSpoiler(
            [
              restored.issue_mirror_markdown,
              "",
              `▶️ Plan #${effectiveInput.issueNumber} repris par \`@${effectiveInput.actor}\` en phase \`${currentState.phase}\`. ${nextStep}`
            ].join("\n"),
            {
              phase: currentState.phase,
              status: currentState.status,
              issueNumber: effectiveInput.issueNumber
            }
          );
          await gh.postIssueComment(effectiveInput.issueNumber, body);
          return {
            executed: true,
            phase: currentState.phase,
            status: currentState.status,
            active_branch: currentState.active_branch,
            summary_markdown: body,
            created_ticket_numbers: [],
            feature_pr_url: ""
          };
        }
      }
      let agentsConfigError: unknown;
      let parsedDevAgentsConfig: ParsedAgentsConfig | null = null;
      try {
        parsedDevAgentsConfig =
          (await loadRepoAgentsConfig(gh, "dev")) ??
          (await loadRepoAgentsConfig(gh, "main"));
      } catch (err) {
        agentsConfigError = err;
      }
      // Config and model errors only escalate on paths that call an LLM.
      let resolvedPhaseModels: ResolvedPhaseModels | undefined;
      const requirePhaseModels = (): ResolvedPhaseModels => {
        if (agentsConfigError !== undefined) {
          throw agentsConfigError;
        }
        resolvedPhaseModels ??= resolvePhaseModels(
          effectiveInput.model,
          parsedDevAgentsConfig
        );
        return resolvedPhaseModels;
      };
      maxCodeFixAttempts = parsedDevAgentsConfig?.max_code_fix_attempts ?? 3;
      // The job cannot outlive its timeout, so a lease older than it belongs to a killed run.
      let runLeaseMinutes: Promise<number> | undefined;
      const resolveRunLeaseMs = async (): Promise<number> => {
        runLeaseMinutes ??= effectiveInput.workflowJob
          ? resolveJobTimeoutMinutes(gh, effectiveInput.workflowJob)
          : Promise.resolve(
              parsedDevAgentsConfig?.job_timeout_minutes ??
                DEFAULT_AGENTS_CONFIG.job_timeout_minutes
            );
        return (await runLeaseMinutes) * 60_000;
      };
      const reviewersDir =
        parsedDevAgentsConfig?.reviewers_dir ?? DEFAULT_REVIEWERS_DIR;

    // 3 & 4. Handle /epure plan, human reply during grilling or spec review, /epure to-spec, /epure to-tickets
    if (
      effectiveInput.command === "plan" ||
      effectiveInput.command === "to-spec" ||
      effectiveInput.command === "to-tickets" ||
      (effectiveInput.command === "reply" &&
        (currentState?.phase === "grilling" ||
          currentState?.phase === "spec") &&
        currentState?.status !== "cancelled")
    ) {
      const phaseModels = requirePhaseModels();
      try {
        return await runGrillAndPlanPhase({
          command: effectiveInput.command,
          currentPhase: currentState?.phase,
          currentStatus: currentState?.status,
          planManifest:
            currentState?.plan_manifest ??
            parsePlanManifestFromComments(allComments, epureIdentity),
          specManifest: resolveSpecManifest(currentState, allComments, epureIdentity),
          epureIdentity,
          repository: effectiveInput.repository,
          issueNumber: effectiveInput.issueNumber,
          commentId: effectiveInput.commentId,
          issue,
          allComments,
          planSlug,
          planBranch,
          gh,
          store,
          llmApiKey: effectiveInput.llmApiKey,
          phaseModels,
          reviewersDir,
          onTransientRetriesUsed: (used) => {
            totalTransientRetriesUsed += used;
          },
          fetchImpl: effectiveInput.fetchImpl
        });
      } catch (err) {
        if (err instanceof LLMError) {
          return await escalateSuspension({
            reason: resolveLlmEscalationReason(err),
            ticketNumber: effectiveInput.issueNumber,
            branch: planBranch,
            phase:
              effectiveInput.command === "to-tickets"
                ? "tickets"
                : effectiveInput.command === "to-spec" ||
                    currentState?.phase === "spec"
                  ? "spec"
                  : "grilling",
            diagnosticExcerpt: redactSecrets(err.message, [
              activeToken,
              effectiveInput.llmApiKey
            ])
          });
        }
        throw err;
      }
    }

      const completeEpicMergedByHuman = async (mergedFeaturePr: {
        number: number;
        html_url: string;
      }): Promise<OrchestrateIssueResult> => {
        const updatedDone = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) =>
            toTerminalState(prev, {
              phase: "completed",
              status: "done",
              active_branch: featureBranch,
              last_processed_comment_id:
                advanceCommentCursor(prev, effectiveInput.commentId)
            })
        });
        const mergedComment = appendEpureCommandsSpoiler(
          [
            updatedDone.issue_mirror_markdown,
            "",
            `La Pull Request de fonctionnalité [#${mergedFeaturePr.number}](${mergedFeaturePr.html_url}) de \`${featureBranch}\` est déjà fusionnée dans \`dev\` : aucune nouvelle Pull Request n'est ouverte.`
          ].join("\n"),
          {
            phase: "completed",
            status: "completed",
            issueNumber: effectiveInput.issueNumber
          }
        );
        await gh.postIssueComment(effectiveInput.issueNumber, mergedComment);
        return {
          executed: true,
          phase: updatedDone.state.phase,
          status: updatedDone.state.status,
          active_branch: featureBranch,
          summary_markdown: mergedComment,
          created_ticket_numbers: [],
          feature_pr_url: mergedFeaturePr.html_url
        };
      };
      // A human may merge the feature PR while this run is still working: checked before every branch write or PR.
      const stopIfFeaturePrMerged =
        async (): Promise<OrchestrateIssueResult | null> => {
          const merged = await gh.findMergedPullRequestByHead(
            featureBranch,
            "dev"
          );
          return merged ? await completeEpicMergedByHuman(merged) : null;
        };

      // 4b. Handle /epure sync or /epure rebase (explicit branch synchronization from dev)
      if (
        effectiveInput.command === "sync" ||
        effectiveInput.command === "rebase"
      ) {
        const mergedBeforeSync = await stopIfFeaturePrMerged();
        if (mergedBeforeSync) {
          return mergedBeforeSync;
        }
        const phaseModels = requirePhaseModels();
        const targetBranch = featureBranch;

        await gh.ensureBranch("dev", "main");
        await gh.ensureBranch(targetBranch, "dev");

        if (currentState?.active_branch?.startsWith("plan/")) {
          await integratePlanBranchIntoFeature({
            gh,
            planBranch: currentState.active_branch,
            featureBranch: targetBranch,
            baseBranch: "dev",
            manifestPaths: manifestArtifactPaths(currentState),
            llmApiKey: effectiveInput.llmApiKey,
            model: phaseModels.planningModel,
            providers: phaseModels.providers,
            maxTransientRetries: phaseModels.maxTransientRetries,
            transientRetryBackoffSeconds:
              phaseModels.transientRetryBackoffSeconds,
            requestTimeoutMs: phaseModels.requestTimeoutMs,
            fetchImpl: effectiveInput.fetchImpl
          });
        }

        const syncRes = await syncBranchWithBase({
          gh,
          targetBranch,
          baseBranch: "dev",
          issueNumber: effectiveInput.issueNumber,
          llmApiKey: effectiveInput.llmApiKey,
          fetchImpl: effectiveInput.fetchImpl,
          model: phaseModels.implementationModel,
          providers: phaseModels.providers,
          maxTransientRetries: phaseModels.maxTransientRetries,
          transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
          requestTimeoutMs: phaseModels.requestTimeoutMs,
          sandboxRunner: effectiveInput.sandboxRunner,
          reviewersDir
        });

        if (syncRes.status === "escalated") {
          return await escalateSuspension({
            reason: syncRes.escalationReason ?? "merge_conflict_unresolved",
            ticketNumber: effectiveInput.issueNumber,
            branch: targetBranch,
            diagnosticExcerpt: syncRes.diagnosticExcerpt
          });
        }

        if (currentState?.active_task_branch) {
          const taskSyncRes = await syncBranchWithBase({
            gh,
            targetBranch: currentState.active_task_branch,
            baseBranch: targetBranch,
            issueNumber:
              currentState.active_ticket_number ?? effectiveInput.issueNumber,
            llmApiKey: effectiveInput.llmApiKey,
            fetchImpl: effectiveInput.fetchImpl,
            model: phaseModels.implementationModel,
            providers: phaseModels.providers,
            maxTransientRetries: phaseModels.maxTransientRetries,
            transientRetryBackoffSeconds:
              phaseModels.transientRetryBackoffSeconds,
            requestTimeoutMs: phaseModels.requestTimeoutMs,
            sandboxRunner: effectiveInput.sandboxRunner,
            reviewersDir
          });
          if (taskSyncRes.status === "escalated") {
            return await escalateSuspension({
              reason:
                taskSyncRes.escalationReason ?? "merge_conflict_unresolved",
              ticketNumber:
                currentState.active_ticket_number ?? effectiveInput.issueNumber,
              branch: currentState.active_task_branch,
              diagnosticExcerpt: taskSyncRes.diagnosticExcerpt
            });
          }
        }

        const updatedSync = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            active_branch: targetBranch,
            feature_branch: prev.feature_branch ?? targetBranch,
            last_processed_comment_id:
              advanceCommentCursor(prev, effectiveInput.commentId)
          })
        });

        const syncBody = appendEpureCommandsSpoiler(
          [
            updatedSync.issue_mirror_markdown,
            "",
            `### 🔄 Synchronisation Git (\`/epure sync\`) — \`dev\` -> \`${targetBranch}\``,
            `- **Statut** : \`${syncRes.status}\``,
            `- **HEAD SHA** : \`${syncRes.headSha || "unchanged"}\``,
            ...(syncRes.conflictsResolved.length > 0
              ? [
                  `- **Conflits résolus en 3-way (validés Stage 1)** : ${syncRes.conflictsResolved.map((p) => `\`${p}\``).join(", ")}`
                ]
              : [])
          ].join("\n"),
          {
            phase: updatedSync.state.phase,
            status: updatedSync.state.status,
            issueNumber: effectiveInput.issueNumber
          }
        );
        await gh.postIssueComment(effectiveInput.issueNumber, syncBody);
        return {
          executed: true,
          phase: updatedSync.state.phase,
          status: updatedSync.state.status,
          active_branch: targetBranch,
          summary_markdown: syncBody,
          created_ticket_numbers: [],
          feature_pr_url: ""
        };
      }

      let forceOneRemediationRoundOnOpenPr = false;

      // 4c. Handle event-driven CI continuation (workflow_run / /epure continue)
      if (effectiveInput.command === "continue") {
        const isWaitingExternalCi =
          currentState !== null &&
          (isAutomaticallyResumable(currentState) ||
            (isAutomaticEntry && isAbandonedCiClaim(currentState)));
        const isManualContinueInImplementation =
          !isWaitingExternalCi &&
          (effectiveInput.commentId ?? 0) > 0 &&
          currentState !== null &&
          resumesImplementationRun(currentState);

        if (!isWaitingExternalCi && !isManualContinueInImplementation) {
          return {
            executed: false,
            phase: currentState?.phase ?? "idle",
            status: currentState?.status ?? "active",
            active_branch: currentState?.active_branch ?? "",
            summary_markdown:
              "Issue is not waiting on external CI continuation.",
            created_ticket_numbers: [],
            feature_pr_url: ""
          };
        }

        if (isWaitingExternalCi && currentState) {
          const activeHeadSha =
            currentState.active_head_sha ?? effectiveInput.triggerHeadSha ?? "";
          // An abandoned claim is still in the subphase its dead run moved the wait to.
          const waitsOnFeatureCi =
            currentState.subphase === "waiting_feature_ci" ||
            currentState.subphase === "remediating_feature";
          const devWorkflowsMapForContinue = await gh.readDevWorkflowsMap("dev");
          const expectedContinueWorkflows = discoverExpectedExternalWorkflows({
            workflowFilesMap: devWorkflowsMapForContinue,
            changedPaths: ["src/index.ts"],
            targetBranch: waitsOnFeatureCi ? "dev" : featureBranch
          });

          const snapshot = await evaluateSingleExternalCiSnapshot({
            headSha: activeHeadSha,
            expectedWorkflows: expectedContinueWorkflows,
            extraSecrets: [activeToken, effectiveInput.llmApiKey],
            listWorkflowRunsForSha: (sha) => gh.listWorkflowRunsForSha(sha),
            listCheckRunsForRef: (sha) => gh.listCheckRunsForRef(sha),
            listCheckRunAnnotations: (id) => gh.listCheckRunAnnotations(id),
            getJobLogs: (id) => gh.getActionJobLogs(id)
          });

          if (!snapshot.completed) {
            return {
              executed: false,
              phase: currentState.phase,
              status: currentState.status,
              active_branch: currentState.active_branch,
              summary_markdown: `External CI still in progress on SHA ${activeHeadSha}.`,
              created_ticket_numbers: [],
              feature_pr_url: ""
            };
          }

          // Claims the wait: a concurrent continuation, cancel or closure makes this run stop here.
          const waitingState = currentState;
          const ciClaimLeaseMs = await resolveRunLeaseMs();
          const ciClaim = await updateIssueStateWithCas({
            issueNumber: effectiveInput.issueNumber,
            store,
            mutator: (prev) => {
              if (
                prev.status !== "active" ||
                prev.subphase !== waitingState.subphase ||
                prev.active_head_sha !== waitingState.active_head_sha ||
                prev.claimed_by_run_id !== waitingState.claimed_by_run_id
              ) {
                throw new StateTransitionAbortedError(
                  prev,
                  "this CI wait was already claimed or ended by another run"
                );
              }
              return claimForRun(
                {
                  ...prev,
                  subphase: waitsOnFeatureCi
                    ? "remediating_feature"
                    : "implementing_ticket"
                },
                runId,
                ciClaimLeaseMs
              );
            }
          });
          leaseExpiresAt = ciClaim.state.claim_expires_at;

          if (snapshot.passed && snapshot.aiReviewPassed) {
            if (waitsOnFeatureCi) {
              const featurePrNumber = currentState.active_pr_number ?? 0;
              const openFeaturePr = await gh.findOpenPullRequestByHead(
                featureBranch,
                "dev"
              );
              const featurePrUrl = openFeaturePr?.html_url ?? "";
              const updatedReviewReady = await updateIssueStateWithCas({
                issueNumber: effectiveInput.issueNumber,
                store,
                mutator: (prev) => ({
                  ...prev,
                  phase: "review",
                  status: "awaiting_human_approval",
                  subphase: "idle",
                  active_head_sha: undefined,
                  code_fix_attempts_used: 0
                })
              });
              const readyMd = appendEpureCommandsSpoiler(
                [
                  formatIssueStateMarker(updatedReviewReady.state),
                  updatedReviewReady.issue_mirror_markdown,
                  "",
                  `### ✅ Feature Pull Request prête pour validation humaine — PR #${featurePrNumber}`,
                  `- **Pull Request** : ${featurePrUrl || `#${featurePrNumber}`}`,
                  `- **CI externe & \`ai-review\`** : \`success\` sur \`${activeHeadSha}\``,
                  "- **Prochaine étape** : Revue humaine et squash-merge vers `dev`."
                ].join("\n"),
                {
                  phase: "completed",
                  status: "completed",
                  issueNumber: effectiveInput.issueNumber
                }
              );
              await gh.ensureLabel(
                "ready-for-human",
                "0E8A16",
                "Ready for human review and merge"
              );
              await gh.addIssueLabels(effectiveInput.issueNumber, [
                "ready-for-human"
              ]);
              await gh.postIssueComment(effectiveInput.issueNumber, readyMd);
              return {
                executed: true,
                phase: updatedReviewReady.state.phase,
                status: updatedReviewReady.state.status,
                active_branch: updatedReviewReady.state.active_branch,
                summary_markdown: readyMd,
                created_ticket_numbers: [],
                feature_pr_url: featurePrUrl
              };
            }

            // waiting_ticket_ci passed: squash-merge current ticket PR and continue to next ticket!
            const ticketNum =
              currentState.active_ticket_number ?? effectiveInput.issueNumber;
            const taskBranchToMerge =
              currentState.active_task_branch ?? `task/${ticketNum}`;
            const prNumberToMerge = currentState.active_pr_number ?? 0;
            const targetFeatureBranch = featureBranch;

            const openTaskPr =
              prNumberToMerge > 0
                ? await gh.findOpenPullRequestByHead(
                    taskBranchToMerge,
                    targetFeatureBranch
                  )
                : null;
            const mergedByHuman =
              prNumberToMerge > 0 &&
              !openTaskPr &&
              (await gh.findMergedPullRequestByHead(
                taskBranchToMerge,
                targetFeatureBranch
              )) !== null;
            // A feature PR already merged into dev is left untouched: step 5 marks the plan done.
            const featurePrAlreadyMerged =
              prNumberToMerge > 0 &&
              !mergedByHuman &&
              (await gh.findMergedPullRequestByHead(
                targetFeatureBranch,
                "dev"
              )) !== null;
            let ticketPrNeedsReview = false;
            if (prNumberToMerge > 0 && !mergedByHuman && !featurePrAlreadyMerged) {
              const prFiles = await gh.listPullRequestFiles(prNumberToMerge);
              const changedFilesForSquash = await Promise.all(
                prFiles.map(async (f) => ({
                  path: f.filename,
                  ...(f.patch
                    ? { patch: f.patch }
                    : {
                        content:
                          (await gh.readSingleBranchFile(
                            taskBranchToMerge,
                            f.filename
                          )) ?? undefined
                      })
                }))
              );

              const phaseModels = requirePhaseModels();
              const squashCommit = await generateSemanticSquashCommitFromDiff({
                prNumber: prNumberToMerge,
                targetBranch: targetFeatureBranch,
                defaultBranch: "dev",
                planIssueNumber: effectiveInput.issueNumber,
                ticketNumbers: [ticketNum],
                fallbackTitle:
                  openTaskPr?.title ||
                  `feat(ticket-${ticketNum}): complete ticket #${ticketNum}`,
                changedFiles: changedFilesForSquash,
                llmApiKey: effectiveInput.llmApiKey,
                model: phaseModels.reviewModel,
                providers: phaseModels.providers,
                maxTransientRetries: phaseModels.maxTransientRetries,
                transientRetryBackoffSeconds:
                  phaseModels.transientRetryBackoffSeconds,
                requestTimeoutMs: phaseModels.requestTimeoutMs,
                fetchImpl: effectiveInput.fetchImpl
              });

              await gh.updatePullRequest(prNumberToMerge, {
                title: squashCommit.pr_title
              });
              await gh.publishCheckRun({
                name: "PR title",
                headSha: activeHeadSha,
                conclusion: "success",
                summary: `Conventional Commit title verified: '${squashCommit.pr_title}'`
              });
              let refusal: PullRequestNotMergeableError | undefined;
              try {
                await gh.mergePullRequest(prNumberToMerge, {
                  headBranch: taskBranchToMerge,
                  baseBranch: targetFeatureBranch,
                  expectedHeadSha: activeHeadSha,
                  commitTitle: squashCommit.commit_title,
                  commitMessage: squashCommit.commit_message
                });
              } catch (err) {
                if (err instanceof PullRequestHeadMovedError) {
                  ticketPrNeedsReview = true;
                } else if (err instanceof PullRequestNotMergeableError) {
                  refusal = err;
                } else {
                  throw err;
                }
              }
              if (refusal) {
                const mergeableState = await gh.getPullRequestMergeableState(
                  prNumberToMerge
                );
                const escalateRefusedMerge = (
                  reason: NeedsHumanEscalationReason,
                  diagnosticExcerpt: string
                ) =>
                  escalateSuspension({
                    reason,
                    ticketNumber: ticketNum,
                    branch: taskBranchToMerge,
                    prNumber: prNumberToMerge,
                    prUrl: openTaskPr?.html_url,
                    diagnosticExcerpt
                  });
                if (!isConflictRefusal(refusal, mergeableState)) {
                  return await escalateRefusedMerge(
                    "pr_not_mergeable",
                    describeMergeRefusal(refusal, mergeableState)
                  );
                }
                // A refused merge gets one re-sync; external CI then re-verifies the new head before the next merge.
                const resync = await syncBranchWithBase({
                  gh,
                  targetBranch: taskBranchToMerge,
                  baseBranch: targetFeatureBranch,
                  issueNumber: ticketNum,
                  llmApiKey: effectiveInput.llmApiKey,
                  fetchImpl: effectiveInput.fetchImpl,
                  model: phaseModels.implementationModel,
                  providers: phaseModels.providers,
                  maxTransientRetries: phaseModels.maxTransientRetries,
                  transientRetryBackoffSeconds:
                    phaseModels.transientRetryBackoffSeconds,
                  requestTimeoutMs: phaseModels.requestTimeoutMs,
                  sandboxRunner: effectiveInput.sandboxRunner,
                  reviewersDir
                });
                if (resync.status === "escalated") {
                  return await escalateRefusedMerge(
                    resync.escalationReason ?? "merge_conflict_unresolved",
                    resync.diagnosticExcerpt ?? refusal.message
                  );
                }
                if (resync.status === "up_to_date") {
                  return await escalateRefusedMerge(
                    "pr_not_mergeable",
                    describeMergeRefusal(refusal, mergeableState)
                  );
                }
                if (resync.status === "resolved") {
                  // The LLM-written conflict resolution is reviewed by the ticket loop below before any merge.
                  ticketPrNeedsReview = true;
                } else {
                  await gh.publishCheckRun({
                    name: "ai-review",
                    headSha: resync.headSha,
                    conclusion: "success",
                    summary: `Review of \`${activeHeadSha}\` carried over: \`${resync.headSha}\` only merges \`${targetFeatureBranch}\` into \`${taskBranchToMerge}\`.`
                  });
                  const updatedResynced = await updateIssueStateWithCas({
                    issueNumber: effectiveInput.issueNumber,
                    store,
                    mutator: (prev) => ({
                      ...prev,
                      subphase: "waiting_ticket_ci",
                      active_head_sha: resync.headSha
                    })
                  });
                  return {
                    executed: true,
                    phase: updatedResynced.state.phase,
                    status: updatedResynced.state.status,
                    active_branch: updatedResynced.state.active_branch,
                    summary_markdown: `PR #${prNumberToMerge} was not mergeable; \`${taskBranchToMerge}\` re-synced with \`${targetFeatureBranch}\` at \`${resync.headSha}\`. Waiting for external CI on the new head.`,
                    created_ticket_numbers: [],
                    feature_pr_url: "",
                    waiting_ci_head_sha: resync.headSha
                  };
                }
              }
            }

            if (ticketPrNeedsReview) {
              forceOneRemediationRoundOnOpenPr = true;
            } else if (!featurePrAlreadyMerged) {
              if (ticketNum !== effectiveInput.issueNumber) {
                await gh.closeIssue(ticketNum);
              }

              const updatedAfterTicketMerge = await updateIssueStateWithCas({
                issueNumber: effectiveInput.issueNumber,
                store,
                mutator: (prev) => ({
                  ...prev,
                  subphase: "idle",
                  active_ticket_number: undefined,
                  active_task_branch: undefined,
                  active_pr_number: undefined,
                  active_head_sha: undefined,
                  code_fix_attempts_used: 0
                })
              });
              currentState = updatedAfterTicketMerge.state;
            }
          } else {
            const attemptsUsed = readActiveCodeFixAttempts(currentState);
            if (attemptsUsed >= maxCodeFixAttempts) {
              return await escalateSuspension({
                reason: "remediation_exhausted",
                ticketNumber:
                  currentState.active_ticket_number ??
                  effectiveInput.issueNumber,
                branch: currentState.active_task_branch || featureBranch,
                prNumber: currentState.active_pr_number,
                codeFixAttemptsUsed: attemptsUsed,
                failedChecks: snapshot.failedChecks,
                diagnosticExcerpt: snapshot.formattedDiagnostics
              });
            }
            forceOneRemediationRoundOnOpenPr = true;
          }
        }
      }

    // 5. Handle /epure approve or continuation (a free-form reply never resumes implementation)
    if (
      effectiveInput.command === "approve" ||
      effectiveInput.command === "continue"
    ) {
      const phaseModels = requirePhaseModels();
      const planManifestResolution = resolvePlanManifest({
        state: currentState,
        comments: allComments,
        identity: epureIdentity,
        epicBody: issue.body
      });
      if (planManifestResolution.kind === "missing") {
        return await escalateSuspension({
          reason: "plan_manifest_missing",
          phase:
            currentState && IMPLEMENTATION_PHASES.has(currentState.phase)
              ? currentState.phase
              : "tickets",
          diagnosticExcerpt: planManifestResolution.reason
        });
      }
      if (currentState?.status === "suspended") {
        await gh.removeIssueLabel?.(effectiveInput.issueNumber, "needs-human");
      }
      const parsedPlanManifest =
        planManifestResolution.kind === "recorded"
          ? planManifestResolution.manifest
          : null;
      let ticketsManifest = parsedPlanManifest?.tickets
        ? [...parsedPlanManifest.tickets]
        : [];
      const hasExplicitPlanManifest = ticketsManifest.length > 0;
      if (!hasExplicitPlanManifest) {
        const parsedCriteria = Array.from(
          issue.body.matchAll(/^\s*-\s*\[[ xX]\]\s+(.+)$/gm)
        ).map((m) => m[1]!.trim());
        const parsedFiles = Array.from(
          issue.body.matchAll(/`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)
        ).map((m) => m[1]!.trim());
        ticketsManifest = [
          {
            ticketIssueNumber: issue.number,
            slug: planSlug,
            title: issue.title,
            description: issue.body,
            acceptanceCriteria:
              parsedCriteria.length > 0 ? parsedCriteria : [issue.title],
            blockedByIssueNumbers: [],
            filesToTouch: parsedFiles
          }
        ];
      }

      await gh.ensureBranch("dev", "main");
      await gh.ensureBranch(featureBranch, "dev");

      const trustedBaseRoster = adaptReviewerRosterForDomain({
        repository: effectiveInput.repository,
        planTitle: issue.title,
        glossaryMarkdown: issue.body,
        specMarkdown: issue.body,
        touchesFrontendUi: true,
        reviewersDir
      });
      const trustedBaseFilesMap = new Map<string, string>();
      for (const f of trustedBaseRoster.files) {
        trustedBaseFilesMap.set(f.path, f.content);
      }

      const existingFeaturePrCheck = await gh.findOpenPullRequestByHead(
        featureBranch,
        "dev"
      );
      if (!existingFeaturePrCheck) {
        const mergedAtStart = await stopIfFeaturePrMerged();
        if (mergedAtStart) {
          return mergedAtStart;
        }
      }

      const planBranchToIntegrate = parsedPlanManifest?.planBranch || planBranch;
      const planHeadSha =
        hasExplicitPlanManifest && !existingFeaturePrCheck
          ? await gh.getDefaultBranchSha(planBranchToIntegrate)
          : null;
      const integratePlan =
        planHeadSha !== null && planHeadSha !== currentState?.integrated_plan_sha;

      const remoteTrustedRoster = await gh.readTrustedBaseRosterFiles(
        "dev",
        reviewersDir
      );
      for (const [relPath, content] of remoteTrustedRoster.entries()) {
        trustedBaseFilesMap.set(relPath, content);
      }

      const devWorkflowsMap = await gh.readDevWorkflowsMap("dev");
      const devBranchPaths = await gh.listBranchPathHints("dev");

      const discoveredDevProfile = discoverVerificationProfile({
        targetFilesHint: [
          ...devBranchPaths,
          ...ticketsManifest.flatMap((t) => t.filesToTouch)
        ],
        workflowFilesMap: Object.fromEntries(devWorkflowsMap)
      });

      const verificationProfile: VerificationProfile =
        parsedDevAgentsConfig?.verification?.targets &&
        parsedDevAgentsConfig.verification.targets.length > 0
          ? {
              ...parsedDevAgentsConfig.verification,
              deferred_external_workflows:
                parsedDevAgentsConfig.verification.deferred_external_workflows
                  ?.length
                  ? parsedDevAgentsConfig.verification
                      .deferred_external_workflows
                  : discoveredDevProfile.deferred_external_workflows
            }
          : {
              ...discoveredDevProfile,
              wait_for_external_ci:
                parsedDevAgentsConfig?.verification?.wait_for_external_ci ??
                discoveredDevProfile.wait_for_external_ci,
              external_ci_timeout_minutes:
                parsedDevAgentsConfig?.verification
                  ?.external_ci_timeout_minutes ??
                discoveredDevProfile.external_ci_timeout_minutes,
              grace_window_seconds:
                parsedDevAgentsConfig?.verification?.grace_window_seconds ??
                discoveredDevProfile.grace_window_seconds
            };

      const verificationGuideMarkdown =
        formatVerificationToolingGuideMarkdown(verificationProfile);

      const effectiveSleepFn =
        effectiveInput.sleepFn ??
        (effectiveInput.fetchImpl ? async () => {} : undefined);
      const infraRerunsBySha = new Map<string, number>();

      const escalateToNeedsHuman: EscalateToNeedsHumanFn = (params) =>
        escalateSuspension({
          ...params,
          graceWindowSeconds: verificationProfile.grace_window_seconds,
          createdTicketNumbers: ticketsManifest.map((t) => t.ticketIssueNumber)
        });

      await gh.ensureBranch(featureBranch, "dev");

      const resumeContextMarkdown =
        currentState?.status === "suspended" && (effectiveInput.commentId ?? 0) > 0
          ? formatResumeContextMarkdown(
              await selectResumeContextComments({
                comments: allComments.map((c) => ({
                  id: c.id,
                  authorLogin: c.user.login,
                  authorType: c.user.type ?? "User",
                  authorAssociation: c.author_association ?? "NONE",
                  viaGitHubApp: Boolean(c.performed_via_github_app),
                  body: c.body
                })),
                afterCommentId: currentState.last_processed_comment_id,
                resumeCommentId: effectiveInput.commentId ?? 0,
                resolvePermission: (login) => gh.getCollaboratorPermission(login)
              })
            )
          : "";

      const runLeaseMs = await resolveRunLeaseMs();
      const migratedPlanManifest =
        planManifestResolution.kind === "recorded" &&
        planManifestResolution.fromLegacyComment
          ? planManifestResolution.manifest
          : undefined;
      const updatedStart = await updateIssueStateWithCas({
        issueNumber: effectiveInput.issueNumber,
        store,
        mutator: (prev) => {
          if (
            prev.claimed_by_run_id !== undefined &&
            prev.claimed_by_run_id !== runId &&
            (prev.claimed_by_run_id !== currentState?.claimed_by_run_id ||
              prev.claim_expires_at !== currentState?.claim_expires_at)
          ) {
            throw new StateTransitionAbortedError(
              prev,
              `run \`${prev.claimed_by_run_id}\` claimed the plan after this run checked the lease`
            );
          }
          return {
            ...claimForRun(
              isAutomaticEntry
                ? prev
                : resumeAfterEscalation(prev, {
                    actor: effectiveInput.actor,
                    commentId: effectiveInput.commentId ?? 0
                  }),
              runId,
              runLeaseMs
            ),
            // Leaving the CI wait makes the lease visible, so a workflow_run or continue cannot claim the plan too.
            subphase:
              prev.subphase === "waiting_feature_ci"
                ? "remediating_feature"
                : prev.subphase === "waiting_ticket_ci"
                  ? "implementing_ticket"
                  : prev.subphase,
            phase: "implementation",
            status: "active",
            active_branch: featureBranch,
            feature_branch: prev.feature_branch ?? featureBranch,
            epic_phase: prev.epic_phase ?? 1,
            plan_manifest: prev.plan_manifest ?? migratedPlanManifest,
            last_processed_comment_id:
              advanceCommentCursor(prev, effectiveInput.commentId)
          };
        }
      }).catch(async (err: unknown) => {
        if (err instanceof StateTransitionAbortedError && !isAutomaticEntry) {
          // Best effort: the abort is the outcome, a failed notice must not turn it into an escalation.
          await gh
            .postIssueComment(
              effectiveInput.issueNumber,
              `⏸️ \`/epure ${effectiveInput.command}\` n'a pas été appliqué : ${err.reason}. Vérifiez l'état du plan avec \`/epure status\`, puis republiez la commande si nécessaire.`
            )
            .catch(() => undefined);
        }
        throw err;
      });
      leaseExpiresAt = updatedStart.state.claim_expires_at;
      if (integratePlan && planHeadSha !== null) {
        await integratePlanBranchIntoFeature({
          gh,
          planBranch: planBranchToIntegrate,
          previousPlanSha: currentState?.integrated_plan_sha,
          featureBranch,
          baseBranch: "dev",
          manifestPaths: manifestArtifactPaths(updatedStart.state),
          llmApiKey: effectiveInput.llmApiKey,
          model: phaseModels.planningModel,
          providers: phaseModels.providers,
          maxTransientRetries: phaseModels.maxTransientRetries,
          transientRetryBackoffSeconds: phaseModels.transientRetryBackoffSeconds,
          requestTimeoutMs: phaseModels.requestTimeoutMs,
          fetchImpl: effectiveInput.fetchImpl
        });
        await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => ({ ...prev, integrated_plan_sha: planHeadSha })
        });
      }
      const grant = updatedStart.state.human_budget_grant_log?.at(-1);
      const grantsAfterStart = readHumanBudgetGrants(updatedStart.state);
      if (
        grant &&
        grantsAfterStart >
          (currentState ? readHumanBudgetGrants(currentState) : 0)
      ) {
        await gh.postIssueComment(
          effectiveInput.issueNumber,
          `▶️ Reprise par \`@${grant.actor}\` : budget de remédiation remis à zéro pour ${grant.scope === "feature" ? "la Pull Request de fonctionnalité" : `le ticket #${grant.ticket}`} (\`human_budget_grant_log\` : ${grantsAfterStart}).`
        );
      }
      const baseSyncGuard = createBaseSyncGuard({
        gh,
        store,
        issueNumber: effectiveInput.issueNumber,
        baseBranch: "dev",
        automaticResume: isAutomaticEntry
      });
      const initialCodeFixAttemptsByTicket = readCodeFixAttemptsByTicket(
        updatedStart.state
      );
      const initialFeatureCodeFixAttemptsUsed = readFeatureCodeFixAttempts(
        updatedStart.state
      );

      const hintForWorkspace = [
        issue.title,
        issue.body,
        ...ticketsManifest.map(
          (t) => `${t.title}\n${t.description}\n${t.filesToTouch.join(" ")}`
        )
      ].join("\n");
      const pinnedWorkspacePaths = [
        ...(parsedPlanManifest?.epicGoalContract?.required_entrypoints ?? []),
        ...ticketsManifest.flatMap((t) => t.filesToTouch)
      ];
      const accumulatedFiles = await gh.readBranchWorkspaceFiles(
        featureBranch,
        hintForWorkspace,
        pinnedWorkspacePaths,
        reviewersDir
      );
      const featureChangedFilesMap = new Map<string, string>();
      const featureDeletedFilesSet = new Set<string>();
      const completedTicketsSummary: string[] = [];

      const existingFeaturePrAtStart = await gh.findOpenPullRequestByHead(
        featureBranch,
        "dev"
      );
      let skipTicketLoopForExistingFeaturePr = false;
      if (existingFeaturePrAtStart) {
        let hasOpenTaskPr = false;
        for (const ticket of ticketsManifest) {
          const candidateTaskBranch = `task/${ticket.ticketIssueNumber}-${ticket.slug}`;
          const openTaskPr = await gh.findOpenPullRequestByHead(
            candidateTaskBranch,
            featureBranch
          );
          if (openTaskPr) {
            hasOpenTaskPr = true;
            break;
          }
        }
        if (!hasOpenTaskPr) {
          skipTicketLoopForExistingFeaturePr = true;
          const featurePrFiles = await gh.listPullRequestFiles(
            existingFeaturePrAtStart.number
          );
          for (const prFile of featurePrFiles) {
            const cleanPath = prFile.filename.replace(/^\/+/, "");
            if (prFile.status === "removed") {
              accumulatedFiles.delete(cleanPath);
              featureChangedFilesMap.delete(cleanPath);
              featureDeletedFilesSet.add(cleanPath);
            } else {
              const content =
                (await gh.readSingleBranchFile(featureBranch, cleanPath)) ??
                accumulatedFiles.get(cleanPath) ??
                null;
              if (content !== null) {
                accumulatedFiles.set(cleanPath, content);
                featureChangedFilesMap.set(cleanPath, content);
                featureDeletedFilesSet.delete(cleanPath);
              }
            }
          }
          for (const ticket of ticketsManifest) {
            completedTicketsSummary.push(
              `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — previously squash-merged into \`${featureBranch}\``
            );
          }
        }
      }

      const asyncCiEnabled =
        effectiveInput.asyncCiContinuation ??
        process.env.EPURE_ASYNC_CI_CONTINUATION === "true";

      let loopOutcome = await runTicketExecutionLoop({
        repository: effectiveInput.repository,
        issueNumber: effectiveInput.issueNumber,
        commentId: effectiveInput.commentId,
        activeToken,
        issue,
        featureBranch,
        ticketsManifest,
        skipTicketLoopForExistingFeaturePr,
        accumulatedFiles,
        featureChangedFilesMap,
        featureDeletedFilesSet,
        completedTicketsSummary,
        devBranchPaths,
        devWorkflowsMap,
        trustedBaseFilesMap,
        trustedBaseDesignMarkdown: trustedBaseRoster.designMarkdown,
        parsedDevAgentsConfig,
        initialVerificationProfile: verificationProfile,
        initialVerificationGuideMarkdown: verificationGuideMarkdown,
        maxCodeFixAttempts,
        hintForWorkspace,
        infraRerunsBySha,
        getTotalTransientRetriesUsed: cumulativeTransientRetriesUsed,
        addTransientRetriesUsed: (delta) => {
          totalTransientRetriesUsed += delta;
        },
        escalateToNeedsHuman,
        gh,
        store,
        llmApiKey: effectiveInput.llmApiKey,
        phaseModels,
        fetchImpl: effectiveInput.fetchImpl,
        effectiveSleepFn,
        pollIntervalMs: effectiveInput.pollIntervalMs,
        sandboxRunner: effectiveInput.sandboxRunner,
        asyncCiContinuation: asyncCiEnabled,
        forceOneRemediationRoundOnOpenPr,
        initialCodeFixAttemptsByTicket,
        baseSyncGuard,
        resumeContextMarkdown,
        stopIfFeaturePrMerged
      });

      if (loopOutcome.halted && loopOutcome.result) {
        return loopOutcome.result;
      }

      // Multi-phase zero-context Epic Convergence Audit & automatic Phase 2 ticket loop (ADR-0032, Q116-Q121)
      const epicGoalContract = parsedPlanManifest?.epicGoalContract;
      let epicConvergenceSummary: string | undefined;
      if (epicGoalContract && !skipTicketLoopForExistingFeaturePr) {
        const maxEpicPhases = Math.min(
          3,
          Math.max(1, parsedDevAgentsConfig?.max_epic_phases ?? 2)
        );
        const highestTicketPhase = ticketsManifest.reduce(
          (maxP, t) => Math.max(maxP, t.phase ?? 1),
          1
        );
        let currentEpicPhase = Math.max(
          updatedStart.state.epic_phase ?? 1,
          highestTicketPhase
        );
        const effectiveSpecPath =
          parsedPlanManifest?.specPath ?? `docs/specs/${planSlug}.md`;
        const specMarkdownOnFeature =
          (await gh.readSingleBranchFile(featureBranch, effectiveSpecPath)) ??
          issue.body;
        const glossaryMarkdownOnFeature =
          (await gh.readSingleBranchFile(featureBranch, "GLOSSARY.md")) ?? "";

        while (true) {
          await updateIssueStateWithCas({
            issueNumber: effectiveInput.issueNumber,
            store,
            mutator: (prev) => ({
              ...prev,
              phase: "implementation",
              status: "active",
              subphase: "auditing_epic_convergence",
              epic_phase: currentEpicPhase
            })
          });

          const stage1Summary =
            completedTicketsSummary.length > 0
              ? `Stage 1 PASSED across ${completedTicketsSummary.length} merged ticket(s) on ${featureBranch}:\n${completedTicketsSummary.join("\n")}`
              : `Stage 1 PASSED on ${featureBranch}`;

          const convergenceAudit = await runEpicConvergenceAudit({
            issueNumber: effectiveInput.issueNumber,
            featureBranch,
            specPath: effectiveSpecPath,
            specMarkdown: specMarkdownOnFeature,
            glossaryMarkdown: glossaryMarkdownOnFeature,
            epicGoalContract,
            accumulatedFiles,
            featureChangedFilesMap,
            devBranchPaths,
            stage1Summary,
            gh,
            llmApiKey: effectiveInput.llmApiKey,
            phaseModels,
            onTransientRetriesUsed: (used) => {
              totalTransientRetriesUsed += used;
            },
            fetchImpl: effectiveInput.fetchImpl
          });

          if (convergenceAudit.verdict === "CONVERGED") {
            epicConvergenceSummary =
              convergenceAudit.rationale ||
              `All required entrypoints (${epicGoalContract.required_entrypoints.join(", ")}) wired and verified in Phase ${currentEpicPhase}.`;
            await updateIssueStateWithCas({
              issueNumber: effectiveInput.issueNumber,
              store,
              mutator: (prev) => ({
                ...prev,
                subphase: "idle",
                epic_phase: currentEpicPhase
              })
            });
            break;
          }

          if (currentEpicPhase >= maxEpicPhases) {
            return await escalateToNeedsHuman({
              reason: "epic_convergence_exhausted",
              ticketNumber: effectiveInput.issueNumber,
              branch: featureBranch,
              phase: "implementation",
              diagnosticExcerpt: convergenceAudit.rationale,
              epicConvergenceDetails: {
                epicPhase: currentEpicPhase,
                maxEpicPhases,
                summary: convergenceAudit.rationale,
                unwiredModules: convergenceAudit.unwired_modules,
                stubViolations: convergenceAudit.stub_violations,
                unmetCriteria: convergenceAudit.unmet_criteria
              }
            });
          }

          const nextEpicPhase = currentEpicPhase + 1;
          await updateIssueStateWithCas({
            issueNumber: effectiveInput.issueNumber,
            store,
            mutator: (prev) => ({
              ...prev,
              phase: "implementation",
              status: "active",
              subphase: "implementing_ticket",
              epic_phase: nextEpicPhase
            })
          });

          ticketsManifest = await spawnPhase2ConvergenceTickets({
            gh,
            issueNumber: effectiveInput.issueNumber,
            issue,
            planBranch: parsedPlanManifest?.planBranch || planBranch,
            specPath: effectiveSpecPath,
            epicGoalContract,
            nextEpicPhase,
            existingTickets: ticketsManifest,
            auditResult: convergenceAudit,
            recordPlanManifest: async (manifest) =>
              (
                await updateIssueStateWithCas({
                  issueNumber: effectiveInput.issueNumber,
                  store,
                  mutator: (prev) => ({ ...prev, plan_manifest: manifest })
                })
              ).issue_mirror_markdown
          });
          currentEpicPhase = nextEpicPhase;

          loopOutcome = await runTicketExecutionLoop({
            repository: effectiveInput.repository,
            issueNumber: effectiveInput.issueNumber,
            commentId: effectiveInput.commentId,
            activeToken,
            issue,
            featureBranch,
            ticketsManifest,
            skipTicketLoopForExistingFeaturePr: false,
            accumulatedFiles,
            featureChangedFilesMap,
            featureDeletedFilesSet,
            completedTicketsSummary,
            devBranchPaths,
            devWorkflowsMap,
            trustedBaseFilesMap,
            trustedBaseDesignMarkdown: trustedBaseRoster.designMarkdown,
            parsedDevAgentsConfig,
            initialVerificationProfile: loopOutcome.verificationProfile,
            initialVerificationGuideMarkdown:
              loopOutcome.verificationGuideMarkdown,
            maxCodeFixAttempts,
            hintForWorkspace,
            infraRerunsBySha,
            getTotalTransientRetriesUsed: cumulativeTransientRetriesUsed,
            addTransientRetriesUsed: (delta) => {
              totalTransientRetriesUsed += delta;
            },
            escalateToNeedsHuman,
            gh,
            store,
            llmApiKey: effectiveInput.llmApiKey,
            phaseModels,
            fetchImpl: effectiveInput.fetchImpl,
            effectiveSleepFn,
            pollIntervalMs: effectiveInput.pollIntervalMs,
            sandboxRunner: effectiveInput.sandboxRunner,
            asyncCiContinuation: asyncCiEnabled,
            forceOneRemediationRoundOnOpenPr: false,
            initialCodeFixAttemptsByTicket,
            baseSyncGuard,
            resumeContextMarkdown,
            stopIfFeaturePrMerged
          });

          if (loopOutcome.halted && loopOutcome.result) {
            return loopOutcome.result;
          }
        }
      }

      try {
        return await runFeatureIntegrationPhase({
          repository: effectiveInput.repository,
          issueNumber: effectiveInput.issueNumber,
          commentId: effectiveInput.commentId,
          activeToken,
          issue,
          planSlug,
          featureBranch,
          activeBranchForStartState: updatedStart.state.active_branch,
          ticketsManifest,
          existingFeaturePrAtStart,
          accumulatedFiles,
          featureChangedFilesMap,
          featureDeletedFilesSet,
          completedTicketsSummary,
          ...(epicConvergenceSummary !== undefined
            ? { epicConvergenceSummary }
            : {}),
          devBranchPaths,
          devWorkflowsMap,
          trustedBaseFilesMap,
          trustedBaseDesignMarkdown: trustedBaseRoster.designMarkdown,
          parsedDevAgentsConfig,
          initialVerificationProfile: loopOutcome.verificationProfile,
          initialVerificationGuideMarkdown: loopOutcome.verificationGuideMarkdown,
          maxCodeFixAttempts,
          infraRerunsBySha,
          getTotalTransientRetriesUsed: cumulativeTransientRetriesUsed,
          addTransientRetriesUsed: (delta) => {
            totalTransientRetriesUsed += delta;
          },
          escalateToNeedsHuman,
          gh,
          store,
          llmApiKey: effectiveInput.llmApiKey,
          phaseModels,
          fetchImpl: effectiveInput.fetchImpl,
          effectiveSleepFn,
          pollIntervalMs: effectiveInput.pollIntervalMs,
          sandboxRunner: effectiveInput.sandboxRunner,
          asyncCiContinuation: asyncCiEnabled,
          forceOneRemediationRoundOnOpenPr,
          initialFeatureCodeFixAttemptsUsed,
          baseSyncGuard,
          resumeContextMarkdown,
          stopIfFeaturePrMerged
        });
      } catch (err) {
        if (err instanceof LLMError) {
          return await escalateToNeedsHuman({
            reason: resolveLlmEscalationReason(err),
            ticketNumber: effectiveInput.issueNumber,
            branch: featureBranch,
            phase: "implementation",
            diagnosticExcerpt: redactSecrets(err.message, [
              activeToken,
              effectiveInput.llmApiKey
            ])
          });
        }
        throw err;
      }
    }

      return {
        executed: false,
        phase: currentState?.phase ?? "idle",
        status: currentState?.status ?? "active",
        active_branch: currentState?.active_branch ?? "",
        summary_markdown: "No orchestration transition matched.",
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    } catch (err) {
      if (err instanceof StateTransitionAbortedError) {
        return abortedResult(err);
      }
      if (effectiveInput.command === "closed") {
        throw new ClosureNotProcessedError(effectiveInput.issueNumber, err);
      }
      const rawErrMessage = err instanceof Error ? err.message : String(err);
      const escalation: EscalationRecordInput = {
        reason:
          err instanceof LLMError
            ? resolveLlmEscalationReason(err)
            : err instanceof GitHubRateLimitError
              ? "github_rate_limited"
              : err instanceof BranchUpdateConflictError
                ? "branch_update_conflict"
                : err instanceof MissingModelConfigError
                  ? "model_config_missing"
                  : err instanceof AmbiguousFeatureBranchError
                    ? "ambiguous_feature_branch"
                    : "internal_error",
        missingModelKeys:
          err instanceof MissingModelConfigError ? err.missingKeys : undefined,
        diagnosticExcerpt: redactSecrets(rawErrMessage, [
          activeToken,
          effectiveInput.llmApiKey
        ])
      };

      // The run's wait budget is spent once it escalates github_rate_limited: recording gets its own.
      const rateLimited = err instanceof GitHubRateLimitError;
      const recordFetch = rateLimited
        ? createGitHubRateLimitedFetch({
            fetchImpl: countedFetch,
            sleepFn: input.sleepFn
          })
        : githubFetch;
      const recordGh = rateLimited
        ? createGitHubRestHelper({
            repository: input.repository,
            token: activeToken,
            fetchImpl: recordFetch
          })
        : gh;
      const recordStore =
        rateLimited && !input.stateStore
          ? guardTerminalStates(
              createGitHubApiRefStateStore({
                repository: input.repository,
                githubToken: activeToken,
                fetchImpl: recordFetch
              }),
              allowedTerminalSha
            )
          : store;

      try {
        return await recordEscalation(escalation, {
          gh: recordGh,
          store: recordStore
        });
      } catch (recordErr) {
        if (recordErr instanceof StateTransitionAbortedError) {
          return abortedResult(recordErr);
        }
        if (!(recordErr instanceof GitHubRateLimitError)) {
          throw recordErr;
        }
        const approveAgain =
          effectiveInput.command === "approve" ? "/epure approve" : undefined;
        throw new EscalationNotRecordedError(
          effectiveInput.issueNumber,
          escalation.reason,
          formatEscalation(escalation, {
            phase: commandPhase,
            branch: IMPLEMENTATION_PHASES.has(commandPhase)
              ? featureBranch
              : planBranch,
            ticketNumber: effectiveInput.issueNumber,
            resumeCommand: approveAgain
          }),
          approveAgain ?? resumeCommandForPhase(commandPhase),
          leaseExpiresAt
        );
      }
    }
  } finally {
    process.stdout.write(
      `[EPURE] GitHub API requests this run: ${githubRequestCount}\n`
    );
    if (mintedAppToken) {
      try {
        await revokeGitHubInstallationToken({
          token: mintedAppToken,
          fetchImpl: input.fetchImpl
        });
      } catch {
        // Ignore revocation errors
      }
    }
  }
}
