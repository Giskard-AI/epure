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
  type GitHubMockRouter,
  type RecordedRequest
} from "./fixtures/github-mock-router.js";

const OWNER = "acme";
const REPO = `${OWNER}/demo`;
const R = `/repos/${REPO}`;
const ISSUE = 77;
const TICKET = 78;
const PLAN = "plan/77-human-merges";
const FEATURE = "feature/77-human-merges";
const TASK = `task/${TICKET}-store`;
const MERGED_TASK_PR = { number: 106, html_url: "pr106", merged_at: "2026-11-06T00:00:00Z" };
const MERGED_FEATURE_PR = { number: 105, html_url: "pr105", merged_at: "2026-11-06T01:00:00Z" };

const MANIFEST = {
  planBranch: PLAN,
  specPath: "docs/specs/77-human-merges.md",
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

const isHead = (req: RecordedRequest, branch: string): boolean =>
  req.path.includes(`head=${encodeURIComponent(`${OWNER}:${branch}`)}`);

function arrange(params: { readonly taskPrMerged: boolean; readonly featurePrMergedFromLookup: number }) {
  const router = createGitHubMockRouter();
  const git = installFakeGitDataApi(router, REPO);
  const devHead = git.commitFiles("dev", { "README.md": "readme\n" });
  git.setRef(`refs/heads/${PLAN}`, devHead);
  git.commitFiles(PLAN, { [MANIFEST.specPath]: "# Spec\n" });
  let featureLookups = 0;
  router
    .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Human merges", body: "- [ ] Store", state: "open" }))
    .on("GET", `${R}/issues/${TICKET}`, json({ number: TICKET, title: "[Ticket 1] Store", body: "", state: "open" }))
    .on("PATCH", `${R}/issues/${TICKET}`, json({ number: TICKET, state: "closed" }))
    .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json([{ id: 10, body: `<!-- epure-plan-manifest:${JSON.stringify(MANIFEST)} -->`, user: { login: "github-actions[bot]", type: "Bot" }, performed_via_github_app: { id: 15368 } }]))
    .on("GET", /\/pulls\?state=open&head=/, json([]))
    .on("GET", /\/pulls\?state=closed&head=/, (req) => {
      if (isHead(req, TASK)) {
        return json(params.taskPrMerged ? [MERGED_TASK_PR] : []);
      }
      featureLookups += 1;
      return json(featureLookups >= params.featurePrMergedFromLookup ? [MERGED_FEATURE_PR] : []);
    })
    .on("GET", /\/labels\/[^/]+$/, json({}))
    .on("POST", /\/issues\/\d+\/labels$/, json([]))
    .on("DELETE", /\/issues\/\d+\/labels\/[^/]+$/, json([]))
    .on("POST", `${R}/issues/${ISSUE}/comments`, json({ html_url: "c" }, 201))
    .on("GET", /\/collaborators\/[^/]+\/permission$/, json({ permission: "write" }))
    .onHost("api.openai.com", "POST", "/v1/chat/completions", json({ error: { message: "no LLM call expected" } }, 400));
  return { router, git };
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

async function approve(router: GitHubMockRouter, store: GitRefStateStore) {
  return orchestrateIssueCommand({
    repository: REPO,
    issueNumber: ISSUE,
    command: "approve",
    commandArgs: "",
    actor: "maintainer",
    commentId: 100,
    fallbackGithubToken: "ghs_test",
    llmApiKey: "key_test",
    model: "openai/gpt-test",
    stateStore: store,
    fetchImpl: router.fetch
  });
}

const ticketClosings = (router: GitHubMockRouter): number =>
  router.requests.filter(
    (r) => r.method === "PATCH" && r.path === `${R}/issues/${TICKET}` && (r.body as { state?: string }).state === "closed"
  ).length;

describe("ticket and feature PRs merged by a human stop EPURE from working on them (#107)", () => {
  it.each([
    {
      id: "feature-pr-merged-before-the-first-ticket-moves-the-epic-to-done",
      taskPrMerged: false,
      featurePrMergedFromLookup: 2,
      expectedTicketClosings: 0
    },
    {
      id: "human-merged-ticket-pr-closes-the-ticket-without-recreating-its-branch-then-the-merged-feature-pr-moves-the-epic-to-done",
      taskPrMerged: true,
      featurePrMergedFromLookup: 3,
      expectedTicketClosings: 1
    }
  ])("$id", async ({ taskPrMerged, featurePrMergedFromLookup, expectedTicketClosings }) => {
    const { router, git } = arrange({ taskPrMerged, featurePrMergedFromLookup });
    const store = await approvedStore();

    const res = await approve(router, store);

    expect(router.unmatched).toEqual([]);
    expect(ticketClosings(router)).toBe(expectedTicketClosings);
    expect(router.calls("POST", `${R}/pulls`)).toBe(0);
    expect(router.calls("POST", "/v1/chat/completions", "api.openai.com")).toBe(0);
    expect(git.getRef(`refs/heads/${TASK}`)).toBeUndefined();
    expect(res).toMatchObject({ status: "done", feature_pr_url: MERGED_FEATURE_PR.html_url });
    expect((await store.readRef(`refs/epure/state/${ISSUE}`)).state).toMatchObject({ status: "done", subphase: "idle" });
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(1);
  });
});
