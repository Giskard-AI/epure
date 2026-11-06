import { describe, expect, it } from "vitest";
import {
  syncBranchWithBase,
  type SyncBranchWithBaseInput
} from "../src/orchestrator/github/branch-sync.js";
import {
  BranchUpdateConflictError,
  createGitHubRestHelper
} from "../src/orchestrator/github/rest-client.js";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import type {
  EscalateToNeedsHumanFn,
  OrchestrateIssueResult
} from "../src/orchestrator/types.js";
import {
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas
} from "../src/state/git-ref-state.js";
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

describe("syncBranchWithBase — a resolved conflict is committed as a two-parent merge, so the merge base moves (#105)", () => {
  it.each([
    { id: "unchanged-base-next-sync-is-up-to-date", nextDevChange: {}, expectedNextStatus: "up_to_date" },
    { id: "unrelated-base-change-next-sync-merges-without-a-new-conflict", nextDevChange: { "src/other.ts": "export const o = 1;\n" }, expectedNextStatus: "merged" },
    { id: "base-edits-the-resolved-line-again-only-that-file-conflicts", nextDevChange: { "src/service.ts": "export const v = 'dev-again';\n" }, expectedNextStatus: "resolved" }
  ])("$id", async ({ nextDevChange, expectedNextStatus }) => {
    const ctx = setup({
      shared: { ...CONFLICTING_SERVICE.shared, "src/util.ts": "export const u = 1;\n" },
      ours: { ...CONFLICTING_SERVICE.ours, "src/util.ts": "export const u = 'ours';\n" },
      theirs: CONFLICTING_SERVICE.theirs
    });
    const targetBefore = featureHead(ctx.git);
    const baseHead = ctx.git.getRef("refs/heads/dev")!;
    answerConflictResolution(ctx.router, [{ path: "src/service.ts", content: RESOLVED_SERVICE }]);

    const first = await sync(ctx);

    expect(first.result.status).toBe("resolved");
    expect(ctx.git.getCommit(featureHead(ctx.git))!.parents).toEqual([targetBefore, baseHead]);
    expect(ctx.git.readFile(FEATURE, "src/util.ts")).toBe("export const u = 'ours';\n");

    if (Object.keys(nextDevChange).length > 0) {
      ctx.git.commitFiles("dev", nextDevChange, "dev moves again");
    }
    const next = await sync(ctx);

    expect(ctx.router.unmatched).toEqual([]);
    expect(next.escalations).toEqual([]);
    expect(next.result.status).toBe(expectedNextStatus);
    expect(next.result.conflictsResolved).toEqual(expectedNextStatus === "resolved" ? ["src/service.ts"] : []);
    expect(ctx.git.isAncestor(ctx.git.getRef("refs/heads/dev")!, featureHead(ctx.git))).toBe(true);
  });
});

// Each time EPURE is about to move `branch`, a human pushes a commit first (up to `times` pushes).
function pushBeforeEachRefWrite(git: FakeGitDataApi, branch: string, times: number): string[] {
  const humanCommits: string[] = [];
  const arm = (): void =>
    git.onBeforeNextRefWrite(`refs/heads/${branch}`, () => {
      humanCommits.push(git.commitFiles(branch, { [`human-${humanCommits.length}.md`]: "human\n" }, "human push"));
      if (humanCommits.length < times) {
        arm();
      }
    });
  arm();
  return humanCommits;
}

