import { describe, expect, it } from "vitest";
import {
  reconcileProvenTicketDependencies,
  type ReconcileDependenciesInput
} from "../src/execution/proven-dependency-unblocker.js";

describe("Ticket 22 (#23) — Unblock dependent tickets only on proven blocker resolution", () => {
  it.each([
    {
      id: "unblocks-dependent-ticket-when-blocker-closed-completed-with-merged-pr",
      input: {
        tickets: [
          {
            ticketId: 1,
            issueNumber: 2,
            state: "closed",
            stateReason: "completed",
            hasMergedPrOnFeatureBranch: true,
            humanOverrideApproved: false,
            blockedByTicketIds: []
          },
          {
            ticketId: 2,
            issueNumber: 3,
            state: "open",
            stateReason: null,
            hasMergedPrOnFeatureBranch: false,
            humanOverrideApproved: false,
            blockedByTicketIds: [1]
          }
        ]
      } satisfies ReconcileDependenciesInput,
      expectedReadyTicketIds: [2],
      expectedBlockedTicketIds: [],
      expectedUnprovenBlockerTicketIds: []
    },
    {
      id: "refuses-to-unblock-when-blocker-closed-as-not-planned-or-without-merged-pr",
      input: {
        tickets: [
          {
            ticketId: 1,
            issueNumber: 2,
            state: "closed",
            stateReason: "not_planned",
            hasMergedPrOnFeatureBranch: false,
            humanOverrideApproved: false,
            blockedByTicketIds: []
          },
          {
            ticketId: 2,
            issueNumber: 3,
            state: "open",
            stateReason: null,
            hasMergedPrOnFeatureBranch: false,
            humanOverrideApproved: false,
            blockedByTicketIds: [1]
          }
        ]
      } satisfies ReconcileDependenciesInput,
      expectedReadyTicketIds: [],
      expectedBlockedTicketIds: [2],
      expectedUnprovenBlockerTicketIds: [1]
    },
    {
      id: "allows-unblocking-when-documented-human-override-approves-non-pr-closure",
      input: {
        tickets: [
          {
            ticketId: 1,
            issueNumber: 2,
            state: "closed",
            stateReason: "completed",
            hasMergedPrOnFeatureBranch: false,
            humanOverrideApproved: true,
            blockedByTicketIds: []
          },
          {
            ticketId: 2,
            issueNumber: 3,
            state: "open",
            stateReason: null,
            hasMergedPrOnFeatureBranch: false,
            humanOverrideApproved: false,
            blockedByTicketIds: [1]
          }
        ]
      } satisfies ReconcileDependenciesInput,
      expectedReadyTicketIds: [2],
      expectedBlockedTicketIds: [],
      expectedUnprovenBlockerTicketIds: []
    }
  ])(
    "reconcileProvenTicketDependencies [$id]: verifies proven resolution before unblocking",
    ({
      input,
      expectedReadyTicketIds,
      expectedBlockedTicketIds,
      expectedUnprovenBlockerTicketIds
    }) => {
      const firstPass = reconcileProvenTicketDependencies(input);
      const secondPassReconcile = reconcileProvenTicketDependencies(input);

      expect(firstPass).toEqual(secondPassReconcile);
      expect(firstPass.ready_ticket_ids).toEqual(expectedReadyTicketIds);
      expect(firstPass.blocked_ticket_ids).toEqual(expectedBlockedTicketIds);
      expect(firstPass.unproven_blocker_ticket_ids).toEqual(
        expectedUnprovenBlockerTicketIds
      );
    }
  );
});
