import { describe, expect, it } from "vitest";
import { parseEpureCommand } from "../src/auth/issue-command-gate.js";
import { evaluateSingleExternalCiSnapshot } from "../src/execution/external-ci-gate.js";
import {
  integratePlanBranchIntoFeature,
  mergeGlossaryMarkdownAdditively,
  renumberCollidingAdrs,
  syncBranchWithBase
} from "../src/orchestrator/github/branch-sync.js";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import type { GitHubRestHelper } from "../src/orchestrator/types.js";
import {
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas
} from "../src/state/git-ref-state.js";
import { createGitHubMockRouter, json, notFound } from "./fixtures/github-mock-router.js";

describe("EPURE v1.2 Chantier 1 & 2 — Git Sync, Concurrency & Event-Driven CI Continuation", () => {
  describe("parseEpureCommand for /epure sync, /epure rebase, and /epure continue", () => {
    it.each([
      {
        id: "parses /epure sync command",
        body: "/epure sync",
        expectedCommand: "sync"
      },
      {
        id: "normalizes /epure rebase alias to sync command",
        body: "/epure rebase",
        expectedCommand: "sync"
      },
      {
        id: "parses /epure continue command",
        body: "/epure continue",
        expectedCommand: "continue"
      }
    ])("$id", ({ body, expectedCommand }) => {
      const parsed = parseEpureCommand(body);
      expect(parsed?.command).toBe(expectedCommand);
    });
  });

  describe("mergeGlossaryMarkdownAdditively", () => {
    it.each([
      {
        id: "preserves concurrent terms from dev while updating modified terms and appending new terms from plan",
        devGlossary: [
          "# GLOSSARY",
          "",
          "Canonical domain terms.",
          "",
          "## Terme Alpha",
          "Définition initiale sur dev.",
          "",
          "## Terme Concurrent Dev",
          "Ajouté par une autre feature fusionnée sur dev pendant le plan."
        ].join("\n"),
        planGlossary: [
          "# GLOSSARY",
          "",
          "Canonical domain terms.",
          "",
          "## Terme Alpha",
          "Définition enrichie dans la branche de plan.",
          "",
          "## Nouveau Terme Plan",
          "Introduit par la nouvelle spécification."
        ].join("\n"),
        expectedSubstrings: [
          "## Terme Alpha\nDéfinition enrichie dans la branche de plan.",
          "## Terme Concurrent Dev\nAjouté par une autre feature fusionnée sur dev pendant le plan.",
          "## Nouveau Terme Plan\nIntroduit par la nouvelle spécification."
        ]
      },
      {
        id: "returns plan glossary when dev glossary is empty",
        devGlossary: null,
        planGlossary: "# GLOSSARY\n\n## Terme Unique\nDéfinition unique.\n",
        expectedSubstrings: ["## Terme Unique", "Définition unique."]
      },
      {
        id: "preserves literal dollar replacement patterns ($&, $') and ignores # inside fenced code blocks",
        devGlossary: [
          "# GLOSSARY",
          "",
          "## Terme Regex",
          "Ancienne définition."
        ].join("\n"),
        planGlossary: [
          "# GLOSSARY",
          "",
          "## Terme Regex",
          "Définition contenant `$&` et `$'` :",
          "```bash",
          "# Commentaire bash qui ne doit pas couper la section",
          "echo $&",
          "```"
        ].join("\n"),
        expectedSubstrings: [
          "Définition contenant `$&` et `$'` :",
          "# Commentaire bash qui ne doit pas couper la section",
          "echo $&"
        ]
      }
    ])("$id", ({ devGlossary, planGlossary, expectedSubstrings }) => {
      const merged = mergeGlossaryMarkdownAdditively(devGlossary, planGlossary);
      for (const expected of expectedSubstrings) {
        expect(merged).toContain(expected);
      }
    });
  });

  describe("renumberCollidingAdrs", () => {
    it.each([
      {
        id: "renumbers colliding ADR 0031 to 0032 when 0031-other.md already exists on dev and updates spec references",
        devPaths: [
          "docs/adr/0030-base.md",
          "docs/adr/0031-concurrent-feature.md"
        ],
        planAdrs: [
          {
            path: "docs/adr/0031-my-new-decision.md",
            content: "# ADR-0031 : My New Decision\n\nRéférence ADR-0031."
          }
        ],
        specFiles: [
          {
            path: "docs/specs/my-feature.md",
            content:
              "Voir `docs/adr/0031-my-new-decision.md` (ADR-0031) pour les détails."
          }
        ],
        expectedAdrPath: "docs/adr/0032-my-new-decision.md",
        expectedAdrSnippet: "# ADR-0032 : My New Decision",
        expectedSpecSnippet: "docs/adr/0032-my-new-decision.md"
      },
      {
        id: "keeps ADR number unchanged when no collision exists on dev",
        devPaths: ["docs/adr/0030-base.md"],
        planAdrs: [
          {
            path: "docs/adr/0031-clean-decision.md",
            content: "# ADR-0031 : Clean Decision"
          }
        ],
        specFiles: [
          {
            path: "docs/specs/clean.md",
            content: "Basé sur docs/adr/0031-clean-decision.md."
          }
        ],
        expectedAdrPath: "docs/adr/0031-clean-decision.md",
        expectedAdrSnippet: "# ADR-0031 : Clean Decision",
        expectedSpecSnippet: "docs/adr/0031-clean-decision.md"
      },
      {
        id: "avoids cascading collisions when plan branch has multiple ADRs (0031 and 0032) and 0031 collides on dev",
        devPaths: ["docs/adr/0031-other-dev.md"],
        planAdrs: [
          {
            path: "docs/adr/0031-first-plan.md",
            content: "# ADR-0031 : First Plan"
          },
          {
            path: "docs/adr/0032-second-plan.md",
            content: "# ADR-0032 : Second Plan"
          }
        ],
        specFiles: [
          {
            path: "docs/specs/multi.md",
            content:
              "Voir docs/adr/0031-first-plan.md (ADR-0031) et docs/adr/0032-second-plan.md (ADR-0032)."
          }
        ],
        expectedAdrPath: "docs/adr/0033-first-plan.md",
        expectedAdrSnippet: "# ADR-0033 : First Plan",
        expectedSpecSnippet:
          "Voir docs/adr/0033-first-plan.md (ADR-0033) et docs/adr/0032-second-plan.md (ADR-0032)."
      }
    ])(
      "$id",
      ({
        devPaths,
        planAdrs,
        specFiles,
        expectedAdrPath,
        expectedAdrSnippet,
        expectedSpecSnippet
      }) => {
        const result = renumberCollidingAdrs({
          devPaths,
          planAdrs,
          specFiles
        });
        expect(result.adrs[0]?.path).toBe(expectedAdrPath);
        expect(result.adrs[0]?.content).toContain(expectedAdrSnippet);
        expect(result.specFiles[0]?.content).toContain(expectedSpecSnippet);
      }
    );
  });

  describe("integratePlanBranchIntoFeature", () => {
    it("transports plan artifacts into feature branch with additive GLOSSARY merge and ADR renumbering without opening a plan->dev PR", async () => {
      const committedFiles: Array<{
        branch: string;
        files: ReadonlyArray<{ path: string; content: string }>;
        commitMessage: string;
      }> = [];

      const mockGh = {
        ensureBranch: async () => "feature-init-sha",
        findOpenPullRequestByHead: async () => null,
        listBranchPaths: async (branch: string) => {
          if (branch === "dev") {
            return ["GLOSSARY.md", "docs/adr/0031-existing-on-dev.md"];
          }
          if (branch === "plan/42-sync") {
            return [
              "GLOSSARY.md",
              "docs/adr/0031-new-plan-adr.md",
              "docs/specs/42-sync.md"
            ];
          }
          return [];
        },
        readSingleBranchFile: async (branch: string, path: string) => {
          if (branch === "dev" && path === "GLOSSARY.md") {
            return "# GLOSSARY\n\n## Terme Dev\nPrésent sur dev.\n";
          }
          if (branch === "plan/42-sync" && path === "GLOSSARY.md") {
            return "# GLOSSARY\n\n## Terme Plan\nPrésent sur plan.\n";
          }
          if (
            branch === "plan/42-sync" &&
            path === "docs/adr/0031-new-plan-adr.md"
          ) {
            return "# ADR-0031: New Plan ADR\n";
          }
          if (branch === "plan/42-sync" && path === "docs/specs/42-sync.md") {
            return "Spec referencing docs/adr/0031-new-plan-adr.md and ADR-0031.";
          }
          return null;
        },
        commitFilesToBranch: async (params: {
          branch: string;
          files: ReadonlyArray<{ path: string; content: string }>;
          commitMessage: string;
        }) => {
          committedFiles.push(params);
          return "commit-sha-123";
        }
      } as unknown as GitHubRestHelper;

      const res = await integratePlanBranchIntoFeature({
        gh: mockGh,
        planBranch: "plan/42-sync",
        featureBranch: "feature/42-sync",
        baseBranch: "dev",
        model: "google/gemini-3.8-flash"
      });

      expect(committedFiles).toHaveLength(1);
      expect(committedFiles[0]?.branch).toBe("feature/42-sync");
      expect(res.renumberedAdrs).toEqual([
        {
          oldPath: "docs/adr/0031-new-plan-adr.md",
          newPath: "docs/adr/0032-new-plan-adr.md"
        }
      ]);
      const glossaryFile = committedFiles[0]?.files.find(
        (f) => f.path === "GLOSSARY.md"
      );
      expect(glossaryFile?.content).toContain("## Terme Dev");
      expect(glossaryFile?.content).toContain("## Terme Plan");
      const specFile = committedFiles[0]?.files.find(
        (f) => f.path === "docs/specs/42-sync.md"
      );
      expect(specFile?.content).toContain("docs/adr/0032-new-plan-adr.md");
    });
  });

  describe("syncBranchWithBase (fast-forward & 3-way LLM conflict resolution)", () => {
    it.each([
      {
        id: "returns up_to_date when GitHub merge API returns 204",
        mergeStatus: { status: "up_to_date" as const, sha: "sha-204" },
        expectedStatus: "up_to_date"
      },
      {
        id: "returns merged when GitHub merge API cleanly fast-forwards or merges (201)",
        mergeStatus: { status: "merged" as const, sha: "sha-201" },
        expectedStatus: "merged"
      }
    ])("$id", async ({ mergeStatus, expectedStatus }) => {
      const mockGh = {
        mergeBranches: async () => mergeStatus
      } as unknown as GitHubRestHelper;

      const res = await syncBranchWithBase({
        gh: mockGh,
        baseBranch: "dev",
        targetBranch: "feature/42-sync",
        issueNumber: 42,
        llmApiKey: "test-key",
        model: "google/gemini-3.8-flash"
      });
      expect(res.status).toBe(expectedStatus);
    });
  });

  describe("Event-driven CI continuation (evaluateSingleExternalCiSnapshot & /epure continue)", () => {
    it.each([
      {
        id: "reports completed=false when check_runs are still in_progress",
        checkRuns: [
          {
            id: 1,
            name: "build",
            status: "in_progress" as const,
            conclusion: null
          }
        ],
        expectedCompleted: false,
        expectedPassed: false
      },
      {
        id: "reports completed=true and passed=true when all check_runs succeed",
        checkRuns: [
          {
            id: 1,
            name: "build",
            status: "completed" as const,
            conclusion: "success"
          },
          {
            id: 2,
            name: "lint",
            status: "completed" as const,
            conclusion: "neutral"
          }
        ],
        expectedCompleted: true,
        expectedPassed: true
      },
      {
        id: "reports completed=true and passed=false when a check_run fails",
        checkRuns: [
          {
            id: 1,
            name: "unit-tests",
            status: "completed" as const,
            conclusion: "failure"
          }
        ],
        expectedCompleted: true,
        expectedPassed: false
      }
    ])("$id", async ({ checkRuns, expectedCompleted, expectedPassed }) => {
      const snap = await evaluateSingleExternalCiSnapshot({
        headSha: "sha-abc",
        expectedWorkflows: ["ci.yml"],
        listWorkflowRunsForSha: async () => [],
        listCheckRunsForRef: async () => checkRuns
      });

      expect(snap.completed).toBe(expectedCompleted);
      expect(snap.passed).toBe(expectedPassed);
    });

    it("resumes waiting_feature_ci state on /epure continue and adds ready-for-human when CI is green", async () => {
      const store = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        issueNumber: 77,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "implementation",
          subphase: "waiting_feature_ci",
          status: "active",
          active_branch: "feature/77-async-ci",
          active_pr_number: 105,
          active_head_sha: "head-sha-feature-105"
        })
      });

      const addedLabels: string[] = [];
      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/issues/77")) {
          return new Response(
            JSON.stringify({
              number: 77,
              title: "Async CI Feature",
              body: "Test async CI continuation",
              labels: [{ name: "ready-for-agent" }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (
          url.includes("/issues/77/comments") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (url.includes("/actions/runs")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  id: 501,
                  name: "CI",
                  path: ".github/workflows/ci.yml",
                  status: "completed",
                  conclusion: "success"
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/check-runs")) {
          return new Response(
            JSON.stringify({
              total_count: 2,
              check_runs: [
                {
                  id: 1,
                  name: "CI",
                  status: "completed",
                  conclusion: "success"
                },
                {
                  id: 2,
                  name: "ai-review",
                  status: "completed",
                  conclusion: "success"
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/issues/77/labels") && init?.method === "POST") {
          const parsed = JSON.parse(String(init.body)) as { labels: string[] };
          addedLabels.push(...parsed.labels);
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };

      const res = await orchestrateIssueCommand({
        repository: "acme/demo",
        issueNumber: 77,
        command: "continue",
        commandArgs: "",
        model: "google/gemini-3.8-flash",
        commentId: 2,
        actor: "github-actions[bot]",
        fallbackGithubToken: "ghs_test",
        llmApiKey: "key_test",
        stateStore: store,
        fetchImpl: mockFetch
      });

      expect(res.phase).toBe("review");
      expect(addedLabels).toContain("ready-for-human");
    });

    it.each([
      {
        id: "ticket-ci-failure-at-exhausted-budget-resolved-from-workflow_run-issueNumber-0-escalates-once-without-sync-or-llm",
        triggerHeadSha: "head-sha-task-203",
        expected: { executed: true, status: "suspended", comments: 1, ciPolls: 2 }
      },
      {
        id: "workflow_run-on-dev-with-issueNumber-0-leaves-unrelated-waiting-state-untouched",
        triggerHeadSha: "dev-sha-unrelated",
        expected: { executed: false, status: "active", comments: 0, ciPolls: 0 }
      }
    ])("$id", async ({ triggerHeadSha, expected }) => {
      const store = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        issueNumber: 156,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "implementation",
          subphase: "waiting_ticket_ci",
          status: "active",
          active_branch: "feature/156-maps",
          active_ticket_number: 203,
          active_task_branch: "task/203-door-auth",
          active_pr_number: 299,
          active_head_sha: "head-sha-task-203",
          code_fix_attempts_used: 3
        })
      });
      const repo = "/repos/acme/demo";
      const router = createGitHubMockRouter()
        .on("GET", `${repo}/issues/156`, json({ number: 156, title: "fix(maps): Map Lighting & Doors", body: "- [ ] Authorize door toggles", state: "open" }))
        .on("GET", `${repo}/issues/156/comments?per_page=100`, json([]))
        .on("GET", /\/git\/trees\/[^?]+\?recursive=1$/, notFound())
        .on("GET", /\/contents\//, notFound())
        .on("GET", /\/git\/ref\/heads\//, notFound())
        .on("GET", /\/actions\/runs\?head_sha=/, json({ workflow_runs: [{ id: 601, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure" }] }))
        .on("GET", /\/commits\/[^/]+\/check-runs\?/, json({ check_runs: [{ id: 11, name: "Backend", status: "completed", conclusion: "failure" }, { id: 12, name: "ai-review", status: "completed", conclusion: "success" }] }))
        .on("GET", /\/check-runs\/\d+\/annotations\?/, json([]))
        .on("GET", /\/actions\/jobs\/\d+\/logs$/, { status: 200, body: "error TS2322" })
        .on("GET", /\/labels\/[^/]+$/, json({}))
        .on("POST", /^\/repos\/acme\/demo\/issues\/(156|203)\/labels$/, json([]))
        .on("DELETE", /\/issues\/156\/labels\/[^/]+$/, json([]))
        .on("POST", `${repo}/issues/156/comments`, json({ html_url: "c" }, 201));

      const res = await orchestrateIssueCommand({
        repository: "acme/demo",
        issueNumber: 0,
        command: "continue",
        commandArgs: "",
        model: "google/gemini-3.8-flash",
        commentId: 0,
        actor: "github-actions[bot]",
        fallbackGithubToken: "ghs_test",
        llmApiKey: "key_test",
        triggerHeadSha,
        asyncCiContinuation: true,
        stateStore: store,
        fetchImpl: router.fetch
      });

      expect(router.unmatched).toEqual([]);
      expect(res.executed).toBe(expected.executed);
      expect(res.status).toBe(expected.status);
      expect(router.calls("POST", `${repo}/issues/156/comments`)).toBe(expected.comments);
      expect(router.calls("GET", /\/actions\/runs\?/) + router.calls("GET", /\/check-runs\?/)).toBe(expected.ciPolls);
      expect(router.calls("POST", `${repo}/merges`)).toBe(0);
      expect(router.requests.filter((r) => r.host !== "api.github.com")).toEqual([]);
    });

    it.each([
      {
        id: "falls through to ticket loop when /epure continue is posted manually (commentId > 0) while subphase is idle in implementation",
        commentId: 999,
        expectedExecuted: true
      },
      {
        id: "returns executed=false when event-driven continue (commentId = 0) fires while subphase is idle",
        commentId: 0,
        expectedExecuted: false
      }
    ])("$id", async ({ commentId, expectedExecuted }) => {
      const store = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        issueNumber: 153,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "implementation",
          subphase: "idle",
          status: "suspended",
          active_branch: "feature/153-tokens"
        })
      });

      const mockFetch: typeof fetch = async (reqInput) => {
        const url = String(reqInput);
        if (url.endsWith("/issues/153")) {
          return new Response(
            JSON.stringify({
              number: 153,
              title: "fix(tokens): Token Manager Fixes",
              body: "- [ ] Escape LIKE metacharacters",
              labels: [{ name: "ready-for-agent" }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/comments")) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return new Response(
            JSON.stringify({
              error: { code: 400, message: "Invalid schema" }
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };

      const res = await orchestrateIssueCommand({
        repository: "acme/demo",
        issueNumber: 153,
        command: "continue",
        commandArgs: "",
        model: "google/gemini-3.8-flash",
        commentId,
        actor: "Hartorn",
        fallbackGithubToken: "ghs_test",
        llmApiKey: "key_test",
        stateStore: store,
        fetchImpl: mockFetch
      });

      expect(res.executed).toBe(expectedExecuted);
    });
  });
});
