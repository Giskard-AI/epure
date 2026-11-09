import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEngine, AgentSessionRequest } from "../src/agent/engine.js";
import { runGrillAndPlanPhase } from "../src/orchestrator/phases/grill-and-plan.js";
import type {
  GitHubRestHelper,
  IssueCommentRecord,
  IssueMetadata,
  ResolvedPhaseModels
} from "../src/orchestrator/types.js";
import { createInMemoryGitRefStateStore } from "../src/state/git-ref-state.js";

const TEST_PHASE_MODELS: ResolvedPhaseModels = {
  planningModel: "openai/gpt-4.1",
  implementationModel: "openai/gpt-4.1",
  reviewModel: "openai/gpt-4.1",
  maxTransientRetries: 0,
  transientRetryBackoffSeconds: [0]
};

const TEST_ISSUE: IssueMetadata = {
  number: 42,
  title: "Add deterministic token bucket rate limiter",
  body: "Implement a token bucket rate limiter with configurable burst and refill rate.",
  state: "open"
};

function createMockPlanningGh(options?: {
  readonly existingSpecContent?: string | undefined;
  readonly committedBranches?: Array<{
    branch: string;
    files: ReadonlyArray<{ path: string; content: string }>;
  }>;
  readonly postedComments?: string[];
  readonly createdTickets?: Array<{ number: number; title: string; body: string }>;
}): GitHubRestHelper {
  const committedBranches = options?.committedBranches ?? [];
  const postedComments = options?.postedComments ?? [];
  const createdTickets = options?.createdTickets ?? [];
  let nextTicketNum = 501;

  const partialGh: Partial<GitHubRestHelper> = {
    ensureBranch: async () => "sha-dev",
    listBranchesByPrefix: async () => [],
    readSingleBranchFile: async (_ref: string, path: string) => {
      if (path.startsWith("docs/specs/") && options?.existingSpecContent) {
        return options.existingSpecContent;
      }
      if (path === "GLOSSARY.md") {
        return "# Glossary\n\n- **Token Bucket**: Deterministic rate limiting algorithm.\n";
      }
      if (path.startsWith("docs/adr/")) {
        return "# ADR 0001\n\n## Context\nRate limiting.\n\n## Decision\nUse token bucket.\n\n## Consequences\nBounded throughput.\n";
      }
      return null;
    },
    readTrustedBaseRosterFiles: async () =>
      new Map([
        [".agents/reviewers/standards-reviewer.md", "# Standards Reviewer\n"]
      ]),
    commitFilesToBranch: async (params: {
      branch: string;
      files: ReadonlyArray<{ path: string; content: string }>;
    }) => {
      committedBranches.push({
        branch: params.branch,
        files: params.files
      });
      return "sha-plan-commit";
    },
    postIssueComment: async (_issueNumber: number, body: string) => {
      postedComments.push(body);
      return "https://github.com/Giskard-AI/epure/issues/42#issuecomment-1";
    },
    removeIssueLabel: async () => {},
    ensureLabel: async () => {},
    addIssueLabels: async () => {},
    listSubIssueNumbers: async () => [],
    getIssue: async (num: number) => ({
      number: num,
      title: TEST_ISSUE.title,
      body: TEST_ISSUE.body,
      state: "open"
    }),
    createIssue: async (params: { title: string; body: string }) => {
      const num = nextTicketNum++;
      createdTickets.push({
        number: num,
        title: params.title,
        body: params.body
      });
      return {
        number: num,
        html_url: `https://github.com/Giskard-AI/epure/issues/${num}`
      };
    },
    addSubIssue: async () => {},
    addIssueBlockedByDependency: async () => {},
    updateIssue: async () => {}
  };
  return partialGh as GitHubRestHelper;
}

