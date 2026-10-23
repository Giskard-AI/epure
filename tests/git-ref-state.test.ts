import { describe, expect, it } from "vitest";
import {
  buildIssueStateRefName,
  createInMemoryGitRefStateStore,
  formatIssueStateMirrorMarkdown,
  updateIssueStateWithCas,
  type EpureIssueState
} from "../src/state/git-ref-state.js";

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
