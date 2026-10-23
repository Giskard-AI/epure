import { describe, expect, it } from "vitest";
import {
  lockPlanAndDispatchReadyTickets,
  type LockPlanAndDispatchInput
} from "../src/planning/execution-dispatch.js";

describe("Ticket 13 (#14) — Lock approved plan scope, create feature/* from dev, and dispatch ready tickets", () => {
  const BASE_INPUT: LockPlanAndDispatchInput = {
    planIssueNumber: 1,
    planSlug: "epure-v1",
    planApprovedByHuman: true,
    scopeAlreadyLocked: false,
    humanRequestedScopeReopen: false,
    attemptingScopeMutation: false,
    maxConcurrentTasksPerFeature: 3,
    tickets: [
      { id: 1, issueNumber: 2, title: "Ticket 1", state: "open", blockedBy: [] },
      { id: 2, issueNumber: 3, title: "Ticket 2", state: "open", blockedBy: [] },
      { id: 3, issueNumber: 4, title: "Ticket 3", state: "open", blockedBy: [] },
      { id: 4, issueNumber: 5, title: "Ticket 4", state: "open", blockedBy: [] },
      { id: 5, issueNumber: 6, title: "Ticket 5", state: "open", blockedBy: [1] }
    ]
  };

  it.each([
    {
      id: "locks-scope-merges-plan-to-dev-creates-feature-branch-and-dispatches-up-to-concurrency-limit",
      input: BASE_INPUT,
      expectedDispatched: true,
      expectedErrorCode: "NONE",
      expectedPlanMergedToDev: true,
      expectedFeatureBranch: "feature/1-epure-v1",
      expectedDispatchedTicketIds: [1, 2, 3],
      expectedQueuedReadyTicketIds: [4],
      expectedBlockedTicketIds: [5]
    },
    {
      id: "blocks-execution-when-plan-not-approved-by-human",
      input: {
        ...BASE_INPUT,
        planApprovedByHuman: false
      } satisfies LockPlanAndDispatchInput,
      expectedDispatched: false,
      expectedErrorCode: "PLAN_NOT_APPROVED_BY_HUMAN",
      expectedPlanMergedToDev: false,
      expectedFeatureBranch: "",
      expectedDispatchedTicketIds: [],
      expectedQueuedReadyTicketIds: [],
      expectedBlockedTicketIds: []
    },
    {
      id: "rejects-unapproved-scope-mutation-after-scope-is-locked",
      input: {
        ...BASE_INPUT,
        scopeAlreadyLocked: true,
        attemptingScopeMutation: true,
        humanRequestedScopeReopen: false
      } satisfies LockPlanAndDispatchInput,
      expectedDispatched: false,
      expectedErrorCode: "SCOPE_LOCKED_REQUIRES_HUMAN_REOPEN",
      expectedPlanMergedToDev: false,
      expectedFeatureBranch: "feature/1-epure-v1",
      expectedDispatchedTicketIds: [],
      expectedQueuedReadyTicketIds: [],
      expectedBlockedTicketIds: []
    }
  ])(
    "lockPlanAndDispatchReadyTickets [$id]: enforces scope lock and ready ticket concurrency cap",
    ({
      input,
      expectedDispatched,
      expectedErrorCode,
      expectedPlanMergedToDev,
      expectedFeatureBranch,
      expectedDispatchedTicketIds,
      expectedQueuedReadyTicketIds,
      expectedBlockedTicketIds
    }) => {
      const result = lockPlanAndDispatchReadyTickets(input);
      expect(result.dispatched).toBe(expectedDispatched);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.plan_merged_to_dev).toBe(expectedPlanMergedToDev);
      expect(result.feature_branch).toBe(expectedFeatureBranch);
      expect(result.dispatched_ticket_ids).toEqual(expectedDispatchedTicketIds);
      expect(result.queued_ready_ticket_ids).toEqual(
        expectedQueuedReadyTicketIds
      );
      expect(result.blocked_ticket_ids).toEqual(expectedBlockedTicketIds);
    }
  );
});
