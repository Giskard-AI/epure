import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEngine, AgentSessionRequest } from "../src/agent/engine.js";
import {
  reconcileAdrsWithLlm,
  runEpicConvergenceAudit,
  runFeatureIntegrationPhase
} from "../src/orchestrator/phases/feature-integration.js";
import { syncBranchWithBase, type BaseSyncGuard } from "../src/orchestrator/github/branch-sync.js";
import type { GitHubRestHelper, ResolvedPhaseModels } from "../src/orchestrator/types.js";
import {
  MAX_CONCURRENT_REVIEWERS,
  runMultiAgentPrReviewPass
} from "../src/review/multi-agent-pr-review.js";
import {
  createInMemoryGitRefStateStore
} from "../src/state/git-ref-state.js";

const TEST_PHASE_MODELS: ResolvedPhaseModels = {
  planningModel: "anthropic/claude-sonnet-4-5",
  implementationModel: "anthropic/claude-sonnet-4-5",
  reviewModel: "openai/gpt-4.1",
  maxTransientRetries: 0,
  transientRetryBackoffSeconds: [0]
};

describe("Slice 3a-2 — Pi agentEngine wiring for feature integration, reviewers, convergence audit and ADR reconciliation (#99)", () => {
  it.each([
    {
      id: "runs read-only reviewers via agentEngine with max 4 concurrency and parses JSON findings",
      changedFiles: [
        { path: "src/components/App.tsx", content: "export const App = () => <div />;\n" },
        { path: "src/domain/service.ts", content: "export const calc = (x: number) => x + 1;\n" },
        { path: "Dockerfile", content: "FROM node:22-alpine\n" }
      ],
      finalMessageForCallIndex: (callIndex: number) =>
        callIndex === 0
          ? JSON.stringify({
              summary: "Found 1 must_fix issue.",
              findings: [
                {
                  category: "must_fix",
                  severity: "high",
                  path: "src/domain/service.ts",
                  line: 1,
                  title: "Missing input bounds check",
                  rationale: "Unbounded numeric input.",
                  suggested_action: "Clamp input."
                }
              ]
            })
          : JSON.stringify({
              summary: `Reviewer ${callIndex} LGTM`,
              findings: []
            }),
      expectedConclusion: "failure" as const,
      expectedMustFixCount: 1,
      expectFallbackFetchCalled: false
    },
    {
      id: "falls back cleanly to structured LLM output when agentEngine returns non-JSON finalMessage",
      changedFiles: [{ path: "src/domain/math.ts", content: "export const add = (a: number, b: number) => a + b;\n" }],
      finalMessageForCallIndex: () => "Non-JSON plain text review output",
      expectedConclusion: "success" as const,
      expectedMustFixCount: 0,
      expectFallbackFetchCalled: true
    }
  ])(
    "$id",
    async ({
      changedFiles,
      finalMessageForCallIndex,
      expectedConclusion,
      expectedMustFixCount,
      expectFallbackFetchCalled
    }) => {
      let activeCount = 0;
      let peakConcurrency = 0;
      const seenRequests: AgentSessionRequest[] = [];
      let fallbackFetchCount = 0;

      const engine: AgentEngine = {
        name: "pi",
        run: async (req) => {
          const callIndex = seenRequests.length;
          seenRequests.push(req);
          activeCount += 1;
          peakConcurrency = Math.max(peakConcurrency, activeCount);
          expect(existsSync(req.worktree)).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 15));
          activeCount -= 1;
          return {
            finalMessage: finalMessageForCallIndex(callIndex),
            diff: { files: [], deleted_files: [], skipped: [] }
          };
        }
      };

      const fetchImpl: typeof fetch = async () => {
        fallbackFetchCount += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Fallback structured output LGTM",
                    findings: []
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const res = await runMultiAgentPrReviewPass({
        repository: "Giskard-AI/epure",
        prNumber: 42,
        headBranch: "feature/42-demo",
        baseBranch: "dev",
        ticketTitle: "Demo feature",
        acceptanceCriteria: ["Must compute accurately"],
        changedFiles,
        llmApiKey: "test-key",
        model: "openai/gpt-4.1",
        fetchImpl,
        agentEngine: engine
      });

      expect(seenRequests.length).toBe(res.selected_reviewers.length);
      expect(seenRequests.every((r) => r.role === "reviewer" && r.toolPolicy === "read_only")).toBe(true);
      expect(peakConcurrency).toBeLessThanOrEqual(MAX_CONCURRENT_REVIEWERS);
      if (res.selected_reviewers.length > MAX_CONCURRENT_REVIEWERS) {
        expect(peakConcurrency).toBe(MAX_CONCURRENT_REVIEWERS);
      }
      expect(res.conclusion).toBe(expectedConclusion);
      expect(res.must_fix_findings).toHaveLength(expectedMustFixCount);
      expect(fallbackFetchCount > 0).toBe(expectFallbackFetchCalled);
    }
  );

  it.each([
    {
      id: "convergence_auditor parses CONVERGED verdict from Pi agentEngine read_only session",
      agentFinalMessage: JSON.stringify({
        verdict: "CONVERGED",
        rationale: "All entrypoints wired in src/index.ts.",
        unwired_modules: [],
        stub_violations: [],
        unmet_criteria: [],
        remediation_tickets: []
      }),
      expectedVerdict: "CONVERGED" as const,
      expectFallback: false
    },
    {
      id: "convergence_auditor falls back to callLlmJson when agentEngine returns non-JSON text",
      agentFinalMessage: "I inspected the worktree and found everything wired.",
      expectedVerdict: "INCOMPLETE" as const,
      expectFallback: true
    }
  ])("$id", async ({ agentFinalMessage, expectedVerdict, expectFallback }) => {
    const seenRequests: AgentSessionRequest[] = [];
    let sawEntrypointInWorktree = false;
    let fallbackCalled = false;

    const engine: AgentEngine = {
      name: "pi",
      run: async (req) => {
        seenRequests.push(req);
        const epPath = join(req.worktree, "src/index.ts");
        sawEntrypointInWorktree =
          existsSync(epPath) && readFileSync(epPath, "utf8").includes("bootstrapApp");
        return {
          finalMessage: agentFinalMessage,
          diff: { files: [], deleted_files: [], skipped: [] }
        };
      }
    };

    const fetchImpl: typeof fetch = async () => {
      fallbackCalled = true;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "INCOMPLETE",
                  rationale: "Missing CLI wiring.",
                  unwired_modules: ["src/cli.ts"],
                  stub_violations: [],
                  unmet_criteria: ["Wire CLI entrypoint"],
                  remediation_tickets: []
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const audit = await runEpicConvergenceAudit({
      issueNumber: 99,
      featureBranch: "feature/99-pi-phases",
      specPath: "docs/specs/99-pi-phases.md",
      specMarkdown: "# Spec 99\n",
      glossaryMarkdown: "# Glossary\n",
      epicGoalContract: {
        epic_goal_summary: "Wire Pi phases",
        required_entrypoints: ["src/index.ts"],
        forbidden_stubs: [],
        end_to_end_verification_criteria: ["All phases run through AgentEngine"]
      },
      accumulatedFiles: new Map([["src/index.ts", "export function bootstrapApp() {}\n"]]),
      featureChangedFilesMap: new Map([["src/index.ts", "export function bootstrapApp() {}\n"]]),
      devBranchPaths: ["src/index.ts"],
      gh: {
        readSingleBranchFile: async () => "export function bootstrapApp() {}\n",
        listBranchPathHints: async () => ["src/index.ts"]
      },
      llmApiKey: "test-key",
      phaseModels: TEST_PHASE_MODELS,
      fetchImpl,
      agentEngine: engine
    });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.role).toBe("convergence_auditor");
    expect(seenRequests[0]?.toolPolicy).toBe("read_only");
    expect(sawEntrypointInWorktree).toBe(true);
    expect(audit.verdict).toBe(expectedVerdict);
    expect(fallbackCalled).toBe(expectFallback);
  });

  it.each([
    {
      id: "adr_reconciler commits updated docs/adr/** and GLOSSARY.md edits and deleted ADRs via syncBranchWithBase",
      mutateInWorktree: true
    },
    {
      id: "adr_reconciler applies diff returned directly in session.diff",
      mutateInWorktree: false
    }
  ])("$id", async ({ mutateInWorktree }) => {
    const seenRequests: AgentSessionRequest[] = [];
    const committedPayloads: Array<{
      branch: string;
      commitMessage: string;
      files: ReadonlyArray<{ path: string; content: string }>;
      deletedFiles?: readonly string[] | undefined;
    }> = [];

    const engine: AgentEngine = {
      name: "pi",
      run: async (req) => {
        seenRequests.push(req);
        if (mutateInWorktree) {
          writeFileSync(
            join(req.worktree, "docs/adr/0002-feature-decision.md"),
            "# ADR-0002: Reconciled Feature Decision\nRefs ADR-0001.\n",
            "utf8"
          );
          writeFileSync(
            join(req.worktree, "GLOSSARY.md"),
            "# Glossary\n- **Terme** : Définition (ADR-0002).\n",
            "utf8"
          );
          if (existsSync(join(req.worktree, "docs/adr/0001-duplicate.md"))) {
            unlinkSync(join(req.worktree, "docs/adr/0001-duplicate.md"));
          }
          return {
            finalMessage: "Reconciled ADR-0002 and GLOSSARY.md.",
            diff: { files: [], deleted_files: [], skipped: [] }
          };
        }
        return {
          finalMessage: "Reconciled ADR-0002 and GLOSSARY.md.",
          diff: {
            files: [
              {
                path: "docs/adr/0002-feature-decision.md",
                content: "# ADR-0002: Reconciled Feature Decision\nRefs ADR-0001.\n",
                mode: "100644"
              },
              {
                path: "GLOSSARY.md",
                content: "# Glossary\n- **Terme** : Définition (ADR-0002).\n",
                mode: "100644"
              }
            ],
            deleted_files: ["docs/adr/0001-duplicate.md"],
            skipped: []
          }
        };
      }
    };

    const directResult = await reconcileAdrsWithLlm({
      devAdrs: [{ path: "docs/adr/0001-dev-decision.md", content: "# ADR-0001: Dev\n" }],
      featureAdrs: [
        { path: "docs/adr/0001-duplicate.md", content: "# ADR-0001: Duplicate\n" },
        { path: "docs/adr/0002-feature-decision.md", content: "# ADR-0002: Feature\n" }
      ],
      specFiles: [{ path: "docs/specs/99-pi.md", content: "# Spec\n" }],
      glossaryContent: "# Glossary\n",
      model: "anthropic/claude-sonnet-4-5",
      agentEngine: engine
    });

    expect(directResult).not.toBeNull();
    expect(directResult?.updated_files).toEqual(
      expect.arrayContaining([
        {
          path: "docs/adr/0002-feature-decision.md",
          content: "# ADR-0002: Reconciled Feature Decision\nRefs ADR-0001.\n"
        },
        {
          path: "GLOSSARY.md",
          content: "# Glossary\n- **Terme** : Définition (ADR-0002).\n"
        }
      ])
    );
    expect(directResult?.deleted_adr_paths).toContain("docs/adr/0001-duplicate.md");

    const branchFiles: Record<string, string> = {
      "dev:docs/adr/0001-dev-decision.md": "# ADR-0001: Dev Decision\n",
      "feature/99-pi:docs/adr/0002-feature-decision.md": "# ADR-0002: Feature Decision\n",
      "feature/99-pi:docs/specs/99-pi.md": "# Spec 99\n",
      "feature/99-pi:GLOSSARY.md": "# Glossary\n"
    };

    const syncRes = await syncBranchWithBase({
      gh: {
        token: "ghs_test",
        mergeBranches: async () => ({ status: "merged", sha: "merged-sha-1" }),
        getDefaultBranchSha: async () => "merged-sha-1",
        listDirectoryPaths: async (branch: string, dir: string) => {
          if (dir === "docs/adr") {
            return branch === "dev"
              ? ["docs/adr/0001-dev-decision.md"]
              : [
                  "docs/adr/0001-dev-decision.md",
                  "docs/adr/0002-feature-decision.md"
                ];
          }
          if (dir === "docs/specs") {
            return ["docs/specs/99-pi.md"];
          }
          return [];
        },
        readSingleBranchFile: async (branch: string, path: string) =>
          branchFiles[`${branch}:${path}`] ?? branchFiles[`feature/99-pi:${path}`] ?? null,
        commitFilesToBranch: async (payload: {
          branch: string;
          commitMessage: string;
          files: ReadonlyArray<{ path: string; content: string }>;
          deletedFiles?: readonly string[] | undefined;
        }) => {
          committedPayloads.push(payload);
          return "reconciled-sha-2";
        }
      } as unknown as GitHubRestHelper,
      targetBranch: "feature/99-pi",
      baseBranch: "dev",
      issueNumber: 99,
      model: "anthropic/claude-sonnet-4-5",
      agentEngine: engine
    });

    expect(seenRequests.every((r) => r.role === "adr_reconciler" && r.toolPolicy === "write")).toBe(true);
    expect(syncRes.headSha).toBe("reconciled-sha-2");
    expect(committedPayloads).toHaveLength(1);
    expect(committedPayloads[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/adr/0002-feature-decision.md" }),
        expect.objectContaining({ path: "GLOSSARY.md" })
      ])
    );
  });

  it("runs feature-level PR remediation (fixer) and read-only reviewers via Pi agentEngine and commits diff to feature branch", async () => {
    const seenRoles: Array<{ role: string; toolPolicy: string }> = [];
    const committedBranches: Array<{
      branch: string;
      fromBranch?: string | undefined;
      files: ReadonlyArray<{ path: string; content: string; mode?: string | undefined }>;
    }> = [];
    let reviewCallRound = 0;

    const engine: AgentEngine = {
      name: "pi",
      run: async (req) => {
        seenRoles.push({ role: req.role, toolPolicy: req.toolPolicy });
        if (req.role === "reviewer") {
          reviewCallRound += 1;
          const failFirstPass = reviewCallRound === 1;
          return {
            finalMessage: JSON.stringify({
              summary: failFirstPass ? "Must fix bug in src/feature.ts" : "All good now",
              findings: failFirstPass
                ? [
                    {
                      category: "must_fix",
                      severity: "high",
                      path: "src/feature.ts",
                      line: 1,
                      title: "Return 42 instead of 0",
                      rationale: "Spec requires 42.",
                      suggested_action: "Return 42."
                    }
                  ]
                : []
            }),
            diff: { files: [], deleted_files: [], skipped: [] }
          };
        }
        if (req.role === "fixer") {
          writeFileSync(join(req.worktree, "src/feature.ts"), "export const answer = () => 42;\n", "utf8");
          return {
            finalMessage: "Updated src/feature.ts to return 42.",
            diff: {
              files: [
                {
                  path: "src/feature.ts",
                  content: "export const answer = () => 42;\n",
                  mode: "100644"
                }
              ],
              deleted_files: [],
              skipped: []
            }
          };
        }
        return {
          finalMessage: "ok",
          diff: { files: [], deleted_files: [], skipped: [] }
        };
      }
    };

    const store = createInMemoryGitRefStateStore();

    const baseSyncGuard: BaseSyncGuard = {
      needsSync: async () => false,
      markSynced: async () => {}
    };

    const result = await runFeatureIntegrationPhase({
      repository: "Giskard-AI/epure",
      issueNumber: 99,
      commentId: 10,
      activeToken: "ghs_test_token_value",
      issue: {
        number: 99,
        title: "[Plan] Pi Phases",
        body: "# Glossary\n",
        state: "open",
        user: { login: "maintainer" }
      },
      planSlug: "99-pi",
      featureBranch: "feature/99-pi",
      activeBranchForStartState: "feature/99-pi",
      ticketsManifest: [
        {
          ticketIssueNumber: 101,
          slug: "slice-1",
          title: "Implement answer",
          description: "Desc",
          acceptanceCriteria: ["answer() returns 42"],
          blockedByIssueNumbers: [],
          filesToTouch: ["src/feature.ts"]
        }
      ],
      existingFeaturePrAtStart: {
        number: 200,
        html_url: "https://github.com/Giskard-AI/epure/pull/200",
        head_sha: "feat-sha-1",
        title: "feat: Pi Phases",
        body: "Body"
      },
      accumulatedFiles: new Map([["src/feature.ts", "export const answer = () => 0;\n"]]),
      featureChangedFilesMap: new Map([["src/feature.ts", "export const answer = () => 0;\n"]]),
      featureDeletedFilesSet: new Set(),
      completedTicketsSummary: ["- #101: Implemented answer"],
      devBranchPaths: ["src/feature.ts"],
      devWorkflowsMap: new Map(),
      trustedBaseFilesMap: new Map(),
      trustedBaseDesignMarkdown: undefined,
      parsedDevAgentsConfig: null,
      initialVerificationProfile: {
        targets: [],
        wait_for_external_ci: false,
        external_ci_timeout_minutes: 5,
        grace_window_seconds: 5
      },
      initialVerificationGuideMarkdown: "No targets",
      maxCodeFixAttempts: 2,
      infraRerunsBySha: new Map(),
      getTotalTransientRetriesUsed: () => 0,
      addTransientRetriesUsed: () => {},
      escalateToNeedsHuman: async (esc) => ({
        action: "escalated",
        reason: esc.reason,
        issue_number: 99
      }) as never,
      gh: {
        token: "ghs_test_token_value",
        getPullRequestMergeableState: async () => "clean",
        findOpenPullRequestByHead: async () => null,
        updatePullRequest: async () => {},
        postPullRequestReview: async () => {},
        publishCheckRun: async () => {},
        listWorkflowRunsForRef: async () => [],
        listCheckRunsForRef: async () => [],
        commitFilesToBranch: async (payload: {
          branch: string;
          fromBranch?: string | undefined;
          files: ReadonlyArray<{ path: string; content: string; mode?: string | undefined }>;
        }) => {
          committedBranches.push(payload);
          return "fix-sha-1";
        },
        openPullRequest: async () => ({
          number: 201,
          html_url: "https://github.com/Giskard-AI/epure/pull/201",
          head_sha: "fix-sha-1",
          title: "fix(review): address final feature review findings on #99",
          body: ""
        }),
        mergePullRequest: async () => {},
        getDefaultBranchSha: async () => "feat-sha-2",
        postIssueComment: async () => ({ id: 999 })
      } as unknown as GitHubRestHelper,
      store,
      llmApiKey: "",
      phaseModels: TEST_PHASE_MODELS,
      initialFeatureCodeFixAttemptsUsed: 0,
      baseSyncGuard,
      stopIfFeaturePrMerged: async () => null,
      agentEngine: engine
    });

    expect(result.status).toBe("done");
    expect(seenRoles.some((r) => r.role === "reviewer" && r.toolPolicy === "read_only")).toBe(true);
    expect(seenRoles.some((r) => r.role === "fixer" && r.toolPolicy === "write")).toBe(true);
    expect(committedBranches).toHaveLength(1);
    expect(committedBranches[0]?.branch).toBe("task/review-fix-99-1");
    expect(committedBranches[0]?.fromBranch).toBe("feature/99-pi");
    expect(committedBranches[0]?.files).toEqual([
      {
        path: "src/feature.ts",
        content: "export const answer = () => 42;\n",
        mode: "100644"
      }
    ]);
  });
});
