import { describe, expect, it } from "vitest";
import {
  reconcileAndIntegrateFeatureQueue,
  type FeatureQueueInput
} from "../src/planning/feature-integration-queue.js";

describe("Ticket 14 (#15) — Reorder, deduplicate, and serialize task/* integrations on feature/*", () => {
  it.each([
    {
      id: "reorders-by-updated-dependencies-and-deduplicates-redundant-ticket",
      input: {
        planIssueNumber: 1,
        featureBranch: "feature/1-epure-v1",
        maxCodeFixAttempts: 3,
        candidates: [
          {
            ticketId: 10,
            issueNumber: 11,
            taskBranch: "task/11-batch",
            blockedByTicketIds: [12],
            duplicateOfTicketId: undefined,
            checksGreen: true,
            reviewApproved: true,
            rebaseConflictsCount: 0
          },
          {
            ticketId: 12,
            issueNumber: 13,
            taskBranch: "task/13-adr",
            blockedByTicketIds: [],
            duplicateOfTicketId: undefined,
            checksGreen: true,
            reviewApproved: true,
            rebaseConflictsCount: 0
          },
          {
            ticketId: 13,
            issueNumber: 14,
            taskBranch: "task/14-dup-of-12",
            blockedByTicketIds: [],
            duplicateOfTicketId: 12,
            checksGreen: true,
            reviewApproved: true,
            rebaseConflictsCount: 0
          }
        ]
      } satisfies FeatureQueueInput,
      expectedMergedTicketIdsInOrder: [12, 10],
      expectedDeduplicatedClosedTicketIds: [13],
      expectedEscalatedTicketIds: []
    },
    {
      id: "escalates-task-branch-when-rebase-conflicts-exceed-max-code-fix-attempts",
      input: {
        planIssueNumber: 1,
        featureBranch: "feature/1-epure-v1",
        maxCodeFixAttempts: 3,
        candidates: [
          {
            ticketId: 1,
            issueNumber: 2,
            taskBranch: "task/2-first",
            blockedByTicketIds: [],
            duplicateOfTicketId: undefined,
            checksGreen: true,
            reviewApproved: true,
            rebaseConflictsCount: 0
          },
          {
            ticketId: 2,
            issueNumber: 3,
            taskBranch: "task/3-conflicting",
            blockedByTicketIds: [1],
            duplicateOfTicketId: undefined,
            checksGreen: true,
            reviewApproved: true,
            rebaseConflictsCount: 4
          }
        ]
      } satisfies FeatureQueueInput,
      expectedMergedTicketIdsInOrder: [1],
      expectedDeduplicatedClosedTicketIds: [],
      expectedEscalatedTicketIds: [2]
    }
  ])(
    "reconcileAndIntegrateFeatureQueue [$id]: enforces serialized topological merge order and deduplication",
    ({
      input,
      expectedMergedTicketIdsInOrder,
      expectedDeduplicatedClosedTicketIds,
      expectedEscalatedTicketIds
    }) => {
      const result = reconcileAndIntegrateFeatureQueue(input);
      expect(result.concurrency_group).toBe("feature-merge-1");
      expect(result.merged_ticket_ids).toEqual(expectedMergedTicketIdsInOrder);
      expect(result.deduplicated_closed_ticket_ids).toEqual(
        expectedDeduplicatedClosedTicketIds
      );
      expect(result.escalated_conflict_ticket_ids).toEqual(
        expectedEscalatedTicketIds
      );
    }
  );
});