describe("commitFilesToBranch — branch writes never force over a concurrent push (#109)", () => {
  const TASK = "task/42-new";

  function setupRepo() {
    const router = createGitHubMockRouter();
    const git = installFakeGitDataApi(router, REPO);
    git.commitFiles("dev", { "README.md": "readme\n" });
    git.commitFiles(FEATURE, { "README.md": "readme\n" });
    const gh = createGitHubRestHelper({ repository: REPO, token: "ghs_test", fetchImpl: router.fetch });
    return { router, git, gh };
  }

  it.each([
    {
      id: "new-branch-whose-ref-still-404s-after-creation-gets-its-commit",
      branch: TASK,
      arrange: (ctx: ReturnType<typeof setupRepo>) => {
        ctx.router.on("GET", `${R}/git/ref/heads/${encodeURIComponent(TASK)}`, notFound());
        return [] as string[];
      }
    },
    {
      id: "branch-created-concurrently-by-another-writer-is-built-upon",
      branch: TASK,
      arrange: (ctx: ReturnType<typeof setupRepo>) => {
        const other = ctx.git.commitFiles("dev", { "other.md": "other\n" }, "other writer");
        ctx.git.onBeforeNextRefWrite(`refs/heads/${TASK}`, () => ctx.git.setRef(`refs/heads/${TASK}`, other));
        return [other];
      }
    },
    {
      id: "one-concurrent-push-is-kept-and-the-commit-is-rebuilt-on-it",
      branch: FEATURE,
      arrange: (ctx: ReturnType<typeof setupRepo>) => pushBeforeEachRefWrite(ctx.git, FEATURE, 1)
    },
    {
      id: "two-concurrent-pushes-are-kept-and-the-commit-lands-on-the-third-attempt",
      branch: FEATURE,
      arrange: (ctx: ReturnType<typeof setupRepo>) => pushBeforeEachRefWrite(ctx.git, FEATURE, 2)
    }
  ])("$id", async ({ branch, arrange }) => {
    const ctx = setupRepo();
    const concurrent = arrange(ctx);

    const sha = await ctx.gh.commitFilesToBranch({
      branch,
      fromBranch: "dev",
      commitMessage: "feat: epure change",
      files: [{ path: "src/epure.ts", content: "export const e = 1;\n" }]
    });

    expect(ctx.git.getRef(`refs/heads/${branch}`)).toBe(sha);
    expect(ctx.git.readFile(sha, "src/epure.ts")).toBe("export const e = 1;\n");
    for (const commit of concurrent) {
      expect(ctx.git.isAncestor(commit, sha)).toBe(true);
    }
    expect(ctx.router.requests.filter((r) => r.method === "PATCH").map((r) => (r.body as { force?: boolean }).force)).not.toContain(true);
  });

  it.each([
    { id: "same-content-as-the-head-returns-the-head-without-a-commit-(#106)", content: "readme\n", expectsCommit: false },
    { id: "changed-content-creates-one-commit", content: "readme v2\n", expectsCommit: true }
  ])("$id", async ({ content, expectsCommit }) => {
    const ctx = setupRepo();
    const headBefore = ctx.git.getRef(`refs/heads/${FEATURE}`)!;

    const sha = await ctx.gh.commitFilesToBranch({
      branch: FEATURE,
      commitMessage: "docs(plan): integrate",
      files: [{ path: "README.md", content }]
    });

    expect(sha === headBefore).toBe(!expectsCommit);
    expect(ctx.git.getRef(`refs/heads/${FEATURE}`)).toBe(sha);
    expect(ctx.router.calls("POST", `${R}/git/commits`)).toBe(expectsCommit ? 1 : 0);
  });

  it("three-concurrent-pushes-raise-branch_update_conflict-and-keep-every-human-commit", async () => {
    const ctx = setupRepo();
    const humanCommits = pushBeforeEachRefWrite(ctx.git, FEATURE, 3);

    const commit = ctx.gh.commitFilesToBranch({
      branch: FEATURE,
      commitMessage: "feat: epure change",
      files: [{ path: "src/epure.ts", content: "export const e = 1;\n" }]
    });

    await expect(commit).rejects.toBeInstanceOf(BranchUpdateConflictError);
    await expect(commit).rejects.toMatchObject({ branch: FEATURE, attempts: 3 });
    expect(ctx.git.getRef(`refs/heads/${FEATURE}`)).toBe(humanCommits.at(-1));
    expect(ctx.git.readFile(FEATURE, "src/epure.ts")).toBeUndefined();
  });
});

const ISSUE = 42;

