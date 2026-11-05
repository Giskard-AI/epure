import { describe, expect, it } from "vitest";
import {
  buildIssueStateRefName,
  createGitHubApiRefStateStore,
  createInMemoryGitRefStateStore,
  formatIssueStateMirrorMarkdown,
  grantHumanBudget,
  readActiveCodeFixAttempts,
  toTerminalState,
  updateIssueStateWithCas,
  withTicketCodeFixAttempts,
  type EpureIssueState
} from "../src/state/git-ref-state.js";
import {
  createGitHubMockRouter,
  installFakeGitDataApi
} from "./fixtures/github-mock-router.js";

describe("Ticket 09 (#10) — Atomic Git ref state (refs/epure/state/*) & concurrent CAS", () => {
  it.each([
    {
      id: "formats-custom-git-ref-outside-working-tree",
      issueNumber: 10,
      expectedRef: "refs/epure/state/10"
    },
    {
      id: "formats-custom-git-ref-for-plan-issue-1",
      issueNumber: 1,
      expectedRef: "refs/epure/state/1"
    }
  ])(
    "buildIssueStateRefName [$id]: maps issue #$issueNumber to '$expectedRef' without touching dev/main/feature/* branches",
    ({ issueNumber, expectedRef }) => {
      const refName = buildIssueStateRefName(issueNumber);
      expect(refName).toBe(expectedRef);
      expect(refName.startsWith("refs/heads/")).toBe(false);
    }
  );

  it.each([
    {
      id: "initializes-new-issue-state-and-mirrors-to-github-issue",
      initialMutations: 1,
      simulateStaleCasConflictOnce: false,
      expectedFinalVersion: 1,
      expectedCasConflictsRecovered: 0
    },
    {
      id: "recovers-from-concurrent-cas-conflict-without-losing-state-transitions",
      initialMutations: 3,
      simulateStaleCasConflictOnce: true,
      expectedFinalVersion: 3,
      expectedCasConflictsRecovered: 1
    }
  ])(
    "updateIssueStateWithCas [$id]: preserves state integrity under concurrent events and mirrors readable Markdown",
    async ({
      initialMutations,
      simulateStaleCasConflictOnce,
      expectedFinalVersion,
      expectedCasConflictsRecovered
    }) => {
      const store = createInMemoryGitRefStateStore({
        simulateConflictOnFirstWrite: simulateStaleCasConflictOnce
      });

      let latestResult = await updateIssueStateWithCas({
        issueNumber: 10,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "active",
          last_processed_comment_id: 101
        })
      });
      let totalCasConflictsRecovered = latestResult.cas_conflicts_recovered;

      for (let i = 2; i <= initialMutations; i += 1) {
        latestResult = await updateIssueStateWithCas({
          issueNumber: 10,
          store,
          mutator: (prev) => ({
            ...prev,
            phase: i === 2 ? "spec" : "implementation",
            status: "active",
            last_processed_comment_id: 100 + i,
            code_fix_attempts_used: prev.code_fix_attempts_used + 1
          })
        });
        totalCasConflictsRecovered += latestResult.cas_conflicts_recovered;
      }

      expect(latestResult.committed).toBe(true);
      expect(latestResult.ref_name).toBe("refs/epure/state/10");
      expect(latestResult.state.version).toBe(expectedFinalVersion);
      expect(totalCasConflictsRecovered).toBe(expectedCasConflictsRecovered);
      expect(latestResult.concurrency_group).toBe("epure-issue-10");
      expect(latestResult.issue_mirror_markdown).toContain(
        "`refs/epure/state/10`"
      );
      expect(latestResult.issue_mirror_markdown).toContain(
        `last_processed_comment_id: ${100 + initialMutations}`
      );
    }
  );

  it.fails.each([
    { id: "concurrent-writer-between-read-and-patch-is-not-overwritten-by-force-true" }
  ])(
    "createGitHubApiRefStateStore CAS [$id]: a concurrent ref update between the CAS read and the PATCH is detected and retried",
    async () => {
      const router = createGitHubMockRouter();
      const git = installFakeGitDataApi(router, "acme/demo");
      const store = createGitHubApiRefStateStore({
        repository: "acme/demo",
        githubToken: "ghs_test",
        fetchImpl: router.fetch
      });
      await updateIssueStateWithCas({
        issueNumber: 10,
        store,
        mutator: (prev) => ({ ...prev, phase: "implementation" })
      });
      git.onBeforeNextRefWrite("refs/epure/state/10", () => {
        const current = JSON.parse(
          git.readBlob(git.getRef("refs/epure/state/10")!)!
        ) as EpureIssueState;
        git.setRef(
          "refs/epure/state/10",
          git.putBlob(JSON.stringify({ ...current, version: 2, status: "cancelled" }))
        );
      });

      const result = await updateIssueStateWithCas({
        issueNumber: 10,
        store,
        mutator: (prev) => ({ ...prev, last_processed_comment_id: 42 })
      });

      expect(result.cas_conflicts_recovered).toBe(1);
      const final = await store.readRef("refs/epure/state/10");
      expect(final.state?.status).toBe("cancelled");
      expect(final.state?.last_processed_comment_id).toBe(42);
    }
  );

  it("formatIssueStateMirrorMarkdown renders deterministic human-readable state summary", () => {
    const state: EpureIssueState = {
      issue_number: 10,
      version: 2,
      phase: "spec",
      status: "awaiting_human_approval",
      active_branch: "plan/10-auth",
      last_processed_comment_id: 550,
      code_fix_attempts_used: 0,
      transient_retries_used: 1,
      updated_at: "2026-10-23T18:00:00.000Z"
    };

    const md = formatIssueStateMirrorMarkdown(state);
    expect(md).toContain("`refs/epure/state/10`");
    expect(md).toContain("`spec`");
    expect(md).toContain("`awaiting_human_approval`");
    expect(md).toContain("`plan/10-auth`");
  });
});

