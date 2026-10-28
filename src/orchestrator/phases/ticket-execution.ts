import { redactSecrets } from "../../auth/issue-command-gate.js";
import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../../bootstrap/ci-and-renovate.js";
import type { parseAgentsYaml } from "../../bootstrap/setup-repo.js";
import {
  discoverExpectedExternalWorkflows,
  resolveLlmEscalationReason,
  waitForExternalCiChecks,
  type WaitForExternalCiChecksResult
} from "../../execution/external-ci-gate.js";
import { reconcileProvenTicketDependencies } from "../../execution/proven-dependency-unblocker.js";
import { evaluateReviewFeedbackTrigger } from "../../execution/review-loop-guard.js";
import { LLMError } from "../../llm/errors.js";
import { runMultiAgentPrReviewPass } from "../../review/multi-agent-pr-review.js";
import type { ReviewerAgentName } from "../../review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../../review/squash-commit-generator.js";
import type {
  SandboxExecutionInput,
  SandboxExecutionResult
} from "../../sandbox/llm-sandbox.js";
import {
  formatVerificationToolingGuideMarkdown,
  prepareRepositorySandboxWorkspace,
  validateWorkspaceFileOperations
} from "../../sandbox/polyglot-workspace-runner.js";
import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  wrapUntrustedContent
} from "../../security/prompt-injection-guard.js";
import { processPendingIssueCommentsBatch } from "../../state/comment-batch-cursor.js";
import {
  updateIssueStateWithCas,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import { appendEpureCommandsSpoiler } from "../formatting/comments.js";
import { callGeminiJson } from "../gemini-client.js";
import { loadOrchestratorStateFromGitRef } from "../github/rest-client.js";
import { EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT } from "../prompts/code-discipline.js";
import {
  GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
  type EscalateToNeedsHumanFn,
  type GeneratedTicketImplementation,
  type GitHubRestHelper,
  type IssueMetadata,
  type OrchestrateIssueResult,
  type ResolvedPhaseModels,
  type TrackedTicketCommentMetadata
} from "../types.js";
import {
  applyTicketImplementationPayload,
  buildRepoExplorationToolsAndHandlers,
  checkIsBrownfieldSubpackageRepo,
  runTestsInIsolatedWorkspace
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
        `<!-- epure-state:${JSON.stringify(snapshot.state)} -->`,
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
        `<!-- epure-state:${JSON.stringify(batchResult.state)} -->`,
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

export async function runTicketExecutionLoop(
  params: RunTicketExecutionLoopParams
): Promise<RunTicketExecutionLoopOutcome> {
  let verificationProfile = params.initialVerificationProfile;
  let verificationGuideMarkdown = params.initialVerificationGuideMarkdown;
  const completedTicketNumbers = new Set<number>();

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
    if (cancelledBeforeTicket) {
      return {
        halted: true,
        result: cancelledBeforeTicket,
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
          mutator: (prev) => ({
            ...prev,
            phase: "implementation",
            status: "suspended",
            active_branch: params.featureBranch,
            last_processed_comment_id:
              params.commentId ?? prev.last_processed_comment_id
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
        `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — previously squash-merged into \`${params.featureBranch}\``
      );
      continue;
    }

    const taskBranch = `task/${ticket.ticketIssueNumber}-${ticket.slug}`;
    if (ticket.ticketIssueNumber !== params.issueNumber) {
      await params.gh.removeIssueLabel?.(ticket.ticketIssueNumber, "needs-human");
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(
        `::group::[EPURE][Ticket #${ticket.ticketIssueNumber}] Initial TDD Implementation (${taskBranch})\n`
      );
    }
    await params.gh.ensureBranch(taskBranch, params.featureBranch);

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

    let taskPr: { number: number; html_url: string; head_sha: string } | undefined;
    let fixAttempt = 0;
    let reviewFixAttempt = 0;

    try {
      const ticketChangedFilesMap = new Map<string, string>();
      const ticketDeletedFilesSet = new Set<string>();
      let impl: {
        commit_message: string;
        test_summary: string;
        files: Array<{ path: string; content: string }>;
      };
      let currentPrHeadSha: string;

      const existingTaskPr = await params.gh.findOpenPullRequestByHead(
        taskBranch,
        params.featureBranch
      );

      if (existingTaskPr) {
        const taskPrFiles = await params.gh.listPullRequestFiles(
          existingTaskPr.number
        );
        if (taskPrFiles.length > 0) {
          for (const prFile of taskPrFiles) {
            const cleanPath = prFile.filename.replace(/^\/+/, "");
            if (prFile.status === "removed") {
              params.accumulatedFiles.delete(cleanPath);
              params.featureChangedFilesMap.delete(cleanPath);
              ticketChangedFilesMap.delete(cleanPath);
              params.featureDeletedFilesSet.add(cleanPath);
              ticketDeletedFilesSet.add(cleanPath);
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
            params.hintForWorkspace
          );
          for (const [p, c] of taskBranchFiles.entries()) {
            params.accumulatedFiles.set(p, c);
            params.featureChangedFilesMap.set(p, c);
            ticketChangedFilesMap.set(p, c);
          }
        }

        const existingPreCheck = validateWorkspaceFileOperations({
          workDir: sandboxWorkspace.workDir,
          files: Array.from(ticketChangedFilesMap.keys()).map((p) => ({
            path: p
          })),
          deleted_files: Array.from(ticketDeletedFilesSet),
          targets: verificationProfile.targets,
          isTaskBranch: true
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
        const existingFilesContext = Array.from(
          params.accumulatedFiles.entries()
        )
          .map(([path, content]) => `--- FILE: ${path} ---\n${content}`)
          .join("\n\n");

        const isBrownfieldSubpackageRepo = checkIsBrownfieldSubpackageRepo(
          params.accumulatedFiles,
          params.devBranchPaths
        );

        const tddSystemInstruction = [
          "Tu es un ingénieur TDD EPURE implémentant un ticket approuvé.",
          PROMPT_INJECTION_IMMUNITY_CLAUSE,
          "Règles strictes :",
          "1. Écris des tests couvrant tous les critères d'acceptation et cas limites.",
          "2. Implémente le code propre et complet faisant passer 100% des tests.",
          "3. N'utilise aucune dépendance externe exotique non déclarée.",
          "4. Ne modifie JAMAIS .cursor/agents/**, .github/workflows/**, .github/agents.yml ou .env*.",
          "",
          verificationGuideMarkdown,
          "",
          ...(isBrownfieldSubpackageRepo
            ? [
                "5. Il s'agit d'un dépôt existant multi-packages (`backend/`, `frontend/`). Utilise les outils `list_repo_files`, `search_in_repo_file` et `read_repo_file` pour inspecter les fichiers pertinents avant de coder.",
                "6. Pour modifier un fichier existant du dépôt, utilise de préférence `patches` (`old_string` -> `new_string` exact) afin de faire une modification chirurgicale sans réécrire des milliers de lignes inchangées. Pour créer un nouveau fichier (ex: nouveau fichier de test), utilise `files` avec son contenu complet. Pour supprimer un fichier obsolète, utilise `deleted_files`. Ne crée PAS de package.json à la racine.",
                "Renvoie un objet JSON strictement valide respectant ce schéma :",
                "{",
                '  "commit_message": "fix: ...",',
                '  "test_summary": "Tests and acceptance criteria verified",',
                '  "patches": [',
                '    { "path": "backend/src/...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
                "  ],",
                '  "files": [',
                '    { "path": "backend/src/__tests__/...", "content": "..." }',
                "  ],",
                '  "deleted_files": []',
                "}"
              ]
            : [
                "5. Renvoie un objet JSON strictement valide respectant exactement ce schéma :",
                "{",
                `  "commit_message": "feat(ticket-${ticket.ticketIssueNumber}): ...",`,
                '  "test_summary": "Vitest parameterized suite verified",',
                '  "files": [',
                '    { "path": "package.json", "content": "..." },',
                '    { "path": "src/...", "content": "..." },',
                '    { "path": "tests/...", "content": "..." }',
                "  ]",
                "}"
              ]),
          "",
          EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
        ].join("\n");

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
          verificationGuideMarkdown,
          "",
          existingFilesContext
            ? `Fichiers déjà présents sur la branche feature :\n${wrapUntrustedContent("untrusted_workspace_files", existingFilesContext)}`
            : "C'est le premier ticket : inclus un package.json complet (avec scripts 'test': 'vitest run' et 'build': 'vite build', dependencies react/react-dom, devDependencies typescript/vite/vitest/@vitejs/plugin-react/@types/react/@types/react-dom) ainsi que tsconfig.json et vite.config.ts."
        ].join("\n");

        const parsedImpl = await callGeminiJson<GeneratedTicketImplementation>({
          apiKey: params.llmApiKey,
          model: params.phaseModels.implementationModel,
          providers: params.phaseModels.providers,
          maxTransientRetries: params.phaseModels.maxTransientRetries,
          transientRetryBackoffSeconds:
            params.phaseModels.transientRetryBackoffSeconds,
          requestTimeoutMs: params.phaseModels.requestTimeoutMs,
          onTransientRetriesUsed: (used) =>
            params.addTransientRetriesUsed(used),
          systemInstruction: tddSystemInstruction,
          prompt: tddPrompt,
          temperature: 0.1,
          ...buildRepoExplorationToolsAndHandlers({
            branch: params.featureBranch,
            featureBranch: params.featureBranch,
            accumulatedFiles: params.accumulatedFiles,
            devBranchPaths: params.devBranchPaths,
            gh: params.gh
          }),
          responseSchema: GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
          fetchImpl: params.fetchImpl
        });

        const preStage1Check = validateWorkspaceFileOperations({
          workDir: sandboxWorkspace.workDir,
          files: [
            ...(parsedImpl.files ?? []).map((f) => ({ path: f.path })),
            ...(parsedImpl.patches ?? []).map((p) => ({ path: p.path }))
          ],
          deleted_files: parsedImpl.deleted_files,
          targets: verificationProfile.targets,
          isTaskBranch: true
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

        let testCheck = await runTestsInIsolatedWorkspace({
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
          verificationProfile,
          bootstrappedTargets,
          sandboxRunner: params.sandboxRunner,
          llmApiKey: params.llmApiKey,
          label: `Ticket #${ticket.ticketIssueNumber} initial TDD suite`
        });

        while (!testCheck.passed && fixAttempt < params.maxCodeFixAttempts) {
          fixAttempt += 1;
          const currentFilesContext = Array.from(
            params.accumulatedFiles.entries()
          )
            .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
            .join("\n\n");

          const fixSystemInstruction = [
            "Tu es un ingénieur TDD EPURE corrigeant un échec de vérification Stage 1 en sandbox isolée.",
            PROMPT_INJECTION_IMMUNITY_CLAUSE,
            "Corrige les fichiers en défaut (code ou assertions de test) pour que 100% des cibles Stage 1 passent.",
            "Ne modifie JAMAIS .cursor/agents/**, .github/workflows/**, .github/agents.yml ou .env*.",
            "Tu peux utiliser les outils `list_repo_files`, `search_in_repo_file` et `read_repo_file` pour inspecter les fichiers du dépôt.",
            "Pour modifier un fichier existant volumineux, utilise de préférence `patches` (`old_string` -> `new_string` exact). Pour supprimer un fichier obsolète, utilise `deleted_files`.",
            "",
            verificationGuideMarkdown,
            "",
            "Renvoie un objet JSON strictement valide respectant exactement ce schéma :",
            "{",
            `  "commit_message": "feat(ticket-${ticket.ticketIssueNumber}): ...",`,
            '  "test_summary": "Stage 1 verification suite verified",',
            '  "patches": [',
            '    { "path": "...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
            "  ],",
            '  "files": [',
            '    { "path": "...", "content": "..." }',
            "  ],",
            '  "deleted_files": []',
            "}",
            "",
            EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
          ].join("\n");

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

          const fixedImpl = await callGeminiJson<GeneratedTicketImplementation>({
            apiKey: params.llmApiKey,
            model: params.phaseModels.implementationModel,
            providers: params.phaseModels.providers,
            maxTransientRetries: params.phaseModels.maxTransientRetries,
            transientRetryBackoffSeconds:
              params.phaseModels.transientRetryBackoffSeconds,
            requestTimeoutMs: params.phaseModels.requestTimeoutMs,
            onTransientRetriesUsed: (used) =>
              params.addTransientRetriesUsed(used),
            systemInstruction: fixSystemInstruction,
            prompt: fixPrompt,
            temperature: 0.1,
            ...buildRepoExplorationToolsAndHandlers({
              branch: params.featureBranch,
              featureBranch: params.featureBranch,
              accumulatedFiles: params.accumulatedFiles,
              deletedFilesSet: ticketDeletedFilesSet,
              devBranchPaths: params.devBranchPaths,
              gh: params.gh
            }),
            responseSchema: GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
            fetchImpl: params.fetchImpl
          });

          const fixPreCheck = validateWorkspaceFileOperations({
            workDir: sandboxWorkspace.workDir,
            files: [
              ...(fixedImpl.files ?? []).map((f) => ({ path: f.path })),
              ...(fixedImpl.patches ?? []).map((p) => ({ path: p.path }))
            ],
            deleted_files: fixedImpl.deleted_files,
            targets: verificationProfile.targets,
            isTaskBranch: true
          });
          if (!fixPreCheck.allowed) {
            const escalated = await params.escalateToNeedsHuman({
              reason: "sensitive_path_violation",
              ticketNumber: ticket.ticketIssueNumber,
              branch: taskBranch,
              codeFixAttemptsUsed: fixAttempt,
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

          testCheck = await runTestsInIsolatedWorkspace({
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
            verificationProfile,
            bootstrappedTargets,
            sandboxRunner: params.sandboxRunner,
            llmApiKey: params.llmApiKey,
            label: `Ticket #${ticket.ticketIssueNumber} TDD auto-fix attempt ${fixAttempt}/${params.maxCodeFixAttempts}`
          });
        }

        if (!testCheck.passed) {
          const escalated = await params.escalateToNeedsHuman({
            reason: "remediation_exhausted",
            ticketNumber: ticket.ticketIssueNumber,
            branch: taskBranch,
            codeFixAttemptsUsed: fixAttempt,
            diagnosticExcerpt: testCheck.output.slice(-2000)
          });
          return {
            halted: true,
            result: escalated,
            verificationProfile,
            verificationGuideMarkdown
          };
        }

        await params.gh.commitFilesToBranch({
          branch: taskBranch,
          fromBranch: params.featureBranch,
          commitMessage: impl.commit_message,
          files: impl.files,
          deletedFiles: Array.from(ticketDeletedFilesSet)
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
            `- **Summary**: ${impl.test_summary}`
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
          title: impl.commit_message,
          body: prBody
        });

        currentPrHeadSha = taskPr.head_sha;
      }

      let reviewedCommitShas: readonly string[] = [];

      const runStage2AndStage3ForTaskPr = async (passParams: {
        headSha: string;
        isReReviewPass: boolean;
        previousFailedReviewers?: ReadonlyArray<ReviewerAgentName>;
        reviewFixAttemptsUsed: number;
      }): Promise<{
        reviewResult: Awaited<ReturnType<typeof runMultiAgentPrReviewPass>>;
        ciGateResult: WaitForExternalCiChecksResult;
        escalateToHuman: boolean;
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

        const reviewRes = await runMultiAgentPrReviewPass({
          repository: params.repository,
          prNumber: taskPr!.number,
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
          fetchImpl: params.fetchImpl
        });

        await params.gh.postPullRequestReview(taskPr!.number, {
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

      let {
        reviewResult,
        ciGateResult,
        escalateToHuman: reviewGuardEscalate
      } = await runStage2AndStage3ForTaskPr({
        headSha: currentPrHeadSha,
        isReReviewPass: false,
        reviewFixAttemptsUsed: 0
      });

      if (reviewGuardEscalate && reviewResult.conclusion === "failure") {
        const escalated = await params.escalateToNeedsHuman({
          reason: "remediation_exhausted",
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          prNumber: taskPr.number,
          prUrl: taskPr.html_url,
          codeFixAttemptsUsed: 0,
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
          codeFixAttemptsUsed: 0,
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
        reviewFixAttempt += 1;
        await updateIssueStateWithCas({
          issueNumber: params.issueNumber,
          store: params.store,
          mutator: (prev) => ({
            ...prev,
            code_fix_attempts_used: reviewFixAttempt,
            transient_retries_used:
              params.getTotalTransientRetriesUsed() ||
              prev.transient_retries_used
          })
        });

        process.stdout.write(
          `[EPURE][Ticket #${ticket.ticketIssueNumber}][PR #${taskPr.number}] Post-PR remediation round ${reviewFixAttempt}/${params.maxCodeFixAttempts} (${reviewResult.must_fix_findings.length} must_fix finding(s), CI passed=${ciGateResult.passed})\n`
        );
        const findingsText = reviewResult.must_fix_findings
          .map(
            (f, idx) =>
              `${idx + 1}. [${f.reviewer}] (${f.path}:${f.line}) ${f.title} — ${f.rationale} -> Action: ${f.suggested_action}`
          )
          .join("\n");

        const currentFilesContext = Array.from(
          params.accumulatedFiles.entries()
        )
          .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
          .join("\n\n");

        const reviewFixSystemInstruction = [
          "Tu es un ingénieur TDD EPURE corrigeant les constats bloquants ('must_fix') de revue multi-agents et/ou les échecs CI externes.",
          PROMPT_INJECTION_IMMUNITY_CLAUSE,
          "Corrige précisément chaque anomalie tout en maintenant 100% des cibles Stage 1 au vert.",
          "Ne modifie JAMAIS .cursor/agents/**, .github/workflows/**, .github/agents.yml ou .env*.",
          "Utilise les outils `list_repo_files`, `search_in_repo_file` et `read_repo_file` pour inspecter les fichiers pertinents du dépôt avant de coder.",
          "",
          verificationGuideMarkdown,
          "",
          "Pour modifier un fichier existant volumineux, utilise de préférence `patches` (`old_string` -> `new_string` exact). Sinon utilise `files` avec le contenu intégral du fichier. Pour supprimer un fichier obsolète, utilise `deleted_files`.",
          "Renvoie un objet JSON strictement valide :",
          "{",
          `  "commit_message": "fix(review): address post-PR findings on #${ticket.ticketIssueNumber}",`,
          '  "test_summary": "Addressed review and CI findings and verified test suite",',
          '  "patches": [',
          '    { "path": "...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
          "  ],",
          '  "files": [',
          '    { "path": "...", "content": "..." }',
          "  ],",
          '  "deleted_files": ["..."]',
          "}",
          "",
          EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT
        ].join("\n");

        const promptParts: string[] = [];
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

        const reviewFixedImpl =
          await callGeminiJson<GeneratedTicketImplementation>({
            apiKey: params.llmApiKey,
            model: params.phaseModels.implementationModel,
            providers: params.phaseModels.providers,
            maxTransientRetries: params.phaseModels.maxTransientRetries,
            transientRetryBackoffSeconds:
              params.phaseModels.transientRetryBackoffSeconds,
            requestTimeoutMs: params.phaseModels.requestTimeoutMs,
            onTransientRetriesUsed: (used) =>
              params.addTransientRetriesUsed(used),
            thinkingLevel: "HIGH",
            logLabel: `review-fix:#${ticket.ticketIssueNumber}/iter-${reviewFixAttempt}`,
            systemInstruction: reviewFixSystemInstruction,
            prompt: promptParts.join("\n"),
            temperature: 0.1,
            ...buildRepoExplorationToolsAndHandlers({
              branch: taskBranch,
              featureBranch: params.featureBranch,
              accumulatedFiles: params.accumulatedFiles,
              deletedFilesSet: ticketDeletedFilesSet,
              devBranchPaths: params.devBranchPaths,
              gh: params.gh
            }),
            responseSchema: GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
            fetchImpl: params.fetchImpl
          });

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
          isTaskBranch: true
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

        let testCheck = await runTestsInIsolatedWorkspace({
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
          verificationProfile,
          bootstrappedTargets,
          sandboxRunner: params.sandboxRunner,
          llmApiKey: params.llmApiKey,
          label: `Ticket #${ticket.ticketIssueNumber} review-fix iteration ${reviewFixAttempt}/${params.maxCodeFixAttempts}`
        });
        let reviewTestRetry = 0;
        while (!testCheck.passed && reviewTestRetry < 2) {
          reviewTestRetry += 1;
          const retryFilesContext = Array.from(
            params.accumulatedFiles.entries()
          )
            .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
            .join("\n\n");
          const retryImpl =
            await callGeminiJson<GeneratedTicketImplementation>({
              apiKey: params.llmApiKey,
              model: params.phaseModels.implementationModel,
              providers: params.phaseModels.providers,
              maxTransientRetries: params.phaseModels.maxTransientRetries,
              transientRetryBackoffSeconds:
                params.phaseModels.transientRetryBackoffSeconds,
              requestTimeoutMs: params.phaseModels.requestTimeoutMs,
              onTransientRetriesUsed: (used) =>
                params.addTransientRetriesUsed(used),
              thinkingLevel: "HIGH",
              systemInstruction: reviewFixSystemInstruction,
              prompt: [
                `La correction a fait échouer la vérification Stage 1 en sandbox (tentative ${reviewTestRetry}/2) :`,
                wrapUntrustedContent(
                  "untrusted_test_output",
                  testCheck.output.slice(-6000)
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
              temperature: 0.1,
              ...buildRepoExplorationToolsAndHandlers({
                branch: taskBranch,
                featureBranch: params.featureBranch,
                accumulatedFiles: params.accumulatedFiles,
                deletedFilesSet: ticketDeletedFilesSet,
                devBranchPaths: params.devBranchPaths,
                gh: params.gh
              }),
              responseSchema: GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
              fetchImpl: params.fetchImpl
            });

          const retryPreCheck = validateWorkspaceFileOperations({
            workDir: sandboxWorkspace.workDir,
            files: [
              ...(retryImpl.files ?? []).map((f) => ({ path: f.path })),
              ...(retryImpl.patches ?? []).map((p) => ({ path: p.path }))
            ],
            deleted_files: retryImpl.deleted_files,
            targets: verificationProfile.targets,
            isTaskBranch: true
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
          testCheck = await runTestsInIsolatedWorkspace({
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
            verificationProfile,
            bootstrappedTargets,
            sandboxRunner: params.sandboxRunner,
            llmApiKey: params.llmApiKey,
            label: `Ticket #${ticket.ticketIssueNumber} review-fix iteration ${reviewFixAttempt} test retry ${reviewTestRetry}/2`
          });
        }
        if (!testCheck.passed) {
          currentPrHeadSha = await params.gh.commitFilesToBranch({
            branch: taskBranch,
            fromBranch: params.featureBranch,
            commitMessage: `chore(wip): checkpoint review-fix attempt ${reviewFixAttempt} on #${ticket.ticketIssueNumber}`,
            files: impl.files,
            deletedFiles: Array.from(ticketDeletedFilesSet)
          });
          if (reviewFixAttempt < params.maxCodeFixAttempts) {
            continue;
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
          files: impl.files,
          deletedFiles: Array.from(ticketDeletedFilesSet)
        });

        const nextPass = await runStage2AndStage3ForTaskPr({
          headSha: currentPrHeadSha,
          isReReviewPass: true,
          previousFailedReviewers: reviewResult.failed_reviewers,
          reviewFixAttemptsUsed: reviewFixAttempt
        });
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

      const squashCommit = await generateSemanticSquashCommitFromDiff({
        prNumber: taskPr.number,
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
      });

      await params.gh.updatePullRequest(taskPr.number, {
        title: squashCommit.pr_title
      });

      await params.gh.publishCheckRun({
        name: "PR title",
        headSha: currentPrHeadSha,
        conclusion: "success",
        summary: `Conventional Commit title verified: '${squashCommit.pr_title}'`
      });

      await params.gh.mergePullRequest(taskPr.number, {
        headBranch: taskBranch,
        baseBranch: params.featureBranch,
        commitTitle: squashCommit.commit_title,
        commitMessage: squashCommit.commit_message
      });

      if (ticket.ticketIssueNumber !== params.issueNumber) {
        await params.gh.closeIssue(ticket.ticketIssueNumber);
      }

      completedTicketNumbers.add(ticket.ticketIssueNumber);
      params.completedTicketsSummary.push(
        `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — PR #${taskPr.number} squash-merged into \`${params.featureBranch}\` as \`${squashCommit.commit_title}\` (Reviewers: ${reviewResult.selected_reviewers.map((r) => `\`${r}\``).join(", ")})`
      );
    } catch (err) {
      if (err instanceof LLMError) {
        const escalated = await params.escalateToNeedsHuman({
          reason: resolveLlmEscalationReason(err),
          ticketNumber: ticket.ticketIssueNumber,
          branch: taskBranch,
          phase: "implementation",
          prNumber: taskPr?.number,
          prUrl: taskPr?.html_url,
          codeFixAttemptsUsed: Math.max(fixAttempt, reviewFixAttempt),
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