async function runSyncCommand(ctx: { router: GitHubMockRouter }) {
  const store = createInMemoryGitRefStateStore();
  await updateIssueStateWithCas({
    issueNumber: ISSUE,
    store,
    mutator: (prev) => ({ ...prev, phase: "implementation", status: "active", active_branch: FEATURE })
  });
  ctx.router
    .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Sync", body: "", state: "open" }))
    .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json([]))
    .on("GET", /\/labels\/[^/]+$/, json({}))
    .on("POST", `${R}/issues/${ISSUE}/labels`, json([]))
    .on("POST", `${R}/issues/${ISSUE}/comments`, json({ html_url: "c" }, 201));
  const result = await orchestrateIssueCommand({
    repository: REPO,
    issueNumber: ISSUE,
    command: "sync",
    commandArgs: "",
    actor: "maintainer",
    commentId: 700,
    fallbackGithubToken: "ghs_test",
    llmApiKey: "key_test",
    model: "openai/gpt-test",
    stateStore: store,
    fetchImpl: ctx.router.fetch
  });
  const comments = ctx.router.requests
    .filter((r) => r.method === "POST" && r.path === `${R}/issues/${ISSUE}/comments`)
    .map((r) => (r.body as { body: string }).body);
  return { result, state: (await store.readRef(`refs/epure/state/${ISSUE}`)).state!, comments };
}

const CONFLICTING_GLOSSARY: Divergence = {
  shared: { "GLOSSARY.md": "# Glossaire\n\n## Terme A\nA.\n" },
  ours: { "GLOSSARY.md": "# Glossaire\n\n## Terme A\nA.\n\n## Terme B\nB.\n" },
  theirs: { "GLOSSARY.md": "# Glossaire\n\n## Terme A\nA.\n\n## Terme C\nC.\n" }
};

describe("/epure sync — a branch that keeps moving escalates branch_update_conflict instead of an internal error (#109)", () => {
  it.each([
    { id: "two-concurrent-pushes-still-sync", pushes: 2, expectedStatus: "active", expectedReason: undefined },
    { id: "three-concurrent-pushes-suspend-with-branch_update_conflict", pushes: 3, expectedStatus: "suspended", expectedReason: "branch_update_conflict" }
  ])("$id", async ({ pushes, expectedStatus, expectedReason }) => {
    const ctx = setup(CONFLICTING_GLOSSARY);
    const humanCommits = pushBeforeEachRefWrite(ctx.git, FEATURE, pushes);

    const { state, comments } = await runSyncCommand(ctx);

    expect(ctx.router.unmatched).toEqual([]);
    expect(state.status).toBe(expectedStatus);
    expect(state.last_escalation?.reason).toBe(expectedReason);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.includes("`branch_update_conflict`")).toBe(expectedReason !== undefined);
    for (const commit of humanCommits) {
      expect(ctx.git.isAncestor(commit, featureHead(ctx.git))).toBe(true);
    }
  });
});

