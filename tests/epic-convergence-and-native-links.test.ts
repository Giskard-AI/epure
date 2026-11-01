import { describe, expect, it } from "vitest";
import { parseAgentsYaml } from "../src/bootstrap/setup-repo.js";
import { formatNeedsHumanEscalationComment } from "../src/execution/external-ci-gate.js";
import type { ProviderConfig } from "../src/llm/index.js";
import {
  reconcileAdrsWithLlm,
  renumberCollidingAdrs,
  type SyncBranchWithBaseInput,
  syncBranchWithBase
} from "../src/orchestrator/github/branch-sync.js";
import { createGitHubRestHelper } from "../src/orchestrator/github/rest-client.js";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import {
  runEpicConvergenceAudit,
  spawnPhase2ConvergenceTickets
} from "../src/orchestrator/phases/epic-convergence.js";
import {
  buildParentIssueTicketsTasklistBlock,
  upsertParentIssueTicketsTasklist
} from "../src/orchestrator/phases/grill-and-plan.js";
import { parseOptionalEpicGoalContract } from "../src/orchestrator/prompts/schemas.js";
import type {
  EpicGoalContract,
  IssueCommentRecord,
  ResolvedPhaseModels,
  TrackedTicketCommentMetadata
} from "../src/orchestrator/types.js";
import {
  parsePlanManifestFromComments,
  validateTicketIntegrityGuard
} from "../src/orchestrator/workspace/repo-tools.js";
import {
  buildIssueStateRefName,
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas
} from "../src/state/git-ref-state.js";

const DEFAULT_PHASE_MODELS: ResolvedPhaseModels = {
  planningModel: "gemini-3.8-flash",
  implementationModel: "gemini-3.8-flash",
  reviewModel: "gemini-3.8-flash"
};

