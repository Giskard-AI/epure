import { describe, expect, it } from "vitest";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import type { OrchestrateIssueInput } from "../src/orchestrator/types.js";
import {
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "../src/state/git-ref-state.js";
import {
  createGitHubMockRouter,
  json,
  noContent,
  notFound,
  primaryRateLimit,
  type GitHubMockRouter
} from "./fixtures/github-mock-router.js";

// `it.fails` cases document invariants the orchestrator violates today; flip them to `it` once fixed.
const REPO = "acme/demo";
const ISSUE = 77;
const FEATURE_BRANCH = "feature/77-async-ci-feature";
const TASK_BRANCH = "task/77-async-ci-feature";
const HEAD_SHA = "head-sha-77";
const R = `/repos/${REPO}`;
const R_RX = R.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OWNER = REPO.split("/")[0]!;

type Trigger = Pick<
  OrchestrateIssueInput,
  "issueNumber" | "commentId" | "triggerHeadSha" | "triggerBranch"
>;

const TRIGGERS = {
  continueWithoutComment: { issueNumber: ISSUE, commentId: 0 },
  workflowRun: { issueNumber: 0, commentId: 0, triggerHeadSha: HEAD_SHA, triggerBranch: FEATURE_BRANCH },
  checkSuite: { issueNumber: 0, commentId: 0, triggerBranch: FEATURE_BRANCH }
} satisfies Record<string, Trigger>;

async function seedState(
  overrides: Partial<EpureIssueState>
): Promise<GitRefStateStore> {
  const store = createInMemoryGitRefStateStore();
  await updateIssueStateWithCas({
    issueNumber: ISSUE,
    store,
    mutator: (prev) => ({
      ...prev,
      phase: "implementation",
      active_branch: FEATURE_BRANCH,
      active_pr_number: 105,
      active_head_sha: HEAD_SHA,
      ...overrides
    })
  });
  return store;
}

async function run(
  router: GitHubMockRouter,
  store: GitRefStateStore,
  input: Pick<OrchestrateIssueInput, "command" | "actor"> & Trigger
) {
  return await orchestrateIssueCommand({
    repository: REPO,
    commandArgs: "",
    fallbackGithubToken: "ghs_test",
    llmApiKey: "key_test",
    model: "openai/gpt-test",
    stateStore: store,
    fetchImpl: router.fetch,
    ...input
  });
}

async function readState(store: GitRefStateStore): Promise<EpureIssueState> {
  return (await store.readRef(`refs/epure/state/${ISSUE}`)).state!;
}

function declareIssueReads(router: GitHubMockRouter): GitHubMockRouter {
  return router
    .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Async CI Feature", body: "- [ ] Ship it", state: "open" }))
    .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json([]))
    .on("GET", new RegExp(`^${R_RX}/git/trees/[^?]+\\?recursive=1$`), notFound());
}

function declareCiSnapshot(
  router: GitHubMockRouter,
  conclusion: "success" | "failure"
): GitHubMockRouter {
  return router
    .on("GET", /\/actions\/runs\?head_sha=/, json({ workflow_runs: [{ id: 501, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion }] }))
    .on("GET", /\/commits\/[^/]+\/check-runs\?/, json({ check_runs: [{ id: 1, name: "CI", status: "completed", conclusion }, { id: 2, name: "ai-review", status: "completed", conclusion: "success" }] }));
}

function declareIssueWrites(router: GitHubMockRouter): GitHubMockRouter {
  return router
    .on("GET", new RegExp(`^${R_RX}/labels/[^/]+$`), json({}))
    .on("POST", `${R}/issues/${ISSUE}/labels`, json([]))
    .on("DELETE", new RegExp(`^${R_RX}/issues/${ISSUE}/labels/[^/]+$`), json([]))
    .on("POST", `${R}/issues/${ISSUE}/comments`, json({ html_url: "c" }, 201));
}

function ciPollCalls(router: GitHubMockRouter): number {
  return (
    router.calls("GET", /\/actions\/runs\?/) +
    router.calls("GET", /\/check-runs\?/)
  );
}

