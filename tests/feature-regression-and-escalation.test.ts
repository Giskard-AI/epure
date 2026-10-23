import { describe, expect, it } from "vitest";
import {
  evaluateFeatureFailuresAndRegressions,
  type FeatureFailureAndRegressionInput
} from "../src/execution/feature-regression-and-escalation.js";

describe("Ticket 24 (#25) — Isolate ticket needs-human escalation & freeze feature on post-merge regression without force-push", () => {
  it.each([
    {
      id: "marks-failing-ticket-needs-human-after-3-attempts-while-independent-tickets-continue",
      input: {
        planIssueNumber: 1,
        featureBranch: "feature/1-epure-v1",
        maxCodeFixAttempts: 3,
        postMergeRegressionDetectedOnFeature: false,
        regressionSummary: "",
        tickets: [
          {
            ticketId: 10,
            issueNumber: 11,
            codeFixAttemptsUsed: 3,
            blockedByTicketIds: []
          },
          {
            ticketId: 11,
            issueNumber: 12,
            codeFixAttemptsUsed: 0,
            blockedByTicketIds: []
          },
          {
            ticketId: 12,
            issueNumber: 13,
            codeFixAttemptsUsed: 0,
            blockedByTicketIds: [10]
          }
        ]
      } satisfies FeatureFailureAndRegressionInput,
      expectedNeedsHumanTicketIds: [10],
      expectedContinuingIndependentTicketIds: [11],
      expectedFeatureMergesFrozen: false,
      expectedCorrectiveIssueCreated: false
    },
    {
      id: "freezes-feature-merges-and-opens-corrective-issue-on-post-merge-regression-without-force-push",
      input: {
        planIssueNumber: 1,
        featureBranch: "feature/1-epure-v1",
        maxCodeFixAttempts: 3,
        postMergeRegressionDetectedOnFeature: true,
        regressionSummary: "Integration suite failed on commit a1b2c3d",
        tickets: [
          {
            ticketId: 11,
            issueNumber: 12,
            codeFixAttemptsUsed: 0,
            blockedByTicketIds: []
          }
        ]
      } satisfies FeatureFailureAndRegressionInput,
      expectedNeedsHumanTicketIds: [],
      expectedContinuingIndependentTicketIds: [],
      expectedFeatureMergesFrozen: true,
      expectedCorrectiveIssueCreated: true
    }
  ])(
    "evaluateFeatureFailuresAndRegressions [$id]: isolates ticket failures and freezes feature on regression without history rewrite",
    ({
      input,
      expectedNeedsHumanTicketIds,
      expectedContinuingIndependentTicketIds,
      expectedFeatureMergesFrozen,
      expectedCorrectiveIssueCreated
    }) => {
      const result = evaluateFeatureFailuresAndRegressions(input);
      expect(result.needs_human_ticket_ids).toEqual(expectedNeedsHumanTicketIds);
      expect(result.continuing_independent_ticket_ids).toEqual(
        expectedContinuingIndependentTicketIds
      );
      expect(result.feature_merges_frozen).toBe(expectedFeatureMergesFrozen);
      expect(result.corrective_issue_created).toBe(
        expectedCorrectiveIssueCreated
      );
      expect(result.shared_history_rewritten).toBe(false);
    }
  );
});
