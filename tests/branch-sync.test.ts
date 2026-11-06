import { describe, expect, it } from "vitest";
import {
  syncBranchWithBase,
  type SyncBranchWithBaseInput
} from "../src/orchestrator/github/branch-sync.js";
import { createGitHubRestHelper } from "../src/orchestrator/github/rest-client.js";
import type {
  EscalateToNeedsHumanFn,
  OrchestrateIssueResult
} from "../src/orchestrator/types.js";
import {
  createGitHubMockRouter,
  installFakeGitDataApi,
  json,
  notFound,
  serverError,
  tooManyRequests,
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

async function sync(
  ctx: { router: GitHubMockRouter; gh: ReturnType<typeof createGitHubRestHelper> },
  extra: Pick<SyncBranchWithBaseInput, "sandboxRunner"> = {}
) {
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
    },
    ...extra
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

const RESOLVED_SERVICE = "export const v = 'both';\n";

describe("syncBranchWithBase — the sensitive-path guard covers only files changed on both sides (#103)", () => {
  it.each([
    {
      id: "agents-yml-changed-only-on-dev-is-carried-over-without-escalation",
      sharedExtra: { ".github/agents.yml": "models: {}\n" },
      theirsExtra: { ".github/agents.yml": "models: { planning: x }\n" },
      carried: [".github/agents.yml", "models: { planning: x }\n"]
    },
    {
      id: "reviewer-file-added-only-on-dev-is-carried-over-without-escalation",
      sharedExtra: {},
      theirsExtra: { ".agents/reviewers/security-reviewer.md": "# Security\n" },
      carried: [".agents/reviewers/security-reviewer.md", "# Security\n"]
    },
    {
      id: "non-sensitive-file-changed-only-on-dev-is-carried-over",
      sharedExtra: { "src/util.ts": "export const u = 1;\n" },
      theirsExtra: { "src/util.ts": "export const u = 2;\n" },
      carried: ["src/util.ts", "export const u = 2;\n"]
    }
  ])("$id", async ({ sharedExtra, theirsExtra, carried }) => {
    const ctx = setup({
      shared: { ...CONFLICTING_SERVICE.shared, ...sharedExtra },
      ours: CONFLICTING_SERVICE.ours,
      theirs: { ...CONFLICTING_SERVICE.theirs, ...theirsExtra }
    });
    answerConflictResolution(ctx.router, [{ path: "src/service.ts", content: RESOLVED_SERVICE }]);

    const { result, escalations } = await sync(ctx);

    expect(ctx.router.unmatched).toEqual([]);
    expect(escalations).toEqual([]);
    expect(result).toMatchObject({ status: "resolved", conflictsResolved: ["src/service.ts"] });
    expect(ctx.git.readFile(FEATURE, carried[0]!)).toBe(carried[1]);
    expect(ctx.git.readFile(FEATURE, "src/service.ts")).toBe(RESOLVED_SERVICE);
  });

  it("workflow-changed-on-both-sides-escalates-and-lists-only-that-path", async () => {
    const ctx = setup({
      shared: { ...CONFLICTING_SERVICE.shared, ".github/workflows/ci.yml": "on: push\n", ".github/agents.yml": "models: {}\n" },
      ours: { ...CONFLICTING_SERVICE.ours, ".github/workflows/ci.yml": "on: [push]\n" },
      theirs: { ...CONFLICTING_SERVICE.theirs, ".github/workflows/ci.yml": "on: pull_request\n", ".github/agents.yml": "models: { planning: x }\n" }
    });
    const headBefore = featureHead(ctx.git);

    const { result, escalations } = await sync(ctx);

    expect(result).toMatchObject({ status: "escalated", escalationReason: "merge_conflict_unresolved" });
    expect(escalations.map((e) => [e.reason, e.sensitivePaths])).toEqual([
      ["merge_conflict_unresolved", [".github/workflows/ci.yml"]]
    ]);
    expect(featureHead(ctx.git)).toBe(headBefore);
    expect(ctx.router.calls("POST", "/v1/chat/completions", "api.openai.com")).toBe(0);
  });
});

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

function sandboxExitingWith(exitCode: number): NonNullable<SyncBranchWithBaseInput["sandboxRunner"]> {
  return async () => ({
    isolated: true,
    error_code: "NONE",
    error_message: "",
    exit_code: exitCode,
    stdout: exitCode === 0 ? "Stage 1 OK" : "1 test failed",
    stderr: "",
    duration_ms: 5,
    proxy_url: ""
  });
}

describe("syncBranchWithBase — LLM 3-way resolution is validated before it is committed", () => {
  it.each([
    { id: "stage1-pass-commits-the-resolution", exitCode: 0, expectedStatus: "resolved", expectedReason: undefined },
    { id: "stage1-failure-escalates-without-committing", exitCode: 1, expectedStatus: "escalated", expectedReason: "merge_conflict_stage1_failed" }
  ])("$id", async ({ exitCode, expectedStatus, expectedReason }) => {
    const ctx = setup({
      shared: { ...CONFLICTING_SERVICE.shared, "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) },
      ours: CONFLICTING_SERVICE.ours,
      theirs: CONFLICTING_SERVICE.theirs
    });
    const headBefore = featureHead(ctx.git);
    answerConflictResolution(ctx.router, [{ path: "src/service.ts", content: RESOLVED_SERVICE }]);

    const { result, escalations } = await sync(ctx, { sandboxRunner: sandboxExitingWith(exitCode) });

    expect(result.status).toBe(expectedStatus);
    expect(escalations.map((e) => e.reason)).toEqual(expectedReason ? [expectedReason] : []);
    expect(ctx.git.readFile(FEATURE, "src/service.ts")).toBe(
      expectedReason ? CONFLICTING_SERVICE.ours["src/service.ts"] : RESOLVED_SERVICE
    );
    expect(featureHead(ctx.git) === headBefore).toBe(expectedReason !== undefined);
  });

  it.each([
    {
      id: "out-of-scope-path-returned-by-the-llm-escalates",
      returned: [
        { path: "src/service.ts", content: RESOLVED_SERVICE },
        { path: ".github/workflows/ci.yml", content: "name: pwned\n" }
      ],
      expectedDiag: "LLM conflict resolution path mismatch: expected [src/service.ts], received [src/service.ts, .github/workflows/ci.yml]."
    },
    {
      id: "conflicted-path-omitted-by-the-llm-escalates",
      returned: [],
      expectedDiag: "LLM conflict resolution path mismatch: expected [src/service.ts], received []."
    }
  ])("$id", async ({ returned, expectedDiag }) => {
    const ctx = setup(CONFLICTING_SERVICE);
    const headBefore = featureHead(ctx.git);
    answerConflictResolution(ctx.router, returned);

    const { result, escalations } = await sync(ctx);

    expect(result.status).toBe("escalated");
    expect(escalations.map((e) => e.diagnosticExcerpt)).toEqual([expectedDiag]);
    expect(featureHead(ctx.git)).toBe(headBefore);
  });
});

const R = `/repos/${REPO}`;

describe("GitHub REST helper — branch reads return null or empty only on 404 (#110)", () => {
  it.each([
    { id: "404-is-a-missing-file", reply: notFound(), expected: "null" },
    { id: "403-forbidden-throws", reply: json({ message: "Resource not accessible by integration" }, 403), expected: "throws" },
    { id: "429-throws", reply: tooManyRequests(1), expected: "throws" },
    { id: "502-after-retries-throws", reply: serverError(502), expected: "throws" }
  ])("readSingleBranchFile $id", async ({ reply, expected }) => {
    const router = createGitHubMockRouter().on("GET", `${R}/contents/src/a.ts?ref=dev`, reply);
    const gh = createGitHubRestHelper({ repository: REPO, token: "ghs_test", fetchImpl: router.fetch });

    const read = gh.readSingleBranchFile("dev", "src/a.ts");

    if (expected === "null") {
      expect(await read).toBeNull();
    } else {
      await expect(read).rejects.toThrow(/GitHub API GET .*contents\/src\/a\.ts/);
    }
  });

  it.each([
    { id: "missing-branch-lists-no-path", ref: notFound(), tree: notFound(), expected: "empty" },
    { id: "403-on-the-tree-throws", ref: json({ object: { sha: "c".repeat(40) } }), tree: json({ message: "Forbidden" }, 403), expected: "throws" },
    { id: "403-on-the-ref-throws", ref: json({ message: "Forbidden" }, 403), tree: notFound(), expected: "throws" }
  ])("listBranchPaths and readDevWorkflowsMap $id", async ({ ref, tree, expected }) => {
    const router = createGitHubMockRouter()
      .on("GET", `${R}/git/ref/heads/dev`, ref)
      .on("GET", new RegExp(`/git/trees/c{40}\\?recursive=1$`), tree);
    const gh = createGitHubRestHelper({ repository: REPO, token: "ghs_test", fetchImpl: router.fetch });

    if (expected === "empty") {
      expect(await gh.listBranchPaths("dev")).toEqual([]);
      expect([...(await gh.readDevWorkflowsMap("dev")).keys()]).toEqual([]);
    } else {
      await expect(gh.listBranchPaths("dev")).rejects.toThrow(/HTTP 403/);
      await expect(gh.readDevWorkflowsMap("dev")).rejects.toThrow(/HTTP 403/);
    }
  });
});

describe("syncBranchWithBase — conflict reads stay bounded and a failed read never deletes a file (#110)", () => {
  it("a-base-only-file-whose-read-fails-aborts-the-sync-and-stays-on-the-target", async () => {
    const ctx = setup({
      shared: { ...CONFLICTING_SERVICE.shared, "src/util.ts": "export const u = 1;\n" },
      ours: CONFLICTING_SERVICE.ours,
      theirs: { ...CONFLICTING_SERVICE.theirs, "src/util.ts": "export const u = 2;\n" }
    });
    ctx.router.on("GET", /\/contents\/src\/util\.ts\?ref=/, json({ message: "Forbidden" }, 403));
    const headBefore = featureHead(ctx.git);
    answerConflictResolution(ctx.router, [{ path: "src/service.ts", content: RESOLVED_SERVICE }]);

    await expect(sync(ctx)).rejects.toThrow(/HTTP 403/);

    expect(featureHead(ctx.git)).toBe(headBefore);
    expect(ctx.git.readFile(FEATURE, "src/util.ts")).toBe("export const u = 1;\n");
  });

  it("a-representative-conflict-fetches-each-tree-once-and-reads-only-the-files-it-needs", async () => {
    const unrelated = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`src/mod${i}.ts`, `export const m${i} = ${i};\n`])
    );
    const ctx = setup({
      shared: { ...CONFLICTING_SERVICE.shared, ...unrelated, "src/util.ts": "export const u = 1;\n" },
      ours: { ...CONFLICTING_SERVICE.ours, "src/mod1.ts": "export const m1 = 'ours';\n" },
      theirs: { ...CONFLICTING_SERVICE.theirs, "src/util.ts": "export const u = 2;\n" }
    });
    answerConflictResolution(ctx.router, [{ path: "src/service.ts", content: RESOLVED_SERVICE }]);

    const { result } = await sync(ctx);

    expect(result.status).toBe("resolved");
    expect(ctx.router.calls("GET", /\/git\/trees\//)).toBe(3);
    expect(ctx.router.calls("GET", /\/git\/blobs\//)).toBe(0);
    expect(
      ctx.router.requests.filter((r) => r.path.includes("/contents/")).map((r) => r.path.split("?")[0]!.replace(`${R}/contents/`, ""))
    ).toEqual(["src/util.ts", "src/service.ts", "src/service.ts", "src/service.ts"]);
    expect(ctx.git.readFile(FEATURE, "src/util.ts")).toBe("export const u = 2;\n");
    expect(ctx.git.readFile(FEATURE, "src/mod1.ts")).toBe("export const m1 = 'ours';\n");
  });
});
