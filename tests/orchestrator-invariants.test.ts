import { describe, expect, it, vi } from "vitest";
import { ClosureNotProcessedError, EscalationNotRecordedError, orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import type { OrchestrateIssueInput } from "../src/orchestrator/types.js";
import {
  createGitHubApiRefStateStore,
  createInMemoryGitRefStateStore,
  toTerminalState,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "../src/state/git-ref-state.js";
import {
  createGitHubMockRouter,
  installFakeGitDataApi,
  json,
  noContent,
  notFound,
  primaryRateLimit,
  secondaryRateLimit,
  serverError,
  tooManyRequests,
  type GitHubMockRouter,
  type RouteStep
} from "./fixtures/github-mock-router.js";

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
  workflowRunForIssue: { issueNumber: ISSUE, commentId: 0, triggerHeadSha: HEAD_SHA },
  branchOnly: { issueNumber: 0, commentId: 0, triggerBranch: FEATURE_BRANCH }
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

function postedComments(router: GitHubMockRouter): string[] {
  return router.requests
    .filter((r) => r.method === "POST" && r.path === `${R}/issues/${ISSUE}/comments`)
    .map((r) => (r.body as { body: string }).body);
}

function captureWrites(store: GitRefStateStore): { store: GitRefStateStore; writes: EpureIssueState[] } {
  const writes: EpureIssueState[] = [];
  return {
    writes,
    store: {
      readRef: (refName) => store.readRef(refName),
      compareAndSwapRef: async (refName, expectedOldSha, nextState) => {
        const result = await store.compareAndSwapRef(refName, expectedOldSha, nextState);
        if (result.swapped) writes.push(nextState);
        return result;
      }
    }
  };
}

function declareIssueReads(router: GitHubMockRouter): GitHubMockRouter {
  return router
    .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Async CI Feature", body: "- [ ] Ship it", state: "open" }))
    .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json([]))
    .on("GET", new RegExp(`^${R_RX}/git/trees/[^?]+\\?recursive=1$`), notFound())
    .on("GET", new RegExp(`^${R_RX}/contents/`), notFound());
}

type CiOutcome = "success" | "failure" | "pending";

function declareCiSnapshot(
  router: GitHubMockRouter,
  outcome: CiOutcome
): GitHubMockRouter {
  const run =
    outcome === "pending"
      ? { status: "in_progress", conclusion: null }
      : { status: "completed", conclusion: outcome };
  return router
    .on("GET", /\/actions\/runs\?head_sha=/, json({ workflow_runs: [{ id: 501, name: "CI", path: ".github/workflows/ci.yml", ...run }] }))
    .on("GET", /\/commits\/[^/]+\/check-runs\?/, json({ check_runs: [{ id: 1, name: "CI", ...run }, { id: 2, name: "ai-review", status: "completed", conclusion: "success" }] }));
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
  ciConclusion: CiOutcome,
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
    .on("GET", /\/pulls\/10[56]$/, json({ mergeable_state: "clean" }))
    .on("POST", `${R}/check-runs`, json({}, 201))
    .on("GET", /\/pulls\?state=closed&head=/, json([]))
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
    .onHost("api.openai.com", "POST", "/v1/chat/completions", (req) => {
      const schemaName = (req.body as { response_format?: { json_schema?: { name?: string } } })
        .response_format?.json_schema?.name;
      const payload =
        schemaName === "squash_commit_payload"
          ? { title: "feat: ship it", body: "", pr_title: "feat: ship it", commit_title: "feat: ship it", commit_body: "", bullets: ["- ship it", "- test it"] }
          : { summary: "ok", findings: [] };
      return json({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    });
}

describe("Invariant 2 — suspended, done and cancelled imply subphase idle and empty active_* fields", () => {
  it.each([
    {
      id: "remediation-exhausted-escalation-clears-subphase-and-active-fields",
      seed: EXHAUSTED_TICKET_STATE,
      expectedStatus: "suspended",
      ciConclusion: "failure",
      openPrs: { taskPr: true, featurePr: false },
      input: { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun }
    },
    {
      id: "done-after-feature-integration-clears-active-fields",
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

  it.each([
    {
      id: "cancel-command-while-waiting_ticket_ci-clears-subphase-and-active-fields",
      expectedStatus: "cancelled",
      declare: (router: GitHubMockRouter) => declareIssueWrites(router),
      input: { command: "cancel", actor: "maintainer", issueNumber: ISSUE, commentId: 501 }
    },
    {
      id: "global-catch-suspension-on-github-403-rate-limit-clears-subphase-and-active-fields",
      expectedStatus: "suspended",
      declare: (router: GitHubMockRouter) =>
        declareIssueWrites(router).on("GET", `${R}/issues/${ISSUE}`, primaryRateLimit(1_800_000_000)),
      input: { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRunForIssue }
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

describe("feature PR integration — a conflicting feature PR is re-synced with dev before its CI is awaited (#105)", () => {
  it.each([
    { id: "dirty-feature-pr-gets-a-second-dev-merge-into-the-feature-branch", mergeableState: "dirty", expectedFeatureSyncs: 2 },
    { id: "clean-feature-pr-keeps-the-single-pre-integration-sync", mergeableState: "clean", expectedFeatureSyncs: 1 }
  ] as const)("$id", async ({ mergeableState, expectedFeatureSyncs }) => {
    const store = await seedState(FEATURE_INTEGRATION_PENDING_STATE);
    const router = declareImplementationFlow(createGitHubMockRouter(), "success", { taskPr: false, featurePr: true })
      .on("GET", `${R}/pulls/105`, json({ mergeable_state: mergeableState }), json({ mergeable_state: "clean" }));

    await run(router, store, { command: "approve", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });

    expect(router.unmatched).toEqual([]);
    expect((await readState(store)).status).toBe("done");
    const featureSyncs = router.requests.filter(
      (r) => r.method === "POST" && r.path === `${R}/merges` && (r.body as { base: string }).base === FEATURE_BRANCH
    );
    expect(featureSyncs).toHaveLength(expectedFeatureSyncs);
  });
});

describe("Invariant 3 — only an explicit human command gets an issue out of cancelled or done", () => {
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
  it.each([
    { id: "ticket-ci-failure-at-3-of-3-attempts-resumed-by-workflow_run", trigger: TRIGGERS.workflowRun },
    { id: "ticket-ci-failure-at-3-of-3-attempts-resumed-by-workflow_run-naming-the-issue", trigger: TRIGGERS.workflowRunForIssue }
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

const TICKET = ISSUE + 1;
const STALE_SHA = "stale-sha-from-previous-push";

const SOURCES = {
  "workflow_run": TRIGGERS.workflowRun,
  "workflow_run-stale-sha": { ...TRIGGERS.workflowRun, triggerHeadSha: STALE_SHA },
  "workflow_run-stale-sha-with-issue-number": { ...TRIGGERS.workflowRun, issueNumber: ISSUE, triggerHeadSha: STALE_SHA },
  "workflow_run-with-issue-number": TRIGGERS.workflowRunForIssue,
  "continue-without-comment": TRIGGERS.continueWithoutComment,
  "branch-only": TRIGGERS.branchOnly
} satisfies Record<string, Trigger>;

type Expected = "none" | "resume" | "fix_round" | "escalation";

function seedFor(row: {
  readonly status: EpureIssueState["status"];
  readonly subphase: NonNullable<EpureIssueState["subphase"]>;
  readonly attempts: number;
}): Partial<EpureIssueState> {
  const scope =
    row.subphase === "waiting_feature_ci"
      ? { feature_code_fix_attempts_used: row.attempts }
      : { active_ticket_number: TICKET, active_task_branch: TASK_BRANCH, active_pr_number: 106, code_fix_attempts_by_ticket: { [String(TICKET)]: row.attempts } };
  return { status: row.status, phase: row.status === "done" ? "completed" : "implementation", subphase: row.subphase, ...scope };
}

function declareFullFlow(ci: CiOutcome): GitHubMockRouter {
  return declareImplementationFlow(createGitHubMockRouter(), ci, { taskPr: true, featurePr: true })
    .on("POST", `${R}/issues/${TICKET}/labels`, json([]))
    .onHost("api.openai.com", "POST", "/v1/chat/completions", json({ error: { message: "invalid request" } }, 400));
}

function llmCalls(router: GitHubMockRouter): number {
  return router.requests.filter((r) => r.host !== "api.github.com").length;
}

describe("Automatic entry decision table (status x subphase x event source x budget)", () => {
  it.each([
    { id: "suspended-waiting_ticket_ci-workflow_run-exhausted-budget-does-nothing", status: "suspended", subphase: "waiting_ticket_ci", source: "workflow_run", attempts: 3, ci: "failure", expected: "none" },
    { id: "suspended-idle-continue-without-comment-fresh-budget-does-nothing", status: "suspended", subphase: "idle", source: "continue-without-comment", attempts: 0, ci: "success", expected: "none" },
    { id: "suspended-waiting_feature_ci-continue-without-comment-does-nothing", status: "suspended", subphase: "waiting_feature_ci", source: "continue-without-comment", attempts: 0, ci: "success", expected: "none" },
    { id: "suspended-waiting_feature_ci-branch-only-trigger-does-nothing", status: "suspended", subphase: "waiting_feature_ci", source: "branch-only", attempts: 0, ci: "success", expected: "none" },
    { id: "awaiting_human_approval-waiting_feature_ci-workflow_run-does-nothing", status: "awaiting_human_approval", subphase: "waiting_feature_ci", source: "workflow_run", attempts: 0, ci: "success", expected: "none" },
    { id: "cancelled-waiting_ticket_ci-workflow_run-does-nothing", status: "cancelled", subphase: "waiting_ticket_ci", source: "workflow_run", attempts: 3, ci: "failure", expected: "none" },
    { id: "cancelled-waiting_feature_ci-continue-without-comment-does-nothing", status: "cancelled", subphase: "waiting_feature_ci", source: "continue-without-comment", attempts: 0, ci: "success", expected: "none" },
    { id: "done-idle-continue-without-comment-does-nothing", status: "done", subphase: "idle", source: "continue-without-comment", attempts: 0, ci: "success", expected: "none" },
    { id: "done-with-leftover-waiting_feature_ci-workflow_run-on-the-old-head-does-nothing", status: "done", subphase: "waiting_feature_ci", source: "workflow_run", attempts: 0, ci: "success", expected: "none" },
    { id: "done-with-leftover-waiting_feature_ci-branch-only-trigger-does-nothing", status: "done", subphase: "waiting_feature_ci", source: "branch-only", attempts: 0, ci: "success", expected: "none" },
    { id: "active-idle-workflow_run-does-nothing", status: "active", subphase: "idle", source: "workflow_run", attempts: 0, ci: "failure", expected: "none" },
    { id: "active-idle-continue-without-comment-does-nothing", status: "active", subphase: "idle", source: "continue-without-comment", attempts: 0, ci: "failure", expected: "none" },
    { id: "active-waiting_ticket_ci-issue-less-trigger-without-head-sha-does-nothing", status: "active", subphase: "waiting_ticket_ci", source: "branch-only", attempts: 0, ci: "success", expected: "none" },
    { id: "active-waiting_ticket_ci-workflow_run-on-stale-sha-does-nothing", status: "active", subphase: "waiting_ticket_ci", source: "workflow_run-stale-sha", attempts: 3, ci: "failure", expected: "none" },
    { id: "active-waiting_feature_ci-workflow_run-on-stale-sha-does-nothing", status: "active", subphase: "waiting_feature_ci", source: "workflow_run-stale-sha", attempts: 0, ci: "success", expected: "none" },
    { id: "active-waiting_ticket_ci-workflow_run-on-stale-sha-for-known-issue-does-nothing", status: "active", subphase: "waiting_ticket_ci", source: "workflow_run-stale-sha-with-issue-number", attempts: 3, ci: "failure", expected: "none" },
    { id: "active-waiting_ticket_ci-workflow_run-ci-still-running-polls-without-writing", status: "active", subphase: "waiting_ticket_ci", source: "workflow_run", attempts: 1, ci: "pending", expected: "resume" },
    { id: "active-waiting_feature_ci-workflow_run-green-ci-at-exhausted-budget-moves-to-review", status: "active", subphase: "waiting_feature_ci", source: "workflow_run", attempts: 3, ci: "success", expected: "resume" },
    { id: "active-waiting_feature_ci-continue-without-comment-or-head-sha-green-ci-does-nothing", status: "active", subphase: "waiting_feature_ci", source: "continue-without-comment", attempts: 0, ci: "success", expected: "none" },
    { id: "active-waiting_feature_ci-workflow_run-naming-the-issue-green-ci-moves-to-review", status: "active", subphase: "waiting_feature_ci", source: "workflow_run-with-issue-number", attempts: 0, ci: "success", expected: "resume" },
    { id: "active-waiting_ticket_ci-workflow_run-red-ci-with-budget-left-runs-one-fix-round", status: "active", subphase: "waiting_ticket_ci", source: "workflow_run", attempts: 2, ci: "failure", expected: "fix_round" },
    { id: "active-waiting_ticket_ci-workflow_run-red-ci-at-exhausted-budget-escalates-once", status: "active", subphase: "waiting_ticket_ci", source: "workflow_run", attempts: 3, ci: "failure", expected: "escalation" },
    { id: "active-waiting_ticket_ci-continue-without-comment-or-head-sha-red-ci-at-exhausted-budget-does-nothing", status: "active", subphase: "waiting_ticket_ci", source: "continue-without-comment", attempts: 3, ci: "failure", expected: "none" },
    { id: "active-waiting_feature_ci-workflow_run-red-ci-at-exhausted-feature-budget-escalates-once", status: "active", subphase: "waiting_feature_ci", source: "workflow_run", attempts: 3, ci: "failure", expected: "escalation" }
  ] as const satisfies ReadonlyArray<{
    id: string;
    status: EpureIssueState["status"];
    subphase: NonNullable<EpureIssueState["subphase"]>;
    source: keyof typeof SOURCES;
    attempts: number;
    ci: CiOutcome;
    expected: Expected;
  }>)("$id", async (row) => {
    const store = await seedState(seedFor(row));
    const before = await readState(store);
    const router = declareFullFlow(row.ci);

    const res = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...SOURCES[row.source] });
    const after = await readState(store);
    const comments = router.calls("POST", `${R}/issues/${ISSUE}/comments`);

    expect(router.unmatched).toEqual([]);
    switch (row.expected) {
      case "none":
        expect(res.executed).toBe(false);
        expect(ciPollCalls(router)).toBe(0);
        expect(after).toEqual(before);
        break;
      case "resume":
        expect(ciPollCalls(router)).toBeGreaterThan(0);
        expect(llmCalls(router)).toBe(0);
        expect(after.status).not.toBe("suspended");
        expect(after.last_escalation).toBeUndefined();
        if (row.ci === "pending") {
          expect(after).toEqual(before);
          expect(comments).toBe(0);
        } else {
          expect(after).toMatchObject({ phase: "review", status: "awaiting_human_approval", subphase: "idle" });
        }
        break;
      case "fix_round":
        expect(llmCalls(router)).toBeGreaterThan(0);
        expect(after.last_escalation?.reason).not.toBe("remediation_exhausted");
        break;
      case "escalation":
        expect(comments).toBe(1);
        expect(llmCalls(router)).toBe(0);
        expect(router.calls("POST", `${R}/merges`)).toBe(0);
        expect(after).toMatchObject({ status: "suspended", last_escalation: { reason: "remediation_exhausted", head_sha: HEAD_SHA } });
        expect(terminalResidue(after)).toEqual(CLEAN_TERMINAL);
        break;
    }
  });
});

describe("Event sequences never loop, run twice or overwrite a cancellation", () => {
  it("cancel-then-workflow_run-on-the-same-head-sha-leaves-the-issue-cancelled", async () => {
    const store = await seedState(seedFor({ status: "active", subphase: "waiting_ticket_ci", attempts: 1 }));
    const router = declareFullFlow("failure");

    await run(router, store, { command: "cancel", actor: "maintainer", issueNumber: ISSUE, commentId: 501 });
    const cancelled = await readState(store);
    const res = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun });

    expect(router.unmatched).toEqual([]);
    expect(cancelled.status).toBe("cancelled");
    expect(res.executed).toBe(false);
    expect(ciPollCalls(router)).toBe(0);
    expect(await readState(store)).toEqual(cancelled);
  });

  it.each([
    {
      id: "cancel-landing-while-the-continuation-reads-ci-stops-it-before-it-claims-the-wait",
      cancelDuring: /\/actions\/runs\?head_sha=/,
      reply: json({ workflow_runs: [{ id: 501, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" }] })
    },
    {
      id: "cancel-landing-after-the-claim-stops-the-continuation-before-it-writes-review",
      cancelDuring: /\/pulls\?state=open&head=/,
      reply: json([{ number: 105, html_url: "pr105", head: { sha: HEAD_SHA } }])
    }
  ])("$id", async ({ cancelDuring, reply }) => {
    const store = await seedState(seedFor({ status: "active", subphase: "waiting_feature_ci", attempts: 0 }));
    const router = declareFullFlow("success").on("GET", cancelDuring, async () => {
      await updateIssueStateWithCas({ issueNumber: ISSUE, store, mutator: (prev) => toTerminalState(prev, { status: "cancelled" }) });
      return reply;
    });

    const res = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(false);
    expect(await readState(store)).toMatchObject({ status: "cancelled", cancelled_from: { phase: "implementation", status: "active" } });
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`) + router.calls("POST", `${R}/issues/${ISSUE}/labels`)).toBe(0);
  });

  it("two-concurrent-workflow_run-continuations-on-the-same-head-move-to-review-once", async () => {
    const store = await seedState(seedFor({ status: "active", subphase: "waiting_feature_ci", attempts: 0 }));
    const router = declareFullFlow("success");

    const results = await Promise.all([
      run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun }),
      run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun })
    ]);

    expect(router.unmatched).toEqual([]);
    expect(results.filter((r) => r.executed)).toHaveLength(1);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(1);
    expect(await readState(store)).toMatchObject({ phase: "review", status: "awaiting_human_approval", subphase: "idle" });
  });

  it("two-successive-automatic-resumes-escalate-once-then-ignore-the-suspended-state", async () => {
    const store = await seedState(seedFor({ status: "active", subphase: "waiting_ticket_ci", attempts: 3 }));
    const router = declareFullFlow("failure");

    const first = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun });
    const suspended = await readState(store);
    const second = await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.continueWithoutComment });

    expect(router.unmatched).toEqual([]);
    expect([first.executed, second.executed]).toEqual([true, false]);
    expect(suspended.status).toBe("suspended");
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(1);
    expect(await readState(store)).toEqual(suspended);
  });

  it("escalation-already-recorded-for-the-same-reason-and-sha-posts-no-new-comment", async () => {
    const store = await seedState({
      ...seedFor({ status: "active", subphase: "waiting_ticket_ci", attempts: 3 }),
      last_escalation: { reason: "remediation_exhausted", head_sha: HEAD_SHA, ticket_number: TICKET, budget_scope: "ticket" }
    });
    const router = declareFullFlow("failure");

    await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun });

    expect(router.unmatched).toEqual([]);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(0);
    expect((await readState(store)).status).toBe("suspended");
  });

  it("plain-human-reply-does-not-resume-a-suspended-implementation", async () => {
    const store = await seedState({ status: "suspended", subphase: "idle" });
    const before = await readState(store);
    const router = declareFullFlow("success");

    await run(router, store, { command: "reply", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });

    expect(router.unmatched).toEqual([]);
    expect(llmCalls(router)).toBe(0);
    expect(router.calls("POST", `${R}/merges`)).toBe(0);
    expect((await readState(store)).status).toBe(before.status);
  });
});

describe("Automatic resume skips dev -> feature -> task sync unless dev moved", () => {
  it.each([
    { id: "dev-unchanged-since-last-sync-skips-both-merges", lastSyncedBaseSha: "branch-sha", expectedMerges: 0 },
    { id: "dev-advanced-since-last-sync-merges-and-records-new-base-sha", lastSyncedBaseSha: "older-dev-sha", expectedMerges: 2 },
    { id: "legacy-state-without-recorded-base-sha-syncs-once", lastSyncedBaseSha: undefined, expectedMerges: 2 }
  ] as const)("$id", async ({ lastSyncedBaseSha, expectedMerges }) => {
    const store = await seedState({
      ...seedFor({ status: "active", subphase: "waiting_ticket_ci", attempts: 1 }),
      last_synced_base_sha: lastSyncedBaseSha
    });
    const router = declareFullFlow("failure");

    await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun });

    expect(router.unmatched).toEqual([]);
    expect(router.calls("POST", `${R}/merges`)).toBe(expectedMerges);
    expect((await readState(store)).last_synced_base_sha).toBe("branch-sha");
  });
});

type CommentSpec = { readonly id: number; readonly login: string; readonly body: string; readonly type?: string; readonly viaApp?: boolean };

const PERMISSIONS: Readonly<Record<string, string>> = { maintainer: "write", owner: "admin", reader: "read" };

function commentPages(comments: readonly CommentSpec[]): (readonly CommentSpec[])[] {
  const pages: (readonly CommentSpec[])[] = [];
  for (let i = 0; i <= comments.length; i += 100) {
    pages.push(comments.slice(i, i + 100));
  }
  return pages;
}

function schemaName(body: unknown): string | undefined {
  return (body as { response_format?: { json_schema?: { name?: string } } }).response_format?.json_schema?.name;
}

function declareResumeFlow(comments: readonly CommentSpec[]): GitHubMockRouter {
  const router = declareImplementationFlow(createGitHubMockRouter(), "failure", { taskPr: true, featurePr: true })
    .on("POST", `${R}/issues/${TICKET}/labels`, json([]))
    .onHost("api.openai.com", "POST", "/v1/chat/completions", (req) =>
      schemaName(req.body) === "generated_ticket_implementation"
        ? json({ error: { message: "stop after capturing the implementation prompt" } }, 400)
        : json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", findings: [] }) } }] })
    );
  commentPages(comments).forEach((page, index) => {
    router.on(
      "GET",
      `${R}/issues/${ISSUE}/comments?per_page=100${index > 0 ? `&page=${index + 1}` : ""}`,
      json(page.map((c) => ({ id: c.id, body: c.body, user: { login: c.login, type: c.type ?? "User" }, created_at: "2026-11-05T10:00:00Z", performed_via_github_app: c.viaApp ? { slug: "other-app" } : null })))
    );
  });
  return router
    .on("GET", new RegExp(`^${R_RX}/collaborators/([^/]+)/permission$`), (_req, m) => {
      const level = PERMISSIONS[decodeURIComponent(m![1]!)] ?? "none";
      return json({ permission: level, role_name: level });
    });
}

function implementationPrompt(router: GitHubMockRouter): string {
  const request = router.requests.find((r) => r.host === "api.openai.com" && schemaName(r.body) === "generated_ticket_implementation");
  expect(request).toBeDefined();
  return JSON.stringify(request!.body);
}

const ESCALATED_AT_CURSOR = 500;
const RESUME_COMMENT = 600;

describe("Resume context: comments since the escalation reach the resumed implementation session", () => {
  it.each([
    {
      id: "write-and-admin-free-text-since-escalation-injected-bots-readers-commands-and-out-of-window-excluded",
      comments: [
        { id: 450, login: "maintainer", body: "BEFORE-ESCALATION guidance" },
        { id: 510, login: "maintainer", body: "GUIDANCE-A use the zod schema" },
        { id: 520, login: "epure-agent[bot]", body: "BOT-NOISE", type: "Bot" },
        { id: 530, login: "reader", body: "READER-NOISE" },
        { id: 540, login: "maintainer", body: "/epure status" },
        { id: 550, login: "owner", body: "GUIDANCE-B keep the public API" },
        { id: RESUME_COMMENT, login: "maintainer", body: "/epure continue" },
        { id: 610, login: "maintainer", body: "AFTER-RESUME guidance" }
      ],
      included: ["GUIDANCE-A use the zod schema", "GUIDANCE-B keep the public API"],
      excluded: ["BEFORE-ESCALATION", "BOT-NOISE", "READER-NOISE", "/epure status", "AFTER-RESUME"]
    },
    {
      id: "more-than-10-eligible-comments-keeps-the-10-most-recent",
      comments: [
        ...Array.from({ length: 12 }, (_, i) => ({ id: 501 + i, login: "maintainer", body: `NOTE-${String(i + 1).padStart(2, "0")}` })),
        { id: RESUME_COMMENT, login: "maintainer", body: "/epure continue" }
      ],
      included: ["NOTE-03", "NOTE-12"],
      excluded: ["NOTE-01", "NOTE-02"]
    },
    {
      id: "context-is-capped-at-8000-characters-keeping-the-most-recent-text",
      comments: [
        { id: 510, login: "maintainer", body: `OLDEST-${"x".repeat(3000)}` },
        { id: 520, login: "maintainer", body: `MIDDLE-${"y".repeat(5000)}-MIDDLE-END` },
        { id: 530, login: "maintainer", body: `NEWEST-${"z".repeat(3500)}` },
        { id: RESUME_COMMENT, login: "maintainer", body: "/epure approve" }
      ],
      included: ["NEWEST-", "MIDDLE-"],
      excluded: ["OLDEST-", "-MIDDLE-END"]
    },
    {
      id: "same-command-definition-as-the-gate-app-comments-and-epure-own-comments-excluded",
      comments: [
        { id: 510, login: "maintainer", body: "MULTILINE-COMMAND first\n/epure status" },
        { id: 520, login: "maintainer", body: "APP-NOISE posted through another app", viaApp: true },
        { id: 530, login: "maintainer", body: "<!-- epure-state-mirror:issue-77:v3 -->\nMIRROR-NOISE" },
        { id: 540, login: "maintainer", body: "/epure someday GUIDANCE-C not a command" },
        { id: RESUME_COMMENT, login: "maintainer", body: "/epure continue" }
      ],
      included: ["GUIDANCE-C not a command"],
      excluded: ["MULTILINE-COMMAND", "APP-NOISE", "MIRROR-NOISE"]
    },
    {
      id: "guidance-on-the-second-comments-page-is-injected",
      comments: [
        ...Array.from({ length: 100 }, (_, i) => ({ id: 1 + i, login: "maintainer", body: `OLD-PAGE-${i + 1}` })),
        { id: 510, login: "maintainer", body: "GUIDANCE-PAGE-2" },
        { id: RESUME_COMMENT, login: "maintainer", body: "/epure continue" }
      ],
      included: ["GUIDANCE-PAGE-2"],
      excluded: ["OLD-PAGE-"]
    },
    {
      id: "permission-lookups-stop-after-10-distinct-authors",
      comments: [
        { id: 510, login: "maintainer", body: "OLDEST-WRITER" },
        ...Array.from({ length: 10 }, (_, i) => ({ id: 520 + i, login: `visitor-${i + 1}`, body: `VISITOR-${i + 1}` })),
        { id: RESUME_COMMENT, login: "maintainer", body: "/epure continue" }
      ],
      included: [],
      excluded: ["OLDEST-WRITER", "VISITOR-"],
      expectedPermissionLookups: 10
    }
  ] satisfies ReadonlyArray<{ id: string; comments: readonly CommentSpec[]; included: readonly string[]; excluded: readonly string[]; expectedPermissionLookups?: number }>)(
    "$id",
    async ({ comments, included, excluded, ...rest }) => {
      const store = await seedState({
        status: "suspended",
        subphase: "idle",
        last_processed_comment_id: ESCALATED_AT_CURSOR,
        last_escalation: { reason: "remediation_exhausted", head_sha: HEAD_SHA, ticket_number: ISSUE, budget_scope: "ticket" }
      });
      const router = declareResumeFlow(comments);
      const command = comments.find((c) => c.id === RESUME_COMMENT)!.body.split(" ")[1] as "continue" | "approve";

      await run(router, store, { command, actor: "maintainer", issueNumber: ISSUE, commentId: RESUME_COMMENT });
      const prompt = implementationPrompt(router);

      expect(router.unmatched).toEqual([]);
      for (const text of included) {
        expect(prompt).toContain(text);
      }
      for (const text of excluded) {
        expect(prompt).not.toContain(text);
      }
      if ("expectedPermissionLookups" in rest) {
        expect(router.calls("GET", new RegExp(`^${R_RX}/collaborators/`))).toBe(rest.expectedPermissionLookups);
      }
    }
  );

  it.each([
    { id: "continue-without-new-comments-injects-no-context-section", command: "continue" },
    { id: "approve-without-new-comments-injects-no-context-section", command: "approve" }
  ] as const)("$id", async ({ command }) => {
    const store = await seedState({ status: "suspended", subphase: "idle", last_processed_comment_id: ESCALATED_AT_CURSOR });
    const router = declareResumeFlow([{ id: RESUME_COMMENT, login: "maintainer", body: `/epure ${command}` }]);

    await run(router, store, { command, actor: "maintainer", issueNumber: ISSUE, commentId: RESUME_COMMENT });

    expect(router.unmatched).toEqual([]);
    expect(implementationPrompt(router)).not.toContain("Consignes humaines publiées depuis l'escalade");
    expect(router.calls("GET", new RegExp(`^${R_RX}/collaborators/`))).toBe(0);
  });
});

describe("Planning LLM rounds can always read the repository", () => {
  it.each([
    { id: "plan-command-outside-github-actions-sends-the-repo-read-tools-with-the-grill-round", command: "plan" },
    { id: "to-spec-command-outside-github-actions-sends-the-repo-read-tools-with-the-spec-round", command: "to-spec" }
  ] as const)("$id", async ({ command }) => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const store = await seedState({ phase: "grilling", status: "active", subphase: "idle", active_branch: "plan/77-async-ci-feature", plan_branch: "plan/77-async-ci-feature" });
    const router = declareIssueWrites(declareIssueReads(createGitHubMockRouter()))
      .on("GET", /\/git\/ref\/heads\//, json({ object: { sha: "branch-sha" } }))
      .on("POST", `${R}/git/refs`, json({ object: { sha: "branch-sha" } }, 201))
      .onHost("api.openai.com", "POST", "/v1/chat/completions", json({ error: { message: "stop after capturing the planning prompt" } }, 400));

    try {
      await run(router, store, { command, actor: "maintainer", issueNumber: ISSUE, commentId: 900 });
    } finally {
      vi.unstubAllEnvs();
    }
    const llmRequest = router.requests.find((r) => r.host === "api.openai.com");

    expect(router.unmatched).toEqual([]);
    expect(JSON.stringify(llmRequest?.body)).toContain("read_repo_file");
  });
});

const FAILING_SANDBOX: NonNullable<OrchestrateIssueInput["sandboxRunner"]> = async () => ({
  isolated: true,
  error_code: "NONE",
  error_message: "",
  proxy_url: "http://127.0.0.1:0/v1/llm",
  exit_code: 1,
  stdout: "",
  stderr: "FAIL src/a.test.ts",
  duration_ms: 5,
  sanitized_env: {}
});

function declareFailingFixFlow(openPrs = { taskPr: true, featurePr: true }): GitHubMockRouter {
  return declareImplementationFlow(createGitHubMockRouter(), "failure", openPrs)
    .on("GET", /\/git\/commits\/[^/]+$/, json({ sha: "branch-sha", tree: { sha: "tree-sha" } }))
    .on("POST", `${R}/git/blobs`, json({ sha: "blob-sha" }, 201))
    .on("POST", `${R}/git/trees`, json({ sha: "new-tree-sha" }, 201))
    .on("POST", `${R}/git/commits`, json({ sha: "wip-sha" }, 201))
    .on("PATCH", /\/git\/refs\/heads\//, json({ object: { sha: "wip-sha" } }))
    .onHost("api.openai.com", "POST", "/v1/chat/completions", (req) => {
      const payload =
        schemaName(req.body) === "generated_ticket_implementation"
          ? { commit_message: "fix: x", test_summary: "x", files: [{ path: "src/a.ts", content: "export const a = 1;\n" }] }
          : { summary: "ok", findings: [] };
      return json({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    });
}

function implementationCalls(router: GitHubMockRouter): number {
  return router.requests.filter((r) => r.host === "api.openai.com" && schemaName(r.body) === "generated_ticket_implementation").length;
}

describe("One remediation budget per ticket shared by fix rounds and Stage 1 retries", () => {
  it.each([
    { id: "fresh-ticket-budget-spends-3-attempts-across-fix-round-and-stage1-retries-then-escalates-once", attempts: 0, expectedImplementationCalls: 3 },
    { id: "ticket-at-1-of-3-spends-its-last-2-attempts-across-fix-round-and-stage1-retry-then-escalates-once", attempts: 1, expectedImplementationCalls: 2 },
    { id: "ticket-at-2-of-3-spends-its-last-attempt-on-the-fix-round-then-escalates-once", attempts: 2, expectedImplementationCalls: 1 },
    { id: "legacy-state-with-a-single-counter-at-2-of-3-spends-its-last-attempt-then-escalates-once", attempts: 2, legacyCounter: true, expectedImplementationCalls: 1 }
  ] as ReadonlyArray<{ id: string; attempts: number; legacyCounter?: boolean; expectedImplementationCalls: number }>)("$id", async ({ attempts, legacyCounter, expectedImplementationCalls }) => {
    const store = await seedState({
      status: "active",
      subphase: "waiting_ticket_ci",
      active_ticket_number: ISSUE,
      active_task_branch: TASK_BRANCH,
      active_pr_number: 106,
      ...(legacyCounter
        ? { code_fix_attempts_used: attempts }
        : { code_fix_attempts_by_ticket: { [String(ISSUE)]: attempts } })
    });
    const router = declareFailingFixFlow();

    await orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      stateStore: store,
      fetchImpl: router.fetch,
      sandboxRunner: FAILING_SANDBOX,
      command: "continue",
      actor: "github-actions[bot]",
      ...TRIGGERS.workflowRun
    });
    const after = await readState(store);

    expect(router.unmatched).toEqual([]);
    expect(implementationCalls(router)).toBe(expectedImplementationCalls);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(1);
    expect(after).toMatchObject({
      status: "suspended",
      code_fix_attempts_by_ticket: { [String(ISSUE)]: 3 },
      last_escalation: { reason: "remediation_exhausted", ticket_number: ISSUE, budget_scope: "ticket" }
    });
  });
});

describe("One remediation budget per feature PR shared by fix rounds and Stage 1 retries", () => {
  it.each([
    { id: "fresh-feature-budget-spends-3-attempts-across-fix-round-and-stage1-retries-then-escalates-once", attempts: 0, expectedImplementationCalls: 3 },
    { id: "feature-at-2-of-3-spends-its-last-attempt-on-the-fix-round-then-escalates-once", attempts: 2, expectedImplementationCalls: 1 }
  ] as const)("$id", async ({ attempts, expectedImplementationCalls }) => {
    const store = await seedState(seedFor({ status: "active", subphase: "waiting_feature_ci", attempts }));
    const router = declareFailingFixFlow({ taskPr: false, featurePr: true });

    await orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      stateStore: store,
      fetchImpl: router.fetch,
      sandboxRunner: FAILING_SANDBOX,
      command: "continue",
      actor: "github-actions[bot]",
      ...TRIGGERS.workflowRun
    });
    const after = await readState(store);

    expect(router.unmatched).toEqual([]);
    expect(implementationCalls(router)).toBe(expectedImplementationCalls);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(1);
    expect(after).toMatchObject({
      status: "suspended",
      feature_code_fix_attempts_used: 3,
      last_escalation: { reason: "remediation_exhausted", budget_scope: "feature" }
    });
  });
});

describe("A resume command after budget exhaustion grants one fresh budget and records it", () => {
  it.each([
    { id: "continue-after-remediation_exhausted-resets-the-ticket-budget-and-records-who-granted-it", command: "continue", reason: "remediation_exhausted", expectedImplementationCalls: 3, expectedGrantLog: [{ actor: "maintainer", comment_id: 900, scope: "ticket", ticket: ISSUE }] },
    { id: "approve-after-remediation_exhausted-resets-the-ticket-budget-and-records-who-granted-it", command: "approve", reason: "remediation_exhausted", expectedImplementationCalls: 3, expectedGrantLog: [{ actor: "maintainer", comment_id: 900, scope: "ticket", ticket: ISSUE }] },
    { id: "continue-after-another-escalation-reason-keeps-the-exhausted-budget", command: "continue", reason: "llm_request_invalid", expectedImplementationCalls: 0, expectedGrantLog: undefined },
    { id: "continue-after-github_rate_limited-resumes-the-ticket-without-a-budget-grant", command: "continue", reason: "github_rate_limited", expectedImplementationCalls: 0, expectedGrantLog: undefined }
  ] as const)("$id", async ({ command, reason, expectedImplementationCalls, expectedGrantLog }) => {
    const store = await seedState({
      status: "suspended",
      subphase: "idle",
      code_fix_attempts_by_ticket: { [String(ISSUE)]: 3 },
      last_escalation: { reason, head_sha: HEAD_SHA, ticket_number: ISSUE, budget_scope: "ticket" }
    });
    const router = declareFailingFixFlow();

    await orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      stateStore: store,
      fetchImpl: router.fetch,
      sandboxRunner: FAILING_SANDBOX,
      command,
      actor: "maintainer",
      issueNumber: ISSUE,
      commentId: 900
    });
    const after = await readState(store);
    const resumeNotes = postedComments(router).filter((body) => body.includes("budget de remédiation remis à zéro pour le ticket #77"));

    expect(router.unmatched).toEqual([]);
    expect(implementationCalls(router)).toBe(expectedImplementationCalls);
    expect(after.human_budget_grants ?? 0).toBe(expectedGrantLog?.length ?? 0);
    expect(after.human_budget_grant_log).toEqual(expectedGrantLog);
    expect(resumeNotes).toHaveLength(expectedGrantLog?.length ?? 0);
    expect(after).toMatchObject({
      status: "suspended",
      code_fix_attempts_by_ticket: { [String(ISSUE)]: 3 },
      last_escalation: { reason: "remediation_exhausted" }
    });
  });

  it.each([
    { id: "resume-after-pr_not_mergeable-forgets-it-so-the-same-refusal-on-the-same-sha-is-reported-again", reason: "pr_not_mergeable" },
    { id: "resume-after-github_rate_limited-forgets-it-so-the-same-escalation-on-the-same-sha-is-reported-again", reason: "github_rate_limited" }
  ] as const)("$id", async ({ reason }) => {
    const seeded = await seedState({
      status: "suspended",
      subphase: "idle",
      last_escalation: { reason, head_sha: HEAD_SHA, ticket_number: ISSUE, budget_scope: "ticket" }
    });
    const { store, writes } = captureWrites(seeded);
    const router = declareFailingFixFlow();

    await run(router, store, { command: "continue", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });

    expect(router.unmatched).toEqual([]);
    expect(writes[0]).toMatchObject({ status: "active", last_escalation: undefined });
  });
});

describe("Escalation comments remind the exact resume command", () => {
  it.each([
    { id: "remediation_exhausted-reminds-continue-and-the-budget-reset", attempts: 3, expectedReason: "remediation_exhausted", mentionsBudgetReset: true },
    { id: "llm_request_invalid-during-a-fix-round-reminds-continue-without-budget-reset", attempts: 2, expectedReason: "llm_request_invalid", mentionsBudgetReset: false }
  ] as const)("$id", async ({ attempts, expectedReason, mentionsBudgetReset }) => {
    const store = await seedState({ ...seedFor({ status: "active", subphase: "waiting_ticket_ci", attempts }), last_processed_comment_id: 321 });
    const router = declareFullFlow("failure");

    await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun });
    const posted = router.requests.filter((r) => r.method === "POST" && r.path === `${R}/issues/${ISSUE}/comments`);
    const body = (posted.at(-1)?.body as { body: string }).body;
    const after = await readState(store);

    expect(router.unmatched).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(after).toMatchObject({ status: "suspended", last_processed_comment_id: 321, last_escalation: { reason: expectedReason } });
    expect(body).toContain("Postez `/epure continue` (ou `/epure approve`)");
    expect(body).toContain("Une réponse libre ne reprend pas l'exécution");
    expect(body.includes("remet à zéro le budget de remédiation")).toBe(mentionsBudgetReset);
  });
});

describe("A feature PR is never opened twice for the same epic", () => {
  it.each([
    {
      id: "merged-feature-pr-for-the-epic-marks-the-plan-done-without-rerunning-tickets-or-opening-another",
      issueTitle: "Async CI Feature",
      closedPrs: [{ number: 105, html_url: "pr105", merged_at: "2026-11-01T00:00:00Z" }],
      expectsShortCircuit: true
    },
    {
      id: "merged-feature-pr-is-found-on-the-stored-branch-after-the-epic-title-was-renamed",
      issueTitle: "Event-driven CI continuation",
      closedPrs: [{ number: 105, html_url: "pr105", merged_at: "2026-11-01T00:00:00Z" }],
      expectsShortCircuit: true
    },
    {
      id: "ticket-escalation-then-epic-rename-then-continue-resolves-the-stored-feature-branch-not-the-task-branch",
      issueTitle: "Event-driven CI continuation",
      seed: { ...FEATURE_INTEGRATION_PENDING_STATE, status: "suspended", subphase: "idle", active_branch: TASK_BRANCH, feature_branch: FEATURE_BRANCH },
      command: "continue",
      closedPrs: [{ number: 105, html_url: "pr105", merged_at: "2026-11-01T00:00:00Z" }],
      expectsShortCircuit: true
    },
    {
      id: "closed-unmerged-feature-pr-does-not-stop-the-implementation",
      issueTitle: "Async CI Feature",
      closedPrs: [{ number: 104, html_url: "pr104", merged_at: null }],
      expectsShortCircuit: false
    },
    {
      id: "no-previous-feature-pr-does-not-stop-the-implementation",
      issueTitle: "Async CI Feature",
      closedPrs: [],
      expectsShortCircuit: false
    }
  ] as ReadonlyArray<{
    readonly id: string;
    readonly issueTitle: string;
    readonly seed?: Partial<EpureIssueState>;
    readonly command?: "approve" | "continue";
    readonly closedPrs: readonly { number: number; html_url: string; merged_at: string | null }[];
    readonly expectsShortCircuit: boolean;
  }>)("$id", async ({ issueTitle, seed, command, closedPrs, expectsShortCircuit }) => {
    const store = await seedState(seed ?? FEATURE_INTEGRATION_PENDING_STATE);
    const router = declareImplementationFlow(createGitHubMockRouter(), "success", { taskPr: false, featurePr: false })
      .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: issueTitle, body: "- [ ] Ship it", state: "open" }))
      .on("GET", /\/pulls\?state=closed&head=/, (req) =>
        json(req.path.includes(encodeURIComponent(`${OWNER}:${FEATURE_BRANCH}`)) ? closedPrs : [])
      );

    await run(router, store, { command: command ?? "approve", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });
    const after = await readState(store);

    expect(router.unmatched).toEqual([]);
    expect(router.calls("POST", `${R}/pulls`)).toBe(0);
    expect(router.requests.filter((r) => r.path.includes("event-driven-ci-continuation"))).toEqual([]);
    expect(router.calls("POST", "/v1/chat/completions", "api.openai.com") > 0).toBe(!expectsShortCircuit);
    expect(after.status === "done").toBe(expectsShortCircuit);
    expect(postedComments(router).some((body) => body.includes("[#105](pr105) de `feature/77-async-ci-feature` est déjà fusionnée dans `dev`"))).toBe(expectsShortCircuit);
  });
});

describe("A feature PR merged by a human while a ticket CI was awaited stops the run before any branch write (#107)", () => {
  it("green-ticket-ci-after-the-feature-pr-was-merged-marks-the-plan-done-without-merging-the-task-pr", async () => {
    const store = await seedState(FEATURE_INTEGRATION_PENDING_STATE);
    const router = declareImplementationFlow(createGitHubMockRouter(), "success", { taskPr: true, featurePr: false })
      .on("GET", /\/pulls\?state=closed&head=/, (req) =>
        json(
          req.path.includes(encodeURIComponent(`${OWNER}:${FEATURE_BRANCH}`))
            ? [{ number: 105, html_url: "pr105", merged_at: "2026-11-01T00:00:00Z" }]
            : []
        )
      );

    await run(router, store, { command: "continue", actor: "github-actions[bot]", ...TRIGGERS.workflowRun });

    expect(router.unmatched).toEqual([]);
    expect(router.requests.filter((r) => r.method === "PUT" || r.path.endsWith("/git/commits"))).toEqual([]);
    expect(await readState(store)).toMatchObject({ status: "done", active_pr_number: undefined });
    expect(postedComments(router).some((body) => body.includes("[#105](pr105) de `feature/77-async-ci-feature` est déjà fusionnée dans `dev`"))).toBe(true);
  });
});

describe("A human closing the epic before its feature branch reaches dev cancels the plan with an alert", () => {
  function declareClosureReads(
    router: GitHubMockRouter,
    params: {
      readonly mergedFeaturePr: boolean;
      readonly aheadBy: number;
      readonly featurePr: boolean;
      readonly taskPrs: readonly number[];
      readonly closer?: { readonly permission: string; readonly role_name: string };
      readonly issueState?: "open" | "closed";
    }
  ): GitHubMockRouter {
    return declareIssueWrites(router)
      .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Async CI Feature", body: "- [ ] Ship it", state: params.issueState ?? "closed" }))
      .on("GET", /\/collaborators\/[^/]+\/permission$/, json(params.closer ?? { permission: "write", role_name: "write" }))
      .on("GET", /\/pulls\?state=closed&head=/, json(params.mergedFeaturePr ? [{ number: 105, html_url: "pr105", merged_at: "2026-11-01T00:00:00Z" }] : []))
      .on("GET", new RegExp(`/compare/dev\\.\\.\\.${encodeURIComponent(FEATURE_BRANCH)}$`), json({ ahead_by: params.aheadBy, merge_base_commit: { sha: "dev-sha" }, files: [] }))
      .on("GET", /\/pulls\?state=open&head=/, json(params.featurePr ? [{ number: 105, html_url: "pr105", head: { sha: HEAD_SHA } }] : []))
      .on("GET", /\/pulls\?state=open&base=/, json(params.taskPrs.map((n) => ({ number: n, html_url: `pr${n}` }))));
  }

  function reopenIssue(router: GitHubMockRouter): GitHubMockRouter {
    return declareIssueReads(router);
  }

  it.each([
    {
      id: "implementation-waiting_ticket_ci-with-unmerged-commits-lists-feature-and-task-prs",
      seed: { status: "active", subphase: "waiting_ticket_ci", active_ticket_number: 78, active_task_branch: TASK_BRANCH },
      reads: { mergedFeaturePr: false, aheadBy: 4, featurePr: true, taskPrs: [106] },
      expectedLines: ["4 commit(s) non intégré(s)", "[#105](pr105), [#106](pr106)"]
    },
    {
      id: "suspended-implementation-without-open-prs-reports-none",
      seed: { status: "suspended", subphase: "idle" },
      reads: { mergedFeaturePr: false, aheadBy: 2, featurePr: false, taskPrs: [] },
      expectedLines: ["2 commit(s) non intégré(s)", "**Pull Requests ouvertes** : aucune"]
    },
    {
      id: "ticket-escalation-left-a-task-branch-active-and-the-alert-still-names-the-stored-feature-branch",
      seed: { status: "suspended", subphase: "idle", active_branch: TASK_BRANCH, feature_branch: FEATURE_BRANCH },
      reads: { mergedFeaturePr: false, aheadBy: 3, featurePr: true, taskPrs: [106] },
      expectedLines: ["3 commit(s) non intégré(s)", "[#105](pr105), [#106](pr106)"]
    },
    {
      id: "review-phase-waiting-on-feature-ci-cancels-and-lists-the-feature-pr",
      seed: { status: "active", phase: "review", subphase: "waiting_feature_ci", active_pr_number: 105 },
      reads: { mergedFeaturePr: false, aheadBy: 5, featurePr: true, taskPrs: [] },
      expectedLines: ["5 commit(s) non intégré(s)", "[#105](pr105)"]
    },
    {
      id: "completed-plan-awaiting-the-human-merge-cancels-and-keeps-the-feature-pr-open",
      seed: { status: "awaiting_human_approval", phase: "completed", subphase: "idle" },
      reads: { mergedFeaturePr: false, aheadBy: 6, featurePr: true, taskPrs: [] },
      expectedLines: ["6 commit(s) non intégré(s)", "[#105](pr105)"]
    },
    {
      id: "done-with-unmerged-feature-pr-keeps-it-open",
      seed: { status: "done", phase: "completed", subphase: "idle" },
      reads: { mergedFeaturePr: false, aheadBy: 7, featurePr: true, taskPrs: [] },
      expectedLines: ["7 commit(s) non intégré(s)", "[#105](pr105)"]
    }
  ] as const)("$id", async ({ seed, reads, expectedLines }) => {
    const store = await seedState(seed);
    const router = declareClosureReads(createGitHubMockRouter(), reads);

    const res = await run(router, store, { command: "closed", actor: "maintainer", issueNumber: ISSUE, commentId: 0 });
    const posted = postedComments(router);
    const after = await readState(store);

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(true);
    expect(after.status).toBe("cancelled");
    expect(terminalResidue(after)).toEqual(CLEAN_TERMINAL);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`- **Branche de fonctionnalité** : \`${FEATURE_BRANCH}\``);
    expect(posted[0]).toContain("rouvrez l'issue #77, puis postez `/epure continue`");
    for (const line of expectedLines) {
      expect(posted[0]).toContain(line);
    }
    expect(router.requests.filter((r) => r.method === "DELETE" || r.method === "PATCH")).toEqual([]);
  });

  it.each([
    { id: "feature-pr-already-merged-into-dev-is-ignored", seed: { status: "done", phase: "completed", subphase: "idle" }, mergedFeaturePr: true, issueState: "closed" },
    { id: "already-cancelled-plan-is-ignored", seed: { status: "cancelled", subphase: "idle" }, mergedFeaturePr: false, issueState: "closed" },
    { id: "closure-event-delivered-after-the-issue-was-reopened-is-ignored", seed: { status: "active", subphase: "waiting_ticket_ci" }, mergedFeaturePr: false, issueState: "open" }
  ] as const)("$id", async ({ seed, mergedFeaturePr, issueState }) => {
    const store = await seedState(seed);
    const before = await readState(store);
    const router = declareClosureReads(createGitHubMockRouter(), { mergedFeaturePr, aheadBy: 0, featurePr: false, taskPrs: [], issueState });

    const res = await run(router, store, { command: "closed", actor: "maintainer", issueNumber: ISSUE, commentId: 0 });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(false);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(0);
    expect(await readState(store)).toEqual(before);
  });

  it.each([
    { id: "maintain-closer-cancels-the-plan", seed: { status: "active", subphase: "waiting_ticket_ci" }, closer: { permission: "write", role_name: "maintain" } },
    { id: "admin-closer-cancels-a-grilling-plan", seed: { status: "active", phase: "grilling", subphase: "idle" }, closer: { permission: "admin", role_name: "admin" } },
    { id: "custom-role-based-on-write-cancels-the-plan", seed: { status: "suspended", subphase: "idle" }, closer: { permission: "write", role_name: "release-manager" } }
  ] as const)("$id", async ({ seed, closer }) => {
    const store = await seedState(seed);
    const router = declareClosureReads(createGitHubMockRouter(), { mergedFeaturePr: false, aheadBy: 1, featurePr: false, taskPrs: [], closer });

    const res = await run(router, store, { command: "closed", actor: "author", issueNumber: ISSUE, commentId: 0 });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(true);
    expect(postedComments(router)).toHaveLength(1);
    expect((await readState(store)).status).toBe("cancelled");
  });

  it.each([
    { id: "read-closer-of-an-implementation-epic-leaves-the-plan-active-without-commenting", seed: { status: "active", subphase: "waiting_ticket_ci" }, closer: { permission: "read", role_name: "read" }, expectedPermission: "read" },
    { id: "triage-closer-of-a-grilling-epic-leaves-the-plan-active-without-commenting", seed: { status: "active", phase: "grilling", subphase: "idle" }, closer: { permission: "read", role_name: "triage" }, expectedPermission: "triage" },
    { id: "issue-author-without-repo-access-leaves-the-plan-suspended-without-commenting", seed: { status: "suspended", subphase: "idle" }, closer: { permission: "none", role_name: "none" }, expectedPermission: "none" },
    { id: "custom-role-based-on-read-leaves-the-plan-active-without-commenting", seed: { status: "active", subphase: "waiting_ticket_ci" }, closer: { permission: "read", role_name: "security-auditor" }, expectedPermission: "read" }
  ] as const)("$id", async ({ seed, closer, expectedPermission }) => {
    const store = await seedState(seed);
    const before = await readState(store);
    const router = declareClosureReads(createGitHubMockRouter(), { mergedFeaturePr: false, aheadBy: 1, featurePr: false, taskPrs: [], closer });

    const res = await run(router, store, { command: "closed", actor: "author", issueNumber: ISSUE, commentId: 0 });

    expect(router.unmatched).toEqual([]);
    expect(res.executed).toBe(false);
    expect(res.summary_markdown).toContain(`closer @author has permission ${expectedPermission}`);
    expect(postedComments(router)).toEqual([]);
    expect(await readState(store)).toEqual(before);
  });

  it.each([
    { id: "grilling-close-cancels-then-continue-reopens-the-interview", phase: "grilling", status: "active", expectedStatus: "active", expectedNextStep: "poursuivre l'entretien", expectsNeedsHuman: false },
    { id: "spec-close-cancels-then-continue-waits-for-the-spec-review-again", phase: "spec", status: "active", expectedStatus: "awaiting_human_approval", expectedNextStep: "réviser la spécification", expectsNeedsHuman: false },
    { id: "tickets-awaiting-approval-close-cancels-then-continue-awaits-approval-again", phase: "tickets", status: "awaiting_human_approval", expectedStatus: "awaiting_human_approval", expectedNextStep: "Postez `/epure approve`", expectsNeedsHuman: false },
    { id: "suspended-grilling-close-cancels-then-continue-stays-suspended-and-names-plan", phase: "grilling", status: "suspended", expectedStatus: "suspended", expectedNextStep: "postez `/epure plan` pour relancer la phase", expectsNeedsHuman: true },
    { id: "suspended-tickets-close-cancels-then-continue-stays-suspended-and-names-to-tickets", phase: "tickets", status: "suspended", expectedStatus: "suspended", expectedNextStep: "postez `/epure to-tickets` pour relancer la phase", expectsNeedsHuman: true }
  ] as const)("$id", async ({ phase, status, expectedStatus, expectedNextStep, expectsNeedsHuman }) => {
    const store = await seedState({ phase, status, subphase: "idle", active_branch: "plan/77-async-ci-feature", plan_branch: "plan/77-async-ci-feature" });
    const router = declareClosureReads(createGitHubMockRouter(), { mergedFeaturePr: false, aheadBy: 0, featurePr: false, taskPrs: [] });

    const closed = await run(router, store, { command: "closed", actor: "maintainer", issueNumber: ISSUE, commentId: 0 });
    const afterClose = await readState(store);
    const [closeBody] = postedComments(router);
    reopenIssue(router);
    const labelsBeforeResume = router.calls("POST", `${R}/issues/${ISSUE}/labels`);
    const resumed = await run(router, store, { command: "continue", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });
    const resumeBody = postedComments(router).at(1);

    expect(router.unmatched).toEqual([]);
    expect(closed.executed).toBe(true);
    expect(afterClose).toMatchObject({ status: "cancelled", phase, cancelled_from: { phase, status } });
    expect(terminalResidue(afterClose)).toEqual(CLEAN_TERMINAL);
    expect(closeBody).toContain(`pendant la phase \`${phase}\``);
    expect(closeBody).toContain("rouvrez l'issue #77, puis postez `/epure continue`");
    expect(router.calls("GET", /\/compare\//) + router.calls("GET", /\/pulls\?/)).toBe(0);
    expect(router.requests.filter((r) => r.method === "DELETE" || r.method === "PATCH")).toEqual([]);
    expect(resumed.executed).toBe(true);
    expect(await readState(store)).toMatchObject({ phase, status: expectedStatus, cancelled_from: undefined, last_processed_comment_id: 900 });
    expect(resumeBody).toContain(expectedNextStep);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/labels`) - labelsBeforeResume).toBe(expectsNeedsHuman ? 1 : 0);
  });

  it("continue-on-a-plan-cancelled-by-closure-while-the-issue-is-still-closed-asks-to-reopen-and-keeps-it-cancelled", async () => {
    const store = await seedState({ phase: "tickets", status: "awaiting_human_approval", subphase: "idle" });
    const router = declareClosureReads(createGitHubMockRouter(), { mergedFeaturePr: false, aheadBy: 0, featurePr: false, taskPrs: [] })
      .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json([]));

    await run(router, store, { command: "closed", actor: "maintainer", issueNumber: ISSUE, commentId: 0 });
    const resumed = await run(router, store, { command: "continue", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });

    expect(router.unmatched).toEqual([]);
    expect(resumed.executed).toBe(false);
    expect(postedComments(router).at(-1)).toContain("rouvrez l'issue #77, puis postez `/epure continue`");
    expect(await readState(store)).toMatchObject({ status: "cancelled", cancelled_from: { phase: "tickets", status: "awaiting_human_approval" } });
  });

  it("review-close-cancels-then-reopen-and-continue-resumes-the-feature-integration-run", async () => {
    const store = await seedState({ phase: "review", status: "active", subphase: "waiting_feature_ci", active_pr_number: 105, feature_branch: FEATURE_BRANCH });
    const router = declareClosureReads(createGitHubMockRouter(), { mergedFeaturePr: false, aheadBy: 2, featurePr: true, taskPrs: [] });

    const closed = await run(router, store, { command: "closed", actor: "maintainer", issueNumber: ISSUE, commentId: 0 });
    const afterClose = await readState(store);
    declareImplementationFlow(router, "success", { taskPr: false, featurePr: true });
    const resumed = await run(router, store, { command: "continue", actor: "maintainer", issueNumber: ISSUE, commentId: 900 });

    expect(router.unmatched).toEqual([]);
    expect(closed.executed).toBe(true);
    expect(afterClose).toMatchObject({ status: "cancelled", cancelled_from: { phase: "review", status: "active" } });
    expect(resumed.executed).toBe(true);
    expect((await readState(store)).status).not.toBe("cancelled");
  });

  it("rate-limit-past-the-budget-during-a-closure-rejects-with-closure-not-processed-and-leaves-the-plan-untouched", async () => {
    const store = await seedState({ status: "active", subphase: "waiting_ticket_ci" });
    const before = await readState(store);
    const router = declareClosureReads(createGitHubMockRouter(), { mergedFeaturePr: false, aheadBy: 1, featurePr: false, taskPrs: [] })
      .on("GET", `${R}/issues/${ISSUE}`, primaryRateLimit(Math.floor(Date.now() / 1000) + 3600));

    await expect(
      run(router, store, { command: "closed", actor: "maintainer", issueNumber: ISSUE, commentId: 0 })
    ).rejects.toBeInstanceOf(ClosureNotProcessedError);

    expect(router.unmatched).toEqual([]);
    expect(postedComments(router)).toEqual([]);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/labels`)).toBe(0);
    expect(await readState(store)).toEqual(before);
  });
});

describe("GitHub API rate limits are waited out within 5 minutes, then escalate github_rate_limited", () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const seedWaitingTicket = () =>
    seedState({ status: "active", subphase: "waiting_ticket_ci", active_ticket_number: 78, active_task_branch: TASK_BRANCH });

  it.each([
    { id: "secondary-403-with-retry-after-waits-the-advertised-seconds", limited: () => secondaryRateLimit(30), expectedWaitsSeconds: [30] },
    { id: "secondary-403-without-retry-after-waits-one-minute", limited: () => secondaryRateLimit(), expectedWaitsSeconds: [60] },
    { id: "429-with-retry-after-waits-the-advertised-seconds", limited: () => tooManyRequests(10), expectedWaitsSeconds: [10] },
    { id: "primary-403-quota-spent-waits-until-x-ratelimit-reset", limited: () => primaryRateLimit(nowSeconds() + 120), expectedWaitsSeconds: [120] },
    { id: "primary-403-reset-already-passed-retries-after-one-second", limited: () => primaryRateLimit(nowSeconds() - 10), expectedWaitsSeconds: [1] }
  ])("$id then completes the command", async ({ limited, expectedWaitsSeconds }) => {
    const store = await seedWaitingTicket();
    const waits: number[] = [];
    const router = declareIssueWrites(createGitHubMockRouter())
      .on("POST", `${R}/issues/${ISSUE}/comments`, limited(), json({ html_url: "c" }, 201));

    await orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      stateStore: store,
      fetchImpl: router.fetch,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
      command: "cancel",
      actor: "maintainer",
      issueNumber: ISSUE,
      commentId: 501
    });

    expect(router.unmatched).toEqual([]);
    expect(waits.map((ms) => Math.ceil(ms / 1000))).toEqual(expectedWaitsSeconds);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(2);
    expect((await readState(store)).status).toBe("cancelled");
  });

  it("primary-403-reset-already-passed-on-every-retry-backs-off-exponentially-then-completes-the-command", async () => {
    const store = await seedWaitingTicket();
    const waits: number[] = [];
    const past = primaryRateLimit(nowSeconds() - 10);
    const router = declareIssueWrites(createGitHubMockRouter())
      .on("POST", `${R}/issues/${ISSUE}/comments`, past, past, past, json({ html_url: "c" }, 201));

    await orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      stateStore: store,
      fetchImpl: router.fetch,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
      command: "cancel",
      actor: "maintainer",
      issueNumber: ISSUE,
      commentId: 501
    });

    expect(router.unmatched).toEqual([]);
    expect(waits.map((ms) => Math.ceil(ms / 1000))).toEqual([1, 2, 4]);
    expect((await readState(store)).status).toBe("cancelled");
  });

  it.each([
    { id: "primary-403-reset-beyond-the-budget-escalates-without-waiting", limited: () => primaryRateLimit(nowSeconds() + 3600), expectedWaitsSeconds: [] },
    { id: "secondary-403-retry-after-120-waits-twice-then-escalates-before-exceeding-300s", limited: () => secondaryRateLimit(120), expectedWaitsSeconds: [120, 120] },
    { id: "429-retry-after-100-waits-three-times-then-escalates-before-exceeding-300s", limited: () => tooManyRequests(100), expectedWaitsSeconds: [100, 100, 100] }
  ])("$id", async ({ limited, expectedWaitsSeconds }) => {
    const store = await seedWaitingTicket();
    const waits: number[] = [];
    const router = declareIssueWrites(createGitHubMockRouter()).on("GET", `${R}/issues/${ISSUE}`, limited());

    await orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      stateStore: store,
      fetchImpl: router.fetch,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
      command: "continue",
      actor: "github-actions[bot]",
      ...TRIGGERS.workflowRunForIssue
    });
    const posted = router.requests.filter((r) => r.method === "POST" && r.path === `${R}/issues/${ISSUE}/comments`);
    const body = (posted.at(-1)?.body as { body: string }).body;

    expect(router.unmatched).toEqual([]);
    expect(waits.map((ms) => Math.ceil(ms / 1000))).toEqual(expectedWaitsSeconds);
    expect(await readState(store)).toMatchObject({ status: "suspended", last_escalation: { reason: "github_rate_limited" } });
    expect(router.calls("POST", `${R}/issues/${ISSUE}/labels`)).toBe(1);
    expect(posted).toHaveLength(1);
    expect(body).toContain("`github_rate_limited`");
    expect(body).toContain("Postez `/epure continue` (ou `/epure approve`)");
  });

  async function runEscalationWithThrottledComment(...commentReplies: [RouteStep, ...RouteStep[]]) {
    const store = await seedWaitingTicket();
    const waits: number[] = [];
    const router = declareIssueWrites(createGitHubMockRouter())
      .on("GET", `${R}/issues/${ISSUE}`, secondaryRateLimit(120))
      .on("POST", `${R}/issues/${ISSUE}/comments`, ...commentReplies);

    const outcome = await orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      stateStore: store,
      fetchImpl: router.fetch,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
      command: "continue",
      actor: "github-actions[bot]",
      ...TRIGGERS.workflowRunForIssue
    }).then(
      () => null,
      (err: unknown) => err
    );
    expect(router.unmatched).toEqual([]);
    return { outcome, waitsSeconds: waits.map((ms) => Math.ceil(ms / 1000)), router, state: await readState(store) };
  }

  it("escalation-comment-throttled-once-after-the-run-budget-is-spent-is-still-posted-within-its-own-budget", async () => {
    const run = await runEscalationWithThrottledComment(secondaryRateLimit(120), json({ html_url: "c" }, 201));

    expect(run.outcome).toBeNull();
    expect(run.waitsSeconds).toEqual([120, 120, 120]);
    expect(run.state).toMatchObject({ status: "suspended", last_escalation: { reason: "github_rate_limited" } });
    expect(postedComments(run.router).at(-1)).toContain("`github_rate_limited`");
  });

  it("escalation-comment-still-throttled-past-its-own-budget-leaves-the-plan-suspended-and-rejects-with-the-escalation-for-the-action-summary", async () => {
    const run = await runEscalationWithThrottledComment(primaryRateLimit(nowSeconds() + 3600));

    expect(run.waitsSeconds).toEqual([120, 120]);
    expect(run.state).toMatchObject({ status: "suspended", subphase: "idle", last_escalation: { reason: "github_rate_limited" } });
    expect(run.outcome).toBeInstanceOf(EscalationNotRecordedError);
    expect(run.outcome).toMatchObject({
      message: expect.stringContaining(`/epure continue\` on #${ISSUE}`),
      escalationMarkdown: expect.stringMatching(/`github_rate_limited`[\s\S]*Postez `\/epure continue`/)
    });
  });
});

describe("State ref read and write failures never act on an empty or stale state", () => {
  const STATE_REF = `refs/epure/state/${ISSUE}`;
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  async function seedRefState(router: GitHubMockRouter) {
    const git = installFakeGitDataApi(router, REPO);
    const store = createGitHubApiRefStateStore({ repository: REPO, githubToken: "ghs_test", fetchImpl: router.fetch });
    await updateIssueStateWithCas({
      issueNumber: ISSUE,
      store,
      mutator: (prev) => ({ ...prev, phase: "implementation", status: "active", subphase: "waiting_ticket_ci", active_branch: FEATURE_BRANCH, active_head_sha: HEAD_SHA })
    });
    return git;
  }

  function graphqlRateLimitedOnce(inner: typeof fetch, resetEpochSeconds: number): typeof fetch {
    let armed = true;
    return async (input, init) => {
      if (armed && String(input).endsWith("/graphql")) {
        armed = false;
        return new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation ID 1." }] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSeconds) }
        });
      }
      return await inner(input, init);
    };
  }

  function cancelThroughRefStore(fetchImpl: typeof fetch, waits: number[] = []) {
    return orchestrateIssueCommand({
      repository: REPO,
      commandArgs: "",
      fallbackGithubToken: "ghs_test",
      llmApiKey: "key_test",
      model: "openai/gpt-test",
      fetchImpl,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
      command: "cancel",
      actor: "maintainer",
      issueNumber: ISSUE,
      commentId: 501
    });
  }

  it("502-on-the-state-commit-read-rejects-the-command-without-posting-or-writing", async () => {
    const router = declareIssueWrites(createGitHubMockRouter());
    const git = await seedRefState(router);
    const refBefore = git.getRef(STATE_REF);
    router.on("GET", /\/git\/commits\/[0-9a-f]+$/, serverError());

    await expect(cancelThroughRefStore(router.fetch)).rejects.toThrow(/HTTP 502/);

    expect(router.unmatched).toEqual([]);
    expect(router.calls("POST", `${R}/issues/${ISSUE}/comments`)).toBe(0);
    expect(git.getRef(STATE_REF)).toBe(refBefore);
  });

  it.each([
    { id: "graphql-rate-limited-state-write-waits-for-the-reset-then-cancels", resetIn: 30, expectedWaitsSeconds: [30], expected: { status: "cancelled" } },
    {
      id: "graphql-rate-limited-state-write-beyond-the-wait-budget-escalates-github_rate_limited-not-a-cas-conflict",
      resetIn: 3600,
      expectedWaitsSeconds: [],
      expected: { status: "suspended", last_escalation: { reason: "github_rate_limited" } }
    }
  ])("$id", async ({ resetIn, expectedWaitsSeconds, expected }) => {
    const router = declareIssueWrites(createGitHubMockRouter());
    await seedRefState(router);
    const waits: number[] = [];

    await cancelThroughRefStore(graphqlRateLimitedOnce(router.fetch, nowSeconds() + resetIn), waits);
    const store = createGitHubApiRefStateStore({ repository: REPO, githubToken: "ghs_test", fetchImpl: router.fetch });

    expect(router.unmatched).toEqual([]);
    expect(waits.map((ms) => Math.ceil(ms / 1000))).toEqual(expectedWaitsSeconds);
    expect((await store.readRef(STATE_REF)).state).toMatchObject(expected);
  });
});

describe("Every run logs how many GitHub API requests it sent (#110)", () => {
  it.each([
    { id: "cancel-logs-its-request-count", command: "cancel", commentId: 501 },
    { id: "status-logs-its-request-count", command: "status", commentId: 502 }
  ] as const)("$id", async ({ command, commentId }) => {
    const store = await seedState({ status: "active", subphase: "idle" });
    const router = declareIssueWrites(declareIssueReads(createGitHubMockRouter()));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await run(router, store, { command, actor: "maintainer", issueNumber: ISSUE, commentId });
    const logged = stdout.mock.calls.map(([chunk]) => String(chunk)).filter((l) => l.includes("GitHub API requests"));
    stdout.mockRestore();

    expect(router.unmatched).toEqual([]);
    expect(logged).toEqual([`[EPURE] GitHub API requests this run: ${router.requests.length}\n`]);
  });
});
