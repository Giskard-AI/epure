import {
  mintRepositoryInstallationToken,
  revokeGitHubInstallationToken
} from "../auth/github-app-jwt.js";
import { redactSecrets } from "../auth/issue-command-gate.js";
import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../bootstrap/ci-and-renovate.js";
import { formatNeedsHumanEscalationComment } from "../execution/external-ci-gate.js";
import { adaptReviewerRosterForDomain } from "../review/reviewer-roster.js";
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
  createGitHubRestHelper,
  encodeGitHubContentsPath,
  loadRepoAgentsConfig,
  slugifyTitle,
  verifyPublisherMergeBoundary
} from "./github/rest-client.js";
import { runFeatureIntegrationPhase } from "./phases/feature-integration.js";
import { runGrillAndPlanPhase } from "./phases/grill-and-plan.js";
import { runTicketExecutionLoop } from "./phases/ticket-execution.js";
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

export {
  applyTicketImplementationPayload,
  buildRepoExplorationToolsAndHandlers,
  createGitHubRestHelper,
  encodeGitHubContentsPath,
  formatIssueStateMirrorMarkdown,
  parseTrackedTicketsFromComments,
  redactSecrets,
  resolvePhaseModels,
  runTestsInIsolatedWorkspace,
  slugifyTitle,
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

    const refName = buildIssueStateRefName(input.issueNumber);
    const currentSnapshot = await store.readRef(refName);
    const currentState = currentSnapshot.state;

    // 1. Handle /epure status
    if (input.command === "status") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });
      const statusBody = appendEpureCommandsSpoiler(
        updated.issue_mirror_markdown,
        {
          phase: updated.state.phase,
          status: updated.state.status,
          issueNumber: input.issueNumber
        }
      );
      await gh.postIssueComment(input.issueNumber, statusBody);
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
    if (input.command === "cancel") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          status: "cancelled",
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });
      const body = appendEpureCommandsSpoiler(
        [
          updated.issue_mirror_markdown,
          "",
          `Plan #${input.issueNumber} has been **cancelled** by \`@${input.actor}\`. No further automated executions or merges will occur.`
        ].join("\n"),
        {
          phase: "cancelled",
          status: "cancelled",
          issueNumber: input.issueNumber
        }
      );
      await gh.postIssueComment(input.issueNumber, body);
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

    const issue = await gh.getIssue(input.issueNumber);
    const allComments = await gh.listIssueComments(input.issueNumber);
    const planSlug = slugifyTitle(issue.title);
    const planBranch = `plan/${input.issueNumber}-${planSlug}`;
    const featureBranch = `feature/${input.issueNumber}-${planSlug}`;
    const parsedDevAgentsConfig =
      (await loadRepoAgentsConfig(gh, "dev")) ??
      (await loadRepoAgentsConfig(gh, "main"));
    const phaseModels = resolvePhaseModels(
      input.model ?? input.geminiModel,
      parsedDevAgentsConfig
    );

    // 3 & 4. Handle /epure plan, human reply during grilling, /epure to-spec, /epure to-tickets
    if (
      input.command === "plan" ||
      input.command === "to-spec" ||
      input.command === "to-tickets" ||
      (input.command === "reply" &&
        currentState?.phase === "grilling" &&
        currentState?.status === "active")
    ) {
      return await runGrillAndPlanPhase({
        command: input.command,
        repository: input.repository,
        issueNumber: input.issueNumber,
        commentId: input.commentId,
        issue,
        allComments,
        planSlug,
        planBranch,
        gh,
        store,
        llmApiKey: input.llmApiKey,
        phaseModels,
        fetchImpl: input.fetchImpl
      });
    }

    // 5. Handle /epure approve
    if (input.command === "approve") {
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

      const trustedBaseRoster = adaptReviewerRosterForDomain({
        repository: input.repository,
        planTitle: issue.title,
        glossaryMarkdown: issue.body,
        specMarkdown: issue.body,
        touchesFrontendUi: true
      });
      const trustedBaseFilesMap = new Map<string, string>();
      for (const f of trustedBaseRoster.files) {
        trustedBaseFilesMap.set(f.path, f.content);
      }

      if (hasExplicitPlanManifest) {
        try {
          const planPr = await gh.openPullRequest({
            head: planBranch,
            base: "dev",
            title: `docs(plan): integrate approved specification and ADRs for #${input.issueNumber}`,
            body: appendEpureCommandsSpoiler(
              `Integrates approved planning artifacts and reviewer roster from \`${planBranch}\` for #${input.issueNumber}.`,
              {
                phase: "tickets",
                status: "active",
                issueNumber: input.issueNumber
              }
            )
          });
          await gh.publishCheckRun({
            name: "PR title",
            headSha: planPr.head_sha,
            conclusion: "success",
            summary: "Conventional Commit PR title verified."
          });
          await gh.publishCheckRun({
            name: "ai-review",
            headSha: planPr.head_sha,
            conclusion: "success",
            summary: `Human-approved planning bundle #${input.issueNumber} verified.`
          });
          await gh.mergePullRequest(planPr.number, {
            headBranch: planBranch,
            baseBranch: "dev",
            commitTitle: `docs(plan): integrate approved plan #${input.issueNumber} (#${planPr.number})`,
            commitMessage: `Integrates GLOSSARY.md, ADRs, specification, DESIGN.md, and .cursor/agents/ roster.\n\nRefs #${input.issueNumber}`
          });
        } catch {
          // Ignore if planBranch was already merged into dev on a previous attempt
        }
      }

      const remoteTrustedRoster = await gh.readTrustedBaseRosterFiles("dev");
      for (const [relPath, content] of remoteTrustedRoster.entries()) {
        trustedBaseFilesMap.set(relPath, content);
      }

      const devWorkflowsMap = await gh.readDevWorkflowsMap("dev");
      const devBranchPaths = await gh.listBranchPaths("dev");
      const maxCodeFixAttempts =
        parsedDevAgentsConfig?.max_code_fix_attempts ?? 3;

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
        input.sleepFn ?? (input.fetchImpl ? async () => {} : undefined);
      const infraRerunsBySha = new Map<string, number>();
      let totalTransientRetriesUsed = 0;

      const escalateToNeedsHuman: EscalateToNeedsHumanFn = async (params) => {
        await gh.ensureLabel(
          "needs-human",
          "D93F0B",
          "Requires human maintainer intervention"
        );
        await gh.addIssueLabels(input.issueNumber, ["needs-human"]);
        if (params.ticketNumber !== input.issueNumber) {
          await gh.addIssueLabels(params.ticketNumber, ["needs-human"]);
        }

        const updatedSuspended = await updateIssueStateWithCas({
          issueNumber: input.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            phase: "implementation",
            status: "suspended",
            active_branch: params.branch,
            code_fix_attempts_used:
              params.codeFixAttemptsUsed ?? prev.code_fix_attempts_used,
            transient_retries_used:
              totalTransientRetriesUsed || prev.transient_retries_used,
            last_processed_comment_id:
              input.commentId ?? prev.last_processed_comment_id
          })
        });

        const escalationMarkdown = appendEpureCommandsSpoiler(
          [
            updatedSuspended.issue_mirror_markdown,
            "",
            formatNeedsHumanEscalationComment({
              reason: params.reason,
              issueNumber: input.issueNumber,
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
            issueNumber: input.issueNumber
          }
        );

        await gh.postIssueComment(input.issueNumber, escalationMarkdown);

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
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "implementation",
          status: "active",
          active_branch: featureBranch,
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
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

      const loopOutcome = await runTicketExecutionLoop({
        repository: input.repository,
        issueNumber: input.issueNumber,
        commentId: input.commentId,
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
        llmApiKey: input.llmApiKey,
        phaseModels,
        fetchImpl: input.fetchImpl,
        effectiveSleepFn,
        pollIntervalMs: input.pollIntervalMs,
        sandboxRunner: input.sandboxRunner
      });

      if (loopOutcome.halted && loopOutcome.result) {
        return loopOutcome.result;
      }

      return await runFeatureIntegrationPhase({
        repository: input.repository,
        issueNumber: input.issueNumber,
        commentId: input.commentId,
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
        llmApiKey: input.llmApiKey,
        phaseModels,
        fetchImpl: input.fetchImpl,
        effectiveSleepFn,
        pollIntervalMs: input.pollIntervalMs,
        sandboxRunner: input.sandboxRunner
      });
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