describe("Slice 3b — Pi agentEngine wiring for griller, spec_writer and ticket_splitter (#99)", () => {
  it.each([
    {
      id: "runs griller in read_only mode on /epure reply and resolves frontier when JSON evaluation is returned",
      command: "reply" as const,
      currentPhase: "grilling",
      finalMessage: JSON.stringify({
        frontier_resolved: true,
        round_number: 2,
        follow_up_questions_markdown: "",
        settled_decisions_summary_markdown:
          "- **Refill strategy**: Monotonic clock refill with integer tokens.",
        rationale: "All architectural questions have been answered."
      }),
      expectedStatus: "awaiting_human_approval",
      expectedCommentSubstring: "Monotonic clock refill with integer tokens",
      expectFallbackFetchCalled: false
    },
    {
      id: "runs griller in read_only mode on /epure plan and posts round 1 questions from agentEngine",
      command: "plan" as const,
      currentPhase: undefined,
      finalMessage:
        "❓ **Q1** - ** Burst Capacity ** : Should burst capacity be configurable per tenant?\n➡️ Default to 100 tokens per tenant.",
      expectedStatus: "active",
      expectedCommentSubstring: "Burst Capacity",
      expectFallbackFetchCalled: false
    },
    {
      id: "falls back cleanly to callLlmJson when griller returns non-JSON on /epure reply",
      command: "reply" as const,
      currentPhase: "grilling",
      finalMessage: "Plain text without JSON structure",
      expectedStatus: "active",
      expectedCommentSubstring: "Fallback follow-up question Q2",
      expectFallbackFetchCalled: true
    }
  ])(
    "$id",
    async ({
      command,
      currentPhase,
      finalMessage,
      expectedStatus,
      expectedCommentSubstring,
      expectFallbackFetchCalled
    }) => {
      const seenRequests: AgentSessionRequest[] = [];
      let fallbackFetchCount = 0;
      const postedComments: string[] = [];

      const engine: AgentEngine = {
        name: "pi",
        run: async (req) => {
          seenRequests.push(req);
          expect(existsSync(req.worktree)).toBe(true);
          return {
            finalMessage,
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
                    frontier_resolved: false,
                    round_number: 2,
                    follow_up_questions_markdown:
                      "❓ **Q2** - **Fallback follow-up question Q2**",
                    settled_decisions_summary_markdown: "",
                    rationale: "Needs one more round."
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const allComments: IssueCommentRecord[] = [
        {
          id: 10,
          body: "### Entretien de Cadrage EPURE (`/grill-with-docs` — Round 1)\n\n❓ **Q1** : Question 1",
          user: { login: "epure-bot[bot]", type: "Bot" },
          created_at: "2026-11-09T10:00:00Z"
        },
        {
          id: 11,
          body: "Yes, validated for Q1.",
          user: { login: "alice", type: "User" },
          created_at: "2026-11-09T10:05:00Z"
        }
      ];

      const res = await runGrillAndPlanPhase({
        command,
        currentPhase,
        currentStatus: "active",
        planManifest: null,
        specManifest: null,
        epureIdentity: { appId: 12345 },
        repository: "Giskard-AI/epure",
        issueNumber: TEST_ISSUE.number,
        commentId: 11,
        issue: TEST_ISSUE,
        allComments,
        planSlug: "42-token-bucket",
        planBranch: "plan/42-token-bucket",
        gh: createMockPlanningGh({ postedComments }),
        store: createInMemoryGitRefStateStore(),
        llmApiKey: "test-key",
        phaseModels: TEST_PHASE_MODELS,
        fetchImpl,
        agentEngine: engine
      });

      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]?.role).toBe("griller");
      expect(seenRequests[0]?.toolPolicy).toBe("read_only");
      expect(res.phase).toBe("grilling");
      expect(res.status).toBe(expectedStatus);
      expect(postedComments.at(-1)).toContain(expectedCommentSubstring);
      expect(fallbackFetchCount > 0).toBe(expectFallbackFetchCalled);
    }
  );

  it.each([
    {
      id: "runs spec_writer in write mode and extracts spec file written to docs/specs/*.md on disk",
      mode: "disk_write" as const,
      expectedSpecContent:
        "# Token Bucket Specification\n\n## Architecture\n\nWHEN a request arrives, TokenBucket consumes 1 token.\n",
      expectFallbackFetchCalled: false
    },
    {
      id: "runs spec_writer in write mode and parses GeneratedSpecArtifacts JSON from finalMessage",
      mode: "json_message" as const,
      expectedSpecContent:
        "# Token Bucket Specification (JSON)\n\n## Invariants\n\nTokenBucket enforces burst capacity.\n",
      expectFallbackFetchCalled: false
    },
    {
      id: "falls back cleanly to callLlmJson when spec_writer writes no files and returns non-JSON text",
      mode: "fallback" as const,
      expectedSpecContent:
        "# Fallback Token Bucket Specification\n\n## Fallback\n\nGenerated via callLlmJson fallback.\n",
      expectFallbackFetchCalled: true
    }
  ])(
    "$id",
    async ({ mode, expectedSpecContent, expectFallbackFetchCalled }) => {
      const seenRequests: AgentSessionRequest[] = [];
      let fallbackFetchCount = 0;
      const committedBranches: Array<{
        branch: string;
        files: ReadonlyArray<{ path: string; content: string }>;
      }> = [];
      const postedComments: string[] = [];

      const engine: AgentEngine = {
        name: "pi",
        run: async (req) => {
          seenRequests.push(req);
          expect(existsSync(req.worktree)).toBe(true);
          if (mode === "disk_write") {
            const specFull = join(
              req.worktree,
              "docs/specs/42-token-bucket.md"
            );
            mkdirSync(dirname(specFull), { recursive: true });
            writeFileSync(specFull, expectedSpecContent, "utf8");
            const adrFull = join(
              req.worktree,
              "docs/adr/0001-token-bucket.md"
            );
            mkdirSync(dirname(adrFull), { recursive: true });
            writeFileSync(
              adrFull,
              "# ADR 0001\n\n## Context\nRate limiter.\n\n## Decision\nToken bucket.\n\n## Consequences\nDeterministic.\n",
              "utf8"
            );
            return {
              finalMessage: "Wrote specification and ADR to worktree.",
              diff: { files: [], deleted_files: [], skipped: [] }
            };
          }
          if (mode === "json_message") {
            return {
              finalMessage: JSON.stringify({
                plan_slug: "42-token-bucket",
                glossary_markdown:
                  "# Glossary\n\n- **TokenBucket**: Rate limiter module.\n",
                adrs: [
                  {
                    path: "docs/adr/0001-token-bucket.md",
                    content:
                      "# ADR 0001\n\n## Context\nRate limiter.\n\n## Decision\nToken bucket.\n\n## Consequences\nDeterministic.\n"
                  }
                ],
                spec_path: "docs/specs/42-token-bucket.md",
                spec_markdown: expectedSpecContent,
                target_files_hint: ["src/rate-limiter.ts"]
              }),
              diff: { files: [], deleted_files: [], skipped: [] }
            };
          }
          return {
            finalMessage: "Unstructured plain text without spec",
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
                    plan_slug: "42-token-bucket",
                    glossary_markdown:
                      "# Glossary\n\n- **TokenBucket**: Rate limiter module.\n",
                    adrs: [
                      {
                        path: "docs/adr/0001-token-bucket.md",
                        content:
                          "# ADR 0001\n\n## Context\nRate limiter.\n\n## Decision\nToken bucket.\n\n## Consequences\nDeterministic.\n"
                      }
                    ],
                    spec_path: "docs/specs/42-token-bucket.md",
                    spec_markdown: expectedSpecContent,
                    target_files_hint: ["src/rate-limiter.ts"]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const res = await runGrillAndPlanPhase({
        command: "to-spec",
        currentPhase: "grilling",
        currentStatus: "awaiting_human_approval",
        planManifest: null,
        specManifest: null,
        epureIdentity: { appId: 12345 },
        repository: "Giskard-AI/epure",
        issueNumber: TEST_ISSUE.number,
        commentId: 20,
        issue: TEST_ISSUE,
        allComments: [],
        planSlug: "42-token-bucket",
        planBranch: "plan/42-token-bucket",
        gh: createMockPlanningGh({ committedBranches, postedComments }),
        store: createInMemoryGitRefStateStore(),
        llmApiKey: "test-key",
        phaseModels: TEST_PHASE_MODELS,
        fetchImpl,
        agentEngine: engine
      });

      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]?.role).toBe("spec_writer");
      expect(seenRequests[0]?.toolPolicy).toBe("write");
      expect(res.phase).toBe("spec");
      expect(res.status).toBe("awaiting_human_approval");
      expect(committedBranches).toHaveLength(1);
      const specFile = committedBranches[0]?.files.find(
        (f) => f.path === "docs/specs/42-token-bucket.md"
      );
      expect(specFile?.content).toBe(expectedSpecContent);
      expect(fallbackFetchCount > 0).toBe(expectFallbackFetchCalled);
    }
  );

  it.each([
    {
      id: "runs ticket_splitter in read_only mode and creates linked tickets from JSON DAG",
      finalMessage: JSON.stringify({
        tickets: [
          {
            index: 1,
            slug: "token-bucket-core",
            title: "[Ticket 1] Implement TokenBucket core state machine",
            description:
              "Create src/rate-limiter.ts implementing TokenBucket refill and consume.",
            acceptance_criteria: [
              "WHEN consume(1) is called with available tokens, TokenBucket returns true."
            ],
            blocked_by_indices: [],
            files_to_create_or_update: ["src/rate-limiter.ts"]
          },
          {
            index: 2,
            slug: "token-bucket-wiring",
            title: "[Ticket 2] Wire TokenBucket into API middleware",
            description:
              "Integrate TokenBucket into src/middleware.ts and verify end-to-end.",
            acceptance_criteria: [
              "WHEN burst limit is exceeded, middleware returns HTTP 429."
            ],
            blocked_by_indices: [1],
            files_to_create_or_update: ["src/middleware.ts"]
          }
        ]
      }),
      expectedTicketCount: 2,
      expectedFirstTicketTitle:
        "[Ticket 1] Implement TokenBucket core state machine",
      expectFallbackFetchCalled: false
    },
    {
      id: "falls back cleanly to callLlmJson when ticket_splitter returns non-JSON output",
      finalMessage: "Plain text without ticket DAG JSON",
      expectedTicketCount: 1,
      expectedFirstTicketTitle: "[Ticket 1] Fallback ticket from callLlmJson",
      expectFallbackFetchCalled: true
    }
  ])(
    "$id",
    async ({
      finalMessage,
      expectedTicketCount,
      expectedFirstTicketTitle,
      expectFallbackFetchCalled
    }) => {
      const seenRequests: AgentSessionRequest[] = [];
      let fallbackFetchCount = 0;
      const createdTickets: Array<{
        number: number;
        title: string;
        body: string;
      }> = [];

      const engine: AgentEngine = {
        name: "pi",
        run: async (req) => {
          seenRequests.push(req);
          expect(existsSync(req.worktree)).toBe(true);
          expect(
            existsSync(join(req.worktree, "docs/specs/42-token-bucket.md"))
          ).toBe(true);
          return {
            finalMessage,
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
                    tickets: [
                      {
                        index: 1,
                        slug: "fallback-ticket",
                        title: "[Ticket 1] Fallback ticket from callLlmJson",
                        description: "Fallback ticket description.",
                        acceptance_criteria: [
                          "WHEN called, module returns expected value."
                        ],
                        blocked_by_indices: [],
                        files_to_create_or_update: ["src/rate-limiter.ts"]
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const res = await runGrillAndPlanPhase({
        command: "to-tickets",
        currentPhase: "spec",
        currentStatus: "awaiting_human_approval",
        planManifest: null,
        specManifest: {
          planBranch: "plan/42-token-bucket",
          specPath: "docs/specs/42-token-bucket.md",
          adrPaths: ["docs/adr/0001-token-bucket.md"],
          targetFilesHint: ["src/rate-limiter.ts"]
        },
        epureIdentity: { appId: 12345 },
        repository: "Giskard-AI/epure",
        issueNumber: TEST_ISSUE.number,
        commentId: 30,
        issue: TEST_ISSUE,
        allComments: [],
        planSlug: "42-token-bucket",
        planBranch: "plan/42-token-bucket",
        gh: createMockPlanningGh({
          existingSpecContent:
            "# Approved Spec\n\n## Details\n\nTokenBucket specification.\n",
          createdTickets
        }),
        store: createInMemoryGitRefStateStore(),
        llmApiKey: "test-key",
        phaseModels: TEST_PHASE_MODELS,
        fetchImpl,
        agentEngine: engine
      });

      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]?.role).toBe("ticket_splitter");
      expect(seenRequests[0]?.toolPolicy).toBe("read_only");
      expect(res.phase).toBe("tickets");
      expect(res.created_ticket_numbers).toHaveLength(expectedTicketCount);
      expect(createdTickets[0]?.title).toBe(expectedFirstTicketTitle);
      expect(fallbackFetchCount > 0).toBe(expectFallbackFetchCalled);
    }
  );
});
