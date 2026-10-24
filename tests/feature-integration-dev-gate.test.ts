import { describe, expect, it } from "vitest";
import {
  evaluateFeatureToDevIntegration,
  type FeatureToDevIntegrationInput
} from "../src/execution/feature-integration-dev-gate.js";

describe("Ticket 21 (#22) — Integrate completed feature into dev with draft-only incomplete state & human review", () => {
  const BASE_INPUT: FeatureToDevIntegrationInput = {
    planIssueNumber: 1,
    featureBranch: "feature/1-epure-v1",
    mandatoryTicketsCompleted: true,
    combinedWithRecentDevGreen: true,
    authorizedHumanReviewApproved: true,
    unapprovedFilesInDiff: []
  };

  it.each([
    {
      id: "allows-ready-pr-and-merge-to-dev-when-complete-synced-and-human-reviewed",
      input: BASE_INPUT,
      expectedPrMode: "ready_for_review",
      expectedCanMergeToDev: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "restricts-incomplete-feature-to-draft-pr-only",
      input: {
        ...BASE_INPUT,
        mandatoryTicketsCompleted: false
      } satisfies FeatureToDevIntegrationInput,
      expectedPrMode: "draft_only",
      expectedCanMergeToDev: false,
      expectedErrorCode: "INCOMPLETE_FEATURE_DRAFT_ONLY"
    },
    {
      id: "blocks-merge-to-dev-when-combined-dev-ci-not-verified",
      input: {
        ...BASE_INPUT,
        combinedWithRecentDevGreen: false
      } satisfies FeatureToDevIntegrationInput,
      expectedPrMode: "ready_for_review",
      expectedCanMergeToDev: false,
      expectedErrorCode: "COMBINED_DEV_INTEGRATION_NOT_GREEN"
    },
    {
      id: "blocks-merge-to-dev-without-authorized-human-github-review",
      input: {
        ...BASE_INPUT,
        authorizedHumanReviewApproved: false
      } satisfies FeatureToDevIntegrationInput,
      expectedPrMode: "ready_for_review",
      expectedCanMergeToDev: false,
      expectedErrorCode: "HUMAN_REVIEW_APPROVAL_REQUIRED"
    },
    {
      id: "blocks-merge-to-dev-when-unapproved-files-exist-in-diff",
      input: {
        ...BASE_INPUT,
        unapprovedFilesInDiff: ["docs/specs/unapproved-scope.md"]
      } satisfies FeatureToDevIntegrationInput,
      expectedPrMode: "ready_for_review",
      expectedCanMergeToDev: false,
      expectedErrorCode: "UNAPPROVED_DIFF_EXCLUDED_FROM_DEV"
    }
  ])(
    "evaluateFeatureToDevIntegration [$id]: enforces draft-only incomplete state, dev sync, and human review",
    ({
      input,
      expectedPrMode,
      expectedCanMergeToDev,
      expectedErrorCode
    }) => {
      const result = evaluateFeatureToDevIntegration(input);
      expect(result.pr_mode).toBe(expectedPrMode);
      expect(result.can_merge_to_dev).toBe(expectedCanMergeToDev);
      expect(result.error_code).toBe(expectedErrorCode);
    }
  );
});
