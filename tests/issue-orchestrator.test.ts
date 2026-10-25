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
        id: "transitions-to-tickets-and-generates-spec-when-frontier-is-resolved",
        frontierResolved: true,
        followUpQuestions: "",
        expectedPhase: "tickets",
        expectedStatus: "awaiting_human_approval",
        expectedInSummary: "Spécification, Roster Adapté et Graphe de Tickets générés"
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
  });
});
