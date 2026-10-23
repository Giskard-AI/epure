import { isBotActor } from "../auth/issue-command-gate.js";

export type ReviewLoopGuardErrorCode =
  | "NONE"
  | "BOT_COMMENT_IGNORED"
  | "UNAUTHORIZED_REVIEWER_IGNORED"
  | "COMMIT_SHA_ALREADY_REVIEWED"
  | "MAX_REVIEW_FIX_ATTEMPTS_EXHAUSTED";

export interface ReviewFeedbackTriggerInput {
  readonly commitSha: string;
  readonly authorLogin: string;
  readonly authorType: "User" | "Bot" | string;
  readonly effectivePermission: "admin" | "maintain" | "write" | "triage" | "read" | "none";
  readonly isIndependentReviewPass: boolean;
  readonly alreadyReviewedCommitShas: readonly string[];
  readonly reviewFixAttemptsUsed: number;
  readonly maxCodeFixAttempts: number;
}

export interface ReviewFeedbackTriggerResult {
  readonly should_process: boolean;
  readonly error_code: ReviewLoopGuardErrorCode;
  readonly error_message: string;
  readonly escalate_to_human: boolean;
  readonly updated_reviewed_commit_shas: readonly string[];
}

export function evaluateReviewFeedbackTrigger(
  input: ReviewFeedbackTriggerInput
): ReviewFeedbackTriggerResult {
  const isBot = isBotActor({
    login: input.authorLogin,
    type: input.authorType
  });

  if (isBot && !input.isIndependentReviewPass) {
    return {
      should_process: false,
      error_code: "BOT_COMMENT_IGNORED",
      error_message:
        "Ordinary bot comments are ignored as review triggers to prevent self-reply loops (ADR-0017).",
      escalate_to_human: false,
      updated_reviewed_commit_shas: input.alreadyReviewedCommitShas
    };
  }

  if (
    !isBot &&
    input.effectivePermission !== "admin" &&
    input.effectivePermission !== "maintain" &&
    input.effectivePermission !== "write"
  ) {
    return {
      should_process: false,
      error_code: "UNAUTHORIZED_REVIEWER_IGNORED",
      error_message:
        "Review trigger requires effective write/maintain/admin repository permission.",
      escalate_to_human: false,
      updated_reviewed_commit_shas: input.alreadyReviewedCommitShas
    };
  }

  if (
    input.isIndependentReviewPass &&
    input.alreadyReviewedCommitShas.includes(input.commitSha)
  ) {
    return {
      should_process: false,
      error_code: "COMMIT_SHA_ALREADY_REVIEWED",
      error_message: `Commit SHA '${input.commitSha}' has already undergone its automated review pass (ADR-0017).`,
      escalate_to_human: false,
      updated_reviewed_commit_shas: input.alreadyReviewedCommitShas
    };
  }

  if (input.reviewFixAttemptsUsed >= input.maxCodeFixAttempts) {
    return {
      should_process: false,
      error_code: "MAX_REVIEW_FIX_ATTEMPTS_EXHAUSTED",
      error_message: `Review fix attempts (${input.reviewFixAttemptsUsed}/${input.maxCodeFixAttempts}) exhausted; escalating to human reviewer.`,
      escalate_to_human: true,
      updated_reviewed_commit_shas: input.alreadyReviewedCommitShas
    };
  }

  const nextShas = input.alreadyReviewedCommitShas.includes(input.commitSha)
    ? input.alreadyReviewedCommitShas
    : [...input.alreadyReviewedCommitShas, input.commitSha];

  return {
    should_process: true,
    error_code: "NONE",
    error_message: "",
    escalate_to_human: false,
    updated_reviewed_commit_shas: nextShas
  };
}