const WAITING_TICKET_STATE: EpureIssueState = {
  issue_number: 10,
  version: 4,
  phase: "implementation",
  status: "active",
  active_branch: "feature/10-auth",
  last_processed_comment_id: 0,
  code_fix_attempts_used: 2,
  transient_retries_used: 0,
  updated_at: "2026-11-02T09:00:00.000Z",
  subphase: "waiting_ticket_ci",
  active_ticket_number: 11,
  active_task_branch: "task/11-login",
  active_pr_number: 21,
  active_head_sha: "sha-21"
};

describe("Lot 1 — terminal states and per-element remediation budgets", () => {
  it.each([
    { id: "suspended-from-waiting_ticket_ci", status: "suspended" },
    { id: "done-from-waiting_ticket_ci", status: "done" },
    { id: "cancelled-from-waiting_ticket_ci", status: "cancelled" }
  ] as const)(
    "toTerminalState [$id]: forces subphase idle and clears every active_* field",
    ({ status }) => {
      const next = toTerminalState(WAITING_TICKET_STATE, { status, phase: "implementation" });

      expect(next).toMatchObject({ status, phase: "implementation", subphase: "idle", active_branch: "feature/10-auth" });
      expect([next.active_head_sha, next.active_pr_number, next.active_task_branch, next.active_ticket_number]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined
      ]);
    }
  );

  it.each([
    { id: "legacy-state-active-ticket-reads-single-counter", state: WAITING_TICKET_STATE, expected: 2 },
    {
      id: "legacy-state-waiting_feature_ci-reads-single-counter",
      state: { ...WAITING_TICKET_STATE, phase: "review", subphase: "waiting_feature_ci", active_ticket_number: 10 },
      expected: 2
    },
    {
      id: "per-ticket-map-isolates-active-ticket-from-exhausted-sibling",
      state: { ...WAITING_TICKET_STATE, code_fix_attempts_used: 3, code_fix_attempts_by_ticket: { "12": 3 } },
      expected: 0
    },
    {
      id: "per-ticket-map-reads-active-ticket-entry",
      state: { ...WAITING_TICKET_STATE, code_fix_attempts_by_ticket: { "11": 3, "12": 1 } },
      expected: 3
    },
    {
      id: "feature-counter-is-independent-of-ticket-map",
      state: {
        ...WAITING_TICKET_STATE,
        subphase: "waiting_feature_ci",
        code_fix_attempts_by_ticket: { "11": 3 },
        feature_code_fix_attempts_used: 1
      },
      expected: 1
    }
  ] satisfies ReadonlyArray<{ id: string; state: EpureIssueState; expected: number }>)(
    "readActiveCodeFixAttempts [$id]",
    ({ state, expected }) => {
      expect(readActiveCodeFixAttempts(state)).toBe(expected);
    }
  );

  it.each([
    {
      id: "remediation_exhausted-on-ticket-resets-that-ticket-and-counts-a-grant",
      escalation: { reason: "remediation_exhausted", head_sha: "sha-21", ticket_number: 11, budget_scope: "ticket" },
      expected: { byTicket: { "11": 0, "12": 2 }, feature: 3, grants: 2, escalationCleared: true }
    },
    {
      id: "remediation_exhausted-on-feature-pr-resets-feature-budget-only",
      escalation: { reason: "remediation_exhausted", head_sha: "sha-30", ticket_number: 10, budget_scope: "feature" },
      expected: { byTicket: { "11": 3, "12": 2 }, feature: 0, grants: 2, escalationCleared: true }
    },
    {
      id: "other-escalation-reason-grants-no-budget",
      escalation: { reason: "grace_window_timeout", head_sha: "sha-21", ticket_number: 11, budget_scope: "ticket" },
      expected: { byTicket: { "11": 3, "12": 2 }, feature: 3, grants: 1, escalationCleared: false }
    }
  ] as const)("grantHumanBudget [$id]", ({ escalation, expected }) => {
    const suspended = toTerminalState(
      {
        ...withTicketCodeFixAttempts({ ...WAITING_TICKET_STATE, code_fix_attempts_by_ticket: { "12": 2 } }, 11, 3),
        feature_code_fix_attempts_used: 3,
        human_budget_grants: 1
      },
      { status: "suspended", last_escalation: escalation }
    );

    const granted = grantHumanBudget(suspended);

    expect(granted.code_fix_attempts_by_ticket).toEqual(expected.byTicket);
    expect(granted.feature_code_fix_attempts_used).toBe(expected.feature);
    expect(granted.human_budget_grants).toBe(expected.grants);
    expect(granted.last_escalation === undefined).toBe(expected.escalationCleared);
  });
});
