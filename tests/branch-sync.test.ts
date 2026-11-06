import { describe, expect, it } from "vitest";
import { syncBranchWithBase } from "../src/orchestrator/github/branch-sync.js";
import { createGitHubRestHelper } from "../src/orchestrator/github/rest-client.js";
import type {
  EscalateToNeedsHumanFn,
  OrchestrateIssueResult
} from "../src/orchestrator/types.js";
import {
  createGitHubMockRouter,
  installFakeGitDataApi,
  json,
  type FakeGitDataApi,
  type GitHubMockRouter
} from "./fixtures/github-mock-router.js";

const REPO = "acme/demo";
const FEATURE = "feature/42-sync";

type Escalation = Parameters<EscalateToNeedsHumanFn>[0];

const SUSPENDED: OrchestrateIssueResult = {
  executed: true,
  phase: "implementation",
  status: "suspended",
  active_branch: FEATURE,
  summary_markdown: "",
  created_ticket_numbers: [],
  feature_pr_url: ""
};

interface Divergence {
  readonly shared: Readonly<Record<string, string>>;
  readonly ours: Readonly<Record<string, string | null>>;
  readonly theirs: Readonly<Record<string, string | null>>;
}

function setup(divergence: Divergence) {
  const router = createGitHubMockRouter();
  const git = installFakeGitDataApi(router, REPO);
  git.commitFiles("dev", divergence.shared, "shared history");
  git.setRef(`refs/heads/${FEATURE}`, git.getRef("refs/heads/dev")!);
  git.commitFiles(FEATURE, divergence.ours, "feature work");
  git.commitFiles("dev", divergence.theirs, "dev work");
  const gh = createGitHubRestHelper({ repository: REPO, token: "ghs_test", fetchImpl: router.fetch });
  return { router, git, gh };
}

function answerConflictResolution(
  router: GitHubMockRouter,
  resolvedFiles: ReadonlyArray<{ path: string; content: string }>
): void {
  router.onHost(
    "api.openai.com",
    "POST",
    "/v1/chat/completions",
    json({
      choices: [{ message: { content: JSON.stringify({ summary: "merged", resolved_files: resolvedFiles }) } }]
    })
  );
}

async function sync(ctx: { router: GitHubMockRouter; gh: ReturnType<typeof createGitHubRestHelper> }) {
  const escalations: Escalation[] = [];
  const result = await syncBranchWithBase({
    gh: ctx.gh,
    baseBranch: "dev",
    targetBranch: FEATURE,
    issueNumber: 42,
    llmApiKey: "key_test",
    model: "openai/gpt-test",
    fetchImpl: ctx.router.fetch,
    escalateToNeedsHuman: async (params) => {
      escalations.push(params);
      return SUSPENDED;
    }
  });
  return { result, escalations };
}

function featureHead(git: FakeGitDataApi): string {
  return git.getRef(`refs/heads/${FEATURE}`)!;
}

const CONFLICTING_SERVICE: Divergence = {
  shared: { "src/service.ts": "export const v = 1;\n" },
  ours: { "src/service.ts": "export const v = 'ours';\n" },
  theirs: { "src/service.ts": "export const v = 'theirs';\n" }
};

describe("syncBranchWithBase — a resolution is rejected only for real Git conflict blocks (#104)", () => {
  it.each([
    {
      id: "rust-doc-comment-banner-is-kept",
      resolved: "//! ============================================================\n//! Service\n//! ============================================================\nexport const v = 'both';\n"
    },
    {
      id: "jsdoc-banner-is-kept",
      resolved: "/**\n * ====================\n * Service\n * ====================\n */\nexport const v = 'both';\n"
    },
    {
      id: "markdown-setext-heading-of-seven-equals-is-kept",
      resolved: "Service\n=======\n\nexport const v = 'both';\n"
    },
    {
      id: "lone-separator-line-without-conflict-block-is-kept",
      resolved: "export const v = 'both';\n=======\n// >>>>>>> quoted in a comment\n"
    }
  ])("$id", async ({ resolved }) => {
    const ctx = setup(CONFLICTING_SERVICE);
    answerConflictResolution(ctx.router, [{ path: "src/service.ts", content: resolved }]);

    const { result, escalations } = await sync(ctx);

    expect(ctx.router.unmatched).toEqual([]);
    expect(escalations).toEqual([]);
    expect(result.status).toBe("resolved");
    expect(ctx.git.readFile(FEATURE, "src/service.ts")).toBe(resolved);
  });

  it.each([
    {
      id: "two-way-conflict-block-escalates",
      resolved: "<<<<<<< feature/42-sync\nexport const v = 'ours';\n=======\nexport const v = 'theirs';\n>>>>>>> dev\n"
    },
    {
      id: "diff3-conflict-block-escalates",
      resolved: "<<<<<<< ours\nexport const v = 'ours';\n||||||| base\nexport const v = 1;\n=======\nexport const v = 'theirs';\n>>>>>>> theirs\n"
    },
    {
      id: "crlf-conflict-block-escalates",
      resolved: "<<<<<<< ours\r\nexport const v = 'ours';\r\n=======\r\nexport const v = 'theirs';\r\n>>>>>>> theirs\r\n"
    }
  ])("$id", async ({ resolved }) => {
    const ctx = setup(CONFLICTING_SERVICE);
    const headBefore = featureHead(ctx.git);
    answerConflictResolution(ctx.router, [{ path: "src/service.ts", content: resolved }]);

    const { result, escalations } = await sync(ctx);

    expect(result.status).toBe("escalated");
    expect(escalations.map((e) => [e.reason, e.diagnosticExcerpt])).toEqual([
      ["merge_conflict_unresolved", "LLM conflict resolution for 'src/service.ts' still contained Git conflict markers."]
    ]);
    expect(featureHead(ctx.git)).toBe(headBefore);
  });
});
