import { generateKeyPairSync, createVerify } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGitHubAppJwt } from "../src/auth/github-app-jwt.js";
import {
  evaluateIssueCommandGate,
  parseEpureCommand
} from "../src/auth/issue-command-gate.js";
import { extractJsonObject } from "../src/orchestrator/gemini-client.js";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import {
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas
} from "../src/state/git-ref-state.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_ORCHESTRATE_ACTION_PATH = join(
  ROOT_DIR,
  "dist",
  "actions",
  "orchestrate-issue",
  "index.mjs"
);
const ORCHESTRATE_ACTION_MANIFEST_PATH = join(
  ROOT_DIR,
  "actions",
  "orchestrate-issue",
  "action.yml"
);

describe("EPURE v1.1.0 — Real Orchestration Wiring (Q84–Q90, ADR-0026)", () => {
  describe("1. RS256 GitHub App JWT Signing (createGitHubAppJwt)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });

    it.each([
      {
        id: "signs-valid-rs256-jwt-with-clock-skew-and-9min-expiry",
        appId: "123456",
        nowEpoch: 1700000000,
        expectedIat: 1699999940,
        expectedExp: 1700000540
      },
      {
        id: "normalizes-escaped-newlines-in-pem-private-key",
        appId: "789012",
        nowEpoch: 1800000000,
        expectedIat: 1799999940,
        expectedExp: 1800000540
      }
    ])("$id", ({ appId, nowEpoch, expectedIat, expectedExp }) => {
      const pemInput =
        appId === "789012" ? privateKey.replace(/\n/g, "\\n") : privateKey;
      const token = createGitHubAppJwt(
        { appId, privateKeyPem: pemInput },
        nowEpoch
      );
      const segments = token.split(".");
      expect(segments).toHaveLength(3);

      const header = JSON.parse(
        Buffer.from(segments[0]!, "base64url").toString("utf8")
      ) as { alg: string; typ: string };
      const payload = JSON.parse(
        Buffer.from(segments[1]!, "base64url").toString("utf8")
      ) as { iat: number; exp: number; iss: string };

      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(payload).toEqual({
        iat: expectedIat,
        exp: expectedExp,
        iss: appId
      });

      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${segments[0]}.${segments[1]}`);
      verifier.end();
      const signatureValid = verifier.verify(
        publicKey,
        Buffer.from(segments[2]!, "base64url")
      );
      expect(signatureValid).toBe(true);
    });
  });

  describe("2. Implicit Grill Reply & Extended Slash Commands (Q84, Q85)", () => {
    it.each([
      {
        id: "parses-explicit-to-spec-slash-command",
        body: "/epure to-spec",
        expected: {
          command: "to-spec",
          args: ""
        }
      },
      {
        id: "parses-explicit-to-tickets-slash-command",
        body: "/epure to-tickets",
        expected: {
          command: "to-tickets",
          args: ""
        }
      },
      {
        id: "returns-null-on-natural-human-comment-in-direct-parser",
        body: "Simple commentaire sans slash command",
        expected: null
      }
    ])("$id", ({ body, expected }) => {
      const parsed = parseEpureCommand(body);
      expect(parsed).toEqual(expected);
    });

    it("authorizes implicit planning reply only for write/admin human users when allowImplicitPlanningReply is true", async () => {
      const authorized = await evaluateIssueCommandGate({
        repository: "Hartorn-Inc/enclume-astrale",
        issueNumber: 1,
        commentBody: "Voici mes réponses au grill : tout en mémoire.",
        actor: { login: "Hartorn", type: "User" },
        effectivePermission: { permission: "admin", role_name: "admin" },
        allowImplicitPlanningReply: true
      });
      expect(authorized.authorized).toBe(true);
      expect(authorized.command).toBe("reply");
      expect(authorized.llm_call_allowed).toBe(true);

      const deniedRead = await evaluateIssueCommandGate({
        repository: "Hartorn-Inc/enclume-astrale",
        issueNumber: 1,
        commentBody: "Voici mes réponses au grill : tout en mémoire.",
        actor: { login: "outsider", type: "User" },
        effectivePermission: { permission: "read", role_name: "read" },
        allowImplicitPlanningReply: true
      });
      expect(deniedRead.authorized).toBe(false);
      expect(deniedRead.error_code).toBe("INSUFFICIENT_EFFECTIVE_PERMISSION");
    });
  });

  describe("3. Gemini JSON Extraction & Pre-bundled Orchestrate Action", () => {
    it.each([
      {
        id: "extracts-direct-json-object",
        raw: '{"questions":["Q1","Q2"],"context_summary":"ok"}',
        expected: { questions: ["Q1", "Q2"], context_summary: "ok" }
      },
      {
        id: "extracts-json-from-markdown-code-fence",
        raw: 'Here is the plan:\n```json\n{"passed":true,"rationale":"clean"}\n```',
        expected: { passed: true, rationale: "clean" }
      },
      {
        id: "sanitizes-unescaped-latex-or-regex-backslashes-in-json-strings",
        raw: '{"formula":"T(B) = \\\\frac{B(B+1)}{2} and \\s+","ok":true}',
        expected: { formula: "T(B) = \\frac{B(B+1)}{2} and \\s+", ok: true }
      }
    ])("$id", ({ raw, expected }) => {
      expect(extractJsonObject(raw)).toEqual(expected);
    });

    it("ships the pre-bundled orchestrate-issue custom action", () => {
      expect(existsSync(ORCHESTRATE_ACTION_MANIFEST_PATH)).toBe(true);
      expect(existsSync(BUNDLED_ORCHESTRATE_ACTION_PATH)).toBe(true);
    });
  });

  describe("4. Multi-Turn /grill-with-docs Loop on Issues", () => {
    it.each([
      {
        id: "remains-in-grilling-and-posts-round-2-when-frontier-is-not-resolved",
        frontierResolved: false,
        followUpQuestions:
          "❓ **Q5** - **Format d'encodage URL** : Quel encodage compact utilises-tu ?\n➡️ **Recommandation** : `lz-string` ou Base64URL JSON.",
        expectedPhase: "grilling",
        expectedStatus: "active",
        expectedInSummary: "Round 2"
      },
      {
        id: "remains-in-grilling-awaiting-human-approval-when-frontier-is-resolved-on-reply",
        frontierResolved: true,
        followUpQuestions: "",
        expectedPhase: "grilling",
        expectedStatus: "awaiting_human_approval",
        expectedInSummary: "Frontière de Cadrage Résolue"
      }
    ])(
      "$id",
      async ({
        frontierResolved,
        followUpQuestions,
        expectedPhase,
        expectedStatus,
        expectedInSummary
      }) => {
        const store = createInMemoryGitRefStateStore();
        await updateIssueStateWithCas({
          issueNumber: 16,
          store,
          mutator: (prev) => ({
            ...prev,
            phase: "grilling",
            status: "active",
            active_branch: "plan/16-enclume-astrale"
          })
        });

        const postedComments: string[] = [];
        let geminiCallIndex = 0;

        const mockFetch = async (
          url: string | URL | Request,
          init?: RequestInit
        ): Promise<Response> => {
          const urlStr = String(url);
          const method = init?.method ?? "GET";

          // Gemini API calls
          if (urlStr.includes("generativelanguage.googleapis.com")) {
            geminiCallIndex += 1;
            if (geminiCallIndex === 1) {
              // First call during reply: GrillRoundEvaluation
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              frontier_resolved: frontierResolved,
                              round_number: 2,
                              follow_up_questions_markdown: followUpQuestions,
                              rationale: frontierResolved
                                ? "All architectural and domain questions answered."
                                : "Follow-up needed on URL encoding."
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }
            // Second call (when frontierResolved=true): Spec & Tickets bundle
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            plan_slug: "enclume-astrale",
                            glossary_markdown: "# GLOSSARY\n",
                            adrs: [
                              {
                                path: "docs/adr/0001-arch.md",
                                content: "# ADR 1\n"
                              }
                            ],
                            spec_path: "docs/specs/enclume-astrale.md",
                            spec_markdown: "# Spec\n",
                            tickets: [
                              {
                                index: 1,
                                slug: "core-math",
                                title: "[Ticket 1] Core math",
                                description: "Implement core math",
                                acceptance_criteria: ["S <= B"],
                                blocked_by_indices: [],
                                files_to_create_or_update: ["src/forge.ts"]
                              }
                            ]
                          })
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200 }
            );
          }

          // GitHub REST API mocks
          if (urlStr.endsWith("/issues/16") && method === "GET") {
            return new Response(
              JSON.stringify({
                number: 16,
                title: "[Plan] L'Enclume Astrale",
                body: "Cahier des charges initial"
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/issues/16/comments") && method === "GET") {
            return new Response(
              JSON.stringify([
                {
                  id: 101,
                  body: "### Entretien de Cadrage EPURE (`/grill-with-docs` — Round 1)\n❓ **Q1** ...",
                  user: { login: "hartorn-inc-epure-agent[bot]", type: "Bot" },
                  created_at: "2026-10-24T10:00:00Z"
                },
                {
                  id: 102,
                  body: "Réponse partielle de l'utilisateur sur Q1.",
                  user: { login: "Hartorn", type: "User" },
                  created_at: "2026-10-24T10:05:00Z"
                }
              ]),
              { status: 200 }
            );
          }
          if (urlStr.includes("/issues/16/comments") && method === "POST") {
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              body: string;
            };
            postedComments.push(parsed.body);
            return new Response(
              JSON.stringify({
                html_url: "https://github.com/Hartorn-Inc/enclume-astrale/issues/16#issuecomment-200"
              }),
              { status: 201 }
            );
          }
          if (urlStr.includes("/git/ref/heads/")) {
            return new Response(
              JSON.stringify({ object: { sha: "abc123456789" } }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/git/commits/")) {
            return new Response(
              JSON.stringify({
                sha: "newcommitsha",
                tree: { sha: "treeshaxxx" }
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/git/blobs") || urlStr.includes("/git/trees")) {
            return new Response(JSON.stringify({ sha: "blobortreesha" }), {
              status: 201
            });
          }
          if (urlStr.includes("/git/refs/heads/")) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          if (urlStr.includes("/labels")) {
            return new Response(JSON.stringify({ name: "ready-for-agent" }), {
              status: 201
            });
          }
          if (urlStr.endsWith("/issues") && method === "POST") {
            return new Response(
              JSON.stringify({
                number: 17,
                html_url: "https://github.com/Hartorn-Inc/enclume-astrale/issues/17"
              }),
              { status: 201 }
            );
          }

          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };

        const result = await orchestrateIssueCommand({
          repository: "Hartorn-Inc/enclume-astrale",
          issueNumber: 16,
          command: "reply",
          commandArgs: "Réponse partielle de l'utilisateur sur Q1.",
          commentId: 102,
          actor: "Hartorn",
          fallbackGithubToken: "ghs_mock",
          llmApiKey: "gemini_mock_key",
          stateStore: store,
          fetchImpl: mockFetch as typeof fetch
        });

        expect(result.executed).toBe(true);
        expect(result.phase).toBe(expectedPhase);
        expect(result.status).toBe(expectedStatus);
        expect(result.summary_markdown).toContain(expectedInSummary);
        expect(postedComments.length).toBe(1);
      }
    );

    it("repairs invalid escape sequences and raw newlines inside JSON string literals without corrupting valid \\\\s escapes", () => {
      const rawMalformedJson =
        '{"commit_message":"feat: test","files":[{"path":"src/App.tsx","content":"const re = /\\\\s+/g;\\nconst label = \\"L\\\'Enclume\nAstrale\\";"}]}';
      const parsed = extractJsonObject<{
        commit_message: string;
        files: Array<{ path: string; content: string }>;
      }>(rawMalformedJson);
      expect(parsed.commit_message).toBe("feat: test");
      expect(parsed.files[0]?.content).toContain("\\s+");
      expect(parsed.files[0]?.content).toContain("L\\'Enclume\nAstrale");
    });

    it("executes separate /epure to-spec (phase=spec, 0 tickets), human spec revision reply, and /epure to-tickets (phase=tickets, creates sub-issues)", async () => {
      const store = createInMemoryGitRefStateStore();
      await updateIssueStateWithCas({
        issueNumber: 16,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "awaiting_human_approval",
          active_branch: "plan/16-l-enclume-astrale"
        })
      });

      const postedComments: Array<{ id: number; body: string }> = [
        {
          id: 101,
          body: "### ✅ Frontière de Cadrage Résolue (`/grill-with-docs` — En attente de validation humaine)"
        }
      ];
      const createdSubIssues: number[] = [];
      let committedSpecContent = "";

      const mockFetch = async (
        url: string | URL | Request,
        init?: RequestInit
      ): Promise<Response> => {
        const urlStr = String(url);
        const method = init?.method ?? "GET";

        if (urlStr.includes("generativelanguage.googleapis.com")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}")) as {
            systemInstruction?: { parts?: Array<{ text?: string }> };
          };
          const sysText =
            parsedBody.systemInstruction?.parts?.[0]?.text ?? "";

          if (sysText.includes("SANS créer les tickets")) {
            committedSpecContent =
              "# Specification Enclume Astrale\n\n## Architecture\nDeterministic engine.\n";
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            plan_slug: "l-enclume-astrale",
                            glossary_markdown:
                              "# GLOSSARY\n\n- **Astral Anvil**: Deterministic forge.\n",
                            adrs: [
                              {
                                path: "docs/adr/0001-astral-anvil.md",
                                content:
                                  "# ADR 0001\n\n## Context\nForge.\n\n## Decision\nPure TS.\n\n## Consequences\nTestable.\n"
                              }
                            ],
                            spec_path: "docs/specs/l-enclume-astrale.md",
                            spec_markdown: committedSpecContent,
                            target_files_hint: ["src/forge.ts"]
                          })
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200 }
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
                          plan_slug: "l-enclume-astrale",
                          tickets: [
                            {
                              index: 1,
                              slug: "core-forge",
                              title: "[Ticket 1] Implement core forge engine",
                              description:
                                "Implement deterministic forge calculation module.",
                              acceptance_criteria: [
                                "Returns exact integer output for all valid inputs"
                              ],
                              blocked_by_indices: [],
                              files_to_create_or_update: ["src/forge.ts"]
                            }
                          ]
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }

        if (urlStr.endsWith("/issues/16") && method === "GET") {
          return new Response(
            JSON.stringify({
              number: 16,
              title: "[Plan] L'Enclume Astrale",
              body: "Cahier des charges initial"
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes("/issues/16/comments") && method === "GET") {
          return new Response(
            JSON.stringify(
              postedComments.map((c) => ({
                id: c.id,
                body: c.body,
                user: { login: "Hartorn", type: "User" },
                created_at: "2026-10-24T10:00:00Z"
              }))
            ),
            { status: 200 }
          );
        }
        if (urlStr.includes("/issues/16/comments") && method === "POST") {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            body: string;
          };
          postedComments.push({
            id: 200 + postedComments.length,
            body: parsed.body
          });
          return new Response(
            JSON.stringify({
              html_url:
                "https://github.com/Hartorn-Inc/enclume-astrale/issues/16#issuecomment-200"
            }),
            { status: 201 }
          );
        }
        if (urlStr.includes("/git/trees/") && method === "GET") {
          if (committedSpecContent) {
            return new Response(
              JSON.stringify({
                tree: [
                  {
                    path: "docs/specs/l-enclume-astrale.md",
                    type: "blob",
                    sha: "sha_spec_1"
                  },
                  {
                    path: "GLOSSARY.md",
                    type: "blob",
                    sha: "sha_glossary_1"
                  },
                  {
                    path: "docs/adr/0001-astral-anvil.md",
                    type: "blob",
                    sha: "sha_adr_1"
                  }
                ]
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ tree: [] }), { status: 200 });
        }
        if (urlStr.includes("/git/blobs/") && method === "GET") {
          const text = urlStr.endsWith("sha_glossary_1")
            ? "# GLOSSARY\n\n- **Astral Anvil**: Deterministic forge.\n"
            : urlStr.endsWith("sha_adr_1")
              ? "# ADR 0001\n\n## Context\nForge.\n\n## Decision\nPure TS.\n\n## Consequences\nTestable.\n"
              : committedSpecContent;
          return new Response(
            JSON.stringify({
              encoding: "base64",
              content: Buffer.from(text, "utf8").toString("base64")
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes("/git/ref/heads/")) {
          return new Response(
            JSON.stringify({ object: { sha: "abc123456789" } }),
            { status: 200 }
          );
        }
        if (urlStr.includes("/git/commits/")) {
          return new Response(
            JSON.stringify({
              sha: "newcommitsha",
              tree: { sha: "treeshaxxx" }
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes("/git/blobs") || urlStr.includes("/git/trees")) {
          return new Response(JSON.stringify({ sha: "blobortreesha" }), {
            status: 201
          });
        }
        if (urlStr.includes("/git/refs/heads/")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (urlStr.includes("/labels")) {
          return new Response(JSON.stringify({ name: "ready-for-agent" }), {
            status: 201
          });
        }
        if (urlStr.endsWith("/issues") && method === "POST") {
          const nextNum = 17 + createdSubIssues.length;
          createdSubIssues.push(nextNum);
          return new Response(
            JSON.stringify({
              number: nextNum,
              html_url: `https://github.com/Hartorn-Inc/enclume-astrale/issues/${nextNum}`
            }),
            { status: 201 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      // Step 1: /epure to-spec -> phase="spec", status="awaiting_human_approval", 0 tickets
      const toSpecResult = await orchestrateIssueCommand({
        repository: "Hartorn-Inc/enclume-astrale",
        issueNumber: 16,
        command: "to-spec",
        commandArgs: "",
        commentId: 105,
        actor: "Hartorn",
        fallbackGithubToken: "ghs_mock",
        llmApiKey: "gemini_mock_key",
        stateStore: store,
        fetchImpl: mockFetch as typeof fetch
      });

      expect(toSpecResult.executed).toBe(true);
      expect(toSpecResult.phase).toBe("spec");
      expect(toSpecResult.status).toBe("awaiting_human_approval");
      expect(toSpecResult.created_ticket_numbers).toEqual([]);
      expect(toSpecResult.summary_markdown).toContain("/epure to-tickets");

      // Step 2: Free-form reply during phase="spec" revises the spec and stays in phase="spec"
      const specReplyResult = await orchestrateIssueCommand({
        repository: "Hartorn-Inc/enclume-astrale",
        issueNumber: 16,
        command: "reply",
        commandArgs: "Ajoute une précision sur l'arrondi dans la section 2.",
        commentId: 106,
        actor: "Hartorn",
        fallbackGithubToken: "ghs_mock",
        llmApiKey: "gemini_mock_key",
        stateStore: store,
        fetchImpl: mockFetch as typeof fetch
      });

      expect(specReplyResult.executed).toBe(true);
      expect(specReplyResult.phase).toBe("spec");
      expect(specReplyResult.status).toBe("awaiting_human_approval");
      expect(specReplyResult.created_ticket_numbers).toEqual([]);
      expect(specReplyResult.summary_markdown).toContain("Spécification révisée");

      // Step 3: /epure to-tickets -> phase="tickets", status="awaiting_human_approval", creates sub-issues
      const toTicketsResult = await orchestrateIssueCommand({
        repository: "Hartorn-Inc/enclume-astrale",
        issueNumber: 16,
        command: "to-tickets",
        commandArgs: "",
        commentId: 107,
        actor: "Hartorn",
        fallbackGithubToken: "ghs_mock",
        llmApiKey: "gemini_mock_key",
        stateStore: store,
        fetchImpl: mockFetch as typeof fetch
      });

      expect(toTicketsResult.executed).toBe(true);
      expect(toTicketsResult.phase).toBe("tickets");
      expect(toTicketsResult.status).toBe("awaiting_human_approval");
      expect(toTicketsResult.created_ticket_numbers).toEqual([17]);
      expect(toTicketsResult.summary_markdown).toContain("/epure approve");
    });
  });

  describe("5. Polyglot Stage 1 Security Gate, Stage 3 External CI Recovery & Open-PR Reconciliation (ADR-0028)", () => {
    it.each([
      {
        id: "pre-stage1-sensitive-path-violation-escalates-to-needs-human-and-suspends",
        scenario: "sensitive_path" as const,
        expectedPhase: "implementation",
        expectedStatus: "suspended",
        expectedAppliedLabels: ["needs-human"],
        expectedSummarySubstring: ".github/agents.yml"
      },
      {
        id: "stage3-external-ci-failure-recovery-feeds-sanitized-logs-to-gemini-and-merges-on-attempt-2",
        scenario: "stage3_ci_recovery" as const,
        expectedPhase: "completed",
        expectedStatus: "done",
        expectedAppliedLabels: [] as string[],
        expectedSummarySubstring:
          "PR #25 squash-merged into `feature/16-l-enclume-astrale`"
      },
      {
        id: "pre-generation-open-pr-reconciliation-q110-repairs-existing-open-pr-without-duplicate-pr",
        scenario: "open_pr_reconciliation" as const,
        expectedPhase: "completed",
        expectedStatus: "done",
        expectedAppliedLabels: [] as string[],
        expectedSummarySubstring:
          "PR #25 squash-merged into `feature/16-l-enclume-astrale`"
      },
      {
        id: "leaf-issue-open-feature-pr-reconciliation-skips-ticket-loop-and-commits-deleted-files-with-null-sha",
        scenario: "leaf_feature_pr_reconciliation_with_deleted_files" as const,
        expectedPhase: "completed",
        expectedStatus: "done",
        expectedAppliedLabels: [] as string[],
        expectedSummarySubstring:
          "previously squash-merged into `feature/16-l-enclume-astrale`"
      }
    ])(
      "$id",
      async ({
        scenario,
        expectedPhase,
        expectedStatus,
        expectedAppliedLabels,
        expectedSummarySubstring
      }) => {
        const store = createInMemoryGitRefStateStore();
        await updateIssueStateWithCas({
          issueNumber: 16,
          store,
          mutator: (prev) => ({
            ...prev,
            phase: "tickets",
            status: "awaiting_human_approval",
            active_branch: "plan/16-enclume-astrale"
          })
        });

        const appliedLabels: string[] = [];
        const createdTaskPrCalls: Array<{ head: string; base: string }> = [];
        const postedGitTrees: Array<
          Array<{ path: string; mode: string; type: string; sha: string | null }>
        > = [];
        const geminiPrompts: string[] = [];
        let commitCounter = 0;

        const mockFetch = async (
          url: string | URL | Request,
          init?: RequestInit
        ): Promise<Response> => {
          const urlStr = String(url);
          const method = init?.method ?? "GET";

          // 1. Gemini API calls
          if (urlStr.includes("generativelanguage.googleapis.com")) {
            const parsedReq = JSON.parse(String(init?.body ?? "{}")) as {
              systemInstruction?: { parts?: Array<{ text?: string }> };
              contents?: Array<{ parts?: Array<{ text?: string }> }>;
            };
            const sysText =
              parsedReq.systemInstruction?.parts?.[0]?.text ?? "";
            const userPrompt =
              parsedReq.contents?.[0]?.parts?.[0]?.text ?? "";
            geminiPrompts.push(userPrompt);

            // Reviewer pass or squash commit synthesis
            if (
              sysText.includes("reviewer") ||
              sysText.includes("Revue") ||
              userPrompt.includes("findings") ||
              userPrompt.includes("Rédige un message de commit")
            ) {
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              summary: "All checks and invariants verified.",
                              findings: [],
                              pr_title:
                                "feat(forge): implement astral forge formulas",
                              commit_title:
                                "feat(forge): implement astral forge formulas (#25)",
                              commit_body: "- Verified quadratic formula"
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }

            if (scenario === "sensitive_path") {
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              commit_message: "feat: attempt tampering",
                              test_summary: "tampered",
                              files: [
                                {
                                  path: ".github/agents.yml",
                                  content: "harness: codex\n"
                                },
                                {
                                  path: "src/forge.ts",
                                  content: "export const x = 1;\n"
                                }
                              ]
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
              );
            }

            // Initial TDD generation or Post-PR Stage 3 remediation fix
            if (userPrompt.includes("<untrusted_test_output>")) {
              return new Response(
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              commit_message:
                                "fix(review): repair external CI failure on #16",
                              test_summary:
                                "Repaired TypeScript type error reported by Stage 3 CI",
                              files: [
                                {
                                  path: "src/forge.ts",
                                  content:
                                    "export const computeCost = (b: number): number => (b * (b + 1)) / 2;\n"
                                }
                              ],
                              deleted_files:
                                scenario ===
                                "leaf_feature_pr_reconciliation_with_deleted_files"
                                  ? ["src/legacy-dup.ts"]
                                  : undefined
                            })
                          }
                        ]
                      }
                    }
                  ]
                }),
                { status: 200 }
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
                            commit_message:
                              "feat(ticket-16): initial forge implementation",
                            test_summary: "Unit tests pass",
                            files: [
                              {
                                path: "src/forge.ts",
                                content:
                                  "export const computeCost = (b: number): number => (b * (b + 1)) / 2;\n"
                              }
                            ]
                          })
                        }
                      ]
                    }
                  }
                ]
              }),
              { status: 200 }
            );
          }

          // 2. GitHub REST API mocks
          if (urlStr.endsWith("/issues/16") && method === "GET") {
            return new Response(
              JSON.stringify({
                number: 16,
                title: "[Plan] L'Enclume Astrale",
                body: "- [ ] Implement `src/forge.ts`",
                state: "open"
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/issues/16/comments") && method === "GET") {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          if (urlStr.includes("/issues/16/labels") && method === "POST") {
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              labels?: string[];
            };
            appliedLabels.push(...(parsed.labels ?? []));
            return new Response(JSON.stringify(appliedLabels), { status: 200 });
          }
          if (urlStr.includes("/git/commits") && method === "POST") {
            commitCounter += 1;
            return new Response(
              JSON.stringify({
                sha: `commit_sha_${commitCounter}`,
                tree: { sha: "tree_sha" }
              }),
              { status: 201 }
            );
          }
          if (urlStr.includes("/git/commits/") && method === "GET") {
            return new Response(
              JSON.stringify({
                sha: "parent_sha",
                tree: { sha: "tree_sha" }
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/git/ref/heads/")) {
            return new Response(
              JSON.stringify({
                object: {
                  sha:
                    commitCounter > 0
                      ? `commit_sha_${commitCounter}`
                      : "base_sha_0"
                }
              }),
              { status: 200 }
            );
          }
          if (
            urlStr.includes("/git/trees/") &&
            method === "GET" &&
            (scenario === "open_pr_reconciliation" ||
              scenario === "leaf_feature_pr_reconciliation_with_deleted_files")
          ) {
            return new Response(
              JSON.stringify({
                tree: [
                  {
                    path: "src/forge.ts",
                    type: "blob",
                    sha: "blob_existing_forge"
                  }
                ]
              }),
              { status: 200 }
            );
          }
          if (
            urlStr.endsWith("/git/blobs/blob_existing_forge") &&
            method === "GET"
          ) {
            return new Response(
              JSON.stringify({
                content: Buffer.from(
                  "export const computeCost = (b: number): number => 0;\n",
                  "utf8"
                ).toString("base64"),
                encoding: "base64"
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/git/trees") && method === "POST") {
            const parsedTree = JSON.parse(String(init?.body ?? "{}")) as {
              tree?: Array<{
                path: string;
                mode: string;
                type: string;
                sha: string | null;
              }>;
            };
            if (Array.isArray(parsedTree.tree)) {
              postedGitTrees.push(parsedTree.tree);
            }
            return new Response(
              JSON.stringify({ sha: "blob_or_tree_sha", tree: [] }),
              { status: 201 }
            );
          }
          if (urlStr.includes("/git/blobs") || urlStr.includes("/git/trees")) {
            return new Response(
              JSON.stringify({ sha: "blob_or_tree_sha", tree: [] }),
              { status: 201 }
            );
          }
          if (urlStr.endsWith("/pulls/26/files") && method === "GET") {
            if (
              scenario === "leaf_feature_pr_reconciliation_with_deleted_files"
            ) {
              return new Response(
                JSON.stringify([
                  { filename: "src/forge.ts", status: "modified" },
                  { filename: "src/obsolete.ts", status: "removed" }
                ]),
                { status: 200 }
              );
            }
            return new Response(JSON.stringify([]), { status: 200 });
          }
          if (urlStr.includes("/pulls?") && method === "GET") {
            if (
              scenario === "open_pr_reconciliation" &&
              urlStr.includes("task%2F16-")
            ) {
              return new Response(
                JSON.stringify([
                  {
                    number: 25,
                    html_url:
                      "https://github.com/Hartorn-Inc/enclume-astrale/pull/25",
                    title: "feat(ticket-16): existing open PR",
                    body: "Existing PR body",
                    head: { sha: "sha_existing_broken_pr" }
                  }
                ]),
                { status: 200 }
              );
            }
            if (
              scenario ===
                "leaf_feature_pr_reconciliation_with_deleted_files" &&
              urlStr.includes("feature%2F16-") &&
              urlStr.includes("base=dev")
            ) {
              return new Response(
                JSON.stringify([
                  {
                    number: 26,
                    html_url:
                      "https://github.com/Hartorn-Inc/enclume-astrale/pull/26",
                    title: "feat(forge): existing feature PR",
                    body: "Existing feature PR body",
                    head: { sha: "sha_existing_broken_feature_pr" }
                  }
                ]),
                { status: 200 }
              );
            }
            return new Response(JSON.stringify([]), { status: 200 });
          }
          if (urlStr.endsWith("/pulls") && method === "POST") {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              head: string;
              base: string;
            };
            if (body.head.startsWith("task/")) {
              createdTaskPrCalls.push({ head: body.head, base: body.base });
              return new Response(
                JSON.stringify({
                  number: 25,
                  html_url:
                    "https://github.com/Hartorn-Inc/enclume-astrale/pull/25",
                  head: { sha: "commit_sha_1" }
                }),
                { status: 201 }
              );
            }
            return new Response(
              JSON.stringify({
                number: 26,
                html_url:
                  "https://github.com/Hartorn-Inc/enclume-astrale/pull/26",
                head: { sha: "feature_head_sha" }
              }),
              { status: 201 }
            );
          }
          if (urlStr.includes("/commits/") && urlStr.includes("/check-runs")) {
            const isFailingAttempt1 =
              (scenario === "stage3_ci_recovery" &&
                urlStr.includes("/commits/commit_sha_1/check-runs")) ||
              (scenario === "open_pr_reconciliation" &&
                urlStr.includes("/commits/sha_existing_broken_pr/check-runs")) ||
              (scenario ===
                "leaf_feature_pr_reconciliation_with_deleted_files" &&
                urlStr.includes(
                  "/commits/sha_existing_broken_feature_pr/check-runs"
                ));
            if (isFailingAttempt1) {
              return new Response(
                JSON.stringify({
                  check_runs: [
                    {
                      id: 901,
                      name: "Backend CI (Postgres + Vitest)",
                      status: "completed",
                      conclusion: "failure",
                      html_url:
                        "https://github.com/Hartorn-Inc/enclume-astrale/runs/901"
                    }
                  ]
                }),
                { status: 200 }
              );
            }
            return new Response(
              JSON.stringify({
                check_runs: [
                  {
                    id: 902,
                    name: "Backend CI (Postgres + Vitest)",
                    status: "completed",
                    conclusion: "success",
                    html_url:
                      "https://github.com/Hartorn-Inc/enclume-astrale/runs/902"
                  }
                ]
              }),
              { status: 200 }
            );
          }
          if (urlStr.endsWith("/actions/jobs/901/logs")) {
            return new Response(
              [
                "2026-10-26T10:00:00.000Z \x1b[31msrc/forge.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\x1b[0m",
                "::set-env name=INJECTED::1",
                "Leaked key: AIzaSyD-1234567890abcdefghijklmnopqrstu"
              ].join("\n"),
              { status: 200 }
            );
          }
          if (urlStr.includes("/actions/runs")) {
            return new Response(JSON.stringify({ workflow_runs: [] }), {
              status: 200
            });
          }

          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };

        const result = await orchestrateIssueCommand({
          repository: "Hartorn-Inc/enclume-astrale",
          issueNumber: 16,
          command: "approve",
          commandArgs: "",
          commentId: 300,
          actor: "Hartorn",
          fallbackGithubToken: "ghs_mock_token",
          llmApiKey: "gemini_mock_key",
          stateStore: store,
          fetchImpl: mockFetch as typeof fetch,
          sleepFn: async () => {},
          sandboxRunner: async () => ({
            isolated: true,
            error_code: "NONE",
            error_message: "",
            proxy_url: "http://127.0.0.1:0/v1/llm",
            exit_code: 0,
            stdout: "PASS",
            stderr: "",
            duration_ms: 5,
            sanitized_env: {}
          })
        });

        expect(result.executed).toBe(true);
        expect(result.phase).toBe(expectedPhase);
        expect(result.status).toBe(expectedStatus);
        expect(appliedLabels).toEqual(expectedAppliedLabels);
        expect(result.summary_markdown).toContain(expectedSummarySubstring);

        if (scenario === "stage3_ci_recovery") {
          const remediationPrompt = geminiPrompts.find((p) =>
            p.includes("<untrusted_test_output>")
          );
          expect(remediationPrompt).toBeDefined();
          expect(remediationPrompt).toContain("error TS2322");
          expect(remediationPrompt).toContain(":[set-env]");
          expect(remediationPrompt).not.toContain("::set-env");
          expect(remediationPrompt).not.toContain(
            "AIzaSyD-1234567890abcdefghijklmnopqrstu"
          );
        }

        if (scenario === "open_pr_reconciliation") {
          // Existing open PR #25 was reconciled without creating a duplicate task PR
          expect(createdTaskPrCalls).toHaveLength(0);
        }

        if (scenario === "leaf_feature_pr_reconciliation_with_deleted_files") {
          // Ticket loop was skipped; only the feature-level remediation PR was opened
          expect(createdTaskPrCalls).toEqual([
            {
              head: "task/review-fix-16-1",
              base: "feature/16-l-enclume-astrale"
            }
          ]);
          const allTreeEntries = postedGitTrees.flat();
          expect(allTreeEntries).toContainEqual({
            path: "src/legacy-dup.ts",
            mode: "100644",
            type: "blob",
            sha: null
          });
        }
      }
    );
  });
});

