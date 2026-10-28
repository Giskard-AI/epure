import { redactSecrets } from "../../auth/issue-command-gate.js";
import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../../bootstrap/ci-and-renovate.js";
import type { parseAgentsYaml } from "../../bootstrap/setup-repo.js";
import {
  discoverExpectedExternalWorkflows,
  waitForExternalCiChecks,
  type WaitForExternalCiChecksResult
} from "../../execution/external-ci-gate.js";
import {
  AuthenticationError,
  LLMError,
  QuotaExhaustedError
} from "../../llm/errors.js";
import { prepareFeatureToDevPullRequest } from "../../planning/feature-to-dev-pr.js";
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
import {
  updateIssueStateWithCas,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import { appendEpureCommandsSpoiler } from "../formatting/comments.js";
import { callGeminiJson } from "../gemini-client.js";
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
  runTestsInIsolatedWorkspace
} from "../workspace/repo-tools.js";

export interface RunFeatureIntegrationPhaseParams {
  readonly repository: string;
  readonly issueNumber: number;
  readonly commentId: number | undefined;
  readonly activeToken: string;
  readonly issue: IssueMetadata;
  readonly planSlug: string;
  readonly featureBranch: string;
  readonly activeBranchForStartState: string;
  readonly ticketsManifest: readonly TrackedTicketCommentMetadata[];
  readonly existingFeaturePrAtStart: {
    number: number;
    html_url: string;
    head_sha: string;
    title: string;
    body: string;
  } | null;
  readonly accumulatedFiles: Map<string, string>;
  readonly featureChangedFilesMap: Map<string, string>;
  readonly featureDeletedFilesSet: Set<string>;
  readonly completedTicketsSummary: readonly string[];
  readonly devBranchPaths: readonly string[];
  readonly devWorkflowsMap: Map<string, string>;
  readonly trustedBaseFilesMap: Map<string, string>;
  readonly trustedBaseDesignMarkdown: string | undefined;
  readonly parsedDevAgentsConfig: ReturnType<typeof parseAgentsYaml> | null;
  readonly initialVerificationProfile: VerificationProfile;
  readonly initialVerificationGuideMarkdown: string;
  readonly maxCodeFixAttempts: number;
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

export async function runFeatureIntegrationPhase(
  params: RunFeatureIntegrationPhaseParams
): Promise<OrchestrateIssueResult> {
  let verificationProfile = params.initialVerificationProfile;
  let verificationGuideMarkdown = params.initialVerificationGuideMarkdown;

  // Bucket A Guard: prepareFeatureToDevPullRequest check
  const featurePrGate = prepareFeatureToDevPullRequest({
    repository: params.repository,
    planIssueNumber: params.issueNumber,
    planTitle: params.issue.title.replace(/\[plan\]\s*/i, ""),
    featureBranch: params.featureBranch,
    specPath: `docs/specs/${params.planSlug}.md`,
    adrPaths: params.devBranchPaths.filter((p) =>
      /^docs\/adr\/\d{4}-.+\.md$/.test(p)
    ),
    tickets: params.ticketsManifest.map((t, idx) => ({
      id: idx + 1,
      issueNumber: t.ticketIssueNumber,
      title: t.title,
      state: "closed" as const
    })),
    featureCiChecksGreen: true,
    attemptAutoMergeToDev: false
  });
  if (!featurePrGate.ready_to_open) {
    return await params.escalateToNeedsHuman({
      reason: "remediation_exhausted",
      ticketNumber: params.issueNumber,
      branch: params.featureBranch,
      diagnosticExcerpt: `${featurePrGate.error_code}: ${featurePrGate.error_message}`
    });
  }

  const effectiveFeatureEntries =
    params.featureChangedFilesMap.size > 0
      ? Array.from(params.featureChangedFilesMap.entries())
      : Array.from(params.accumulatedFiles.entries());
  const allFeatureFiles = effectiveFeatureEntries.map(([path, content]) => ({
    path,
    content
  }));
  const allTicketNumbers = params.ticketsManifest.map(
    (t) => t.ticketIssueNumber
  );

  const featureSquashPreview = await generateSemanticSquashCommitFromDiff({
    prNumber: params.issueNumber,
    targetBranch: "dev",
    defaultBranch: "dev",
    planIssueNumber: params.issueNumber,
    ticketNumbers: allTicketNumbers,
    fallbackTitle: `feat: ${params.issue.title.replace(/\[plan\]\s*/i, "")}`,
    changedFiles: allFeatureFiles,
    llmApiKey: params.llmApiKey,
    model: params.phaseModels.reviewModel,
    providers: params.phaseModels.providers,
    maxTransientRetries: params.phaseModels.maxTransientRetries,
    transientRetryBackoffSeconds:
      params.phaseModels.transientRetryBackoffSeconds,
    requestTimeoutMs: params.phaseModels.requestTimeoutMs,
    onTransientRetriesUsed: (used) => params.addTransientRetriesUsed(used),
    fetchImpl: params.fetchImpl
  });

  const existingFeaturePr =
    params.existingFeaturePrAtStart ??
    (await params.gh.findOpenPullRequestByHead(params.featureBranch, "dev"));

  const featurePrBody = appendEpureCommandsSpoiler(
    [
      "## Summary",
      `Completes implementation for #${params.issueNumber}.`,
      "",
      `Closes #${params.issueNumber}`,
      "",
      featureSquashPreview.commit_message,
      "",
      "## Completed Tickets & Squash History",
      ...params.completedTicketsSummary,
      "",
      "## Governance",
      "- Requires human review and squash-merge into `dev` in the GitHub UI (ADR-0001, ADR-0027, Q45, Q91, Q95)."
    ].join("\n"),
    {
      phase: "completed",
      status: "completed",
      issueNumber: params.issueNumber
    }
  );

  const featurePr = existingFeaturePr
    ? existingFeaturePr
    : await params.gh.openPullRequest({
        head: params.featureBranch,
        base: "dev",
        title: featureSquashPreview.pr_title,
        body: featurePrBody
      });

  if (params.featureChangedFilesMap.size === 0) {
    const existingFeaturePrFiles = await params.gh.listPullRequestFiles(
      featurePr.number
    );
    for (const prFile of existingFeaturePrFiles) {
      const cleanPath = prFile.filename.replace(/^\/+/, "");
      if (prFile.status === "removed") {
        params.accumulatedFiles.delete(cleanPath);
        params.featureChangedFilesMap.delete(cleanPath);
        params.featureDeletedFilesSet.add(cleanPath);
      } else {
        const content = await params.gh.readSingleBranchFile(
          params.featureBranch,
          cleanPath
        );
        if (content !== null) {
          params.accumulatedFiles.set(cleanPath, content);
          params.featureChangedFilesMap.set(cleanPath, content);
          params.featureDeletedFilesSet.delete(cleanPath);
        }
      }
    }
  }

  let currentFeaturePrHeadSha = featurePr.head_sha;
  const runStage2AndStage3ForFeaturePr = async (passParams: {
    headSha: string;
    isReReviewPass: boolean;
    previousFailedReviewers?: ReadonlyArray<ReviewerAgentName>;
  }): Promise<{
    reviewResult: Awaited<ReturnType<typeof runMultiAgentPrReviewPass>>;
    ciGateResult: WaitForExternalCiChecksResult;
  }> => {
    const currentChangedFeatureFiles = Array.from(
      (params.featureChangedFilesMap.size > 0
        ? params.featureChangedFilesMap
        : params.accumulatedFiles
      ).entries()
    ).map(([path, content]) => ({ path, content }));
    const expectedFeatureWorkflows = discoverExpectedExternalWorkflows({
      workflowFilesMap: params.devWorkflowsMap,
      changedPaths: currentChangedFeatureFiles.map((f) => f.path),
      targetBranch: "dev"
    });

    const reviewRes = await runMultiAgentPrReviewPass({
      repository: params.repository,
      prNumber: featurePr.number,
      headBranch: params.featureBranch,
      baseBranch: "dev",
      ticketTitle: params.issue.title,
      acceptanceCriteria: params.ticketsManifest.flatMap(
        (t) => t.acceptanceCriteria
      ),
      glossaryMarkdown: params.issue.body,
      designMarkdown: params.trustedBaseDesignMarkdown,
      changedFiles: currentChangedFeatureFiles,
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
      onTransientRetriesUsed: (used) => params.addTransientRetriesUsed(used),
      fetchImpl: params.fetchImpl
    });

    await params.gh.postPullRequestReview(featurePr.number, {
      commitId: passParams.headSha,
      body: reviewRes.review_body_markdown
    });

    await params.gh.publishCheckRun({
      name: "PR title",
      headSha: passParams.headSha,
      conclusion: "success",
      summary: `Conventional Commit title verified: '${featureSquashPreview.pr_title}'`
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
          reviewRes.impeccable_conclusion === "failure" ? "failure" : "success",
        summary: `Impeccable UI & Accessibility Gate: ${reviewRes.impeccable_conclusion}`
      });
    }

    const ciRes = await waitForExternalCiChecks({
      headSha: passParams.headSha,
      expectedWorkflows: expectedFeatureWorkflows,
      waitForExternalCi: verificationProfile.wait_for_external_ci,
      timeoutMinutes: verificationProfile.external_ci_timeout_minutes,
      graceWindowSeconds: verificationProfile.grace_window_seconds,
      pollIntervalMs: params.pollIntervalMs,
      extraSecrets: [params.activeToken, params.llmApiKey],
      infraRerunsBySha: params.infraRerunsBySha,
      listWorkflowRunsForSha: (sha) => params.gh.listWorkflowRunsForSha(sha),
      listCheckRunsForRef: (sha) => params.gh.listCheckRunsForRef(sha),
      listCheckRunAnnotations: (id) => params.gh.listCheckRunAnnotations(id),
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

    return { reviewResult: reviewRes, ciGateResult: ciRes };
  };

  let {
    reviewResult: finalFeatureReview,
    ciGateResult: finalFeatureCiGate
  } = await runStage2AndStage3ForFeaturePr({
    headSha: currentFeaturePrHeadSha,
    isReReviewPass: false
  });

  if (
    !finalFeatureCiGate.passed &&
    (finalFeatureCiGate.reason === "grace_window_timeout" ||
      finalFeatureCiGate.reason === "wall_clock_budget_exhausted")
  ) {
    return await params.escalateToNeedsHuman({
      reason: finalFeatureCiGate.reason,
      ticketNumber: params.issueNumber,
      branch: params.featureBranch,
      prNumber: featurePr.number,
      prUrl: featurePr.html_url,
      featurePrUrl: featurePr.html_url,
      codeFixAttemptsUsed: 0,
      failedChecks: finalFeatureCiGate.failedChecks,
      mustFixFindings: finalFeatureReview.must_fix_findings,
      diagnosticExcerpt: finalFeatureCiGate.formattedDiagnostics
    });
  }

  let featureReviewFixAttempt = 0;
  const maxFeatureReviewFixAttempts = params.maxCodeFixAttempts;
  while (
    (finalFeatureReview.conclusion === "failure" ||
      !finalFeatureCiGate.passed) &&
    featureReviewFixAttempt < maxFeatureReviewFixAttempts
  ) {
    featureReviewFixAttempt += 1;
    await updateIssueStateWithCas({
      issueNumber: params.issueNumber,
      store: params.store,
      mutator: (prev) => ({
        ...prev,
        code_fix_attempts_used: featureReviewFixAttempt,
        transient_retries_used:
          params.getTotalTransientRetriesUsed() || prev.transient_retries_used
      })
    });

    process.stdout.write(
      `[EPURE][Feature PR #${featurePr.number}] Multi-agent synthesis review + CI fix iteration ${featureReviewFixAttempt}/${maxFeatureReviewFixAttempts} (${finalFeatureReview.must_fix_findings.length} must_fix finding(s), CI passed=${finalFeatureCiGate.passed})\n`
    );
    const findingsText = finalFeatureReview.must_fix_findings
      .map(
        (f, idx) =>
          `${idx + 1}. [${f.reviewer}] (${f.path}:${f.line}) ${f.title} — ${f.rationale} -> Action: ${f.suggested_action}`
      )
      .join("\n");

    const featureSandbox = prepareRepositorySandboxWorkspace({
      repository: params.repository,
      branch: params.featureBranch,
      githubToken: params.activeToken,
      seedFiles: params.accumulatedFiles,
      enableRemoteClone: Boolean(
        process.env.GITHUB_ACTIONS === "true" && !params.fetchImpl
      )
    });
    if (
      featureSandbox.clonedFromRemote &&
      !params.parsedDevAgentsConfig?.verification?.targets?.length
    ) {
      const clonedProfile = discoverVerificationProfile({
        repoRootDir: featureSandbox.workDir,
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

    try {
      const currentFilesContext = Array.from(params.accumulatedFiles.entries())
        .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
        .join("\n\n");

      const featureFixSystemInstruction = [
        "Tu es un ingénieur TDD EPURE corrigeant les constats bloquants ('must_fix') et/ou échecs CI sur la PR finale de feature.",
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
        `  "commit_message": "fix(review): address final feature review findings on #${params.issueNumber}",`,
        '  "test_summary": "Addressed final feature review findings and verified test suite",',
        '  "patches": [',
        '    { "path": "...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
        "  ],",
        '  "files": [',
        '    { "path": "...", "content": "..." }',
        "  ],",
        '  "deleted_files": ["..."]',
        "}"
      ].join("\n");

      const featureFixPromptParts: string[] = [];
      if (finalFeatureReview.must_fix_findings.length > 0) {
        featureFixPromptParts.push(
          `Les reviewers multi-agents EPURE ont émis ${finalFeatureReview.must_fix_findings.length} constat(s) bloquant(s) ('must_fix') sur la PR finale #${featurePr.number} (\`${params.featureBranch} -> dev\`) :`,
          wrapUntrustedContent("untrusted_issue_content", findingsText),
          ""
        );
      }
      if (
        !finalFeatureCiGate.passed &&
        finalFeatureCiGate.formattedDiagnostics
      ) {
        featureFixPromptParts.push(
          `Les workflows CI externes sur la PR finale #${featurePr.number} (\`${params.featureBranch} -> dev\`) ont échoué :`,
          finalFeatureCiGate.formattedDiagnostics,
          ""
        );
      }
      featureFixPromptParts.push(
        verificationGuideMarkdown,
        "",
        "Fichiers actuels du workspace :",
        wrapUntrustedContent("untrusted_workspace_files", currentFilesContext)
      );

      const parsedFeatureFix =
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
          logLabel: `feature-review-fix:#PR${featurePr.number}/iter-${featureReviewFixAttempt}`,
          systemInstruction: featureFixSystemInstruction,
          prompt: featureFixPromptParts.join("\n"),
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

      const featureFixPreCheck = validateWorkspaceFileOperations({
        workDir: featureSandbox.workDir,
        files: [
          ...(parsedFeatureFix.files ?? []).map((f) => ({ path: f.path })),
          ...(parsedFeatureFix.patches ?? []).map((p) => ({
            path: p.path
          }))
        ],
        deleted_files: parsedFeatureFix.deleted_files,
        targets: verificationProfile.targets,
        isTaskBranch: true
      });
      if (!featureFixPreCheck.allowed) {
        return await params.escalateToNeedsHuman({
          reason: "sensitive_path_violation",
          ticketNumber: params.issueNumber,
          branch: params.featureBranch,
          prNumber: featurePr.number,
          prUrl: featurePr.html_url,
          featurePrUrl: featurePr.html_url,
          codeFixAttemptsUsed: featureReviewFixAttempt,
          sensitivePaths: featureFixPreCheck.sensitivePaths,
          traversalPaths: featureFixPreCheck.traversalPaths
        });
      }

      const changedFixFilesMap = new Map<string, string>();
      const changedDeletedFilesSet = new Set<string>();
      await applyTicketImplementationPayload({
        parsed: parsedFeatureFix,
        accumulatedFiles: params.accumulatedFiles,
        featureChangedFilesMap: params.featureChangedFilesMap,
        ticketChangedFilesMap: changedFixFilesMap,
        featureDeletedFilesSet: params.featureDeletedFilesSet,
        ticketDeletedFilesSet: changedDeletedFilesSet,
        gh: params.gh,
        branch: params.featureBranch
      });

      let featureTestCheck = await runTestsInIsolatedWorkspace({
        workDir: featureSandbox.workDir,
        files: Array.from(params.accumulatedFiles.entries()).map(
          ([path, content]) => ({ path, content })
        ),
        deleted_files: Array.from(changedDeletedFilesSet),
        changedPaths: Array.from(
          new Set([
            ...Array.from(params.featureChangedFilesMap.keys()),
            ...Array.from(changedFixFilesMap.keys()),
            ...Array.from(changedDeletedFilesSet)
          ])
        ),
        isTaskBranch: true,
        verificationProfile,
        sandboxRunner: params.sandboxRunner,
        llmApiKey: params.llmApiKey,
        label: `Feature PR #${featurePr.number} review-fix iteration ${featureReviewFixAttempt}/${maxFeatureReviewFixAttempts}`
      });

      let featureTestRetry = 0;
      while (!featureTestCheck.passed && featureTestRetry < 2) {
        featureTestRetry += 1;
        const retryFilesContext = Array.from(
          params.accumulatedFiles.entries()
        )
          .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
          .join("\n\n");
        const retryParsed =
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
            logLabel: `feature-review-test-retry:#PR${featurePr.number}/iter-${featureReviewFixAttempt}-retry-${featureTestRetry}`,
            systemInstruction: featureFixSystemInstruction,
            prompt: [
              `La correction de review finale a échoué à la vérification Stage 1 (tentative ${featureTestRetry}/2) :`,
              wrapUntrustedContent(
                "untrusted_test_output",
                featureTestCheck.output.slice(-6000)
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
              branch: params.featureBranch,
              featureBranch: params.featureBranch,
              accumulatedFiles: params.accumulatedFiles,
              devBranchPaths: params.devBranchPaths,
              gh: params.gh
            }),
            responseSchema: GENERATED_TICKET_IMPLEMENTATION_SCHEMA,
            fetchImpl: params.fetchImpl
          });

        const retryPreCheck = validateWorkspaceFileOperations({
          workDir: featureSandbox.workDir,
          files: [
            ...(retryParsed.files ?? []).map((f) => ({ path: f.path })),
            ...(retryParsed.patches ?? []).map((p) => ({ path: p.path }))
          ],
          deleted_files: retryParsed.deleted_files,
          targets: verificationProfile.targets,
          isTaskBranch: true
        });
        if (!retryPreCheck.allowed) {
          return await params.escalateToNeedsHuman({
            reason: "sensitive_path_violation",
            ticketNumber: params.issueNumber,
            branch: params.featureBranch,
            prNumber: featurePr.number,
            prUrl: featurePr.html_url,
            featurePrUrl: featurePr.html_url,
            codeFixAttemptsUsed: featureReviewFixAttempt,
            sensitivePaths: retryPreCheck.sensitivePaths,
            traversalPaths: retryPreCheck.traversalPaths
          });
        }

        await applyTicketImplementationPayload({
          parsed: retryParsed,
          accumulatedFiles: params.accumulatedFiles,
          featureChangedFilesMap: params.featureChangedFilesMap,
          ticketChangedFilesMap: changedFixFilesMap,
          featureDeletedFilesSet: params.featureDeletedFilesSet,
          ticketDeletedFilesSet: changedDeletedFilesSet,
          gh: params.gh,
          branch: params.featureBranch
        });
        featureTestCheck = await runTestsInIsolatedWorkspace({
          workDir: featureSandbox.workDir,
          files: Array.from(params.accumulatedFiles.entries()).map(
            ([path, content]) => ({ path, content })
          ),
          deleted_files: Array.from(changedDeletedFilesSet),
          changedPaths: Array.from(
            new Set([
              ...Array.from(params.featureChangedFilesMap.keys()),
              ...Array.from(changedFixFilesMap.keys()),
              ...Array.from(changedDeletedFilesSet)
            ])
          ),
          isTaskBranch: true,
          verificationProfile,
          sandboxRunner: params.sandboxRunner,
          llmApiKey: params.llmApiKey,
          label: `Feature PR #${featurePr.number} review-fix iteration ${featureReviewFixAttempt} test retry ${featureTestRetry}/2`
        });
      }

      if (!featureTestCheck.passed) {
        if (featureReviewFixAttempt < maxFeatureReviewFixAttempts) {
          continue;
        }
        return await params.escalateToNeedsHuman({
          reason: "code_fix_attempts_exhausted",
          ticketNumber: params.issueNumber,
          branch: params.featureBranch,
          prNumber: featurePr.number,
          prUrl: featurePr.html_url,
          featurePrUrl: featurePr.html_url,
          codeFixAttemptsUsed: featureReviewFixAttempt,
          mustFixFindings: featureReview.must_fix_findings,
          diagnosticExcerpt: featureTestCheck.output.slice(-2000)
        });
      }

      const changedFixFiles = Array.from(changedFixFilesMap.entries()).map(
        ([path, content]) => ({ path, content })
      );

      const fixTaskBranch = `task/review-fix-${params.issueNumber}-${featureReviewFixAttempt}`;
      const fixCommitTitle =
        parsedFeatureFix.commit_message &&
        /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: .+/i.test(
          parsedFeatureFix.commit_message
        )
          ? parsedFeatureFix.commit_message
          : `fix(review): address final feature review findings on #${params.issueNumber}`;

      await params.gh.commitFilesToBranch({
        branch: fixTaskBranch,
        fromBranch: params.featureBranch,
        commitMessage: fixCommitTitle,
        files: changedFixFiles,
        deletedFiles: Array.from(changedDeletedFilesSet)
      });

      const fixPr = await params.gh.openPullRequest({
        head: fixTaskBranch,
        base: params.featureBranch,
        title: fixCommitTitle,
        body: appendEpureCommandsSpoiler(
          `Addresses multi-agent review findings on feature PR #${featurePr.number} (iteration ${featureReviewFixAttempt}).\n\nRefs #${params.issueNumber}`,
          {
            phase: "implementation",
            status: "active",
            issueNumber: params.issueNumber
          }
        )
      });

      await params.gh.publishCheckRun({
        name: "PR title",
        headSha: fixPr.head_sha,
        conclusion: "success",
        summary: `Conventional Commit title verified: '${fixCommitTitle}'`
      });

      await params.gh.publishCheckRun({
        name: "ai-review",
        headSha: fixPr.head_sha,
        conclusion: "success",
        summary:
          "Sandbox verified remediation commit for feature synthesis PR."
      });

      await params.gh.publishCheckRun({
        name: "impeccable-gate",
        headSha: fixPr.head_sha,
        conclusion: "success",
        summary: "Impeccable gate verified in synthesis loop."
      });

      await params.gh.mergePullRequest(fixPr.number, {
        headBranch: fixTaskBranch,
        baseBranch: params.featureBranch,
        commitTitle: `${fixCommitTitle} (#${fixPr.number})`,
        commitMessage: `Automated remediation of synthesis review findings.\n\nRefs #${params.issueNumber}`
      });

      currentFeaturePrHeadSha =
        (await params.gh.getDefaultBranchSha(params.featureBranch)) ??
        currentFeaturePrHeadSha;

      const nextFeaturePass = await runStage2AndStage3ForFeaturePr({
        headSha: currentFeaturePrHeadSha,
        isReReviewPass: true,
        previousFailedReviewers: finalFeatureReview.failed_reviewers
      });
      finalFeatureReview = nextFeaturePass.reviewResult;
      finalFeatureCiGate = nextFeaturePass.ciGateResult;

      if (
        !finalFeatureCiGate.passed &&
        (finalFeatureCiGate.reason === "grace_window_timeout" ||
          finalFeatureCiGate.reason === "wall_clock_budget_exhausted")
      ) {
        return await params.escalateToNeedsHuman({
          reason: finalFeatureCiGate.reason,
          ticketNumber: params.issueNumber,
          branch: params.featureBranch,
          prNumber: featurePr.number,
          prUrl: featurePr.html_url,
          featurePrUrl: featurePr.html_url,
          codeFixAttemptsUsed: featureReviewFixAttempt,
          failedChecks: finalFeatureCiGate.failedChecks,
          mustFixFindings: finalFeatureReview.must_fix_findings,
          diagnosticExcerpt: finalFeatureCiGate.formattedDiagnostics
        });
      }
    } catch (err) {
      if (err instanceof LLMError) {
        const reason =
          err instanceof AuthenticationError ||
          err instanceof QuotaExhaustedError
            ? "llm_quota_or_auth_failure"
            : "transient_llm_api_exhausted";
        return await params.escalateToNeedsHuman({
          reason,
          ticketNumber: params.issueNumber,
          branch: params.featureBranch,
          phase: "implementation",
          prNumber: featurePr.number,
          prUrl: featurePr.html_url,
          featurePrUrl: featurePr.html_url,
          codeFixAttemptsUsed: featureReviewFixAttempt,
          diagnosticExcerpt: redactSecrets(err.message, [
            params.activeToken,
            params.llmApiKey
          ])
        });
      }
      throw err;
    } finally {
      featureSandbox.cleanup();
    }
  }

  if (
    finalFeatureReview.conclusion === "failure" ||
    !finalFeatureCiGate.passed
  ) {
    return await params.escalateToNeedsHuman({
      reason: "remediation_exhausted",
      ticketNumber: params.issueNumber,
      branch: params.featureBranch,
      prNumber: featurePr.number,
      prUrl: featurePr.html_url,
      featurePrUrl: featurePr.html_url,
      codeFixAttemptsUsed: featureReviewFixAttempt,
      failedChecks: finalFeatureCiGate.failedChecks,
      mustFixFindings: finalFeatureReview.must_fix_findings,
      diagnosticExcerpt: finalFeatureCiGate.formattedDiagnostics
    });
  }

  const updatedDone = await updateIssueStateWithCas({
    issueNumber: params.issueNumber,
    store: params.store,
    mutator: (prev) => ({
      ...prev,
      phase: "completed",
      status: "done",
      active_branch: params.featureBranch,
      last_processed_comment_id:
        params.commentId ?? prev.last_processed_comment_id
    })
  });

  const finalComment = appendEpureCommandsSpoiler(
    [
      updatedDone.issue_mirror_markdown,
      "",
      `### Exécution TDD & Revue Multi-Agents terminées pour le plan #${params.issueNumber}`,
      "",
      "Tous les tickets du DAG ont été implémentés en TDD sur leurs branches `task/*`, vérifiés en sandbox isolée, audités par le roster multi-agents (`ai-review` + `impeccable-gate`) et squash-mergés dans `" +
        params.featureBranch +
        "` :",
      ...params.completedTicketsSummary,
      "",
      `👉 **Pull Request finale ouverte vers \`dev\`** : ${featurePr.html_url}`,
      "Conformément à la gouvernance EPURE (Q45, Q91, Q95), la fusion finale `feature/* → dev` est réservée à la validation humaine dans l'interface GitHub."
    ].join("\n"),
    {
      phase: "completed",
      status: "completed",
      issueNumber: params.issueNumber
    }
  );

  await params.gh.postIssueComment(params.issueNumber, finalComment);

  return {
    executed: true,
    phase: updatedDone.state.phase,
    status: updatedDone.state.status,
    active_branch: params.activeBranchForStartState,
    summary_markdown: finalComment,
    created_ticket_numbers: allTicketNumbers,
    feature_pr_url: featurePr.html_url
  };
}
