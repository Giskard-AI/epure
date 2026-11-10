import {
  AgentEngineError,
  assertNoSecretMaterial,
  resolveLifecycleAgentEngine,
  type AgentEngine,
  type AgentRole,
  type AgentThinkingLevel,
  type FileMode,
  type SkippedPathReason
} from "../../agent/engine.js";
import { listTrackedPaths } from "../../agent/worktree-snapshot.js";
import { redactSecrets } from "../../auth/issue-command-gate.js";
import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../../bootstrap/ci-and-renovate.js";
import type { parseAgentsYaml } from "../../bootstrap/setup-repo.js";
import {
  discoverExpectedExternalWorkflows,
  resolveAgentEngineEscalationReason,
  resolveLlmEscalationReason,
  waitForExternalCiChecks,
  type NeedsHumanEscalationReason,
  type WaitForExternalCiChecksResult
} from "../../execution/external-ci-gate.js";
import { reconcileProvenTicketDependencies } from "../../execution/proven-dependency-unblocker.js";
import { evaluateReviewFeedbackTrigger } from "../../execution/review-loop-guard.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "../../llm/client.js";
import {
  AuthenticationError,
  LLMError,
  QuotaExhaustedError
} from "../../llm/errors.js";
import { runMultiAgentPrReviewPass } from "../../review/multi-agent-pr-review.js";
import {
  DEFAULT_REVIEWERS_DIR,
  type ReviewerAgentName
} from "../../review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../../review/squash-commit-generator.js";
import { formatAgentProvenanceLine } from "../../security/audit-trace.js";
import {
  collectRunnerSecretValues,
  type SandboxExecutionInput,
  type SandboxExecutionResult
} from "../../sandbox/llm-sandbox.js";
import {
  formatVerificationToolingGuideMarkdown,
  isSensitiveTaskBranchPath,
  prepareRepositorySandboxWorkspace,
  syncWorkspaceFiles,
  validateWorkspaceFileOperations
} from "../../sandbox/polyglot-workspace-runner.js";
import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  wrapUntrustedContent
} from "../../security/prompt-injection-guard.js";
import { processPendingIssueCommentsBatch } from "../../state/comment-batch-cursor.js";
import {
  advanceCommentCursor,
  formatIssueStateMarker,
  toTerminalState,
  updateIssueStateWithCas,
  withTicketCodeFixAttempts,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import { currentTokenUsage, withUsageAttribution } from "../../usage/token-usage.js";
import { formatTicketUsageSuffix } from "../../usage/usage-report.js";
import { appendEpureCommandsSpoiler, fencedCodeBlock } from "../formatting/comments.js";
import { callLlmJson } from "../llm-helper.js";
import {
  syncBranchWithBase,
  type BaseSyncGuard
} from "../github/branch-sync.js";
import {
  describeMergeRefusal,
  isConflictRefusal,
  loadOrchestratorStateFromGitRef,
  PullRequestHeadMovedError,
  PullRequestNotMergeableError,
  TruncatedGitTreeError
} from "../github/rest-client.js";
import { EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT } from "../prompts/code-discipline.js";
import { formatResumeContextPromptLines } from "../prompts/resume-context.js";
import {
  TICKET_SESSION_SUMMARY_SCHEMA,
  type TicketSessionSummary
} from "../prompts/schemas.js";
import {
  type EscalateToNeedsHumanFn,
  type GitBlobRef,
  type GitHubRestHelper,
  type IssueMetadata,
  type OrchestrateIssueResult,
  type ResolvedPhaseModels,
  type TrackedTicketCommentMetadata
} from "../types.js";
import {
  applyTicketImplementationPayload,
  buildCompactWorkspaceFilesContext,
  runTestsInIsolatedWorkspace,
  validateTicketIntegrityGuard,
  type TicketImplementationDiffPayload
} from "../workspace/repo-tools.js";

export interface RunTicketExecutionLoopParams {
  readonly repository: string;
  readonly issueNumber: number;
  readonly commentId: number | undefined;
  readonly activeToken: string;
  readonly issue: IssueMetadata;
  readonly featureBranch: string;
  readonly ticketsManifest: readonly TrackedTicketCommentMetadata[];
  readonly skipTicketLoopForExistingFeaturePr: boolean;
  readonly accumulatedFiles: Map<string, string>;
  readonly featureChangedFilesMap: Map<string, string>;
  readonly featureDeletedFilesSet: Set<string>;
  readonly completedTicketsSummary: string[];
  readonly devBranchPaths: readonly string[];
  readonly devWorkflowsMap: Map<string, string>;
  readonly trustedBaseFilesMap: Map<string, string>;
  readonly trustedBaseDesignMarkdown: string | undefined;
  readonly parsedDevAgentsConfig: ReturnType<typeof parseAgentsYaml> | null;
  readonly initialVerificationProfile: VerificationProfile;
  readonly initialVerificationGuideMarkdown: string;
  readonly maxCodeFixAttempts: number;
  readonly hintForWorkspace: string;
  readonly infraRerunsBySha: Map<string, number>;
  readonly getTotalTransientRetriesUsed: () => number;
  readonly addTransientRetriesUsed: (delta: number) => void;
  readonly escalateToNeedsHuman: EscalateToNeedsHumanFn;
  readonly gh: GitHubRestHelper;
  readonly store: GitRefStateStore;
  readonly llmApiKey: string;
  readonly phaseModels: ResolvedPhaseModels;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly effectiveSleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly asyncCiContinuation?: boolean | undefined;
  readonly forceOneRemediationRoundOnOpenPr?: boolean | undefined;
  readonly initialCodeFixAttemptsByTicket: Readonly<Record<string, number>>;
  readonly baseSyncGuard: BaseSyncGuard;
  readonly resumeContextMarkdown?: string | undefined;
  // Moves the epic to `done` and returns its result when a human merged the feature PR meanwhile.
  readonly stopIfFeaturePrMerged: () => Promise<OrchestrateIssueResult | null>;
  // Implementation, Stage 1 fixes and review/CI remediation run as sessions of this engine when set.
  readonly agentEngine?: AgentEngine | undefined;
  // Epoch ms at which the job's timeout kills the run; agent sessions end before it.
  readonly jobDeadlineMs?: number | undefined;
}

export interface RunTicketExecutionLoopOutcome {
  readonly halted: boolean;
  readonly result?: OrchestrateIssueResult | undefined;
  readonly verificationProfile: VerificationProfile;
  readonly verificationGuideMarkdown: string;
}

async function checkMidLoopCancellation(params: {
  readonly issueNumber: number;
  readonly commentId: number | undefined;
  readonly featureBranch: string;
  readonly ticketsManifest: readonly TrackedTicketCommentMetadata[];
  readonly gh: GitHubRestHelper;
  readonly store: GitRefStateStore;
}): Promise<OrchestrateIssueResult | null> {
  const snapshot = await loadOrchestratorStateFromGitRef(
    params.store,
    params.issueNumber
  );
  if (snapshot.state?.status === "cancelled") {
    const cancelMarkdown = appendEpureCommandsSpoiler(
      [
        formatIssueStateMarker(snapshot.state),
        "",
        `🛑 Plan #${params.issueNumber} execution halted because status is **cancelled**.`
      ].join("\n"),
      {
        phase: "cancelled",
        status: "cancelled",
        issueNumber: params.issueNumber
      }
    );
    await params.gh.postIssueComment(params.issueNumber, cancelMarkdown);
    return {
      executed: true,
      phase: snapshot.state.phase,
      status: "cancelled",
      active_branch: params.featureBranch,
      summary_markdown: cancelMarkdown,
      created_ticket_numbers: params.ticketsManifest.map(
        (t) => t.ticketIssueNumber
      ),
      feature_pr_url: ""
    };
  }

  const initialCursor = Math.max(
    snapshot.state?.last_processed_comment_id ?? 0,
    params.commentId ?? 0
  );

  const batchResult = await processPendingIssueCommentsBatch({
    issueNumber: params.issueNumber,
    store: params.store,
    initialCursor,
    fetchCommentsSinceCursor: async (cursor) => {
      const latestComments = await params.gh.listIssueComments(
        params.issueNumber
      );
      return latestComments
        .filter((c) => c.id > cursor)
        .map((c) => ({
          id: c.id,
          authorLogin: c.user.login,
          authorType: c.user.type ?? "User",
          effectivePermission: "write" as const,
          body: c.body
        }));
    }
  });

  if (batchResult.cancelled) {
    const cancelMarkdown = appendEpureCommandsSpoiler(
      [
        formatIssueStateMarker(batchResult.state),
        "",
        `🛑 Plan #${params.issueNumber} has been **cancelled** mid-run via \`/epure cancel\`. Halting remaining ticket executions.`
      ].join("\n"),
      {
        phase: "cancelled",
        status: "cancelled",
        issueNumber: params.issueNumber
      }
    );
    await params.gh.postIssueComment(params.issueNumber, cancelMarkdown);
    return {
      executed: true,
      phase: batchResult.state.phase,
      status: "cancelled",
      active_branch: params.featureBranch,
      summary_markdown: cancelMarkdown,
      created_ticket_numbers: params.ticketsManifest.map(
        (t) => t.ticketIssueNumber
      ),
      feature_pr_url: ""
    };
  }

  return null;
}

interface RunTicketAgentSessionParams {
  readonly ticket: TrackedTicketCommentMetadata;
  readonly prompt: string;
  readonly thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined;
  readonly logLabel?: string | undefined;
  readonly accumulatedFiles: Map<string, string>;
  readonly deletedFilesSet: ReadonlySet<string>;
  readonly reviewersDir: string;
  readonly gh: GitHubRestHelper;
  readonly llmApiKey: string;
  readonly phaseModels: ResolvedPhaseModels;
  readonly addTransientRetriesUsed: (delta: number) => void;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly agentSession?: TicketAgentSession | undefined;
}

// Shared by a ticket's sessions.
interface TicketAgentSessionState {
  // Carried to the commits: the text pipeline does not keep the executable bit.
  readonly fileModes: Map<string, FileMode>;
  // Reverted changes of the last session, told to the next one.
  pendingFeedback: string[];
  // Set when the last session counts as a failed attempt without running Stage 1.
  failedAttempt: string | undefined;
  lastSessionEmpty: boolean;
}

interface TicketAgentSession {
  readonly engine: AgentEngine;
  readonly role: AgentRole;
  // The Stage 1 checkout; it is brought to the ticket's current files before the session.
  readonly worktree: string;
  readonly trackedPaths: readonly string[];
  readonly jobDeadlineMs: number | undefined;
  readonly maxLlmRequests: number;
  readonly state: TicketAgentSessionState;
}

const TICKET_AGENT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
// Kept after a session for Stage 1, the commit and an escalation before the job's timeout kills the run.
const AGENT_SESSION_RESERVE_MS = 10 * 60 * 1000;
const MIN_AGENT_SESSION_MS = 2 * 60 * 1000;
// One Stage 1 install or test command at its timeout, then the commit or an escalation.
const MIN_STAGE1_BUDGET_MS = 5 * 60 * 1000;
export const DEFAULT_AGENT_MAX_LLM_REQUESTS = 200;

export class JobBudgetExhaustedError extends Error {
  constructor(
    remainingMs: number,
    step = "an agent session with Stage 1 and the commit",
    neededMs = AGENT_SESSION_RESERVE_MS + MIN_AGENT_SESSION_MS
  ) {
    super(
      `${Math.max(0, Math.floor(remainingMs / 1000))} s of the job's time budget remain: ${step} needs ${neededMs / 1000} s.`
    );
    this.name = "JobBudgetExhaustedError";
  }
}

// min(session cap, what the job leaves after the reserve); undefined when that is too short to start.
export function agentSessionTimeoutMs(jobDeadlineMs: number | undefined, nowMs: number): number | undefined {
  const available =
    jobDeadlineMs === undefined ? TICKET_AGENT_SESSION_TIMEOUT_MS : jobDeadlineMs - nowMs - AGENT_SESSION_RESERVE_MS;
  return available < MIN_AGENT_SESSION_MS ? undefined : Math.min(TICKET_AGENT_SESSION_TIMEOUT_MS, available);
}

// The summary call leaves Stage 1 its floor; at least 1 s so the call can still fail over to the fallback message.
export function summaryRequestTimeoutMs(
  jobDeadlineMs: number | undefined,
  nowMs: number,
  requestTimeoutMs: number | undefined
): number | undefined {
  if (jobDeadlineMs === undefined) {
    return requestTimeoutMs;
  }
  return Math.max(
    1_000,
    Math.min(requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS, jobDeadlineMs - nowMs - MIN_STAGE1_BUDGET_MS)
  );
}

const SKIPPED_PATH_LABELS: Record<SkippedPathReason, string> = {
  symlink: "lien symbolique",
  submodule: "sous-module",
  binary: "binaire ou texte non UTF-8",
  ignored: "nouveau fichier ignoré (.gitignore, dépendances ou sortie de build)",
  protected: "chemin protégé"
};

const TICKET_AGENT_ROLE_HEADLINES: Record<AgentRole, string> = {
  implementer: "Tu es un ingénieur TDD EPURE implémentant un ticket approuvé.",
  fixer:
    "Tu es un ingénieur TDD EPURE corrigeant les échecs décrits dans le message (vérification Stage 1, constats 'must_fix' de revue, CI externe) en gardant 100% des cibles Stage 1 au vert.",
  conflict_resolver:
    "Tu es un ingénieur expert chargé de résoudre un conflit de fusion Git à 3 voies (3-way merge) directement dans le répertoire de travail.",
  reviewer: "Tu es un ingénieur EPURE en revue de code (lecture seule).",
  convergence_auditor:
    "Tu es un auditeur de convergence EPURE évaluant l'alignement global du dépôt (lecture seule).",
  adr_reconciler:
    "Tu es un architecte EPURE réconciliant GLOSSARY.md et docs/adr/ après un audit de convergence.",
  griller:
    "Tu es un ingénieur EPURE menant un entretien de cadrage (grilling) sur une demande.",
  spec_writer:
    "Tu es un ingénieur EPURE rédigeant une spécification technique à partir d'un entretien validé.",
  ticket_splitter:
    "Tu es un ingénieur EPURE découpant une spécification approuvée en tickets atomiques."
};

function ticketAgentInstructions(role: AgentRole, reviewersDir: string): string {
  return [
    TICKET_AGENT_ROLE_HEADLINES[role],
    PROMPT_INJECTION_IMMUNITY_CLAUSE,
    "Tu travailles directement dans le checkout du dépôt (répertoire courant) avec tes outils : les fichiers que tu laisses modifiés, créés ou supprimés constituent le livrable.",
    "Écris des tests paramétrés couvrant les critères d'acceptation et cas limites, et du code propre qui les fait passer. Lance les commandes de vérification du guide quand c'est possible ; le réseau est coupé (hors LLM), n'installe aucune dépendance.",
    `Ne modifie JAMAIS ${reviewersDir}/**, .github/workflows/**, .github/agents.yml, .env* ni .git/.`,
    "Termine par un court compte rendu : fichiers changés, tests ajoutés et commandes lancées avec leur résultat.",
    "",
    EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
  ].join("\n");
}

// Agent session, then a direct structured-output call for the commit message: the diff is the worktree's.
async function runTicketAgentSession(
  params: RunTicketAgentSessionParams
): Promise<TicketImplementationDiffPayload> {
  if (!params.agentSession) {
    throw new AgentEngineError(
      "AGENT_ENGINE_UNAVAILABLE",
      "No agentEngine configured for ticket session."
    );
  }
  const session = params.agentSession;
  const nowMs = Date.now();
  const timeoutMs = agentSessionTimeoutMs(session.jobDeadlineMs, nowMs);
  if (timeoutMs === undefined) {
    throw new JobBudgetExhaustedError((session.jobDeadlineMs ?? nowMs) - nowMs);
  }
  syncWorkspaceFiles(session.worktree, params.accumulatedFiles, params.deletedFilesSet, session.state.fileModes);
  const { state } = session;
  const feedback = state.pendingFeedback;
  state.pendingFeedback = [];
  const { finalMessage, diff } = await session.engine.run({
    role: session.role,
    toolPolicy: "write",
    instructions: ticketAgentInstructions(session.role, params.reviewersDir),
    prompt: feedback.length > 0 ? [params.prompt, "", ...feedback].join("\n") : params.prompt,
    worktree: session.worktree,
    timeoutMs,
    model: params.phaseModels.implementationModel,
    providers: params.phaseModels.providers,
    thinking: params.thinkingLevel ? THINKING_LEVELS[params.thinkingLevel] : undefined,
    trackedPaths: session.trackedPaths,
    isProtectedPath: (path) => isSensitiveTaskBranchPath(path, params.reviewersDir),
    maxLlmRequests: session.maxLlmRequests,
    secrets: [params.gh.token]
  });

  for (const f of diff.files) {
    state.fileModes.set(f.path, f.mode);
  }
  const reverted = diff.skipped.map((s) => `- ${s.path} (${SKIPPED_PATH_LABELS[s.reason]})`);
  if (reverted.length > 0) {
    state.pendingFeedback = [
      "Changements de la session précédente annulés (non committables) ; le dépôt est revenu à leur état antérieur :",
      ...reverted
    ];
  }
  const protectedPaths = diff.skipped.filter((s) => s.reason === "protected").map((s) => s.path);
  state.lastSessionEmpty = diff.files.length === 0 && diff.deleted_files.length === 0;
  state.failedAttempt =
    protectedPaths.length > 0
      ? `Modification interdite de chemin(s) protégé(s), annulée : ${protectedPaths.join(", ")}. Ne modifie jamais ${params.reviewersDir}/**, .github/workflows/**, .github/agents.yml ni .env*.`
      : session.role === "fixer" && state.lastSessionEmpty
        ? "no changes left in worktree: la session de correction n'a laissé aucun changement dans le dépôt."
        : undefined;

  const changedPaths = [
    ...diff.files.map((f) => `- ${f.path}`),
    ...diff.deleted_files.map((p) => `- ${p} (supprimé)`)
  ];
  const summary = await summarizeAgentSession(params, changedPaths, finalMessage, session.jobDeadlineMs);
  // The summary reaches the commit and the PR body.
  assertNoSecretMaterial(
    [
      { label: "the commit message", text: summary.commit_message },
      { label: "the test summary", text: summary.test_summary }
    ],
    [params.gh.token, params.llmApiKey, ...collectRunnerSecretValues(process.env)]
  );

  return {
    commit_message: summary.commit_message,
    test_summary: summary.test_summary,
    files: diff.files.map(({ path, content }) => ({ path, content })),
    patches: [],
    deleted_files: [...diff.deleted_files]
  };
}

const THINKING_LEVELS = {
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high"
} as const satisfies Record<NonNullable<RunTicketAgentSessionParams["thinkingLevel"]>, AgentThinkingLevel>;

const MAX_SUMMARIZED_FINAL_MESSAGE_CHARS = 16_000;

// A failed summary call (other than auth or quota) falls back to a deterministic message instead of losing the session.
async function summarizeAgentSession(
  params: RunTicketAgentSessionParams,
  changedPaths: readonly string[],
  finalMessage: string,
  jobDeadlineMs: number | undefined
): Promise<TicketSessionSummary> {
  const requestTimeoutMs = summaryRequestTimeoutMs(jobDeadlineMs, Date.now(), params.phaseModels.requestTimeoutMs);
  try {
    return await callLlmJson<TicketSessionSummary>({
    apiKey: params.llmApiKey,
    model: params.phaseModels.implementationModel,
    providers: params.phaseModels.providers,
    maxTransientRetries: params.phaseModels.maxTransientRetries,
    transientRetryBackoffSeconds: params.phaseModels.transientRetryBackoffSeconds,
    requestTimeoutMs,
    onTransientRetriesUsed: (used) => params.addTransientRetriesUsed(used),
    logLabel: params.logLabel ? `${params.logLabel}/summary` : undefined,
    systemInstruction: [
      "Tu rédiges le message de commit (Conventional Commits) et le résumé de tests des changements qu'une session d'agent a laissés dans le dépôt.",
      PROMPT_INJECTION_IMMUNITY_CLAUSE,
      'Renvoie un objet JSON : { "commit_message": "...", "test_summary": "..." }.'
    ].join("\n"),
    prompt: [
      `Ticket #${params.ticket.ticketIssueNumber} : ${params.ticket.title}`,
      "",
      "Fichiers changés :",
      changedPaths.length > 0 ? changedPaths.join("\n") : "(aucun)",
      "",
      "Compte rendu de la session :",
      wrapUntrustedContent(
        "untrusted_test_output",
        finalMessage.length > MAX_SUMMARIZED_FINAL_MESSAGE_CHARS
          ? `${finalMessage.slice(0, MAX_SUMMARIZED_FINAL_MESSAGE_CHARS)}\n[… compte rendu tronqué]`
          : finalMessage
      )
    ].join("\n"),
    temperature: 0.1,
    responseSchema: TICKET_SESSION_SUMMARY_SCHEMA,
    fetchImpl: params.fetchImpl
    });
  } catch (err) {
    if (err instanceof AuthenticationError || err instanceof QuotaExhaustedError) {
      throw err;
    }
    return {
      commit_message: `feat(ticket-${params.ticket.ticketIssueNumber}): ${params.ticket.title}`,
      test_summary: "Résumé indisponible : l'appel de synthèse de la session a échoué."
    };
  }
}

export async function runTicketExecutionLoop(
  params: RunTicketExecutionLoopParams
): Promise<RunTicketExecutionLoopOutcome> {
  const reviewersDir =
    params.parsedDevAgentsConfig?.reviewers_dir ?? DEFAULT_REVIEWERS_DIR;
  let verificationProfile = params.initialVerificationProfile;
  let verificationGuideMarkdown = params.initialVerificationGuideMarkdown;
  const completedTicketNumbers = new Set<number>();
  const resumeContextPromptLines = formatResumeContextPromptLines(
    params.resumeContextMarkdown
  );

  for (const ticket of params.skipTicketLoopForExistingFeaturePr
    ? []
    : params.ticketsManifest) {
    // Bucket A Guard 1: Mid-loop cancellation check before starting ticket
    const cancelledBeforeTicket = await checkMidLoopCancellation({
      issueNumber: params.issueNumber,
      commentId: params.commentId,
      featureBranch: params.featureBranch,
      ticketsManifest: params.ticketsManifest,
      gh: params.gh,
      store: params.store
    });
    const haltBeforeTicket =
      cancelledBeforeTicket ?? (await params.stopIfFeaturePrMerged());
    if (haltBeforeTicket) {
      return {
        halted: true,
        result: haltBeforeTicket,
        verificationProfile,
        verificationGuideMarkdown
      };
    }

    // Bucket A Guard 2: Proven dependency unblocker before starting dependent ticket
    if (ticket.blockedByIssueNumbers.length > 0) {
      const blockerEntries = await Promise.all(
        ticket.blockedByIssueNumbers.map(async (blockerNum) => {
          if (completedTicketNumbers.has(blockerNum)) {
            return {
              ticketId: blockerNum,
              issueNumber: blockerNum,
              state: "closed" as const,
              stateReason: "completed" as const,
              hasMergedPrOnFeatureBranch: true,
              humanOverrideApproved: false,
              blockedByTicketIds: [] as readonly number[]
            };
          }
          const blockerMeta = await params.gh.getIssue(blockerNum);
          const isClosed = blockerMeta.state === "closed";
          const effectiveReason: "completed" | "not_planned" | "reopened" | null =
            blockerMeta.state_reason === "not_planned"
              ? "not_planned"
              : blockerMeta.state_reason === "reopened"
                ? "reopened"
                : isClosed
                  ? "completed"
                  : null;
          return {
            ticketId: blockerNum,
            issueNumber: blockerNum,
            state: isClosed ? ("closed" as const) : ("open" as const),
            stateReason: effectiveReason,
            hasMergedPrOnFeatureBranch:
              isClosed && effectiveReason === "completed",
            humanOverrideApproved: false,
            blockedByTicketIds: [] as readonly number[]
          };
        })
      );

      const depReconciliation = reconcileProvenTicketDependencies({
        tickets: [
          ...blockerEntries,
          {
            ticketId: ticket.ticketIssueNumber,
            issueNumber: ticket.ticketIssueNumber,
            state: "open",
            stateReason: null,
            hasMergedPrOnFeatureBranch: false,
            humanOverrideApproved: false,
            blockedByTicketIds: ticket.blockedByIssueNumbers
          }
        ]
      });

      if (
        depReconciliation.unproven_blocker_ticket_ids.length > 0 ||
        !depReconciliation.ready_ticket_ids.includes(ticket.ticketIssueNumber)
      ) {
        await params.gh.ensureLabel(
          "needs-human",
          "D93F0B",
          "Requires human maintainer intervention"
        );
        await params.gh.addIssueLabels(params.issueNumber, ["needs-human"]);
        if (ticket.ticketIssueNumber !== params.issueNumber) {
          await params.gh.addIssueLabels(ticket.ticketIssueNumber, [
            "needs-human"
          ]);
        }

        const updatedSuspended = await updateIssueStateWithCas({
          issueNumber: params.issueNumber,
          store: params.store,
          mutator: (prev) =>
            toTerminalState(prev, {
              phase: "implementation",
              status: "suspended",
              active_branch: params.featureBranch,
              last_processed_comment_id:
                advanceCommentCursor(prev, params.commentId)
            })
        });

        const unprovenList =
          depReconciliation.unproven_blocker_ticket_ids.length > 0
            ? depReconciliation.unproven_blocker_ticket_ids
                .map((id) => `#${id} (\`not_planned\`)`)
                .join(", ")
            : ticket.blockedByIssueNumbers.map((id) => `#${id}`).join(", ");

        const escalationMarkdown = appendEpureCommandsSpoiler(
          [
            updatedSuspended.issue_mirror_markdown,
            "",
            `### ⚠️ Escalade \`needs-human\` — Dépendance bloquante non prouvée pour #${ticket.ticketIssueNumber} (\`UNPROVEN_BLOCKER_CLOSURE\`)`,
            "",
            `- **Ticket dépendant** : #${ticket.ticketIssueNumber} (${ticket.title})`,
            `- **Ticket(s) bloquant(s) non prouvé(s)** : ${unprovenList}`,
            "- **Raison** : Un ticket bloquant a été fermé avec `state_reason: \"not_planned\"` ou n'est pas résolu de manière prouvée sur la branche `feature/*` (ADR-0003, ADR-0029)."
          ].join("\n"),
          {
            phase: "suspended",
            status: "suspended",
            issueNumber: params.issueNumber
          }
        );

        await params.gh.postIssueComment(
          params.issueNumber,
          escalationMarkdown
        );

        return {
          halted: true,
          result: {
            executed: true,
            phase: updatedSuspended.state.phase,
            status: updatedSuspended.state.status,
            active_branch: params.featureBranch,
            summary_markdown: escalationMarkdown,
            created_ticket_numbers: params.ticketsManifest.map(
              (t) => t.ticketIssueNumber
            ),
            feature_pr_url: ""
          },
          verificationProfile,
          verificationGuideMarkdown
        };
      }
    }

    const ticketIssueMeta = await params.gh.getIssue(ticket.ticketIssueNumber);
    if (
      ticket.ticketIssueNumber !== params.issueNumber &&
      ticketIssueMeta.state === "closed" &&
      params.accumulatedFiles.size > 0
    ) {
      if (process.env.GITHUB_ACTIONS === "true") {
        process.stdout.write(
          `[EPURE][Ticket #${ticket.ticketIssueNumber}] Already merged & closed on ${params.featureBranch} — skipping\n`
        );
      }
      completedTicketNumbers.add(ticket.ticketIssueNumber);
      params.completedTicketsSummary.push(
        `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — previously squash-merged into \`${params.featureBranch}\`` +
          formatTicketUsageSuffix(currentTokenUsage(), ticket.ticketIssueNumber, params.parsedDevAgentsConfig?.pricing)
      );
      continue;
    }

    const taskBranch = `task/${ticket.ticketIssueNumber}-${ticket.slug}`;
    const mergedTaskPr = await params.gh.findMergedPullRequestByHead(
      taskBranch,
      params.featureBranch
    );
    if (mergedTaskPr) {
      if (ticket.ticketIssueNumber !== params.issueNumber) {
        await params.gh.closeIssue(ticket.ticketIssueNumber);
      }
      completedTicketNumbers.add(ticket.ticketIssueNumber);
      params.completedTicketsSummary.push(
        `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — PR [#${mergedTaskPr.number}](${mergedTaskPr.html_url}) already merged into \`${params.featureBranch}\`` +
          formatTicketUsageSuffix(currentTokenUsage(), ticket.ticketIssueNumber, params.parsedDevAgentsConfig?.pricing)
      );
      continue;
    }
    if (ticket.ticketIssueNumber !== params.issueNumber) {
      await params.gh.removeIssueLabel?.(ticket.ticketIssueNumber, "needs-human");
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(
        `::group::[EPURE][Ticket #${ticket.ticketIssueNumber}] Initial TDD Implementation (${taskBranch})\n`
      );
    }
    const syncWithBase = await params.baseSyncGuard.needsSync();
    if (syncWithBase) {
      const featureSync = await withUsageAttribution({ phase: "integration" }, () => syncBranchWithBase({
        gh: params.gh,
        targetBranch: params.featureBranch,
        baseBranch: "dev",
        issueNumber: params.issueNumber,
        llmApiKey: params.llmApiKey,
        fetchImpl: params.fetchImpl,
        model: params.phaseModels.implementationModel,
        providers: params.phaseModels.providers,
        maxTransientRetries: params.phaseModels.maxTransientRetries,
        transientRetryBackoffSeconds:
          params.phaseModels.transientRetryBackoffSeconds,
        requestTimeoutMs: params.phaseModels.requestTimeoutMs,
        sandboxRunner: params.sandboxRunner,
        reviewersDir,
        agentEngine: params.agentEngine,
        maxLlmRequests:
          params.parsedDevAgentsConfig?.agent_max_llm_requests ?? DEFAULT_AGENT_MAX_LLM_REQUESTS
      }));
      if (featureSync.status === "escalated") {
        const escalated = await params.escalateToNeedsHuman({
          reason: featureSync.escalationReason ?? "merge_conflict_unresolved",
          ticketNumber: ticket.ticketIssueNumber,
          branch: params.featureBranch,
          diagnosticExcerpt: featureSync.diagnosticExcerpt
        });
        return {
          halted: true,
          result: escalated,
          verificationProfile,
          verificationGuideMarkdown
        };
      }
    }

    await params.gh.ensureBranch(taskBranch, params.featureBranch);

    const syncTaskBranchWithFeature = () =>
      withUsageAttribution({ phase: "integration", ticket: ticket.ticketIssueNumber }, () => syncBranchWithBase({
        gh: params.gh,
        targetBranch: taskBranch,
        baseBranch: params.featureBranch,
        issueNumber: ticket.ticketIssueNumber,
        llmApiKey: params.llmApiKey,
        fetchImpl: params.fetchImpl,
        model: params.phaseModels.implementationModel,
        providers: params.phaseModels.providers,
        maxTransientRetries: params.phaseModels.maxTransientRetries,
        transientRetryBackoffSeconds:
          params.phaseModels.transientRetryBackoffSeconds,
        requestTimeoutMs: params.phaseModels.requestTimeoutMs,
        sandboxRunner: params.sandboxRunner,
        reviewersDir,
        agentEngine: params.agentEngine,
        maxLlmRequests:
          params.parsedDevAgentsConfig?.agent_max_llm_requests ?? DEFAULT_AGENT_MAX_LLM_REQUESTS
      }));

    if (syncWithBase) {
      const taskSync = await syncTaskBranchWithFeature();
      if (taskSync.status === "escalated") {
        const escalated = await params.escalateToNeedsHuman({
          reason: taskSync.escalationReason ?? "merge_conflict_unresolved",
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          diagnosticExcerpt: taskSync.diagnosticExcerpt
        });
        return {
          halted: true,
          result: escalated,
          verificationProfile,
          verificationGuideMarkdown
        };
      }
      await params.baseSyncGuard.markSynced();
    }

    const sandboxWorkspace = prepareRepositorySandboxWorkspace({
      repository: params.repository,
      branch: params.featureBranch,
      githubToken: params.activeToken,
      seedFiles: params.accumulatedFiles,
      enableRemoteClone: Boolean(
        process.env.GITHUB_ACTIONS === "true" && !params.fetchImpl
      )
    });
    if (
      sandboxWorkspace.clonedFromRemote &&
      !params.parsedDevAgentsConfig?.verification?.targets?.length
    ) {
      const clonedProfile = discoverVerificationProfile({
        repoRootDir: sandboxWorkspace.workDir,
        targetFilesHint: [
          ...params.devBranchPaths,
          ...params.ticketsManifest.flatMap((t) => t.filesToTouch)
        ],
        workflowFilesMap: Object.fromEntries(params.devWorkflowsMap)
      });
      verificationProfile = {
        ...clonedProfile,
        wait_for_external_ci:
          params.parsedDevAgentsConfig?.verification?.wait_for_external_ci ??
          clonedProfile.wait_for_external_ci,
        external_ci_timeout_minutes:
          params.parsedDevAgentsConfig?.verification
            ?.external_ci_timeout_minutes ??
          clonedProfile.external_ci_timeout_minutes,
        grace_window_seconds:
          params.parsedDevAgentsConfig?.verification?.grace_window_seconds ??
          clonedProfile.grace_window_seconds
      };
      verificationGuideMarkdown =
        formatVerificationToolingGuideMarkdown(verificationProfile);
    }
    const bootstrappedTargets = new Set<string>();
    const agentState: TicketAgentSessionState = {
      fileModes: new Map(),
      pendingFeedback: [],
      failedAttempt: undefined,
      lastSessionEmpty: false
    };
    let agentTrackedPaths: readonly string[] = [];
    const agentSessionFor = (role: AgentRole): TicketAgentSession | undefined =>
      params.agentEngine
        ? {
            engine: params.agentEngine,
            role,
            worktree: sandboxWorkspace.workDir,
            trackedPaths: agentTrackedPaths,
            jobDeadlineMs: params.jobDeadlineMs,
            maxLlmRequests:
              params.parsedDevAgentsConfig?.agent_max_llm_requests ?? DEFAULT_AGENT_MAX_LLM_REQUESTS,
            state: agentState
          }
        : undefined;
    const withFileModes = <T extends { path: string }>(files: readonly T[]) =>
      files.map((f) => ({ ...f, mode: agentState.fileModes.get(f.path) }));

    let taskPr: { number: number; html_url: string; head_sha: string } | undefined;
    const initialTicketFixAttempts =
      params.initialCodeFixAttemptsByTicket[String(ticket.ticketIssueNumber)] ??
      0;
    let reviewFixAttempt = initialTicketFixAttempts;
    const consumeTicketFixAttempt = async (): Promise<void> => {
      reviewFixAttempt += 1;
      await updateIssueStateWithCas({
        issueNumber: params.issueNumber,
        store: params.store,
        mutator: (prev) => ({
          ...withTicketCodeFixAttempts(
            prev,
            ticket.ticketIssueNumber,
            reviewFixAttempt
          ),
          transient_retries_used: params.getTotalTransientRetriesUsed()
        })
      });
    };

    try {
      if (params.agentEngine) {
        agentTrackedPaths = await listTrackedPaths(sandboxWorkspace.workDir);
      }
      const ticketChangedFilesMap = new Map<string, string>();
      const ticketDeletedFilesSet = new Set<string>();
      let impl: {
        commit_message: string;
        test_summary: string;
        files: Array<{ path: string; content: string }>;
      };
      let currentPrHeadSha: string;

      const baseBranchFilesSnapshot = new Map<string, string>(
        params.accumulatedFiles
      );
      const ensureBaselineFilesLoaded = async (
        candidatePaths: readonly string[]
      ): Promise<void> => {
        for (const rawP of candidatePaths) {
          const cleanP = rawP.trim().replace(/^\/+/, "");
          if (!cleanP || baseBranchFilesSnapshot.has(cleanP)) {
            continue;
          }
          const existingOnFeature = await params.gh.readSingleBranchFile(
            params.featureBranch,
            cleanP
          );
          if (existingOnFeature !== null) {
            baseBranchFilesSnapshot.set(cleanP, existingOnFeature);
            if (!params.accumulatedFiles.has(cleanP)) {
              params.accumulatedFiles.set(cleanP, existingOnFeature);
            }
          }
        }
      };

      const restoreViolatedBaselineFiles = (
        integrityCheck: ReturnType<typeof validateTicketIntegrityGuard>
      ): void => {
        if (integrityCheck.passed) {
          return;
        }
        for (const v of integrityCheck.violations) {
          const baseline = baseBranchFilesSnapshot.get(v.path);
          if (baseline !== undefined) {
            params.accumulatedFiles.set(v.path, baseline);
            params.featureChangedFilesMap.set(v.path, baseline);
            ticketChangedFilesMap.delete(v.path);
            params.featureDeletedFilesSet.delete(v.path);
            ticketDeletedFilesSet.delete(v.path);
          }
        }
      };

      let lastStage1Output = "";
      const evaluateIntegrityAndStage1Suite = async (label: string) => {
        const integrityCheck = validateTicketIntegrityGuard({
          baseFiles: baseBranchFilesSnapshot,
          changedFiles: impl.files,
          deletedFiles: Array.from(ticketDeletedFilesSet),
          ticketFilesToTouch: ticket.filesToTouch,
          ticketDescription: `${ticket.title}\n${ticket.description}\n${ticket.acceptanceCriteria.join("\n")}`
        });
        const agentFailure = agentState.failedAttempt;
        agentState.failedAttempt = undefined;
        if (agentFailure !== undefined) {
          return {
            integrityCheck,
            testCheck: {
              passed: false,
              output: [agentFailure, lastStage1Output].filter(Boolean).join("\n\n")
            }
          };
        }
        const remainingMs = params.jobDeadlineMs === undefined ? undefined : params.jobDeadlineMs - Date.now();
        if (integrityCheck.passed && remainingMs !== undefined && remainingMs < MIN_STAGE1_BUDGET_MS) {
          throw new JobBudgetExhaustedError(remainingMs, "Stage 1 with the commit", MIN_STAGE1_BUDGET_MS);
        }
        const testCheck = !integrityCheck.passed
          ? {
              passed: false,
              output: integrityCheck.diagnosticMarkdown
            }
          : await runTestsInIsolatedWorkspace({
              workDir: sandboxWorkspace.workDir,
              files: Array.from(params.accumulatedFiles.entries()).map(
                ([path, content]) => ({ path, content })
              ),
              deleted_files: Array.from(ticketDeletedFilesSet),
              changedPaths: [
                ...impl.files.map((f) => f.path),
                ...Array.from(ticketDeletedFilesSet)
              ],
              isTaskBranch: true,
              reviewersDir,
              verificationProfile,
              bootstrappedTargets,
              sandboxRunner: params.sandboxRunner,
              llmApiKey: params.llmApiKey,
              label
            });
        lastStage1Output = testCheck.output;
        return { integrityCheck, testCheck };
      };

      const existingTaskPr = await params.gh.findOpenPullRequestByHead(
        taskBranch,
        params.featureBranch
      );

      if (existingTaskPr) {
        const taskPrFiles = await params.gh.listPullRequestFiles(
          existingTaskPr.number
        );
        if (taskPrFiles.length > 0) {
          const markRemoved = (cleanPath: string): void => {
            params.accumulatedFiles.delete(cleanPath);
            params.featureChangedFilesMap.delete(cleanPath);
            ticketChangedFilesMap.delete(cleanPath);
            params.featureDeletedFilesSet.add(cleanPath);
            ticketDeletedFilesSet.add(cleanPath);
          };
          for (const prFile of taskPrFiles) {
            const cleanPath = prFile.filename.replace(/^\/+/, "");
            if (prFile.status === "renamed" && prFile.previous_filename) {
              markRemoved(prFile.previous_filename.replace(/^\/+/, ""));
            }
            if (prFile.status === "removed") {
              markRemoved(cleanPath);
            } else {
              const content =
                (await params.gh.readSingleBranchFile(taskBranch, cleanPath)) ??
                params.accumulatedFiles.get(cleanPath) ??
                null;
              if (content !== null) {
                params.accumulatedFiles.set(cleanPath, content);
                params.featureChangedFilesMap.set(cleanPath, content);
                ticketChangedFilesMap.set(cleanPath, content);
                params.featureDeletedFilesSet.delete(cleanPath);
                ticketDeletedFilesSet.delete(cleanPath);
              }
            }
          }
        } else {
          const taskBranchFiles = await params.gh.readBranchWorkspaceFiles(
            taskBranch,
            params.hintForWorkspace,
            [],
            reviewersDir
          );
          for (const [p, c] of taskBranchFiles.entries()) {
            params.accumulatedFiles.set(p, c);
            params.featureChangedFilesMap.set(p, c);
            ticketChangedFilesMap.set(p, c);
          }
        }
        // The reconcile commit and Stage 1 keep the task branch's executable bits.
        const taskBranchBlobs = await params.gh.listBranchBlobs(taskBranch).catch((err: unknown) => {
          if (err instanceof TruncatedGitTreeError) {
            return new Map<string, GitBlobRef>();
          }
          throw err;
        });
        for (const path of ticketChangedFilesMap.keys()) {
          const mode = taskBranchBlobs.get(path)?.mode;
          if (mode === "100644" || mode === "100755") {
            agentState.fileModes.set(path, mode);
          }
        }
        syncWorkspaceFiles(
          sandboxWorkspace.workDir,
          params.accumulatedFiles,
          params.featureDeletedFilesSet,
          agentState.fileModes
        );

        const existingPreCheck = validateWorkspaceFileOperations({
          workDir: sandboxWorkspace.workDir,
          files: Array.from(ticketChangedFilesMap.keys()).map((p) => ({
            path: p
          })),
          deleted_files: Array.from(ticketDeletedFilesSet),
          targets: verificationProfile.targets,
          isTaskBranch: true,
          reviewersDir
        });
        if (!existingPreCheck.allowed) {
          const escalated = await params.escalateToNeedsHuman({
            reason: "sensitive_path_violation",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            prNumber: existingTaskPr.number,
            prUrl: existingTaskPr.html_url,
            sensitivePaths: existingPreCheck.sensitivePaths,
            traversalPaths: existingPreCheck.traversalPaths
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }

        impl = {
          commit_message:
            existingTaskPr.title ||
            `feat(ticket-${ticket.ticketIssueNumber}): ${ticket.title}`,
          test_summary:
            "Reconciled existing open Pull Request on task branch (Q110)",
          files: Array.from(ticketChangedFilesMap.entries()).map(
            ([path, content]) => ({ path, content })
          )
        };
        taskPr = existingTaskPr;
        currentPrHeadSha = existingTaskPr.head_sha;
      } else {
        const existingFilesContext = buildCompactWorkspaceFilesContext({
          reviewersDir,
          accumulatedFiles: params.accumulatedFiles,
          priorityPaths: [
            ...ticket.filesToTouch,
            ...ticketChangedFilesMap.keys(),
            ...params.featureChangedFilesMap.keys()
          ]
        });

        const tddPrompt = [
          `Plan parent (#${params.issueNumber}) et cahier des charges :`,
          wrapUntrustedContent(
            "untrusted_issue_content",
            `Titre : ${params.issue.title}\n\nCahier des charges :\n${params.issue.body}`
          ),
          "",
          "Ticket à implémenter :",
          wrapUntrustedContent(
            "untrusted_issue_content",
            [
              `Ticket #${ticket.ticketIssueNumber} : ${ticket.title}`,
              `Description : ${ticket.description}`,
              `Critères d'acceptation : ${ticket.acceptanceCriteria.join(" ; ")}`,
              `Fichiers cibles : ${ticket.filesToTouch.join(", ")}`
            ].join("\n")
          ),
          "",
          ...resumeContextPromptLines,
          verificationGuideMarkdown,
          "",
          existingFilesContext
            ? `Fichiers déjà présents sur la branche feature :\n${wrapUntrustedContent("untrusted_workspace_files", existingFilesContext)}`
            : "C'est le premier ticket : inclus un package.json complet (avec scripts 'test': 'vitest run' et 'build': 'vite build', dependencies react/react-dom, devDependencies typescript/vite/vitest/@vitejs/plugin-react/@types/react/@types/react-dom) ainsi que tsconfig.json et vite.config.ts."
        ].join("\n");

        const parsedImpl = await withUsageAttribution({ phase: "implementation", ticket: ticket.ticketIssueNumber }, () => runTicketAgentSession({
          ticket,
          prompt: tddPrompt,
          logLabel: `tdd-init:#${ticket.ticketIssueNumber}`,
          accumulatedFiles: params.accumulatedFiles,
          deletedFilesSet: ticketDeletedFilesSet,
          reviewersDir,
          gh: params.gh,
          llmApiKey: params.llmApiKey,
          phaseModels: params.phaseModels,
          addTransientRetriesUsed: params.addTransientRetriesUsed,
          fetchImpl: params.fetchImpl,
          agentSession: agentSessionFor("implementer")
        }));
        if (params.agentEngine && agentState.lastSessionEmpty && agentState.failedAttempt === undefined) {
          const escalated = await params.escalateToNeedsHuman({
            reason: "agent_no_changes",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            diagnosticExcerpt: agentState.pendingFeedback.join("\n") || undefined
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }

        const preStage1Check = validateWorkspaceFileOperations({
          workDir: sandboxWorkspace.workDir,
          files: [
            ...(parsedImpl.files ?? []).map((f) => ({ path: f.path })),
            ...(parsedImpl.patches ?? []).map((p) => ({ path: p.path }))
          ],
          deleted_files: parsedImpl.deleted_files,
          targets: verificationProfile.targets,
          isTaskBranch: true,
          reviewersDir
        });
        if (!preStage1Check.allowed) {
          const escalated = await params.escalateToNeedsHuman({
            reason: "sensitive_path_violation",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            sensitivePaths: preStage1Check.sensitivePaths,
            traversalPaths: preStage1Check.traversalPaths
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }

        await ensureBaselineFilesLoaded([
          ...(parsedImpl.files ?? []).map((f) => f.path),
          ...(parsedImpl.patches ?? []).map((p) => p.path),
          ...(parsedImpl.deleted_files ?? [])
        ]);

        const initialChangedFiles = await applyTicketImplementationPayload({
          parsed: parsedImpl,
          accumulatedFiles: params.accumulatedFiles,
          featureChangedFilesMap: params.featureChangedFilesMap,
          ticketChangedFilesMap,
          featureDeletedFilesSet: params.featureDeletedFilesSet,
          ticketDeletedFilesSet,
          gh: params.gh,
          branch: params.featureBranch
        });
        impl = {
          commit_message: parsedImpl.commit_message,
          test_summary: parsedImpl.test_summary,
          files: initialChangedFiles
        };
        if (process.env.GITHUB_ACTIONS === "true") {
          process.stdout.write(
            `[EPURE][Ticket #${ticket.ticketIssueNumber}] Generated ${impl.files.length} file(s): ${impl.files.map((f) => f.path).join(", ")}\n::endgroup::\n`
          );
        }

        let { integrityCheck, testCheck } =
          await evaluateIntegrityAndStage1Suite(
            `Ticket #${ticket.ticketIssueNumber} initial TDD suite`
          );

        while (
          !testCheck.passed &&
          reviewFixAttempt < params.maxCodeFixAttempts
        ) {
          await consumeTicketFixAttempt();
          restoreViolatedBaselineFiles(integrityCheck);
          const currentFilesContext = buildCompactWorkspaceFilesContext({
            reviewersDir,
            accumulatedFiles: params.accumulatedFiles,
            priorityPaths: [
              ...ticket.filesToTouch,
              ...ticketChangedFilesMap.keys()
            ]
          });

          const fixPrompt = [
            `La vérification Stage 1 du Ticket #${ticket.ticketIssueNumber} a échoué dans la sandbox avec la sortie suivante :`,
            wrapUntrustedContent("untrusted_test_output", testCheck.output),
            "",
            verificationGuideMarkdown,
            "",
            "Fichiers actuels du workspace :",
            wrapUntrustedContent(
              "untrusted_workspace_files",
              currentFilesContext
            )
          ].join("\n");

          const fixedImpl = await withUsageAttribution({ phase: "fixes", ticket: ticket.ticketIssueNumber }, () => runTicketAgentSession({
            ticket,
            prompt: fixPrompt,
            logLabel: `stage1-fix:#${ticket.ticketIssueNumber}/iter-${reviewFixAttempt}`,
            accumulatedFiles: params.accumulatedFiles,
            deletedFilesSet: ticketDeletedFilesSet,
            reviewersDir,
            gh: params.gh,
            llmApiKey: params.llmApiKey,
            phaseModels: params.phaseModels,
            addTransientRetriesUsed: params.addTransientRetriesUsed,
            fetchImpl: params.fetchImpl,
            agentSession: agentSessionFor("fixer")
          }));

          const fixPreCheck = validateWorkspaceFileOperations({
            workDir: sandboxWorkspace.workDir,
            files: [
              ...(fixedImpl.files ?? []).map((f) => ({ path: f.path })),
              ...(fixedImpl.patches ?? []).map((p) => ({ path: p.path }))
            ],
            deleted_files: fixedImpl.deleted_files,
            targets: verificationProfile.targets,
            isTaskBranch: true,
            reviewersDir
          });
          if (!fixPreCheck.allowed) {
            const escalated = await params.escalateToNeedsHuman({
              reason: "sensitive_path_violation",
              ticketNumber: ticket.ticketIssueNumber,
              branch: taskBranch,
              codeFixAttemptsUsed: reviewFixAttempt,
              sensitivePaths: fixPreCheck.sensitivePaths,
              traversalPaths: fixPreCheck.traversalPaths
            });
            return {
              halted: true,
              result: escalated,
              verificationProfile,
              verificationGuideMarkdown
            };
          }

          await ensureBaselineFilesLoaded([
            ...(fixedImpl.files ?? []).map((f) => f.path),
            ...(fixedImpl.patches ?? []).map((p) => p.path),
            ...(fixedImpl.deleted_files ?? [])
          ]);

          const updatedFiles = await applyTicketImplementationPayload({
            parsed: fixedImpl,
            accumulatedFiles: params.accumulatedFiles,
            featureChangedFilesMap: params.featureChangedFilesMap,
            ticketChangedFilesMap,
            featureDeletedFilesSet: params.featureDeletedFilesSet,
            ticketDeletedFilesSet,
            gh: params.gh,
            branch: params.featureBranch
          });
          impl = {
            commit_message: fixedImpl.commit_message || impl.commit_message,
            test_summary: fixedImpl.test_summary || impl.test_summary,
            files: updatedFiles
          };

          const nextEval = await evaluateIntegrityAndStage1Suite(
            `Ticket #${ticket.ticketIssueNumber} TDD auto-fix attempt ${reviewFixAttempt}/${params.maxCodeFixAttempts}`
          );
          integrityCheck = nextEval.integrityCheck;
          testCheck = nextEval.testCheck;
        }

        if (!testCheck.passed) {
          const escalated = await params.escalateToNeedsHuman({
            reason: "remediation_exhausted",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            codeFixAttemptsUsed: reviewFixAttempt,
            diagnosticExcerpt: testCheck.output.slice(-2000)
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }

        const featureMergedBeforeTaskPr = await params.stopIfFeaturePrMerged();
        if (featureMergedBeforeTaskPr) {
          return {
            halted: true,
            result: featureMergedBeforeTaskPr,
            verificationProfile,
            verificationGuideMarkdown
          };
        }
        await params.gh.commitFilesToBranch({
          branch: taskBranch,
          fromBranch: params.featureBranch,
          commitMessage: impl.commit_message,
          files: withFileModes(impl.files),
          deletedFiles: Array.from(ticketDeletedFilesSet)
        });

        const provenanceLine = formatAgentProvenanceLine({
          engine: params.agentEngine?.name ?? "pi",
          model: params.phaseModels.implementationModel
        });
        const prBody = appendEpureCommandsSpoiler(
          [
            "## Summary",
            `Automated TDD implementation of #${ticket.ticketIssueNumber} for plan #${params.issueNumber}.`,
            "",
            `Refs #${ticket.ticketIssueNumber}`,
            `Part of #${params.issueNumber}`,
            "",
            "## TDD & Sandbox Verification",
            `- **Sandbox Test Execution**: \`passed\``,
            provenanceLine,
            "- **Summary**:",
            "",
            fencedCodeBlock(impl.test_summary)
          ].join("\n"),
          {
            phase: "implementation",
            status: "active",
            issueNumber: params.issueNumber
          }
        );

        taskPr = await params.gh.openPullRequest({
          head: taskBranch,
          base: params.featureBranch,
          title: impl.commit_message.split("\n", 1)[0]?.trim() || `feat(ticket-${ticket.ticketIssueNumber}): ${ticket.title}`,
          body: prBody
        });

        currentPrHeadSha = taskPr.head_sha;
      }
      const openTaskPr = taskPr;

      let reviewedCommitShas: readonly string[] = [];

      // GitHub runs no `pull_request` workflow on a conflicting PR: re-sync it before waiting for external CI.
      const resyncTaskPrIfConflicting = async (): Promise<
        OrchestrateIssueResult | undefined
      > => {
        const mergeableState = await params.gh.getPullRequestMergeableState(
          openTaskPr.number
        );
        if (mergeableState !== "dirty") {
          return undefined;
        }
        const resync = await syncTaskBranchWithFeature();
        if (resync.status === "escalated") {
          return await params.escalateToNeedsHuman({
            reason: resync.escalationReason ?? "merge_conflict_unresolved",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            prNumber: openTaskPr.number,
            prUrl: openTaskPr.html_url,
            diagnosticExcerpt: resync.diagnosticExcerpt
          });
        }
        const previousHeadSha = currentPrHeadSha;
        currentPrHeadSha = resync.headSha || currentPrHeadSha;
        if (params.agentEngine && currentPrHeadSha !== previousHeadSha) {
          await refreshTicketFilesAfterResync(previousHeadSha, currentPrHeadSha);
        }
        return undefined;
      };

      // Without it the next session's worktree and the next commit would revert what the merge brought.
      const refreshTicketFilesAfterResync = async (fromSha: string, toSha: string): Promise<void> => {
        const { changedFiles } = await params.gh.compareCommits(fromSha, toSha);
        const removed = new Set<string>();
        for (const path of changedFiles) {
          const content = await params.gh.readSingleBranchFile(toSha, path);
          if (content === null) {
            params.accumulatedFiles.delete(path);
            ticketChangedFilesMap.delete(path);
            removed.add(path);
            continue;
          }
          // Binary files are left alone: they cannot be held as text.
          if (content.includes("\u0000") || content.includes("\uFFFD")) {
            continue;
          }
          params.accumulatedFiles.set(path, content);
          if (ticketChangedFilesMap.has(path)) {
            ticketChangedFilesMap.set(path, content);
          } else {
            baseBranchFilesSnapshot.set(path, content);
          }
        }
        syncWorkspaceFiles(sandboxWorkspace.workDir, new Map(), removed);
        impl = {
          ...impl,
          files: Array.from(ticketChangedFilesMap, ([path, content]) => ({ path, content }))
        };
      };

      const runStage2AndStage3ForTaskPr = async (passParams: {
        headSha: string;
        isReReviewPass: boolean;
        previousFailedReviewers?: ReadonlyArray<ReviewerAgentName>;
        reviewFixAttemptsUsed: number;
      }): Promise<{
        reviewResult: Awaited<ReturnType<typeof runMultiAgentPrReviewPass>>;
        ciGateResult: WaitForExternalCiChecksResult;
        escalateToHuman: boolean;
        releasedForAsyncCi?: OrchestrateIssueResult | undefined;
      }> => {
        // Bucket A Guard 3: Review loop guard on commit SHA
        const reviewGuard = evaluateReviewFeedbackTrigger({
          commitSha: passParams.headSha,
          authorLogin: "epure-review-roster[bot]",
          authorType: "Bot",
          effectivePermission: "write",
          isIndependentReviewPass: true,
          alreadyReviewedCommitShas: reviewedCommitShas,
          reviewFixAttemptsUsed: Math.max(
            0,
            passParams.reviewFixAttemptsUsed - 1
          ),
          maxCodeFixAttempts: params.maxCodeFixAttempts
        });
        reviewedCommitShas = reviewGuard.updated_reviewed_commit_shas;

        const changedPaths = impl.files.map((f) => f.path);
        const expectedWorkflows = discoverExpectedExternalWorkflows({
          workflowFilesMap: params.devWorkflowsMap,
          changedPaths,
          targetBranch: params.featureBranch
        });

        const reviewRes = await withUsageAttribution({ phase: "review", ticket: ticket.ticketIssueNumber }, () => runMultiAgentPrReviewPass({
          repository: params.repository,
          prNumber: openTaskPr.number,
          headBranch: taskBranch,
          baseBranch: params.featureBranch,
          ticketNumber: ticket.ticketIssueNumber,
          ticketTitle: ticket.title,
          acceptanceCriteria: ticket.acceptanceCriteria,
          glossaryMarkdown: params.issue.body,
          designMarkdown: params.trustedBaseDesignMarkdown,
          changedFiles: impl.files,
          deletedFiles: Array.from(ticketDeletedFilesSet),
          workspaceFiles: params.accumulatedFiles,
          trustedBaseBranchFiles: params.trustedBaseFilesMap,
          reviewersDir,
          isReReviewPass: passParams.isReReviewPass,
          previousFailedReviewers: passParams.previousFailedReviewers,
          llmApiKey: params.llmApiKey,
          model: params.phaseModels.reviewModel,
          providers: params.phaseModels.providers,
          maxTransientRetries: params.phaseModels.maxTransientRetries,
          transientRetryBackoffSeconds:
            params.phaseModels.transientRetryBackoffSeconds,
          requestTimeoutMs: params.phaseModels.requestTimeoutMs,
          onTransientRetriesUsed: (used) =>
            params.addTransientRetriesUsed(used),
          fetchImpl: params.fetchImpl,
          agentEngine: resolveLifecycleAgentEngine(params.agentEngine),
          worktreeDir: sandboxWorkspace.workDir,
          githubToken: params.activeToken,
          maxLlmRequests:
            params.parsedDevAgentsConfig?.agent_max_llm_requests ??
            DEFAULT_AGENT_MAX_LLM_REQUESTS
        }));

        await params.gh.postPullRequestReview(openTaskPr.number, {
          commitId: passParams.headSha,
          body: reviewRes.review_body_markdown
        });

        await params.gh.publishCheckRun({
          name: "ai-review",
          headSha: passParams.headSha,
          conclusion: reviewRes.conclusion,
          summary: reviewRes.check_summary_markdown
        });

        if (reviewRes.touches_frontend_ui) {
          await params.gh.publishCheckRun({
            name: "impeccable-gate",
            headSha: passParams.headSha,
            conclusion:
              reviewRes.impeccable_conclusion === "failure"
                ? "failure"
                : "success",
            summary: `Impeccable UI & Accessibility Gate: ${reviewRes.impeccable_conclusion}`
          });
        }

        const shouldReleaseRunnerForAsyncCi =
          Boolean(params.asyncCiContinuation) &&
          verificationProfile.wait_for_external_ci !== false &&
          expectedWorkflows.length > 0 &&
          (!params.forceOneRemediationRoundOnOpenPr ||
            passParams.reviewFixAttemptsUsed > initialTicketFixAttempts);

        if (shouldReleaseRunnerForAsyncCi) {
          const updatedWaiting = await updateIssueStateWithCas({
            issueNumber: params.issueNumber,
            store: params.store,
            mutator: (prev) => ({
              ...withTicketCodeFixAttempts(
                prev,
                ticket.ticketIssueNumber,
                passParams.reviewFixAttemptsUsed
              ),
              phase: "implementation",
              status: "active",
              active_branch: params.featureBranch,
              subphase: "waiting_ticket_ci",
              active_ticket_number: ticket.ticketIssueNumber,
              active_task_branch: taskBranch,
              active_pr_number: openTaskPr.number,
              active_head_sha: passParams.headSha
            })
          });
          const asyncSummary = [
            formatIssueStateMarker(updatedWaiting.state),
            updatedWaiting.issue_mirror_markdown,
            "",
            `### ⏳ Attente événementielle CI externe (\`waiting_ticket_ci\`) — Ticket #${ticket.ticketIssueNumber} (PR #${openTaskPr.number})`,
            `- **Branche du ticket** : \`${taskBranch}\` -> \`${params.featureBranch}\``,
            `- **HEAD SHA** : \`${passParams.headSha}\``,
            `- **Revue Multi-Agents (\`ai-review\`)** : \`${reviewRes.conclusion}\``,
            "- **Action** : Runner GitHub Actions libéré (`exit 0`). Reprise automatique sur `workflow_run: completed` ou `/epure continue`."
          ].join("\n");
          return {
            reviewResult: reviewRes,
            ciGateResult: {
              passed: true,
              reason: "all_passed",
              infraRerunsTriggered: 0,
              failedChecks: [],
              formattedDiagnostics: "",
              registeredWorkflowNames: [],
              registeredCheckNames: []
            },
            escalateToHuman: false,
            releasedForAsyncCi: {
              executed: true,
              phase: updatedWaiting.state.phase,
              status: updatedWaiting.state.status,
              active_branch: params.featureBranch,
              summary_markdown: asyncSummary,
              created_ticket_numbers: params.ticketsManifest.map(
                (t) => t.ticketIssueNumber
              ),
              feature_pr_url: "",
              waiting_ci_head_sha: passParams.headSha
            }
          };
        }

        const ciRes = await waitForExternalCiChecks({
          headSha: passParams.headSha,
          expectedWorkflows,
          waitForExternalCi: verificationProfile.wait_for_external_ci,
          timeoutMinutes: verificationProfile.external_ci_timeout_minutes,
          graceWindowSeconds: verificationProfile.grace_window_seconds,
          pollIntervalMs: params.pollIntervalMs,
          extraSecrets: [params.activeToken, params.llmApiKey],
          infraRerunsBySha: params.infraRerunsBySha,
          listWorkflowRunsForSha: (sha) =>
            params.gh.listWorkflowRunsForSha(sha),
          listCheckRunsForRef: (sha) => params.gh.listCheckRunsForRef(sha),
          listCheckRunAnnotations: (id) =>
            params.gh.listCheckRunAnnotations(id),
          getJobLogs: (id) => params.gh.getActionJobLogs(id),
          rerunFailedJobs: (runId) => params.gh.rerunFailedWorkflowJobs(runId),
          sleepFn: params.effectiveSleepFn
        });

        if (ciRes.infraRerunsTriggered > 0) {
          params.addTransientRetriesUsed(ciRes.infraRerunsTriggered);
          await updateIssueStateWithCas({
            issueNumber: params.issueNumber,
            store: params.store,
            mutator: (prev) => ({
              ...prev,
              transient_retries_used: params.getTotalTransientRetriesUsed()
            })
          });
        }

        return {
          reviewResult: reviewRes,
          ciGateResult: ciRes,
          escalateToHuman: reviewGuard.escalate_to_human
        };
      };

      const initialConflictEscalation = await resyncTaskPrIfConflicting();
      if (initialConflictEscalation) {
        return {
          halted: true,
          result: initialConflictEscalation,
          verificationProfile,
          verificationGuideMarkdown
        };
      }
      const initialPass = await runStage2AndStage3ForTaskPr({
        headSha: currentPrHeadSha,
        isReReviewPass: false,
        reviewFixAttemptsUsed: reviewFixAttempt
      });
      if (initialPass.releasedForAsyncCi) {
        return {
          halted: true,
          result: initialPass.releasedForAsyncCi,
          verificationProfile,
          verificationGuideMarkdown
        };
      }
      let {
        reviewResult,
        ciGateResult,
        escalateToHuman: reviewGuardEscalate
      } = initialPass;

      if (reviewGuardEscalate && reviewResult.conclusion === "failure") {
        const escalated = await params.escalateToNeedsHuman({
          reason: "remediation_exhausted",
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          prNumber: taskPr.number,
          prUrl: taskPr.html_url,
          failedChecks: ciGateResult.failedChecks,
          mustFixFindings: reviewResult.must_fix_findings,
          diagnosticExcerpt: ciGateResult.formattedDiagnostics
        });
        return {
          halted: true,
          result: escalated,
          verificationProfile,
          verificationGuideMarkdown
        };
      }

      if (
        !ciGateResult.passed &&
        (ciGateResult.reason === "grace_window_timeout" ||
          ciGateResult.reason === "wall_clock_budget_exhausted")
      ) {
        const escalated = await params.escalateToNeedsHuman({
          reason: ciGateResult.reason,
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          prNumber: taskPr.number,
          prUrl: taskPr.html_url,
          failedChecks: ciGateResult.failedChecks,
          mustFixFindings: reviewResult.must_fix_findings,
          diagnosticExcerpt: ciGateResult.formattedDiagnostics
        });
        return {
          halted: true,
          result: escalated,
          verificationProfile,
          verificationGuideMarkdown
        };
      }

      while (
        (reviewResult.conclusion === "failure" || !ciGateResult.passed) &&
        reviewFixAttempt < params.maxCodeFixAttempts
      ) {
        await consumeTicketFixAttempt();

        process.stdout.write(
          `[EPURE][Ticket #${ticket.ticketIssueNumber}][PR #${taskPr.number}] Post-PR remediation round ${reviewFixAttempt}/${params.maxCodeFixAttempts} (${reviewResult.must_fix_findings.length} must_fix finding(s), CI passed=${ciGateResult.passed})\n`
        );
        const findingsText = reviewResult.must_fix_findings
          .map(
            (f, idx) =>
              `${idx + 1}. [${f.reviewer}] (${f.path}:${f.line}) ${f.title} — ${f.rationale} -> Action: ${f.suggested_action}`
          )
          .join("\n");

        const currentFilesContext = buildCompactWorkspaceFilesContext({
          reviewersDir,
          accumulatedFiles: params.accumulatedFiles,
          priorityPaths: [
            ...ticket.filesToTouch,
            ...ticketChangedFilesMap.keys(),
            ...reviewResult.must_fix_findings.map((f) => f.path)
          ]
        });

        const promptParts: string[] = [...resumeContextPromptLines];
        if (reviewResult.must_fix_findings.length > 0) {
          promptParts.push(
            `Les reviewers multi-agents EPURE ont émis ${reviewResult.must_fix_findings.length} constat(s) bloquant(s) ('must_fix') sur la PR #${taskPr.number} du Ticket #${ticket.ticketIssueNumber} :`,
            wrapUntrustedContent("untrusted_issue_content", findingsText),
            ""
          );
        }
        if (!ciGateResult.passed && ciGateResult.formattedDiagnostics) {
          promptParts.push(
            `Les workflows CI externes sur la PR #${taskPr.number} (SHA \`${currentPrHeadSha}\`) ont échoué :`,
            ciGateResult.formattedDiagnostics,
            ""
          );
        }
        promptParts.push(
          verificationGuideMarkdown,
          "",
          "Fichiers actuels du workspace :",
          wrapUntrustedContent("untrusted_workspace_files", currentFilesContext)
        );

        const reviewFixedImpl = await withUsageAttribution({ phase: "fixes", ticket: ticket.ticketIssueNumber }, () => runTicketAgentSession({
          ticket,
          thinkingLevel: "HIGH",
          logLabel: `review-fix:#${ticket.ticketIssueNumber}/iter-${reviewFixAttempt}`,
          prompt: promptParts.join("\n"),
          accumulatedFiles: params.accumulatedFiles,
          deletedFilesSet: ticketDeletedFilesSet,
          reviewersDir,
          gh: params.gh,
          llmApiKey: params.llmApiKey,
          phaseModels: params.phaseModels,
          addTransientRetriesUsed: params.addTransientRetriesUsed,
          fetchImpl: params.fetchImpl,
          agentSession: agentSessionFor("fixer")
        }));

        const remediationPreCheck = validateWorkspaceFileOperations({
          workDir: sandboxWorkspace.workDir,
          files: [
            ...(reviewFixedImpl.files ?? []).map((f) => ({ path: f.path })),
            ...(reviewFixedImpl.patches ?? []).map((p) => ({
              path: p.path
            }))
          ],
          deleted_files: reviewFixedImpl.deleted_files,
          targets: verificationProfile.targets,
          isTaskBranch: true,
          reviewersDir
        });
        if (!remediationPreCheck.allowed) {
          const escalated = await params.escalateToNeedsHuman({
            reason: "sensitive_path_violation",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            prNumber: taskPr.number,
            prUrl: taskPr.html_url,
            codeFixAttemptsUsed: reviewFixAttempt,
            sensitivePaths: remediationPreCheck.sensitivePaths,
            traversalPaths: remediationPreCheck.traversalPaths
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }

        await ensureBaselineFilesLoaded([
          ...(reviewFixedImpl.files ?? []).map((f) => f.path),
          ...(reviewFixedImpl.patches ?? []).map((p) => p.path),
          ...(reviewFixedImpl.deleted_files ?? [])
        ]);

        const updatedReviewFiles = await applyTicketImplementationPayload({
          parsed: reviewFixedImpl,
          accumulatedFiles: params.accumulatedFiles,
          featureChangedFilesMap: params.featureChangedFilesMap,
          ticketChangedFilesMap,
          featureDeletedFilesSet: params.featureDeletedFilesSet,
          ticketDeletedFilesSet,
          gh: params.gh,
          branch: params.featureBranch
        });
        impl = {
          commit_message:
            reviewFixedImpl.commit_message ||
            `fix(review): address reviewer findings on #${ticket.ticketIssueNumber}`,
          test_summary: reviewFixedImpl.test_summary || impl.test_summary,
          files: updatedReviewFiles
        };

        let {
          integrityCheck: reviewIntegrityCheck,
          testCheck
        } = await evaluateIntegrityAndStage1Suite(
          `Ticket #${ticket.ticketIssueNumber} review-fix iteration ${reviewFixAttempt}/${params.maxCodeFixAttempts}`
        );
        while (
          !testCheck.passed &&
          reviewFixAttempt < params.maxCodeFixAttempts
        ) {
          await consumeTicketFixAttempt();
          restoreViolatedBaselineFiles(reviewIntegrityCheck);
          const retryFilesContext = buildCompactWorkspaceFilesContext({
            reviewersDir,
            accumulatedFiles: params.accumulatedFiles,
            priorityPaths: [
              ...ticket.filesToTouch,
              ...ticketChangedFilesMap.keys(),
              ...reviewResult.must_fix_findings.map((f) => f.path)
            ]
          });
          const retryImpl = await withUsageAttribution({ phase: "fixes", ticket: ticket.ticketIssueNumber }, () => runTicketAgentSession({
            ticket,
            thinkingLevel: "HIGH",
            logLabel: `review-fix-retry:#${ticket.ticketIssueNumber}/iter-${reviewFixAttempt}`,
            prompt: [
              `La correction a fait échouer la vérification Stage 1 en sandbox (tentative ${reviewFixAttempt}/${params.maxCodeFixAttempts}) :`,
              wrapUntrustedContent(
                "untrusted_test_output",
                testCheck.output
              ),
              "",
              ...(findingsText
                ? [
                    "Constats must_fix à maintenir corrigés :",
                    wrapUntrustedContent(
                      "untrusted_issue_content",
                      findingsText
                    ),
                    ""
                  ]
                : []),
              "Fichiers actuels du workspace :",
              wrapUntrustedContent(
                "untrusted_workspace_files",
                retryFilesContext
              )
            ].join("\n"),
            accumulatedFiles: params.accumulatedFiles,
            deletedFilesSet: ticketDeletedFilesSet,
            reviewersDir,
            gh: params.gh,
            llmApiKey: params.llmApiKey,
            phaseModels: params.phaseModels,
            addTransientRetriesUsed: params.addTransientRetriesUsed,
            fetchImpl: params.fetchImpl,
            agentSession: agentSessionFor("fixer")
          }));

          const retryPreCheck = validateWorkspaceFileOperations({
            workDir: sandboxWorkspace.workDir,
            files: [
              ...(retryImpl.files ?? []).map((f) => ({ path: f.path })),
              ...(retryImpl.patches ?? []).map((p) => ({ path: p.path }))
            ],
            deleted_files: retryImpl.deleted_files,
            targets: verificationProfile.targets,
            isTaskBranch: true,
            reviewersDir
          });
          if (!retryPreCheck.allowed) {
            const escalated = await params.escalateToNeedsHuman({
              reason: "sensitive_path_violation",
              ticketNumber: ticket.ticketIssueNumber,
              branch: taskBranch,
              prNumber: taskPr.number,
              prUrl: taskPr.html_url,
              codeFixAttemptsUsed: reviewFixAttempt,
              sensitivePaths: retryPreCheck.sensitivePaths,
              traversalPaths: retryPreCheck.traversalPaths
            });
            return {
              halted: true,
              result: escalated,
              verificationProfile,
              verificationGuideMarkdown
            };
          }

          await ensureBaselineFilesLoaded([
            ...(retryImpl.files ?? []).map((f) => f.path),
            ...(retryImpl.patches ?? []).map((p) => p.path),
            ...(retryImpl.deleted_files ?? [])
          ]);

          const updatedRetryFiles = await applyTicketImplementationPayload({
            parsed: retryImpl,
            accumulatedFiles: params.accumulatedFiles,
            featureChangedFilesMap: params.featureChangedFilesMap,
            ticketChangedFilesMap,
            featureDeletedFilesSet: params.featureDeletedFilesSet,
            ticketDeletedFilesSet,
            gh: params.gh,
            branch: params.featureBranch
          });
          impl = {
            commit_message: impl.commit_message,
            test_summary: retryImpl.test_summary || impl.test_summary,
            files: updatedRetryFiles
          };
          const retryEval = await evaluateIntegrityAndStage1Suite(
            `Ticket #${ticket.ticketIssueNumber} review-fix test retry ${reviewFixAttempt}/${params.maxCodeFixAttempts}`
          );
          reviewIntegrityCheck = retryEval.integrityCheck;
          testCheck = retryEval.testCheck;
        }
        const featureMergedBeforeReviewFix = await params.stopIfFeaturePrMerged();
        if (featureMergedBeforeReviewFix) {
          return {
            halted: true,
            result: featureMergedBeforeReviewFix,
            verificationProfile,
            verificationGuideMarkdown
          };
        }
        if (!testCheck.passed) {
          if (!reviewIntegrityCheck.passed) {
            restoreViolatedBaselineFiles(reviewIntegrityCheck);
          } else {
            currentPrHeadSha = await params.gh.commitFilesToBranch({
              branch: taskBranch,
              fromBranch: params.featureBranch,
              commitMessage: `chore(wip): checkpoint review-fix attempt ${reviewFixAttempt} on #${ticket.ticketIssueNumber}`,
              files: withFileModes(impl.files),
              deletedFiles: Array.from(ticketDeletedFilesSet)
            });
          }
          const escalated = await params.escalateToNeedsHuman({
            reason: "remediation_exhausted",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            prNumber: taskPr.number,
            prUrl: taskPr.html_url,
            codeFixAttemptsUsed: reviewFixAttempt,
            mustFixFindings: reviewResult.must_fix_findings,
            diagnosticExcerpt: testCheck.output.slice(-2000)
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }

        currentPrHeadSha = await params.gh.commitFilesToBranch({
          branch: taskBranch,
          fromBranch: params.featureBranch,
          commitMessage: `fix(review): address reviewer findings on #${ticket.ticketIssueNumber}`,
          files: withFileModes(impl.files),
          deletedFiles: Array.from(ticketDeletedFilesSet)
        });

        const nextConflictEscalation = await resyncTaskPrIfConflicting();
        if (nextConflictEscalation) {
          return {
            halted: true,
            result: nextConflictEscalation,
            verificationProfile,
            verificationGuideMarkdown
          };
        }
        const nextPass = await runStage2AndStage3ForTaskPr({
          headSha: currentPrHeadSha,
          isReReviewPass: true,
          previousFailedReviewers: reviewResult.failed_reviewers,
          reviewFixAttemptsUsed: reviewFixAttempt
        });
        if (nextPass.releasedForAsyncCi) {
          return {
            halted: true,
            result: nextPass.releasedForAsyncCi,
            verificationProfile,
            verificationGuideMarkdown
          };
        }
        reviewResult = nextPass.reviewResult;
        ciGateResult = nextPass.ciGateResult;

        if (
          !ciGateResult.passed &&
          (ciGateResult.reason === "grace_window_timeout" ||
            ciGateResult.reason === "wall_clock_budget_exhausted")
        ) {
          const escalated = await params.escalateToNeedsHuman({
            reason: ciGateResult.reason,
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            prNumber: taskPr.number,
            prUrl: taskPr.html_url,
            codeFixAttemptsUsed: reviewFixAttempt,
            failedChecks: ciGateResult.failedChecks,
            mustFixFindings: reviewResult.must_fix_findings,
            diagnosticExcerpt: ciGateResult.formattedDiagnostics
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }
      }

      if (reviewResult.conclusion === "failure" || !ciGateResult.passed) {
        const escalated = await params.escalateToNeedsHuman({
          reason: "remediation_exhausted",
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          prNumber: taskPr.number,
          prUrl: taskPr.html_url,
          codeFixAttemptsUsed: reviewFixAttempt,
          failedChecks: ciGateResult.failedChecks,
          mustFixFindings: reviewResult.must_fix_findings,
          diagnosticExcerpt: ciGateResult.formattedDiagnostics
        });
        return {
          halted: true,
          result: escalated,
          verificationProfile,
          verificationGuideMarkdown
        };
      }

      // Check cancellation right before merging task PR
      const cancelledBeforeMerge = await checkMidLoopCancellation({
        issueNumber: params.issueNumber,
        commentId: params.commentId,
        featureBranch: params.featureBranch,
        ticketsManifest: params.ticketsManifest,
        gh: params.gh,
        store: params.store
      });
      if (cancelledBeforeMerge) {
        return {
          halted: true,
          result: cancelledBeforeMerge,
          verificationProfile,
          verificationGuideMarkdown
        };
      }

      const taskPrNumber = taskPr.number;
      const squashCommit = await withUsageAttribution({ phase: "integration", ticket: ticket.ticketIssueNumber }, () => generateSemanticSquashCommitFromDiff({
        prNumber: taskPrNumber,
        targetBranch: params.featureBranch,
        defaultBranch: "dev",
        planIssueNumber: params.issueNumber,
        ticketNumbers: [ticket.ticketIssueNumber],
        fallbackTitle: impl.commit_message,
        changedFiles: impl.files,
        llmApiKey: params.llmApiKey,
        model: params.phaseModels.reviewModel,
        providers: params.phaseModels.providers,
        maxTransientRetries: params.phaseModels.maxTransientRetries,
        transientRetryBackoffSeconds:
          params.phaseModels.transientRetryBackoffSeconds,
        requestTimeoutMs: params.phaseModels.requestTimeoutMs,
        onTransientRetriesUsed: (used) =>
          params.addTransientRetriesUsed(used),
        fetchImpl: params.fetchImpl
      }));

      const featureMergedBeforeTaskMerge = await params.stopIfFeaturePrMerged();
      if (featureMergedBeforeTaskMerge) {
        return {
          halted: true,
          result: featureMergedBeforeTaskMerge,
          verificationProfile,
          verificationGuideMarkdown
        };
      }
      await params.gh.updatePullRequest(taskPr.number, {
        title: squashCommit.pr_title
      });

      await params.gh.publishCheckRun({
        name: "PR title",
        headSha: currentPrHeadSha,
        conclusion: "success",
        summary: `Conventional Commit title verified: '${squashCommit.pr_title}'`
      });

      const mergeTaskPr = () =>
        params.gh.mergePullRequest(openTaskPr.number, {
          headBranch: taskBranch,
          baseBranch: params.featureBranch,
          expectedHeadSha: currentPrHeadSha,
          commitTitle: squashCommit.commit_title,
          commitMessage: squashCommit.commit_message
        });
      const escalateRefusedMerge = (
        reason: NeedsHumanEscalationReason,
        diagnosticExcerpt: string | undefined
      ) =>
        params.escalateToNeedsHuman({
          reason,
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          prNumber: openTaskPr.number,
          prUrl: openTaskPr.html_url,
          diagnosticExcerpt
        });
      // A refused merge gets one re-verification of the new head (re-synced on a conflict, pushed by someone on a 409), then a typed escalation.
      const reverifyAndRetryTaskPrMerge = async (
        refusal: PullRequestNotMergeableError | PullRequestHeadMovedError
      ): Promise<OrchestrateIssueResult | undefined> => {
        if (refusal instanceof PullRequestHeadMovedError) {
          const movedPr = await params.gh.findOpenPullRequestByHead(
            taskBranch,
            params.featureBranch
          );
          if (!movedPr) {
            return await escalateRefusedMerge(
              "pr_not_mergeable",
              `${refusal.message} The pull request is no longer open.`
            );
          }
          currentPrHeadSha = movedPr.head_sha;
        } else {
          const mergeableState = await params.gh.getPullRequestMergeableState(
            openTaskPr.number
          );
          if (!isConflictRefusal(refusal, mergeableState)) {
            return await escalateRefusedMerge(
              "pr_not_mergeable",
              describeMergeRefusal(refusal, mergeableState)
            );
          }
          const resync = await syncTaskBranchWithFeature();
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
          currentPrHeadSha = resync.headSha;
        }
        const pass = await runStage2AndStage3ForTaskPr({
          headSha: currentPrHeadSha,
          isReReviewPass: true,
          reviewFixAttemptsUsed: reviewFixAttempt
        });
        if (pass.releasedForAsyncCi) {
          return pass.releasedForAsyncCi;
        }
        if (
          pass.reviewResult.conclusion === "failure" ||
          !pass.ciGateResult.passed
        ) {
          return await params.escalateToNeedsHuman({
            reason: "resync_verification_failed",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            prNumber: openTaskPr.number,
            prUrl: openTaskPr.html_url,
            codeFixAttemptsUsed: reviewFixAttempt,
            failedChecks: pass.ciGateResult.failedChecks,
            mustFixFindings: pass.reviewResult.must_fix_findings,
            diagnosticExcerpt: pass.ciGateResult.formattedDiagnostics
          });
        }
        await params.gh.publishCheckRun({
          name: "PR title",
          headSha: currentPrHeadSha,
          conclusion: "success",
          summary: `Conventional Commit title verified: '${squashCommit.pr_title}'`
        });
        try {
          await mergeTaskPr();
          return undefined;
        } catch (retryErr) {
          if (retryErr instanceof PullRequestHeadMovedError) {
            return await escalateRefusedMerge(
              "branch_update_conflict",
              retryErr.message
            );
          }
          if (!(retryErr instanceof PullRequestNotMergeableError)) {
            throw retryErr;
          }
          const mergeableState = await params.gh.getPullRequestMergeableState(
            openTaskPr.number
          );
          return await escalateRefusedMerge(
            isConflictRefusal(retryErr, mergeableState)
              ? "merge_conflict_unresolved"
              : "pr_not_mergeable",
            describeMergeRefusal(retryErr, mergeableState)
          );
        }
      };
      try {
        await mergeTaskPr();
      } catch (err) {
        if (
          !(err instanceof PullRequestNotMergeableError) &&
          !(err instanceof PullRequestHeadMovedError)
        ) {
          throw err;
        }
        const refusedMergeResult = await reverifyAndRetryTaskPrMerge(err);
        if (refusedMergeResult) {
          return {
            halted: true,
            result: refusedMergeResult,
            verificationProfile,
            verificationGuideMarkdown
          };
        }
      }

      if (ticket.ticketIssueNumber !== params.issueNumber) {
        await params.gh.closeIssue(ticket.ticketIssueNumber);
      }

      completedTicketNumbers.add(ticket.ticketIssueNumber);
      params.completedTicketsSummary.push(
        `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — PR #${taskPr.number} squash-merged into \`${params.featureBranch}\` as \`${squashCommit.commit_title}\` (Reviewers: ${reviewResult.selected_reviewers.map((r) => `\`${r}\``).join(", ")})` +
          formatTicketUsageSuffix(currentTokenUsage(), ticket.ticketIssueNumber, params.parsedDevAgentsConfig?.pricing)
      );
    } catch (err) {
      if (err instanceof LLMError || err instanceof AgentEngineError || err instanceof JobBudgetExhaustedError) {
        const escalated = await params.escalateToNeedsHuman({
          reason:
            err instanceof LLMError
              ? resolveLlmEscalationReason(err)
              : err instanceof AgentEngineError
                ? resolveAgentEngineEscalationReason(err)
                : "job_budget_exhausted",
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          phase: "implementation",
          prNumber: taskPr?.number,
          prUrl: taskPr?.html_url,
          codeFixAttemptsUsed: reviewFixAttempt,
          diagnosticExcerpt: redactSecrets(err.message, [
            params.activeToken,
            params.llmApiKey
          ])
        });
        return {
          halted: true,
          result: escalated,
          verificationProfile,
          verificationGuideMarkdown
        };
      }
      throw err;
    } finally {
      sandboxWorkspace.cleanup();
    }
  }

  return {
    halted: false,
    verificationProfile,
    verificationGuideMarkdown
  };
}