describe("Invariant 1 — automatic continuation runs only when status is active and subphase is waiting_*", () => {
  it.fails.each([
    { id: "suspended-waiting_feature_ci-resumed-by-continue-without-comment", status: "suspended", trigger: TRIGGERS.continueWithoutComment },
    { id: "suspended-waiting_feature_ci-resumed-by-workflow_run-head-sha", status: "suspended", trigger: TRIGGERS.workflowRun },
    { id: "suspended-waiting_feature_ci-resumed-by-check_suite-branch", status: "suspended", trigger: TRIGGERS.checkSuite },
    { id: "awaiting_human_approval-waiting_feature_ci-resumed-by-workflow_run", status: "awaiting_human_approval", trigger: TRIGGERS.workflowRun }
  ] as const)("$id", async ({ status, trigger }) => {
    const store = await seedState({ status, subphase: "waiting_feature_ci" });
    const before = await readState(store);
    const router = declareIssueWrites(declareCiSnapshot(declareIssueReads(createGitHubMockRouter()), "success"))
      .on("GET", /\/pulls\?state=open&head=/, json([{ number: 105, html_url: "pr", head: { sha: HEAD_SHA } }]));

    const res = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...trigger });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(false);
    expect(ciPollCalls(router)).toBe(0);
    expect(await readState(store)).toEqual(before);
  });

  it.each([
    { id: "active-idle-not-resumed-by-continue-without-comment", trigger: TRIGGERS.continueWithoutComment },
    { id: "active-idle-not-resumed-by-workflow_run", trigger: TRIGGERS.workflowRun }
  ] as const)("$id", async ({ trigger }) => {
    const store = await seedState({ status: "active", subphase: "idle" });
    const before = await readState(store);
    const router = declareIssueReads(createGitHubMockRouter());

    const res = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...trigger });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(false);
    expect(ciPollCalls(router)).toBe(0);
    expect(await readState(store)).toEqual(before);
  });
});

function terminalResidue(state: EpureIssueState) {
  return {
    subphase: state.subphase ?? "idle",
    active_ticket_number: state.active_ticket_number,
    active_task_branch: state.active_task_branch,
    active_pr_number: state.active_pr_number,
    active_head_sha: state.active_head_sha
  };
}

const CLEAN_TERMINAL = {
  subphase: "idle",
  active_ticket_number: undefined,
  active_task_branch: undefined,
  active_pr_number: undefined,
  active_head_sha: undefined
};

const EXHAUSTED_TICKET_STATE: Partial<EpureIssueState> = {
  status: "active",
  subphase: "waiting_ticket_ci",
  active_ticket_number: ISSUE,
  active_task_branch: TASK_BRANCH,
  active_pr_number: 106,
  code_fix_attempts_used: 3
};

const FEATURE_INTEGRATION_PENDING_STATE: Partial<EpureIssueState> = {
  status: "active",
  subphase: "waiting_ticket_ci",
  active_ticket_number: ISSUE,
  active_task_branch: TASK_BRANCH,
  active_pr_number: 106
};

function declareImplementationFlow(
  router: GitHubMockRouter,
  ciConclusion: "success" | "failure",
  openPrs: { readonly taskPr: boolean; readonly featurePr: boolean }
): GitHubMockRouter {
  return declareIssueWrites(declareCiSnapshot(declareIssueReads(router), ciConclusion))
    .on("GET", /\/check-runs\/\d+\/annotations\?/, json([]))
    .on("GET", /\/actions\/jobs\/\d+\/logs$/, { status: 200, body: "error TS2322" })
    .on("GET", /\/git\/ref\/heads\//, json({ object: { sha: "branch-sha" } }))
    .on("POST", `${R}/merges`, noContent())
    .on("GET", /\/pulls\/10[56]\/files$/, json([{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@" }]))
    .on("POST", /\/pulls\/10[56]\/reviews$/, json({}))
    .on("PATCH", /\/pulls\/10[56]$/, json({ head: { sha: HEAD_SHA } }))
    .on("POST", `${R}/check-runs`, json({}, 201))
    .on("GET", /\/pulls\?state=open&head=/, (req) => {
      const isTask = req.path.includes(encodeURIComponent(`${OWNER}:${TASK_BRANCH}`));
      return json(
        isTask && openPrs.taskPr
          ? [{ number: 106, html_url: "pr106", title: "feat: x", head: { sha: HEAD_SHA } }]
          : !isTask && openPrs.featurePr
            ? [{ number: 105, html_url: "pr105", title: "feat: y", head: { sha: HEAD_SHA } }]
            : []
      );
    })
    .onHost("generativelanguage.googleapis.com", "POST", /:generateContent\?/, json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "ok", findings: [] }) }] } }]
    }));
}