describe("EPURE Graphe GitHub Natif, Garde-fous d'Intégrité Inter-Tickets et Convergence Multi-Phases (Q112–Q121, ADR-0032)", () => {
  describe("1. Graphe relationnel GitHub natif (Sub-issues, Blocked-by, Tasklist) — Q112", () => {
    it.each([
      {
        id: "binds sub_issues and dependencies/blocked_by using numeric GitHub issue IDs on 201 OK",
        subIssueStatus: 201,
        depStatus: 201,
        expectPatchCount: 1
      },
      {
        id: "degrades gracefully without throwing when GitHub returns 404/422 on sub_issues or dependencies",
        subIssueStatus: 404,
        depStatus: 422,
        expectPatchCount: 1
      },
      {
        id: "degrades gracefully without throwing when GitHub returns 500 server error on relational endpoints",
        subIssueStatus: 500,
        depStatus: 503,
        expectPatchCount: 1
      }
    ])("$id", async ({ subIssueStatus, depStatus, expectPatchCount }) => {
      const apiCalls: Array<{
        method: string;
        url: string;
        body?: unknown;
      }> = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        apiCalls.push({ method, url, body });

        if (url.endsWith("/sub_issues")) {
          return new Response(JSON.stringify({ id: 9001 }), {
            status: subIssueStatus,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.endsWith("/dependencies/blocked_by")) {
          return new Response(JSON.stringify({ id: 9002 }), {
            status: depStatus,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (method === "PATCH" && url.includes("/issues/10")) {
          return new Response(JSON.stringify({ number: 10, id: 10010 }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (method === "POST" && url.endsWith("/issues")) {
          return new Response(
            JSON.stringify({
              id: 50001,
              number: 11,
              html_url: "https://github.com/org/repo/issues/11"
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 200 });
      };

      const gh = createGitHubRestHelper({
        repository: "org/repo",
        token: "ghs_test",
        fetchImpl: mockFetch
      });
      const created = await gh.createIssue({
        title: "Child ticket",
        body: "Body",
        labels: ["ticket"]
      });
      expect(created.id).toBe(50001);
      expect(created.number).toBe(11);

      await gh.addSubIssue?.(10, 50001);
      await gh.addIssueBlockedByDependency?.(12, 50001);
      await gh.updateIssue?.(10, { body: "Updated body" });

      expect(
        apiCalls.find((c) => c.url.endsWith("/issues/10/sub_issues"))?.body
      ).toEqual({ sub_issue_id: 50001 });
      expect(
        apiCalls.find((c) =>
          c.url.endsWith("/issues/12/dependencies/blocked_by")
        )?.body
      ).toEqual({ issue_id: 50001 });
      expect(
        apiCalls.filter(
          (c) => c.method === "PATCH" && c.url.endsWith("/issues/10")
        )
      ).toHaveLength(expectPatchCount);
    });

    it.each([
      {
        id: "appends bounded epure-tickets-tasklist block to parent issue body when absent",
        initialBody: "Description initiale de l'epic.",
        tickets: [
          {
            ticketIssueNumber: 11,
            title: "Core domain",
            blockedByIssueNumbers: [],
            phase: 1
          },
          {
            ticketIssueNumber: 12,
            title: "CLI wiring",
            blockedByIssueNumbers: [11],
            phase: 1
          }
        ],
        expectedSubstrings: [
          "<!-- epure-tickets-tasklist:start -->",
          "### Plan Tickets (Phase 1)",
          "- [ ] #11 — Core domain",
          "- [ ] #12 — CLI wiring _(blocked by #11)_",
          "<!-- epure-tickets-tasklist:end -->"
        ]
      },
      {
        id: "replaces existing bounded epure-tickets-tasklist block idempotently and groups Phase 1 and Phase 2 tickets",
        initialBody: [
          "Description initiale de l'epic.",
          "",
          "<!-- epure-tickets-tasklist:start -->",
          "### Plan Tickets (Phase 1)",
          "- [ ] #99 — Ancien ticket",
          "<!-- epure-tickets-tasklist:end -->"
        ].join("\n"),
        tickets: [
          {
            ticketIssueNumber: 11,
            title: "Core domain",
            blockedByIssueNumbers: [],
            phase: 1
          },
          {
            ticketIssueNumber: 15,
            title: "Phase 2 wiring",
            blockedByIssueNumbers: [11],
            phase: 2
          }
        ],
        expectedSubstrings: [
          "<!-- epure-tickets-tasklist:start -->",
          "### Plan Tickets (Phase 1)",
          "- [ ] #11 — Core domain",
          "### Remediation Tickets (Phase 2)",
          "- [ ] #15 — Phase 2 wiring _(blocked by #11)_",
          "<!-- epure-tickets-tasklist:end -->"
        ]
      }
    ])("$id", async ({ initialBody, tickets, expectedSubstrings }) => {
      let updatedBody = "";
      const mockGh = {
        getIssue: async () => ({
          number: 10,
          title: "Epic 10",
          body: initialBody
        }),
        updateIssue: async (_num: number, params: { body?: string }) => {
          updatedBody = params.body ?? "";
        }
      };

      const directBlock = buildParentIssueTicketsTasklistBlock(tickets);
      for (const sub of expectedSubstrings) {
        expect(directBlock).toContain(sub);
      }

      await upsertParentIssueTicketsTasklist({
        gh: mockGh,
        parentIssueNumber: 10,
        fallbackBody: initialBody,
        tickets
      });

      for (const sub of expectedSubstrings) {
        expect(updatedBody).toContain(sub);
      }
      expect(updatedBody).not.toContain("#99");
      const blockMatches = updatedBody.match(
        /<!-- epure-tickets-tasklist:start -->/g
      );
      expect(blockMatches).toHaveLength(1);
    });
  });

  describe("2. Garde-fou d'intégrité inter-tickets (validateTicketIntegrityGuard) — Q113", () => {
    const TWENTY_LINES = Array.from(
      { length: 20 },
      (_, idx) => `export const symbol_${idx} = ${idx};`
    ).join("\n");

    it.each([
      {
        id: "allows legitimate modifications within ticketFilesToTouch, barrel neighbor re-exports, and new test additions",
        baseFiles: new Map([
          ["src/feature.ts", TWENTY_LINES],
          ["src/index.ts", TWENTY_LINES],
          ["tests/existing.test.ts", "it('works', () => expect(1).toBe(1));\n"],
          [
            "package.json",
            JSON.stringify({
              scripts: {
                build: "tsc -p tsconfig.json",
                test: "vitest run"
              }
            })
          ]
        ]),
        changedFiles: [
          {
            path: "src/feature.ts",
            content: `${TWENTY_LINES}\nexport const extra = true;\n`
          },
          {
            path: "src/index.ts",
            content: 'export * from "./feature.js";\n'
          },
          {
            path: "tests/new-feature.test.ts",
            content: "it('tests new feature', () => expect(true).toBe(true));\n"
          }
        ],
        ticketFilesToTouch: ["src/feature.ts", "tests/new-feature.test.ts"],
        expectedAllowed: true,
        expectedCategory: undefined
      },
      {
        id: "blocks unauthorized deletion or emptying of an existing test file outside ticketFilesToTouch",
        baseFiles: new Map([
          [
            "tests/critical-regression.test.ts",
            "describe('suite', () => {\n  it('checks invariant', () => expect(1).toBe(1));\n});\n"
          ]
        ]),
        changedFiles: [
          {
            path: "tests/critical-regression.test.ts",
            content: "   \n"
          }
        ],
        ticketFilesToTouch: ["src/other.ts"],
        expectedAllowed: false,
        expectedCategory: "unauthorized_test_deletion"
      },
      {
        id: "blocks out-of-scope file truncation (>30% line loss on existing file >= 15 lines outside ticketFilesToTouch)",
        baseFiles: new Map([["src/unlisted-module.ts", TWENTY_LINES]]),
        changedFiles: [
          {
            path: "src/unlisted-module.ts",
            content: "export const symbol_0 = 0;\nexport const symbol_1 = 1;\n"
          }
        ],
        ticketFilesToTouch: ["src/declared-target.ts"],
        expectedAllowed: false,
        expectedCategory: "out_of_scope_file_truncation"
      },
      {
        id: "blocks verification script degradation when package.json build or check script is replaced by echo stub",
        baseFiles: new Map([
          [
            "package.json",
            JSON.stringify({
              name: "app",
              scripts: {
                build: "tsc -b && vite build",
                check: "tsc --noEmit",
                test: "vitest run"
              }
            })
          ]
        ]),
        changedFiles: [
          {
            path: "package.json",
            content: JSON.stringify({
              name: "app",
              scripts: {
                build: "tsc -b && vite build",
                check: "echo 'check skipped'",
                test: "vitest run"
              }
            })
          }
        ],
        ticketFilesToTouch: ["package.json"],
        expectedAllowed: false,
        expectedCategory: "verification_script_degradation"
      },
      {
        id: "blocks verification script degradation when package.json build script is downgraded to vitest run",
        baseFiles: new Map([
          [
            "package.json",
            JSON.stringify({
              name: "app",
              scripts: {
                build: "tsup src/index.ts",
                test: "vitest run"
              }
            })
          ]
        ]),
        changedFiles: [
          {
            path: "package.json",
            content: JSON.stringify({
              name: "app",
              scripts: {
                build: "vitest run",
                test: "vitest run"
              }
            })
          }
        ],
        ticketFilesToTouch: ["package.json"],
        expectedAllowed: false,
        expectedCategory: "verification_script_degradation"
      },
      {
        id: "blocks verification script degradation when Makefile test target is replaced by true no-op or build equals test",
        baseFiles: new Map([
          [
            "Makefile",
            "build:\n\tcargo build --release\n\ntest:\n\tcargo test\n"
          ]
        ]),
        changedFiles: [
          {
            path: "Makefile",
            content: "build:\n\tcargo test\n\ntest:\n\tcargo test\n"
          }
        ],
        ticketFilesToTouch: ["Makefile"],
        expectedAllowed: false,
        expectedCategory: "verification_script_degradation"
      },
      {
        id: "blocks verification script degradation in pyproject.toml when poetry/poe scripts replace build or lint with echo/pytest",
        baseFiles: new Map([
          [
            "pyproject.toml",
            '[tool.poetry.scripts]\nbuild = "hatch build"\ntest = "pytest"\nlint = "ruff check ."\n'
          ]
        ]),
        changedFiles: [
          {
            path: "pyproject.toml",
            content:
              '[tool.poetry.scripts]\nbuild = "pytest"\ntest = "pytest"\nlint = "echo ok"\n'
          }
        ],
        ticketFilesToTouch: ["pyproject.toml"],
        expectedAllowed: false,
        expectedCategory: "verification_script_degradation"
      },
      {
        id: "blocks verification script degradation in Cargo.toml when alias or package build is replaced by no-op stub",
        baseFiles: new Map([
          [
            "Cargo.toml",
            '[package]\nname = "engine"\nbuild = "build.rs"\n\n[alias]\ncheck = "clippy --all-targets"\n'
          ]
        ]),
        changedFiles: [
          {
            path: "Cargo.toml",
            content:
              '[package]\nname = "engine"\nbuild = "echo skipped"\n\n[alias]\ncheck = "true"\n'
          }
        ],
        ticketFilesToTouch: ["Cargo.toml"],
        expectedAllowed: false,
        expectedCategory: "verification_script_degradation"
      }
    ])(
      "$id",
      ({
        baseFiles,
        changedFiles,
        ticketFilesToTouch,
        expectedAllowed,
        expectedCategory
      }) => {
        const result = validateTicketIntegrityGuard({
          baseFiles,
          changedFiles,
          ticketFilesToTouch
        });

        expect(result.passed).toBe(expectedAllowed);
        if (expectedCategory) {
          expect(result.violations[0]?.kind).toBe(expectedCategory);
          expect(result.diagnosticMarkdown).toContain(expectedCategory);
        } else {
          expect(result.violations).toHaveLength(0);
          expect(result.diagnosticMarkdown).toBe("");
        }
      }
    );
  });

  describe("3. Réconciliation sémantique et monotone des ADRs (Q114 & Q118)", () => {
    it.each([
      {
        id: "deduplicates triplon ADRs sharing the same normalized slug (0039/0042/0045 -> canonical 0039) and updates references across ADRs, specs, and GLOSSARY",
        devPaths: ["docs/adr/0039-sandbox-network-isolation.md"],
        planAdrs: [
          {
            path: "docs/adr/0039-sandbox-network-isolation.md",
            content: "# ADR-0039 : Sandbox Network Isolation (v1)\n"
          },
          {
            path: "docs/adr/0042-sandbox-network-isolation.md",
            content: "# ADR-0042 : Sandbox Network Isolation (v2)\n"
          },
          {
            path: "docs/adr/0045-sandbox-network-isolation.md",
            content:
              "# ADR-0045 : Sandbox Network Isolation (v3)\nVoir ADR-0042 et ADR-0045.\n"
          }
        ],
        specFiles: [
          {
            path: "docs/specs/sandbox.md",
            content:
              "Conforme à `docs/adr/0045-sandbox-network-isolation.md` (ADR-0045) et ADR-0042."
          }
        ],
        glossaryContent:
          "# GLOSSARY\n\n## Sandbox Isolation (ADR-0045)\nDéfini dans `docs/adr/0045-sandbox-network-isolation.md`.\n",
        expectedAdrPaths: ["docs/adr/0039-sandbox-network-isolation.md"],
        expectedDeletedPaths: [
          "docs/adr/0042-sandbox-network-isolation.md",
          "docs/adr/0045-sandbox-network-isolation.md"
        ],
        expectedSpecSnippet:
          "Conforme à `docs/adr/0039-sandbox-network-isolation.md` (ADR-0039) et ADR-0039.",
        expectedGlossarySnippet: "## Sandbox Isolation (ADR-0039)"
      },
      {
        id: "allocates max(dev, feature) + 1 when distinct slugs collide on the same ADR number",
        devPaths: [
          "docs/adr/0030-base.md",
          "docs/adr/0031-concurrent-dev-decision.md"
        ],
        planAdrs: [
          {
            path: "docs/adr/0031-feature-specific-decision.md",
            content: "# ADR-0031 : Feature Specific Decision\n"
          }
        ],
        specFiles: [
          {
            path: "docs/specs/feature.md",
            content:
              "Basé sur `docs/adr/0031-feature-specific-decision.md` (ADR-0031)."
          }
        ],
        glossaryContent: "# GLOSSARY\n\n## Feature Term (ADR-0031)\n",
        expectedAdrPaths: ["docs/adr/0032-feature-specific-decision.md"],
        expectedDeletedPaths: ["docs/adr/0031-feature-specific-decision.md"],
        expectedSpecSnippet:
          "Basé sur `docs/adr/0032-feature-specific-decision.md` (ADR-0032).",
        expectedGlossarySnippet: "## Feature Term (ADR-0032)"
      }
    ])(
      "$id",
      ({
        devPaths,
        planAdrs,
        specFiles,
        glossaryContent,
        expectedAdrPaths,
        expectedDeletedPaths,
        expectedSpecSnippet,
        expectedGlossarySnippet
      }) => {
        const res = renumberCollidingAdrs({
          devPaths,
          planAdrs,
          specFiles,
          glossaryContent
        });

        expect(res.adrs.map((a) => a.path)).toEqual(expectedAdrPaths);
        expect(res.deletedAdrPaths).toEqual(expectedDeletedPaths);
        expect(res.specFiles[0]?.content).toContain(expectedSpecSnippet);
        expect(res.glossaryContent).toContain(expectedGlossarySnippet);
      }
    );

    it.each([
      {
        id: "runs reconcileAdrsWithLlm directly and via syncBranchWithBase when concurrent dev ADRs exist",
        summaryText: "Added Supersedes link to ADR-0031.",
        updatedContent: "# ADR-0032 : Second\n\nSupersedes ADR-0031.\n"
      }
    ])("$id", async ({ summaryText, updatedContent }) => {
      const mockFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        coherent: true,
                        summary: summaryText,
                        updated_files: [
                          {
                            path: "docs/adr/0032-second.md",
                            content: updatedContent
                          }
                        ],
                        deleted_adr_paths: []
                      })
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );

      const reconciled = await reconcileAdrsWithLlm({
        devAdrs: [
          { path: "docs/adr/0031-first.md", content: "# ADR-0031 : First\n" }
        ],
        featureAdrs: [
          { path: "docs/adr/0032-second.md", content: "# ADR-0032 : Second\n" }
        ],
        specFiles: [
          { path: "docs/specs/second.md", content: "Ref ADR-0032.\n" }
        ],
        glossaryContent: "# GLOSSARY\n",
        llmApiKey: "test-key",
        model: "google/gemini-3.8-flash",
        fetchImpl: mockFetch
      });

      expect(reconciled).not.toBeNull();
      expect(reconciled?.summary).toBe(summaryText);
      expect(
        reconciled?.updated_files.find(
          (a) => a.path === "docs/adr/0032-second.md"
        )?.content
      ).toContain("Supersedes ADR-0031.");

      let committedFiles: Array<{ path: string; content: string }> = [];
      const mockSyncGh: SyncBranchWithBaseInput["gh"] = {
        getDefaultBranchSha: async () => "sha-dev",
        readBranchWorkspaceFiles: async () => new Map(),
        mergeBranches: async () => ({
          status: "merged" as const,
          sha: "sha-merged"
        }),
        listBranchPaths: async (branch: string) =>
          branch === "dev"
            ? ["docs/adr/0031-first.md"]
            : ["docs/adr/0031-first.md", "docs/adr/0032-second.md"],
        readSingleBranchFile: async (_branch: string, path: string) =>
          path.includes("0031")
            ? "# ADR-0031 : First\n"
            : "# ADR-0032 : Second\n",
        commitFilesToBranch: async (params: {
          files: ReadonlyArray<{ path: string; content: string }>;
        }) => {
          committedFiles = [...params.files];
          return "sha-reconciled";
        }
      };

      const syncRes = await syncBranchWithBase({
        gh: mockSyncGh,
        targetBranch: "feature/42-sync",
        baseBranch: "dev",
        issueNumber: 42,
        llmApiKey: "test-key",
        model: "google/gemini-3.8-flash",
        fetchImpl: mockFetch
      });

      expect(syncRes.status).toBe("merged");
      expect(syncRes.headSha).toBe("sha-reconciled");
      expect(
        committedFiles.find((f) => f.path === "docs/adr/0032-second.md")
          ?.content
      ).toContain("Supersedes ADR-0031.");
    });

    it.each([
      {
        id: "reconcileAdrsWithLlm routes an agents.yml provider alias and forwards its effort",
        providers: {
          claude: { provider: "anthropic", effort: "high" }
        } satisfies Readonly<Record<string, ProviderConfig>>,
        model: "claude/claude-haiku-5-5",
        expectedUrl: "https://api.anthropic.com/v1/messages",
        expectedModel: "claude-haiku-5-5",
        expectedEffort: "high"
      }
    ])(
      "$id",
      async ({ providers, model, expectedUrl, expectedModel, expectedEffort }) => {
        const requests: Array<{ url: string; body: Record<string, unknown> }> =
          [];
        const mockFetch: typeof fetch = async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>
          });
          return new Response(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    coherent: true,
                    summary: "ok",
                    updated_files: [],
                    deleted_adr_paths: []
                  })
                }
              ]
            }),
            { status: 200 }
          );
        };

        const reconciled = await reconcileAdrsWithLlm({
          devAdrs: [
            { path: "docs/adr/0031-first.md", content: "# ADR-0031 : First\n" }
          ],
          featureAdrs: [
            { path: "docs/adr/0032-second.md", content: "# ADR-0032 : Second\n" }
          ],
          specFiles: [],
          llmApiKey: "test-key",
          model,
          providers,
          fetchImpl: mockFetch
        });

        expect(reconciled?.summary).toBe("ok");
        expect(requests[0]?.url).toBe(expectedUrl);
        expect(requests[0]?.body.model).toBe(expectedModel);
        expect(requests[0]?.body.output_config).toMatchObject({
          effort: expectedEffort
        });
      }
    );
  });

  describe("4. Épinglage dynamique des entrypoints et manifestes dans readBranchWorkspaceFiles — Q115", () => {
    it.each([
      {
        id: "pins required_entrypoints and project manifests even when hintText has no lexical overlap",
        pinnedPaths: ["src/zzz-cli-entry.ts"],
        expectedPaths: [
          "package.json",
          "src/zzz-cli-entry.ts",
          "src/unrelated-alpha.ts"
        ]
      }
    ])("$id", async ({ pinnedPaths, expectedPaths }) => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes("/git/trees/")) {
          return new Response(
            JSON.stringify({
              tree: [
                {
                  path: "package.json",
                  type: "blob",
                  sha: "sha-pkg",
                  size: 60
                },
                {
                  path: "src/unrelated-alpha.ts",
                  type: "blob",
                  sha: "sha-alpha",
                  size: 120
                },
                {
                  path: "src/zzz-cli-entry.ts",
                  type: "blob",
                  sha: "sha-cli",
                  size: 80
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/git/blobs/sha-pkg")) {
          return new Response(
            JSON.stringify({
              encoding: "base64",
              content: Buffer.from('{"name":"demo"}').toString("base64")
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/git/blobs/sha-cli")) {
          return new Response(
            JSON.stringify({
              encoding: "base64",
              content: Buffer.from("export function main() {}").toString(
                "base64"
              )
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/git/blobs/sha-alpha")) {
          return new Response(
            JSON.stringify({
              encoding: "base64",
              content: Buffer.from("export const alpha = 1;").toString("base64")
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 404 });
      };

      const gh = createGitHubRestHelper({
        repository: "org/repo",
        token: "ghs_test",
        fetchImpl: mockFetch
      });
      const files = await gh.readBranchWorkspaceFiles(
        "feature/10-epic",
        "implement alpha module",
        pinnedPaths
      );

      for (const expectedPath of expectedPaths) {
        expect(files.has(expectedPath)).toBe(true);
      }
    });
  });

  describe("5. Contrat de convergence, Audit zéro-contexte et Boucle automatique de Phase 2 — Q115, Q116, Q117, Q120, Q121", () => {
    const sampleContract: EpicGoalContract = {
      epic_goal_summary:
        "Provide a complete CLI binary with interactive and headless modes.",
      required_entrypoints: ["src/cli.ts"],
      forbidden_stubs: ["TODO: wire cli", "stub implementation"],
      end_to_end_verification_criteria: [
        "src/cli.ts imports and invokes runEngine()",
        "package.json bin entry points to dist/cli.js"
      ]
    };

    const sampleTicket: TrackedTicketCommentMetadata = {
      ticketIssueNumber: 51,
      slug: "core-engine",
      title: "Core engine",
      description: "Implement engine",
      acceptanceCriteria: ["Engine runs"],
      blockedByIssueNumbers: [],
      filesToTouch: ["src/engine.ts"],
      phase: 1
    };

    it.each([
      {
        id: "parses epic_goal_contract and extracts it from epure-plan-manifest comment",
        planBranch: "plan/50-cli",
        specPath: "docs/specs/50-cli.md"
      }
    ])("$id", ({ planBranch, specPath }) => {
      const parsed = parseOptionalEpicGoalContract(sampleContract);
      expect(parsed).toEqual(sampleContract);

      const commentBody = `### Plan\n<!-- epure-plan-manifest:${JSON.stringify({
        planBranch,
        specPath,
        epicGoalContract: sampleContract,
        tickets: [sampleTicket]
      })} -->`;

      const commentRecord: IssueCommentRecord = {
        id: 1,
        body: commentBody,
        user: { login: "epure-bot" },
        created_at: "2026-10-31T00:00:00Z"
      };

      const manifest = parsePlanManifestFromComments([commentRecord]);
      expect(manifest?.epicGoalContract).toEqual(sampleContract);
      expect(manifest?.tickets).toHaveLength(1);
    });

    it.each([
      {
        id: "returns CONVERGED and exposes read-only repo tools (read_repo_file, search_repo_code, list_repo_files) when zero-context Goldfish auditor validates all entrypoints",
        auditResponse: {
          verdict: "CONVERGED" as const,
          rationale: "All entrypoints and criteria verified.",
          unwired_modules: [],
          stub_violations: [],
          unmet_criteria: [],
          remediation_tickets: []
        },
        expectedVerdict: "CONVERGED",
        expectedTicketCount: 0
      },
      {
        id: "returns INCOMPLETE with remediation_tickets when auditor detects stubbed entrypoint",
        auditResponse: {
          verdict: "INCOMPLETE" as const,
          rationale: "CLI entrypoint is still a stub.",
          unwired_modules: ["src/cli.ts"],
          stub_violations: ["src/cli.ts:12 TODO: wire cli"],
          unmet_criteria: ["src/cli.ts imports and invokes runEngine()"],
          remediation_tickets: [
            {
              index: 1,
              slug: "wire-cli-entrypoint",
              title: "Wire CLI entrypoint to runEngine",
              description: "Replace stub in src/cli.ts with real invocation.",
              summary: "Wire CLI entrypoint",
              acceptance_criteria: ["src/cli.ts calls runEngine()"],
              blocked_by_indices: [],
              files_to_create_or_update: ["src/cli.ts"],
              files_likely_touched: ["src/cli.ts"]
            }
          ]
        },
        expectedVerdict: "INCOMPLETE",
        expectedTicketCount: 1
      }
    ])(
      "$id",
      async ({ auditResponse, expectedVerdict, expectedTicketCount }) => {
        let capturedRequestBody = "";
        const mockFetch: typeof fetch = async (_input, init) => {
          capturedRequestBody = String(init?.body ?? "");
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(auditResponse) }]
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        };

        const longLineFile = Array.from(
          { length: 400 },
          (_, idx) => `export const line_${idx + 1} = "${"x".repeat(40)}";`
        ).join("\n");
        const mockGh = {
          listBranchPaths: async () => ["src/cli.ts", "src/large.ts"],
          readSingleBranchFile: async (_branch: string, path: string) =>
            path === "src/large.ts"
              ? longLineFile
              : "export function cli() { /* TODO: wire cli */ }"
        };

        const audit = await runEpicConvergenceAudit({
          issueNumber: 50,
          featureBranch: "feature/50-cli",
          specPath: "docs/specs/50-cli.md",
          specMarkdown: "# Spec 50",
          glossaryMarkdown: "# GLOSSARY",
          epicGoalContract: sampleContract,
          accumulatedFiles: new Map([
            ["src/cli.ts", "export function cli() { /* TODO: wire cli */ }"],
            ["src/large.ts", longLineFile]
          ]),
          featureChangedFilesMap: new Map([
            ["src/cli.ts", "export function cli() { /* TODO: wire cli */ }"],
            ["src/large.ts", longLineFile]
          ]),
          devBranchPaths: ["src/cli.ts", "src/large.ts"],
          stage1Summary: "Stage 1 PASSED on feature/50-cli",
          gh: mockGh,
          llmApiKey: "test-key",
          phaseModels: DEFAULT_PHASE_MODELS,
          fetchImpl: mockFetch
        });

        expect(audit.verdict).toBe(expectedVerdict);
        expect(audit.remediation_tickets).toHaveLength(expectedTicketCount);
        expect(capturedRequestBody).toContain("read_repo_file");
        expect(capturedRequestBody).toContain("search_repo_code");
        expect(capturedRequestBody).toContain("list_repo_files");
        expect(capturedRequestBody).toContain("Stage 1 PASSED on feature/50-cli");
        expect(capturedRequestBody).toContain("export const line_400 =");
      }
    );

    it.each([
      {
        id: "spawns Phase 2 tickets, links native sub-issues & blocked_by dependencies, and updates parent issue manifest and tasklist",
        nextEpicPhase: 2,
        expectedTicketNumbers: [51, 52, 53]
      }
    ])("$id", async ({ nextEpicPhase, expectedTicketNumbers }) => {
      const createdIssues: Array<{ title: string; body: string }> = [];
      const subIssues: Array<{ parent: number; childId: number }> = [];
      const blockedByDeps: Array<{ issue: number; blockerId: number }> = [];
      const postedComments: string[] = [];
      let updatedParentIssueBody = "";

      let nextIssueNum = 52;
      const mockGh = {
        createIssue: async (params: { title: string; body: string }) => {
          const num = nextIssueNum++;
          createdIssues.push({ title: params.title, body: params.body });
          return {
            id: 90000 + num,
            number: num,
            html_url: `https://github.com/org/repo/issues/${num}`
          };
        },
        addSubIssue: async (parent: number, childId: number) => {
          subIssues.push({ parent, childId });
        },
        addIssueBlockedByDependency: async (
          issue: number,
          blockerId: number
        ) => {
          blockedByDeps.push({ issue, blockerId });
        },
        getIssue: async () => ({
          id: 90050,
          number: 50,
          title: "Epic 50",
          body: "Epic body"
        }),
        updateIssue: async (_num: number, patch: { body?: string }) => {
          if (patch.body) updatedParentIssueBody = patch.body;
        },
        postIssueComment: async (_num: number, body: string) => {
          postedComments.push(body);
          return "https://github.com/org/repo/issues/50#issuecomment-2";
        }
      };

      const phase2Tickets = [
        {
          index: 1,
          slug: "wire-cli",
          title: "Wire CLI",
          description: "Connect CLI to engine",
          summary: "Connect CLI",
          acceptance_criteria: ["CLI invokes engine"],
          blocked_by_indices: [],
          files_to_create_or_update: ["src/cli.ts"],
          files_likely_touched: ["src/cli.ts"]
        },
        {
          index: 2,
          slug: "verify-cli-e2e",
          title: "Verify CLI E2E",
          description: "Add E2E test for CLI",
          summary: "Add E2E test",
          acceptance_criteria: ["E2E test passes"],
          blocked_by_indices: [1],
          files_to_create_or_update: ["tests/cli.test.ts"],
          files_likely_touched: ["tests/cli.test.ts"]
        }
      ];

      const combined = await spawnPhase2ConvergenceTickets({
        issueNumber: 50,
        issue: {
          id: 90050,
          number: 50,
          title: "Epic 50",
          body: "Epic body"
        },
        planBranch: "plan/50-cli",
        specPath: "docs/specs/50-cli.md",
        epicGoalContract: sampleContract,
        existingTickets: [sampleTicket],
        auditResult: {
          verdict: "INCOMPLETE",
          rationale: "Missing CLI wiring and E2E check.",
          unwired_modules: ["src/cli.ts"],
          stub_violations: [],
          unmet_criteria: ["src/cli.ts calls runEngine()"],
          remediation_tickets: phase2Tickets
        },
        nextEpicPhase,
        stateMirrorMarkdown: "<!-- state -->",
        gh: mockGh
      });

      expect(combined.map((t) => t.ticketIssueNumber)).toEqual(
        expectedTicketNumbers
      );
      expect(subIssues).toEqual([
        { parent: 50, childId: 90052 },
        { parent: 50, childId: 90053 }
      ]);
      expect(blockedByDeps).toEqual([{ issue: 53, blockerId: 90052 }]);
      expect(postedComments[0]).toContain("epure-plan-manifest:");
      expect(postedComments[0]).toContain("wire-cli");
      expect(updatedParentIssueBody).toContain(
        "<!-- epure-tickets-tasklist:start -->"
      );
      expect(updatedParentIssueBody).toContain("### Remediation Tickets (Phase 2)");
      expect(updatedParentIssueBody).toContain("#52");
      expect(updatedParentIssueBody).toContain("#53");
    });

    it.each([
      {
        id: "escalates with epic_convergence_exhausted when audit remains INCOMPLETE at max_epic_phases",
        initialEpicPhase: 2,
        expectEscalated: true
      },
      {
        id: "automatically transitions from Phase 1 INCOMPLETE to spawning Phase 2 tickets, updates epic_phase to 2, and includes convergence summary in final PR body",
        initialEpicPhase: 1,
        expectEscalated: false
      }
    ])("$id", async ({ initialEpicPhase, expectEscalated }) => {
      const issueNum = expectEscalated ? 60 : 70;
      const branchSlug = expectEscalated ? "60-incomplete" : "70-auto-phase2";
      const store = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        store,
        issueNumber: issueNum,
        mutator: (current) => ({
          ...current,
          issue_number: issueNum,
          phase: "implementation",
          subphase: "implementing_ticket",
          status: "active",
          active_branch: `feature/${branchSlug}`,
          epic_phase: initialEpicPhase
        })
      });

      const postedComments: string[] = [];
      const addedLabels: string[][] = [];
      const createdTicketTitles: string[] = [];
      const subIssueLinks: Array<{ parent: number; childId: number }> = [];
      const createdPullRequestBodies: string[] = [];
      let auditCallCount = 0;

      const manifestComment = `<!-- epure-plan-manifest:${JSON.stringify({
        planBranch: `plan/${branchSlug}`,
        specPath: `docs/specs/${branchSlug}.md`,
        epicGoalContract: sampleContract,
        tickets: [
          {
            ticketIssueNumber: issueNum + 1,
            slug: "core-engine",
            title: "Core engine",
            description: "Implement engine",
            acceptanceCriteria: ["Engine runs"],
            blockedByIssueNumbers: [],
            filesToTouch: ["src/engine.ts"],
            phase: 1
          }
        ]
      })} -->`;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.includes("generativelanguage.googleapis.com")) {
          const reqBody = String(init?.body ?? "");
          if (reqBody.includes("runEpicConvergenceAudit")) {
            auditCallCount += 1;
            if (expectEscalated || auditCallCount === 1) {
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              verdict: "INCOMPLETE",
                              rationale: "src/cli.ts still does not invoke runEngine().",
                              summary: "src/cli.ts still does not invoke runEngine().",
                              unwired_modules: ["src/cli.ts"],
                              stub_violations: ["src/cli.ts:5 TODO: wire cli"],
                              unmet_criteria: [
                                "src/cli.ts imports and invokes runEngine()"
                              ],
                              remediation_tickets: expectEscalated
                                ? []
                                : [
                                    {
                                      index: 1,
                                      slug: "wire-cli-phase2",
                                      title: "Wire CLI in Phase 2",
                                      description:
                                        "Connect src/cli.ts to runEngine()",
                                      summary: "Connect CLI",
                                      acceptance_criteria: [
                                        "src/cli.ts calls runEngine()"
                                      ],
                                      blocked_by_indices: [],
                                      files_to_create_or_update: ["src/cli.ts"],
                                      files_likely_touched: ["src/cli.ts"]
                                    }
                                  ]
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              );
            }
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            verdict: "CONVERGED",
                            rationale: "Phase 2 wired src/cli.ts.",
                            summary: "Phase 2 wired src/cli.ts.",
                            unwired_modules: [],
                            stub_violations: [],
                            unmet_criteria: [],
                            remediation_tickets: []
                          })
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          findings: []
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.endsWith("/issues") && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { title: string };
          createdTicketTitles.push(body.title);
          return new Response(
            JSON.stringify({
              id: 90072,
              number: 72,
              html_url: "https://github.com/org/repo/issues/72"
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith(`/issues/${issueNum}/sub_issues`) && method === "POST") {
          const body = JSON.parse(String(init?.body)) as {
            sub_issue_id: number;
          };
          subIssueLinks.push({ parent: issueNum, childId: body.sub_issue_id });
          return new Response(JSON.stringify({ id: 1 }), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.endsWith(`/issues/${issueNum}`) && method === "GET") {
          return new Response(
            JSON.stringify({
              id: 90000 + issueNum,
              number: issueNum,
              title: `Epic ${issueNum}`,
              body: `Body ${issueNum}`,
              state: "open"
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (
          (url.endsWith(`/issues/${issueNum + 1}`) ||
            url.endsWith("/issues/72")) &&
          method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              id: 90071,
              number: url.endsWith("/72") ? 72 : issueNum + 1,
              title: "Ticket",
              body: "Body",
              state: "closed"
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes(`/issues/${issueNum}/comments`) && method === "GET") {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                body: manifestComment,
                user: { login: "epure-bot" },
                created_at: "2026-10-31T00:00:00Z"
              }
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes(`/issues/${issueNum}/comments`) && method === "POST") {
          const parsed = JSON.parse(String(init?.body)) as { body: string };
          postedComments.push(parsed.body);
          return new Response(
            JSON.stringify({
              id: 99,
              html_url: `https://github.com/org/repo/issues/${issueNum}#issuecomment-99`
            }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" }
            }
          );
        }
        if (url.includes(`/issues/${issueNum}/labels`) && method === "POST") {
          const parsed = JSON.parse(String(init?.body)) as { labels: string[] };
          addedLabels.push(parsed.labels);
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.endsWith("/pulls") && method === "POST") {
          const parsed = JSON.parse(String(init?.body)) as { body: string };
          createdPullRequestBodies.push(parsed.body);
          return new Response(
            JSON.stringify({
              id: 1,
              number: 80,
              html_url: "https://github.com/org/repo/pull/80",
              head: { sha: "sha-123" }
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/pulls?") && method === "GET") {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/git/trees/")) {
          return new Response(
            JSON.stringify({
              tree: [
                { path: "src/cli.ts", type: "blob", sha: "sha-cli", size: 40 }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (
          url.includes("/contents/src%2Fcli.ts") ||
          url.endsWith("/git/blobs/sha-cli")
        ) {
          return new Response(
            JSON.stringify({
              encoding: "base64",
              content: Buffer.from("export function cli() {}").toString(
                "base64"
              )
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            id: 1,
            number: 80,
            html_url: "https://github.com/org/repo/pull/80",
            sha: "sha-123",
            object: { sha: "sha-123" }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await orchestrateIssueCommand({
        repository: "org/repo",
        issueNumber: issueNum,
        command: "continue",
        commandArgs: "",
        model: "google/gemini-3.8-flash",
        commentId: 202,
        actor: "maintainer",
        fallbackGithubToken: "ghs_test",
        llmApiKey: "test-key",
        stateStore: store,
        sandboxRunner: async () => ({
          isolated: true,
          error_code: "NONE",
          error_message: "",
          exit_code: 0,
          stdout: "Stage 1 OK",
          stderr: "",
          duration_ms: 10,
          proxy_url: "http://127.0.0.1:0"
        }),
        fetchImpl: mockFetch
      });

      if (expectEscalated) {
        expect(res.executed).toBe(true);
        expect(res.status).toBe("suspended");
        expect(addedLabels.flat()).toContain("needs-human");
        expect(
          postedComments.some((c) => c.includes("epic_convergence_exhausted"))
        ).toBe(true);
      } else {
        expect(auditCallCount).toBe(2);
        expect(createdTicketTitles).toEqual([
          "[Phase 2 - Ticket 1] Wire CLI in Phase 2"
        ]);
        expect(subIssueLinks).toEqual([{ parent: 70, childId: 90072 }]);
        const snap = await store.readRef(buildIssueStateRefName(70));
        expect(snap.state?.epic_phase).toBe(2);
        expect(createdPullRequestBodies[0]).toContain(
          "## Epic Convergence Audit (ADR-0032)"
        );
        expect(createdPullRequestBodies[0]).toContain(
          "Phase 2 wired src/cli.ts."
        );
      }
    });

    it.each([
      {
        id: "defaults max_epic_phases to 2 when omitted in .github/agents.yml",
        yaml: "max_code_fix_attempts: 3\n",
        expectedMaxPhases: 2
      },
      {
        id: "clamps max_epic_phases below 1 to 1",
        yaml: "max_epic_phases: 0\n",
        expectedMaxPhases: 1
      },
      {
        id: "clamps max_epic_phases above 3 to 3 and formats epic_convergence_exhausted escalation comment",
        yaml: "max_epic_phases: 5\n",
        expectedMaxPhases: 3
      }
    ])("$id", ({ yaml, expectedMaxPhases }) => {
      const cfg = parseAgentsYaml(yaml);
      expect(cfg.max_epic_phases).toBe(expectedMaxPhases);

      const comment = formatNeedsHumanEscalationComment({
        issueNumber: 60,
        branch: "feature/60-incomplete",
        reason: "epic_convergence_exhausted",
        epicConvergenceDetails: {
          epicPhase: 2,
          maxEpicPhases: 2,
          summary: "CLI remains unwired.",
          unwiredModules: ["src/cli.ts"],
          stubViolations: ["src/cli.ts:10 TODO"],
          unmetCriteria: ["src/cli.ts invokes runEngine()"]
        }
      });

      expect(comment).toContain("epic_convergence_exhausted");
      expect(comment).toContain("Phase 2/2");
      expect(comment).toContain("src/cli.ts invokes runEngine()");
      expect(comment).toContain("src/cli.ts:10 TODO");
    });
  });
});
