import { describe, expect, it } from "vitest";
import {
  processPendingIssueCommentsBatch,
  type IncomingIssueComment
} from "../src/state/comment-batch-cursor.js";
import { createInMemoryGitRefStateStore } from "../src/state/git-ref-state.js";

describe("Ticket 10 (#11) — Batch comment cursor (last_processed_comment_id) & cancel priority", () => {
  it.each([
    {
      id: "processes-chronological-batch-after-cursor-and-ignores-bots-and-read-only-users",
      initialCursor: 200,
      firstWaveComments: [
        {
          id: 199,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "write",
          body: "Old already processed comment"
        },
        {
          id: 205,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "admin",
          body: "Second chronologically: add rate limit details"
        },
        {
          id: 201,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "write",
          body: "First chronologically: clarify auth scope"
        },
        {
          id: 202,
          authorLogin: "epure-agent[bot]",
          authorType: "Bot",
          effectivePermission: "write",
          body: "Bot comment must be ignored"
        },
        {
          id: 203,
          authorLogin: "external-reader",
          authorType: "User",
          effectivePermission: "read",
          body: "Unauthorized comment must be ignored"
        }
      ] satisfies readonly IncomingIssueComment[],
      lateArrivingCommentsOnFinalCheck: [] satisfies readonly IncomingIssueComment[],
      expectedProcessedIds: [201, 205],
      expectedFinalCursor: 205,
      expectedCancelled: false,
      expectedFinalStatus: "active"
    },
    {
      id: "prioritizes-cancel-or-stop-immediately-and-halts-batch",
      initialCursor: 300,
      firstWaveComments: [
        {
          id: 301,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "write",
          body: "Update section 1"
        },
        {
          id: 302,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "admin",
          body: "/epure cancel"
        },
        {
          id: 303,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "write",
          body: "/to-spec should not execute after cancel"
        }
      ] satisfies readonly IncomingIssueComment[],
      lateArrivingCommentsOnFinalCheck: [] satisfies readonly IncomingIssueComment[],
      expectedProcessedIds: [302],
      expectedFinalCursor: 303,
      expectedCancelled: true,
      expectedFinalStatus: "cancelled"
    },
    {
      id: "final-race-check-collects-comment-arriving-right-before-run-exit",
      initialCursor: 400,
      firstWaveComments: [
        {
          id: 401,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "write",
          body: "Initial instruction"
        }
      ] satisfies readonly IncomingIssueComment[],
      lateArrivingCommentsOnFinalCheck: [
        {
          id: 402,
          authorLogin: "maintainer",
          authorType: "User",
          effectivePermission: "write",
          body: "Late comment caught by final check before exit"
        }
      ] satisfies readonly IncomingIssueComment[],
      expectedProcessedIds: [401, 402],
      expectedFinalCursor: 402,
      expectedCancelled: false,
      expectedFinalStatus: "active"
    }
  ])(
    "processPendingIssueCommentsBatch [$id]: batches authorized comments and updates cursor in refs/epure/state/*",
    async ({
      initialCursor,
      firstWaveComments,
      lateArrivingCommentsOnFinalCheck,
      expectedProcessedIds,
      expectedFinalCursor,
      expectedCancelled,
      expectedFinalStatus
    }) => {
      const store = createInMemoryGitRefStateStore();
      let fetchPass = 0;

      const result = await processPendingIssueCommentsBatch({
        issueNumber: 11,
        store,
        initialCursor,
        fetchCommentsSinceCursor: async () => {
          fetchPass += 1;
          if (fetchPass === 1) {
            return firstWaveComments;
          }
          if (fetchPass === 2) {
            return [...firstWaveComments, ...lateArrivingCommentsOnFinalCheck];
          }
          return [...firstWaveComments, ...lateArrivingCommentsOnFinalCheck];
        }
      });

      expect(result.processed_comment_ids).toEqual(expectedProcessedIds);
      expect(result.last_processed_comment_id).toBe(expectedFinalCursor);
      expect(result.cancelled).toBe(expectedCancelled);
      expect(result.state.status).toBe(expectedFinalStatus);
      expect(result.state.last_processed_comment_id).toBe(expectedFinalCursor);
    }
  );
});
