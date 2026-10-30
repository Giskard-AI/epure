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
  discoverExpectedExternalWorkflows,
  evaluateSingleExternalCiSnapshot,
  formatNeedsHumanEscalationComment,
  resolveLlmEscalationReason
} from "../execution/external-ci-gate.js";
import { LLMError } from "../llm/errors.js";
import { adaptReviewerRosterForDomain } from "../review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../review/squash-commit-generator.js";
import { formatVerificationToolingGuideMarkdown } from "../sandbox/polyglot-workspace-runner.js";
import {
  buildIssueStateRefName,
  createGitHubApiRefStateStore,
  formatIssueStateMirrorMarkdown,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "../state/git-ref-state.js";
import { appendEpureCommandsSpoiler } from "./formatting/comments.js";
import {
  integratePlanBranchIntoFeature,
  mergeGlossaryMarkdownAdditively,
  renumberCollidingAdrs,
  syncBranchWithBase
} from "./github/branch-sync.js";
import {
  createGitHubRestHelper,
  loadRepoAgentsConfig,
  slugifyTitle,
  verifyPublisherMergeBoundary
} from "./github/rest-client.js";
import { runFeatureIntegrationPhase } from "./phases/feature-integration.js";
import {
  runGoldfishSpecAudit,
  runGrillAndPlanPhase
} from "./phases/grill-and-plan.js";
import { runTicketExecutionLoop } from "./phases/ticket-execution.js";
import { EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT } from "./prompts/code-discipline.js";
import {
  resolvePhaseModels,
  type CreatedTicketRecord,
  type EscalateToNeedsHumanFn,
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
import {
  applyTicketImplementationPayload,
  buildRepoExplorationToolsAndHandlers,
  parseTrackedTicketsFromComments,
  runTestsInIsolatedWorkspace
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
  buildRepoExplorationToolsAndHandlers,
  buildWebExplorationToolsAndHandlers,
  cleanHtmlToReadableText,
  createGitHubRestHelper,
  formatIssueStateMirrorMarkdown,
  integratePlanBranchIntoFeature,
  mergeGlossaryMarkdownAdditively,
  parseTrackedTicketsFromComments,
  redactSecrets,
  renumberCollidingAdrs,
  resolvePhaseModels,
  runGoldfishSpecAudit,
  runTestsInIsolatedWorkspace,
  safePublicHttpsFetch,
  slugifyTitle,
  syncBranchWithBase,
  validatePublicHttpsUrlForWebTool,
  verifyPublisherMergeBoundary,
  type CreatedTicketRecord,
  type EpureIssueState,
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
  type TrackedTicketCommentMetadata
};

export async function orchestrateIssueCommand(
  input: OrchestrateIssueInput
): Promise<OrchestrateIssueResult> {
  let mintedAppToken: string | null = null;

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

    const gh = createGitHubRestHelper({
      repository: input.repository,
      token: activeToken,
      fetchImpl: input.fetchImpl
    });

    const store =
      input.stateStore ??
      createGitHubApiRefStateStore({
        repository: input.repository,
        githubToken: activeToken,
        fetchImpl: input.fetchImpl
      });

    let resolvedIssueNumber = input.issueNumber;
    if (resolvedIssueNumber <= 0 && input.command === "continue") {
      const allStates = store.listIssueStates
        ? await store.listIssueStates()
        : [];
      const waitingCandidates = allStates.filter(
        (s) =>
          s.subphase === "waiting_ticket_ci" ||
          s.subphase === "waiting_feature_ci"
      );
      const hasTriggerSelector = Boolean(
        input.triggerHeadSha?.trim() || input.triggerBranch?.trim()
      );
      const matched = hasTriggerSelector
        ? waitingCandidates.find(
            (s) =>
              (input.triggerHeadSha &&
                s.active_head_sha === input.triggerHeadSha) ||
              (input.triggerBranch &&
                (s.active_task_branch === input.triggerBranch ||
                  s.active_branch === input.triggerBranch))
          )
        : waitingCandidates[0];
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
    let maxCodeFixAttempts = 3;
    let totalTransientRetriesUsed = 0;

    try {
      const currentSnapshot = await store.readRef(refName);
      let currentState = currentSnapshot.state;

      // 1. Handle /epure status
      if (effectiveInput.command === "status") {
        const updated = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            last_processed_comment_id:
              effectiveInput.commentId ?? prev.last_processed_comment_id
          })
        });
        const statusBody = appendEpureCommandsSpoiler(
          updated.issue_mirror_markdown,
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
      if (effectiveInput.command === "cancel") {
        const updated = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            status: "cancelled",
            last_processed_comment_id:
              effectiveInput.commentId ?? prev.last_processed_comment_id
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

      const issue = await gh.getIssue(effectiveInput.issueNumber);
      const allComments = await gh.listIssueComments(effectiveInput.issueNumber);
      const planSlug = slugifyTitle(issue.title);
      planBranch = `plan/${effectiveInput.issueNumber}-${planSlug}`;
      featureBranch = `feature/${effectiveInput.issueNumber}-${planSlug}`;
      const parsedDevAgentsConfig =
        (await loadRepoAgentsConfig(gh, "dev")) ??
        (await loadRepoAgentsConfig(gh, "main"));
      const phaseModels = resolvePhaseModels(
        effectiveInput.model ?? effectiveInput.geminiModel,
        parsedDevAgentsConfig
      );
      maxCodeFixAttempts = parsedDevAgentsConfig?.max_code_fix_attempts ?? 3;

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
      try {
        return await runGrillAndPlanPhase({
          command: effectiveInput.command,
          currentPhase: currentState?.phase,
          currentStatus: currentState?.status,
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
          onTransientRetriesUsed: (used) => {
            totalTransientRetriesUsed += used;
          },
          fetchImpl: effectiveInput.fetchImpl
        });
      } catch (err) {
        if (err instanceof LLMError) {
          await gh.ensureLabel(
            "needs-human",
            "D93F0B",
            "Requires human maintainer intervention"
          );
          await gh.addIssueLabels(effectiveInput.issueNumber, ["needs-human"]);

          const suspendedPhase: EpureIssueState["phase"] =
            effectiveInput.command === "to-tickets"
              ? "tickets"
              : effectiveInput.command === "to-spec" || currentState?.phase === "spec"
                ? "spec"
                : "grilling";

          const updatedSuspended = await updateIssueStateWithCas({
            issueNumber: effectiveInput.issueNumber,
            store,
            mutator: (prev) => ({
              ...prev,
              phase: suspendedPhase,
              status: "suspended",
              active_branch: planBranch,
              transient_retries_used:
                totalTransientRetriesUsed || prev.transient_retries_used,
              last_processed_comment_id:
                effectiveInput.commentId ?? prev.last_processed_comment_id
            })
          });

          const escalationMarkdown = appendEpureCommandsSpoiler(
            [
              updatedSuspended.issue_mirror_markdown,
              "",
              formatNeedsHumanEscalationComment({
                reason: resolveLlmEscalationReason(err),
                issueNumber: effectiveInput.issueNumber,
                ticketIssueNumber: effectiveInput.issueNumber,
                branch: planBranch,
                maxCodeFixAttempts,
                diagnosticExcerpt: redactSecrets(err.message, [
                  activeToken,
                  effectiveInput.llmApiKey
                ])
              })
            ].join("\n"),
            {
              phase: "suspended",
              status: "suspended",
              issueNumber: effectiveInput.issueNumber
            }
          );

          await gh.postIssueComment(effectiveInput.issueNumber, escalationMarkdown);
          return {
            executed: true,
            phase: updatedSuspended.state.phase,
            status: updatedSuspended.state.status,
            active_branch: planBranch,
            summary_markdown: escalationMarkdown,
            created_ticket_numbers: [],
            feature_pr_url: ""
          };
        }
        throw err;
      }
    }

      // 4b. Handle /epure sync or /epure rebase (explicit branch synchronization from dev)
      if (
        effectiveInput.command === "sync" ||
        effectiveInput.command === "rebase"
      ) {
        const targetBranch =
          currentState?.active_branch &&
          !currentState.active_branch.startsWith("plan/")
            ? currentState.active_branch
            : featureBranch;

        await gh.ensureBranch("dev", "main");
        await gh.ensureBranch(targetBranch, "dev");

        if (currentState?.active_branch?.startsWith("plan/")) {
          await integratePlanBranchIntoFeature({
            gh,
            planBranch: currentState.active_branch,
            featureBranch: targetBranch,
            baseBranch: "dev"
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
          sandboxRunner: effectiveInput.sandboxRunner
        });

        if (syncRes.status === "escalated") {
          await gh.ensureLabel(
            "needs-human",
            "D93F0B",
            "Requires human maintainer intervention"
          );
          await gh.addIssueLabels(effectiveInput.issueNumber, ["needs-human"]);
          const updatedSuspended = await updateIssueStateWithCas({
            issueNumber: effectiveInput.issueNumber,
            store,
            mutator: (prev) => ({
              ...prev,
              status: "suspended",
              active_branch: targetBranch,
              last_processed_comment_id:
                effectiveInput.commentId ?? prev.last_processed_comment_id
            })
          });
          const escalationMd = appendEpureCommandsSpoiler(
            [
              updatedSuspended.issue_mirror_markdown,
              "",
              formatNeedsHumanEscalationComment({
                reason:
                  syncRes.escalationReason ?? "merge_conflict_unresolved",
                issueNumber: effectiveInput.issueNumber,
                ticketIssueNumber: effectiveInput.issueNumber,
                branch: targetBranch,
                maxCodeFixAttempts,
                diagnosticExcerpt: syncRes.diagnosticExcerpt
              })
            ].join("\n"),
            {
              phase: "suspended",
              status: "suspended",
              issueNumber: effectiveInput.issueNumber
            }
          );
          await gh.postIssueComment(effectiveInput.issueNumber, escalationMd);
          return {
            executed: true,
            phase: updatedSuspended.state.phase,
            status: updatedSuspended.state.status,
            active_branch: targetBranch,
            summary_markdown: escalationMd,
            created_ticket_numbers: [],
            feature_pr_url: ""
          };
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
            sandboxRunner: effectiveInput.sandboxRunner
          });
          if (taskSyncRes.status === "escalated") {
            await gh.ensureLabel(
              "needs-human",
              "D93F0B",
              "Requires human maintainer intervention"
            );
            await gh.addIssueLabels(effectiveInput.issueNumber, [
              "needs-human"
            ]);
            const updatedTaskSuspended = await updateIssueStateWithCas({
              issueNumber: effectiveInput.issueNumber,
              store,
              mutator: (prev) => ({
                ...prev,
                status: "suspended",
                active_branch: targetBranch,
                last_processed_comment_id:
                  effectiveInput.commentId ?? prev.last_processed_comment_id
              })
            });
            const taskEscalationMd = appendEpureCommandsSpoiler(
              [
                updatedTaskSuspended.issue_mirror_markdown,
                "",
                formatNeedsHumanEscalationComment({
                  reason:
                    taskSyncRes.escalationReason ?? "merge_conflict_unresolved",
                  issueNumber: effectiveInput.issueNumber,
                  ticketIssueNumber:
                    currentState.active_ticket_number ??
                    effectiveInput.issueNumber,
                  branch: currentState.active_task_branch,
                  maxCodeFixAttempts,
                  diagnosticExcerpt: taskSyncRes.diagnosticExcerpt
                })
              ].join("\n"),
              {
                phase: "suspended",
                status: "suspended",
                issueNumber: effectiveInput.issueNumber
              }
            );
            await gh.postIssueComment(
              effectiveInput.issueNumber,
              taskEscalationMd
            );
            return {
              executed: true,
              phase: updatedTaskSuspended.state.phase,
              status: updatedTaskSuspended.state.status,
              active_branch: targetBranch,
              summary_markdown: taskEscalationMd,
              created_ticket_numbers: [],
              feature_pr_url: ""
            };
          }
        }

        const updatedSync = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            active_branch: targetBranch,
            last_processed_comment_id:
              effectiveInput.commentId ?? prev.last_processed_comment_id
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
      let initialCodeFixAttemptsUsed =
        currentState?.code_fix_attempts_used ?? 0;

      // 4c. Handle event-driven CI continuation (check_suite / workflow_run / /epure continue)
      if (effectiveInput.command === "continue") {
        if (
          !currentState ||
          (currentState.subphase !== "waiting_ticket_ci" &&
            currentState.subphase !== "waiting_feature_ci")
        ) {
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

        const activeHeadSha =
          currentState.active_head_sha ?? effectiveInput.triggerHeadSha ?? "";
        const devWorkflowsMapForContinue = await gh.readDevWorkflowsMap("dev");
        const expectedContinueWorkflows = discoverExpectedExternalWorkflows({
          workflowFilesMap: devWorkflowsMapForContinue,
          changedPaths: ["src/index.ts"],
          targetBranch:
            currentState.subphase === "waiting_feature_ci"
              ? "dev"
              : currentState.active_branch || featureBranch
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

        if (snapshot.passed && snapshot.aiReviewPassed) {
          if (currentState.subphase === "waiting_feature_ci") {
            const featurePrNumber = currentState.active_pr_number ?? 0;
            const openFeaturePr = await gh.findOpenPullRequestByHead(
              currentState.active_branch || featureBranch,
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
                `<!-- epure-state:${JSON.stringify(updatedReviewReady.state)} -->`,
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
          const targetFeatureBranch =
            currentState.active_branch || featureBranch;

          if (prNumberToMerge > 0) {
            const squashCommit = await generateSemanticSquashCommitFromDiff({
              prNumber: prNumberToMerge,
              targetBranch: targetFeatureBranch,
              defaultBranch: "dev",
              planIssueNumber: effectiveInput.issueNumber,
              ticketNumbers: [ticketNum],
              fallbackTitle: `feat(ticket-${ticketNum}): complete ticket #${ticketNum}`,
              changedFiles: [],
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
            await gh.mergePullRequest(prNumberToMerge, {
              headBranch: taskBranchToMerge,
              baseBranch: targetFeatureBranch,
              commitTitle: squashCommit.commit_title,
              commitMessage: squashCommit.commit_message
            });
          }

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
          initialCodeFixAttemptsUsed = 0;
        } else {
          // External CI or ai-review failed on activeHeadSha -> run one remediation round
          forceOneRemediationRoundOnOpenPr = true;
        }
      }

    // 5. Handle /epure approve (or reply when suspended in implementation phase, or continuation)
    if (
      effectiveInput.command === "approve" ||
      effectiveInput.command === "continue" ||
      (effectiveInput.command === "reply" &&
        currentState?.phase === "implementation" &&
        currentState?.status === "suspended")
    ) {
      if (currentState?.status === "suspended") {
        await gh.removeIssueLabel?.(effectiveInput.issueNumber, "needs-human");
      }
      let ticketsManifest = parseTrackedTicketsFromComments(allComments);
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
        touchesFrontendUi: true
      });
      const trustedBaseFilesMap = new Map<string, string>();
      for (const f of trustedBaseRoster.files) {
        trustedBaseFilesMap.set(f.path, f.content);
      }

      const existingFeaturePrCheck = await gh.findOpenPullRequestByHead(
        featureBranch,
        "dev"
      );

      if (hasExplicitPlanManifest && !existingFeaturePrCheck) {
        await integratePlanBranchIntoFeature({
          gh,
          planBranch,
          featureBranch,
          baseBranch: "dev"
        });
      }

      const remoteTrustedRoster = await gh.readTrustedBaseRosterFiles("dev");
      for (const [relPath, content] of remoteTrustedRoster.entries()) {
        trustedBaseFilesMap.set(relPath, content);
      }

      const devWorkflowsMap = await gh.readDevWorkflowsMap("dev");
      const devBranchPaths = await gh.listBranchPaths("dev");

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

      const escalateToNeedsHuman: EscalateToNeedsHumanFn = async (params) => {
        await gh.ensureLabel(
          "needs-human",
          "D93F0B",
          "Requires human maintainer intervention"
        );
        await gh.addIssueLabels(effectiveInput.issueNumber, ["needs-human"]);
        if (params.ticketNumber !== effectiveInput.issueNumber) {
          await gh.addIssueLabels(params.ticketNumber, ["needs-human"]);
        }

        const updatedSuspended = await updateIssueStateWithCas({
          issueNumber: effectiveInput.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            phase: params.phase ?? "implementation",
            status: "suspended",
            active_branch: params.branch,
            code_fix_attempts_used:
              params.codeFixAttemptsUsed ?? prev.code_fix_attempts_used,
            transient_retries_used:
              totalTransientRetriesUsed || prev.transient_retries_used,
            last_processed_comment_id:
              effectiveInput.commentId ?? prev.last_processed_comment_id
          })
        });

        const escalationMarkdown = appendEpureCommandsSpoiler(
          [
            updatedSuspended.issue_mirror_markdown,
            "",
            formatNeedsHumanEscalationComment({
              reason: params.reason,
              issueNumber: effectiveInput.issueNumber,
              ticketIssueNumber: params.ticketNumber,
              prNumber: params.prNumber,
              prUrl: params.prUrl,
              branch: params.branch,
              codeFixAttemptsUsed: params.codeFixAttemptsUsed,
              maxCodeFixAttempts,
              graceWindowSeconds: verificationProfile.grace_window_seconds,
              failedChecks: params.failedChecks,
              mustFixFindings: params.mustFixFindings,
              sensitivePaths: params.sensitivePaths,
              traversalPaths: params.traversalPaths,
              diagnosticExcerpt: params.diagnosticExcerpt
            })
          ].join("\n"),
          {
            phase: "suspended",
            status: "suspended",
            issueNumber: effectiveInput.issueNumber
          }
        );

        await gh.postIssueComment(effectiveInput.issueNumber, escalationMarkdown);

        return {
          executed: true,
          phase: updatedSuspended.state.phase,
          status: updatedSuspended.state.status,
          active_branch: params.branch,
          summary_markdown: escalationMarkdown,
          created_ticket_numbers: ticketsManifest.map(
            (t) => t.ticketIssueNumber
          ),
          feature_pr_url: params.featurePrUrl ?? params.prUrl ?? ""
        };
      };

      await gh.ensureBranch(featureBranch, "dev");

      const updatedStart = await updateIssueStateWithCas({
        issueNumber: effectiveInput.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "implementation",
          status: "active",
          active_branch: featureBranch,
          last_processed_comment_id:
            effectiveInput.commentId ?? prev.last_processed_comment_id
        })
      });

      const hintForWorkspace = [
        issue.title,
        issue.body,
        ...ticketsManifest.map(
          (t) => `${t.title}\n${t.description}\n${t.filesToTouch.join(" ")}`
        )
      ].join("\n");
      const accumulatedFiles = await gh.readBranchWorkspaceFiles(
        featureBranch,
        hintForWorkspace
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

      const loopOutcome = await runTicketExecutionLoop({
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
        getTotalTransientRetriesUsed: () => totalTransientRetriesUsed,
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
        initialCodeFixAttemptsUsed
      });

      if (loopOutcome.halted && loopOutcome.result) {
        return loopOutcome.result;
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
          devBranchPaths,
          devWorkflowsMap,
          trustedBaseFilesMap,
          trustedBaseDesignMarkdown: trustedBaseRoster.designMarkdown,
          parsedDevAgentsConfig,
          initialVerificationProfile: loopOutcome.verificationProfile,
          initialVerificationGuideMarkdown: loopOutcome.verificationGuideMarkdown,
          maxCodeFixAttempts,
          infraRerunsBySha,
          getTotalTransientRetriesUsed: () => totalTransientRetriesUsed,
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
          initialCodeFixAttemptsUsed
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
      await gh.ensureLabel(
        "needs-human",
        "D93F0B",
        "Requires human maintainer intervention"
      );
      await gh.addIssueLabels(effectiveInput.issueNumber, ["needs-human"]);

      const latestSnap = await store.readRef(refName);
      const fallbackPhase: EpureIssueState["phase"] =
        latestSnap.state?.phase && latestSnap.state.phase !== "idle"
          ? latestSnap.state.phase
          : effectiveInput.command === "approve" ||
              effectiveInput.command === "continue"
            ? "implementation"
            : effectiveInput.command === "to-tickets"
              ? "tickets"
              : effectiveInput.command === "to-spec"
                ? "spec"
                : "grilling";
      const fallbackBranch =
        latestSnap.state?.active_branch ||
        (fallbackPhase === "implementation" ? featureBranch : planBranch);

      const updatedSuspended = await updateIssueStateWithCas({
        issueNumber: effectiveInput.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: prev.phase !== "idle" ? prev.phase : fallbackPhase,
          status: "suspended",
          active_branch: prev.active_branch || fallbackBranch,
          transient_retries_used:
            totalTransientRetriesUsed || prev.transient_retries_used,
          last_processed_comment_id:
            effectiveInput.commentId ?? prev.last_processed_comment_id
        })
      });

      const rawErrMessage = err instanceof Error ? err.message : String(err);
      const escalationReason =
        err instanceof LLMError
          ? resolveLlmEscalationReason(err)
          : "internal_error";

      const escalationMarkdown = appendEpureCommandsSpoiler(
        [
          updatedSuspended.issue_mirror_markdown,
          "",
          formatNeedsHumanEscalationComment({
            reason: escalationReason,
            issueNumber: effectiveInput.issueNumber,
            ticketIssueNumber: effectiveInput.issueNumber,
            branch: updatedSuspended.state.active_branch || fallbackBranch,
            codeFixAttemptsUsed: updatedSuspended.state.code_fix_attempts_used,
            maxCodeFixAttempts,
            diagnosticExcerpt: redactSecrets(rawErrMessage, [
              activeToken,
              effectiveInput.llmApiKey
            ])
          })
        ].join("\n"),
        {
          phase: "suspended",
          status: "suspended",
          issueNumber: effectiveInput.issueNumber
        }
      );

      await gh.postIssueComment(effectiveInput.issueNumber, escalationMarkdown);
      return {
        executed: true,
        phase: updatedSuspended.state.phase,
        status: updatedSuspended.state.status,
        active_branch: updatedSuspended.state.active_branch,
        summary_markdown: escalationMarkdown,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }
  } finally {
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
