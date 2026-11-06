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
  installFakeGitDataApi,
  json,
  serverError
} from "./fixtures/github-mock-router.js";

type ApiStore = ReturnType<typeof createGitHubApiRefStateStore>;

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

  it.each([
    { id: "concurrent-writer-between-read-and-update-is-rejected-by-the-graphql-beforeOid-precondition", seeded: true, expectedUpdateRefsCalls: 2 },
    { id: "concurrent-creator-of-a-missing-ref-is-rejected-as-already-existing", seeded: false, expectedUpdateRefsCalls: 1 }
  ])(
    "createGitHubApiRefStateStore CAS [$id]: a concurrent ref update before the write is detected and retried without a lost update",
    async ({ seeded, expectedUpdateRefsCalls }) => {
      const ref = "refs/epure/state/10";
      const router = createGitHubMockRouter();
      const git = installFakeGitDataApi(router, "acme/demo");
      const store = createGitHubApiRefStateStore({
        repository: "acme/demo",
        githubToken: "ghs_test",
        fetchImpl: router.fetch
      });
      if (seeded) {
        await updateIssueStateWithCas({
          issueNumber: 10,
          store,
          mutator: (prev) => ({ ...prev, phase: "implementation" })
        });
      }
      const snapshot = await store.readRef(ref);
      const before = snapshot.state ?? { ...WAITING_TICKET_STATE, version: 0 };
      git.onBeforeNextRefWrite(ref, () => {
        git.setRef(
          ref,
          git.putCommit({
            parents: snapshot.sha ? [snapshot.sha] : [],
            message: JSON.stringify({ ...before, version: before.version + 1, status: "cancelled" })
          })
        );
      });

      const result = await updateIssueStateWithCas({
        issueNumber: 10,
        store,
        mutator: (prev) => ({ ...prev, last_processed_comment_id: 42 })
      });

      expect(router.unmatched).toEqual([]);
      expect(result.cas_conflicts_recovered).toBe(1);
      expect(router.calls("POST", "/graphql")).toBe(expectedUpdateRefsCalls);
      expect(router.calls("PATCH", /\/git\/refs\//)).toBe(0);
      const final = await store.readRef(ref);
      expect(final.state).toMatchObject({ status: "cancelled", last_processed_comment_id: 42, version: before.version + 2 });
    }
  );

  it.each([
    { id: "state-commit-ref-moves-through-graphql-updateRefs-on-a-child-commit", legacyBlob: false, expected: { parents: 1, updateRefs: 1, patches: 0 } },
    { id: "legacy-json-blob-ref-is-read-then-migrated-to-a-state-commit-by-rest-patch", legacyBlob: true, expected: { parents: 0, updateRefs: 0, patches: 1 } }
  ])("createGitHubApiRefStateStore write [$id]", async ({ legacyBlob, expected }) => {
    const ref = "refs/epure/state/10";
    const router = createGitHubMockRouter();
    const git = installFakeGitDataApi(router, "acme/demo");
    const store = createGitHubApiRefStateStore({ repository: "acme/demo", githubToken: "ghs_test", fetchImpl: router.fetch });
    if (legacyBlob) {
      git.setRef(ref, git.putBlob(JSON.stringify({ ...WAITING_TICKET_STATE, phase: "spec" }, null, 2)));
    } else {
      await updateIssueStateWithCas({ issueNumber: 10, store, mutator: (prev) => ({ ...prev, phase: "spec" }) });
    }
    const before = await store.readRef(ref);
    const writesBefore = router.requests.length;

    await updateIssueStateWithCas({ issueNumber: 10, store, mutator: (prev) => ({ ...prev, phase: "tickets" }) });

    const writes = router.requests.slice(writesBefore);
    const commit = writes.find((r) => r.method === "POST" && r.path.endsWith("/git/commits"))!.body as { parents: string[] };
    expect(router.unmatched).toEqual([]);
    expect(before.state?.phase).toBe("spec");
    expect(commit.parents).toHaveLength(expected.parents);
    expect(writes.filter((r) => r.path === "/graphql")).toHaveLength(expected.updateRefs);
    expect(writes.filter((r) => r.method === "PATCH")).toHaveLength(expected.patches);
    expect((await store.readRef(ref)).state).toMatchObject({ phase: "tickets", version: before.state!.version + 1 });
  });

  it.each([
    {
      id: "502-on-the-state-commit-read-rejects-instead-of-reading-an-empty-state",
      failing: { method: "GET", path: /\/git\/commits\/[0-9a-f]+$/, reply: serverError() },
      act: (store: ApiStore) => store.readRef("refs/epure/state/10"),
      expectedError: /state object .* \(HTTP 502\)/
    },
    {
      id: "502-on-the-state-ref-listing-rejects-instead-of-listing-no-state",
      failing: { method: "GET", path: /\/git\/matching-refs\//, reply: serverError() },
      act: (store: ApiStore) => store.listIssueStates(),
      expectedError: /list EPURE state refs \(HTTP 502\)/
    },
    {
      id: "502-on-the-state-commit-creation-rejects-instead-of-retrying-as-a-cas-conflict",
      failing: { method: "POST", path: "/repos/acme/demo/git/commits", reply: serverError() },
      act: (store: ApiStore) => updateIssueStateWithCas({ issueNumber: 10, store, mutator: (prev) => prev }),
      expectedError: /state commit .* \(HTTP 502\)/
    },
    {
      id: "graphql-error-while-the-ref-did-not-move-rejects-instead-of-retrying-as-a-cas-conflict",
      failing: { method: "POST", path: "/graphql", reply: json({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }) },
      act: (store: ApiStore) => updateIssueStateWithCas({ issueNumber: 10, store, mutator: (prev) => prev }),
      expectedError: /Failed to update Git ref 'refs\/epure\/state\/10' \(HTTP 200\): .*Resource not accessible/
    }
  ] as const)("createGitHubApiRefStateStore fails closed [$id]", async ({ failing, act, expectedError }) => {
    const router = createGitHubMockRouter();
    installFakeGitDataApi(router, "acme/demo");
    const store = createGitHubApiRefStateStore({ repository: "acme/demo", githubToken: "ghs_test", fetchImpl: router.fetch });
    await updateIssueStateWithCas({ issueNumber: 10, store, mutator: (prev) => ({ ...prev, phase: "spec" }) });
    const callsBefore = router.calls(failing.method, failing.path);
    router.on(failing.method, failing.path, failing.reply);

    await expect(act(store)).rejects.toThrow(expectedError);
    expect(router.unmatched).toEqual([]);
    expect(router.calls(failing.method, failing.path) - callsBefore).toBe(1);
  });

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
