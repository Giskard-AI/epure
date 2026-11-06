import { describe, expect, it } from "vitest";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import {
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas,
  type GitRefStateStore
} from "../src/state/git-ref-state.js";
import {
  createGitHubMockRouter,
  installFakeGitDataApi,
  json,
  type FakeGitDataApi,
  type GitHubMockRouter
} from "./fixtures/github-mock-router.js";

const REPO = "acme/demo";
const R = `/repos/${REPO}`;
const ISSUE = 77;
const TICKET = 78;
const PLAN = "plan/77-plan-once";
const FEATURE = "feature/77-plan-once";
const ADR = "docs/adr/0001-storage.md";
const SPEC = "docs/specs/77-plan-once.md";

const MANIFEST = {
  planBranch: PLAN,
  specPath: SPEC,
  tickets: [
    {
      ticketIssueNumber: TICKET,
      slug: "store",
      title: "[Ticket 1] Store",
      description: "Add the store",
      acceptanceCriteria: ["Store works"],
      blockedByIssueNumbers: [],
      filesToTouch: ["src/store.ts"]
    }
  ]
};

function arrange() {
  const router = createGitHubMockRouter();
  const git = installFakeGitDataApi(router, REPO);
  const devHead = git.commitFiles("dev", { "README.md": "readme\n", "GLOSSARY.md": "# Glossaire\n\n## Terme Dev\nDev.\n" });
  git.setRef(`refs/heads/${PLAN}`, devHead);
  git.commitFiles(PLAN, {
    "GLOSSARY.md": "# Glossaire\n\n## Terme Dev\nDev.\n\n## Terme Plan\nPlan.\n",
    [ADR]: "# ADR-0001: Storage\nUse a file.\n",
    [SPEC]: "# Spec\nStore v1.\n"
  });
  router
    .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Plan once", body: "- [ ] Store", state: "open" }))
    .on("GET", `${R}/issues/${TICKET}`, json({ number: TICKET, title: "[Ticket 1] Store", body: "", state: "open" }))
    .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json([{ id: 10, body: `<!-- epure-plan-manifest:${JSON.stringify(MANIFEST)} -->`, user: { login: "epure[bot]", type: "Bot" } }]))
    .on("GET", /\/pulls\?state=(open|closed)&head=/, json([]))
    .on("GET", /\/labels\/[^/]+$/, json({}))
    .on("POST", /\/issues\/\d+\/labels$/, json([]))
    .on("DELETE", /\/issues\/\d+\/labels\/[^/]+$/, json([]))
    .on("POST", `${R}/issues/${ISSUE}/comments`, json({ html_url: "c" }, 201))
    .on("GET", /\/collaborators\/[^/]+\/permission$/, json({ permission: "write" }))
    .onHost("api.openai.com", "POST", "/v1/chat/completions", json({ error: { message: "stop after the integration" } }, 400));
  return { router, git };
}

async function enter(router: GitHubMockRouter, store: GitRefStateStore, command: "approve" | "continue", commentId: number) {
  await orchestrateIssueCommand({
    repository: REPO,
    issueNumber: ISSUE,
    command,
    commandArgs: "",
    actor: "maintainer",
    commentId,
    fallbackGithubToken: "ghs_test",
    llmApiKey: "key_test",
    model: "openai/gpt-test",
    stateStore: store,
    fetchImpl: router.fetch
  });
}

function planCommitsOnFeature(git: FakeGitDataApi): number {
  let count = 0;
  for (let sha = git.getRef(`refs/heads/${FEATURE}`); sha; sha = git.getCommit(sha)?.parents[0]) {
    if (git.getCommit(sha)?.message.startsWith("docs(plan):")) {
      count += 1;
    }
  }
  return count;
}

async function approvedStore(): Promise<GitRefStateStore> {
  const store = createInMemoryGitRefStateStore();
  await updateIssueStateWithCas({
    issueNumber: ISSUE,
    store,
    mutator: (prev) => ({ ...prev, phase: "tickets", status: "awaiting_human_approval", active_branch: PLAN })
  });
  return store;
}

