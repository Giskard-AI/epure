import { describe, expect, it } from "vitest";
import {
  evaluateTaskPrAutoMerge,
  type TaskPrAutoMergeInput
} from "../src/execution/task-pr-automerge.js";

describe("Ticket 17 (#18) — Task PR auto-merge policy (strict vs relaxed) & independent reviewer check", () => {
  const BASE_INPUT: TaskPrAutoMergeInput = {
    mergePolicy: "relaxed",
    headBranch: "task/18-automerge",
    baseBranch: "feature/1-epure-v1",
    branchProtectionsActive: true,
    ciChecksGreen: true,
    implementerJobId: "job-impl-101",
    reviewerJobId: "job-review-202",
    openBlockerFindingsCount: 0,
    openWarningFindingsCount: 1,
    humanApprovedPr: false
  };

  it.each([
    {
      id: "relaxed-policy-allows-automerge-on-feature-branch-when-ci-and-independent-review-pass",
      input: BASE_INPUT,
      expectedAllowed: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "strict-policy-blocks-automerge-when-warnings-or-missing-human-approval",
      input: {
        ...BASE_INPUT,
        mergePolicy: "strict",
        openWarningFindingsCount: 1,
        humanApprovedPr: false
      } satisfies TaskPrAutoMergeInput,
      expectedAllowed: false,
      expectedErrorCode: "STRICT_POLICY_REQUIRES_ZERO_WARNINGS_AND_APPROVAL"
    },
    {
      id: "strict-policy-allows-merge-when-zero-warnings-and-human-approved",
      input: {
        ...BASE_INPUT,
        mergePolicy: "strict",
        openWarningFindingsCount: 0,
        humanApprovedPr: true
      } satisfies TaskPrAutoMergeInput,
      expectedAllowed: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "rejects-when-reviewer-ran-in-same-job-as-implementer",
      input: {
        ...BASE_INPUT,
        implementerJobId: "job-same-101",
        reviewerJobId: "job-same-101"
      } satisfies TaskPrAutoMergeInput,
      expectedAllowed: false,
      expectedErrorCode: "SELF_REVIEW_FORBIDDEN"
    },
    {
      id: "rejects-when-branch-protections-missing",
      input: {
        ...BASE_INPUT,
        branchProtectionsActive: false
      } satisfies TaskPrAutoMergeInput,
      expectedAllowed: false,
      expectedErrorCode: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS"
    },
    {
      id: "rejects-automerge-targeting-dev-or-main",
      input: {
        ...BASE_INPUT,
        baseBranch: "dev"
      } satisfies TaskPrAutoMergeInput,
      expectedAllowed: false,
      expectedErrorCode: "PROTECTED_TARGET_BRANCH_FORBIDDEN"
    }
  ])(
    "evaluateTaskPrAutoMerge [$id]: enforces strict/relaxed policy and independent review",
    ({ input, expectedAllowed, expectedErrorCode }) => {
      const result = evaluateTaskPrAutoMerge(input);
      expect(result.auto_merge_allowed).toBe(expectedAllowed);
      expect(result.error_code).toBe(expectedErrorCode);
    }
  );
});