describe("continue on green ticket CI — a task PR merge refused with 405 re-syncs once, then escalates typed (#105)", () => {
  const TASK = "task/42-sync";

  async function runGreenTicketContinue(arrange: { taskChange: string; featureChange?: string; resolution: string }) {
    const router = createGitHubMockRouter();
    const git = installFakeGitDataApi(router, REPO);
    const base = git.commitFiles("dev", CONFLICTING_SERVICE.shared, "shared history");
    git.setRef(`refs/heads/${FEATURE}`, base);
    git.setRef(`refs/heads/${TASK}`, base);
    git.commitFiles(TASK, { "src/service.ts": arrange.taskChange }, "ticket work");
    if (arrange.featureChange) {
      git.commitFiles(FEATURE, { "src/service.ts": arrange.featureChange }, "other ticket merged");
    }
    const taskHead = git.getRef(`refs/heads/${TASK}`)!;
    const store = createInMemoryGitRefStateStore();
    await updateIssueStateWithCas({
      issueNumber: ISSUE,
      store,
      mutator: (prev) => ({
        ...prev,
        phase: "implementation",
        status: "active",
        subphase: "waiting_ticket_ci",
        active_branch: FEATURE,
        active_ticket_number: ISSUE,
        active_task_branch: TASK,
        active_pr_number: 106,
        active_head_sha: taskHead
      })
    });
    router
      .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Sync", body: "", state: "open" }))
      .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json([]))
      .on("GET", /\/labels\/[^/]+$/, json({}))
      .on("POST", `${R}/issues/${ISSUE}/labels`, json([]))
      .on("POST", `${R}/issues/${ISSUE}/comments`, json({ html_url: "c" }, 201))
      .on("GET", /\/actions\/runs\?head_sha=/, json({ workflow_runs: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" }] }))
      .on("GET", /\/commits\/[^/]+\/check-runs\?/, json({ check_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "success" }, { id: 2, name: "ai-review", status: "completed", conclusion: "success" }] }))
      .on("GET", /\/pulls\?state=open&head=/, json([{ number: 106, html_url: "pr106", title: "feat: x", head: { sha: taskHead } }]))
      .on("GET", `${R}/pulls/106/files`, json([{ filename: "src/service.ts", status: "modified", patch: "@@ -1 +1 @@" }]))
      .on("PATCH", `${R}/pulls/106`, json({ head: { sha: taskHead } }))
      .on("POST", `${R}/check-runs`, json({}, 201))
      .on("PUT", `${R}/pulls/106/merge`, json({ message: "Pull Request is not mergeable" }, 405))
      .onHost("api.openai.com", "POST", "/v1/chat/completions", (req) => {
        const schema = (req.body as { response_format?: { json_schema?: { name?: string } } }).response_format?.json_schema?.name;
        const payload =
          schema === "squash_commit_payload"
            ? { title: "feat: x", body: "", pr_title: "feat: x", commit_title: "feat: x", commit_body: "", bullets: ["- x", "- y"] }
            : { summary: "merged", resolved_files: [{ path: "src/service.ts", content: arrange.resolution }] };
        return json({ choices: [{ message: { content: JSON.stringify(payload) } }] });
      });

    const result = await orchestrateIssueCommand({
      repository: REPO,
      issueNumber: ISSUE,
      command: "continue",
      commandArgs: "",
      actor: "github-actions[bot]",
      commentId: 0,
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      asyncCiContinuation: true,
      stateStore: store,
      fetchImpl: router.fetch
    });
    const checkRuns = router.requests
      .filter((r) => r.method === "POST" && r.path === `${R}/check-runs`)
      .map((r) => r.body as { name: string; head_sha: string });
    return {
      router,
      git,
      taskHead,
      result,
      checkRuns,
      state: (await store.readRef(`refs/epure/state/${ISSUE}`)).state!
    };
  }

  it("conflicting-task-branch-is-re-synced-as-a-merge-commit-and-ci-is-awaited-on-it", async () => {
    const run = await runGreenTicketContinue({
      taskChange: CONFLICTING_SERVICE.ours["src/service.ts"]!,
      featureChange: CONFLICTING_SERVICE.theirs["src/service.ts"]!,
      resolution: RESOLVED_SERVICE
    });
    const newHead = run.git.getRef(`refs/heads/${TASK}`)!;

    expect(run.router.unmatched).toEqual([]);
    expect(run.git.getCommit(newHead)!.parents).toEqual([run.taskHead, run.git.getRef(`refs/heads/${FEATURE}`)]);
    expect(run.git.readFile(newHead, "src/service.ts")).toBe(RESOLVED_SERVICE);
    expect(run.state).toMatchObject({ status: "active", subphase: "waiting_ticket_ci", active_head_sha: newHead });
    expect(run.state.last_escalation).toBeUndefined();
    expect(run.checkRuns.filter((c) => c.name === "ai-review").map((c) => c.head_sha)).toEqual([newHead]);
    expect(run.router.calls("PUT", `${R}/pulls/106/merge`)).toBe(1);
  });

  it.each([
    {
      id: "unresolvable-conflict-escalates-merge_conflict_unresolved",
      arrange: {
        taskChange: CONFLICTING_SERVICE.ours["src/service.ts"]!,
        featureChange: CONFLICTING_SERVICE.theirs["src/service.ts"]!,
        resolution: "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n"
      }
    },
    {
      id: "task-branch-already-up-to-date-escalates-merge_conflict_unresolved",
      arrange: { taskChange: CONFLICTING_SERVICE.ours["src/service.ts"]!, resolution: RESOLVED_SERVICE }
    }
  ])("$id", async ({ arrange }) => {
    const run = await runGreenTicketContinue(arrange);

    expect(run.router.unmatched).toEqual([]);
    expect(run.state).toMatchObject({ status: "suspended", last_escalation: { reason: "merge_conflict_unresolved" } });
    expect(run.git.getRef(`refs/heads/${TASK}`)).toBe(run.taskHead);
    expect(run.result.summary_markdown).toContain("`MERGE_CONFLICT_UNRESOLVED`");
    expect(run.result.summary_markdown).not.toContain("Internal orchestrator error");
  });
});
