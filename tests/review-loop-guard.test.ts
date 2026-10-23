import { describe, expect, it } from "vitest";
import {
  evaluateReviewFeedbackTrigger,
  type ReviewFeedbackTriggerInput
} from "../src/execution/review-loop-guard.js";

describe("Ticket 19 (#20) — Prevent infinite review loops across bot comments and commit SHAs", () => {
  const BASE_INPUT: ReviewFeedbackTriggerInput = {
    commitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    authorLogin: "maintainer",
    authorType: "User",
    effectivePermission: "write",
    isIndependentReviewPass: false,
    alreadyReviewedCommitShas: [],
    reviewFixAttemptsUsed: 0,
    maxCodeFixAttempts: 3
  };

  it.each([
    {
      id: "allows-authorized-human-review-comment-within-fix-budget",
      input: BASE_INPUT,
      expectedShouldProcess: true,
      expectedErrorCode: "NONE",
      expectedEscalateToHuman: false
    },
    {
      id: "allows-first-independent-review-pass-for-commit-sha",
      input: {
        ...BASE_INPUT,
        authorLogin: "epure-reviewer[bot]",
        authorType: "Bot",
        isIndependentReviewPass: true
      } satisfies ReviewFeedbackTriggerInput,
      expectedShouldProcess: true,
      expectedErrorCode: "NONE",
      expectedEscalateToHuman: false
    },
    {
      id: "blocks-duplicate-automated-review-pass-on-already-reviewed-commit-sha",
      input: {
        ...BASE_INPUT,
        authorLogin: "epure-reviewer[bot]",
        authorType: "Bot",
        isIndependentReviewPass: true,
        alreadyReviewedCommitShas: ["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"]
      } satisfies ReviewFeedbackTriggerInput,
      expectedShouldProcess: false,
      expectedErrorCode: "COMMIT_SHA_ALREADY_REVIEWED",
      expectedEscalateToHuman: false
    },
    {
      id: "ignores-ordinary-bot-comments-to-prevent-self-reply-loops",
      input: {
        ...BASE_INPUT,
        authorLogin: "epure-agent[bot]",
        authorType: "Bot",
        isIndependentReviewPass: false
      } satisfies ReviewFeedbackTriggerInput,
      expectedShouldProcess: false,
      expectedErrorCode: "BOT_COMMENT_IGNORED",
      expectedEscalateToHuman: false
    },
    {
      id: "escalates-to-human-when-review-fix-attempts-reach-max-budget",
      input: {
        ...BASE_INPUT,
        reviewFixAttemptsUsed: 3,
        maxCodeFixAttempts: 3
      } satisfies ReviewFeedbackTriggerInput,
      expectedShouldProcess: false,
      expectedErrorCode: "MAX_REVIEW_FIX_ATTEMPTS_EXHAUSTED",
      expectedEscalateToHuman: true
    }
  ])(
    "evaluateReviewFeedbackTrigger [$id]: prevents infinite review loops",
    ({
      input,
      expectedShouldProcess,
      expectedErrorCode,
      expectedEscalateToHuman
    }) => {
      const result = evaluateReviewFeedbackTrigger(input);
      expect(result.should_process).toBe(expectedShouldProcess);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.escalate_to_human).toBe(expectedEscalateToHuman);
    }
  );
});