describe("plan artifacts are integrated into feature/* once, not on every run (#106)", () => {
  it.each([
    { id: "approve-then-three-continues-with-an-unchanged-plan-add-one-plan-commit", continues: 3 },
    { id: "approve-alone-adds-one-plan-commit", continues: 0 }
  ])("$id", async ({ continues }) => {
    const { router, git } = arrange();
    const store = await approvedStore();

    await enter(router, store, "approve", 100);
    const featureAfterApprove = git.getRef(`refs/heads/${FEATURE}`);
    for (let i = 1; i <= continues; i += 1) {
      await enter(router, store, "continue", 100 + i);
    }

    expect(router.unmatched).toEqual([]);
    expect(planCommitsOnFeature(git)).toBe(1);
    expect(git.getRef(`refs/heads/${FEATURE}`)).toBe(featureAfterApprove);
    expect((await store.readRef(`refs/epure/state/${ISSUE}`)).state!.integrated_plan_sha).toBe(git.getRef(`refs/heads/${PLAN}`));
  });

  it.each([
    {
      id: "plan-moved-brings-the-new-spec-and-keeps-the-adr-translated-on-feature",
      featureEdit: { [ADR]: "# ADR-0001 : Stockage\nUn fichier.\n" },
      planEdit: { [SPEC]: "# Spec\nStore v2.\n" },
      expected: { [ADR]: "# ADR-0001 : Stockage\nUn fichier.\n", [SPEC]: "# Spec\nStore v2.\n" },
      expectedPlanCommits: 2
    },
    {
      id: "plan-moved-keeps-a-glossary-term-edited-on-feature-and-adds-the-new-plan-term",
      featureEdit: { "GLOSSARY.md": "# Glossaire\n\n## Terme Dev\nDev.\n\n## Terme Plan\nPlan, précisé sur feature.\n" },
      planEdit: { "GLOSSARY.md": "# Glossaire\n\n## Terme Dev\nDev.\n\n## Terme Plan\nPlan.\n\n## Terme Nouveau\nNouveau.\n" },
      expected: { "GLOSSARY.md": "# Glossaire\n\n## Terme Dev\nDev.\n\n## Terme Plan\nPlan, précisé sur feature.\n\n## Terme Nouveau\nNouveau.\n" },
      expectedPlanCommits: 2
    },
    {
      id: "feature-edit-with-an-unchanged-plan-is-never-touched",
      featureEdit: { [SPEC]: "# Spec\nEdited on feature.\n" },
      planEdit: {},
      expected: { [SPEC]: "# Spec\nEdited on feature.\n" },
      expectedPlanCommits: 1
    }
  ])("$id", async ({ featureEdit, planEdit, expected, expectedPlanCommits }) => {
    const { router, git } = arrange();
    const store = await approvedStore();
    await enter(router, store, "approve", 100);

    git.commitFiles(FEATURE, featureEdit, "human edit on feature");
    if (Object.keys(planEdit).length > 0) {
      git.commitFiles(PLAN, planEdit, "human edit on plan");
    }
    await enter(router, store, "continue", 101);

    expect(router.unmatched).toEqual([]);
    for (const [path, content] of Object.entries(expected)) {
      expect(git.readFile(FEATURE, path)).toBe(content);
    }
    expect(planCommitsOnFeature(git)).toBe(expectedPlanCommits);
  });

  it.each([
    { id: "continue-after-the-feature-pr-was-merged-writes-nothing-and-opens-no-pr", planMoved: false },
    { id: "continue-after-the-feature-pr-was-merged-ignores-a-moved-plan", planMoved: true }
  ])("$id", async ({ planMoved }) => {
    const { router, git } = arrange();
    const store = await approvedStore();
    await enter(router, store, "approve", 100);
    const featureAfterApprove = git.getRef(`refs/heads/${FEATURE}`);
    if (planMoved) {
      git.commitFiles(PLAN, { [SPEC]: "# Spec\nStore v2.\n" }, "human edit on plan");
    }
    router.on("GET", /\/pulls\?state=closed&head=/, json([{ number: 105, html_url: "pr105", merged_at: "2026-11-06T00:00:00Z" }]));

    await enter(router, store, "continue", 101);

    expect(router.unmatched).toEqual([]);
    expect(git.getRef(`refs/heads/${FEATURE}`)).toBe(featureAfterApprove);
    expect(router.calls("POST", `${R}/pulls`)).toBe(0);
    expect((await store.readRef(`refs/epure/state/${ISSUE}`)).state).toMatchObject({ status: "done" });
  });
});