describe("Invariant 2 — suspended, done and cancelled imply subphase idle and empty active_* fields", () => {
  it.fails.each([
    {
      id: "remediation-exhausted-escalation-keeps-subphase-and-active-fields",
      seed: EXHAUSTED_TICKET_STATE,
      expectedStatus: "suspended",
      ciConclusion: "failure",
      openPrs: { taskPr: true, featurePr: false },
      input: { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun }
    },
    {
      id: "done-after-feature-integration-keeps-stale-active-fields",
      seed: FEATURE_INTEGRATION_PENDING_STATE,
      expectedStatus: "done",
      ciConclusion: "success",
      openPrs: { taskPr: false, featurePr: true },
      input: { command: "approve", actor: "maintainer", issueNumber: ISSUE, commentId: 900 }
    }
  ] as const)("$id", async ({ seed, expectedStatus, ciConclusion, openPrs, input }) => {
    const store = await seedState(seed);
    const router = declareImplementationFlow(createGitHubMockRouter(), ciConclusion, openPrs);

    await run(router, store, input);

    expect(router.unmatched).toEqual([]);
    const after = await readState(store);
    expect(after.status).toBe(expectedStatus);
    expect(terminalResidue(after)).toEqual(CLEAN_TERMINAL);
  });

  it.fails.each([
    {
      id: "cancel-command-while-waiting_ticket_ci-keeps-subphase-and-active-fields",
      expectedStatus: "cancelled",
      declare: (router: GitHubMockRouter) => declareIssueWrites(router),
      input: { command: "cancel", actor: "maintainer", issueNumber: ISSUE, commentId: 501 }
    },
    {
      id: "global-catch-suspension-on-github-403-rate-limit-keeps-subphase-and-active-fields",
      expectedStatus: "suspended",
      declare: (router: GitHubMockRouter) =>
        declareIssueWrites(router).on("GET", `${R}/issues/${ISSUE}`, primaryRateLimit(1_800_000_000)),
      input: { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.continueWithoutComment }
    }
  ] as const)("$id", async ({ expectedStatus, declare, input }) => {
    const store = await seedState({
      status: "active",
      subphase: "waiting_ticket_ci",
      active_ticket_number: 78,
      active_task_branch: TASK_BRANCH
    });
    const router = declare(createGitHubMockRouter());

    await run(router, store, input);

    expect(router.unmatched).toEqual([]);
    const after = await readState(store);
    expect(after.status).toBe(expectedStatus);
    expect(terminalResidue(after)).toEqual(CLEAN_TERMINAL);
  });
});

describe("Invariant 3 — only an explicit human command gets an issue out of cancelled or done", () => {
  it.fails.each([
    { id: "cancelled-with-stale-waiting_feature_ci-reactivated-by-workflow_run", status: "cancelled", phase: "implementation", trigger: TRIGGERS.workflowRun },
    { id: "cancelled-with-stale-waiting_feature_ci-reactivated-by-continue-without-comment", status: "cancelled", phase: "implementation", trigger: TRIGGERS.continueWithoutComment },
    { id: "done-with-stale-waiting_feature_ci-reactivated-by-check_suite", status: "done", phase: "completed", trigger: TRIGGERS.checkSuite }
  ] as const)("$id", async ({ status, phase, trigger }) => {
    const store = await seedState({ status, phase, subphase: "waiting_feature_ci" });
    const router = declareIssueWrites(declareCiSnapshot(declareIssueReads(createGitHubMockRouter()), "success"))
      .on("GET", /\/pulls\?state=open&head=/, json([{ number: 105, html_url: "pr", head: { sha: HEAD_SHA } }]));

    const res = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...trigger });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(false);
    expect((await readState(store)).status).toBe(status);
  });

  it.each([
    { id: "cancelled-in-spec-phase-not-reopened-by-plain-human-reply", status: "cancelled", phase: "spec" },
    { id: "cancelled-in-implementation-phase-not-reopened-by-plain-human-reply", status: "cancelled", phase: "implementation" },
    { id: "done-in-completed-phase-not-reopened-by-plain-human-reply", status: "done", phase: "completed" }
  ] as const)("$id", async ({ status, phase }) => {
    const store = await seedState({ status, phase, subphase: "idle" });
    const router = declareIssueReads(createGitHubMockRouter());

    const res = await run(router, store, { command: "reply", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(false);
    expect((await readState(store)).status).toBe(status);
  });
});

describe("Invariant 4 — exhausted remediation budget escalates exactly once with no sync, review or LLM call", () => {
  it.fails.each([
    { id: "ticket-ci-failure-at-3-of-3-attempts-resumed-by-workflow_run", trigger: TRIGGERS.workflowRun },
    { id: "ticket-ci-failure-at-3-of-3-attempts-resumed-by-continue-without-comment", trigger: TRIGGERS.continueWithoutComment }
  ] as const)("$id", async ({ trigger }) => {
    const store = await seedState(EXHAUSTED_TICKET_STATE);
    const router = declareImplementationFlow(createGitHubMockRouter(), "failure", { taskPr: true, featurePr: false });

    await run(router, store, { command: "continue", actor: "github-actions[bot]", ...trigger });

    expect(router.unmatched).toEqual([]);
    expect(router.calls("POST", `${R}/merges`)).toBe(0);
    expect(router.calls("POST", /\/pulls\/\d+\/reviews$/) + router.calls("POST", `${R}/check-runs`)).toBe(0);
    expect(router.requests.filter((r) => r.host !== "api.github.com")).toEqual([]);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(1);
    expect((await readState(store)).status).toBe("suspended");
  });
});
