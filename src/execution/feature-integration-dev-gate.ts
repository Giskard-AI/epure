export type FeatureToDevIntegrationErrorCode =
  | "NONE"
  | "INCOMPLETE_FEATURE_DRAFT_ONLY"
  | "COMBINED_DEV_INTEGRATION_NOT_GREEN"
  | "HUMAN_REVIEW_APPROVAL_REQUIRED"
  | "UNAPPROVED_DIFF_EXCLUDED_FROM_DEV";

export interface FeatureToDevIntegrationInput {
  readonly planIssueNumber: number;
  readonly featureBranch: string;
  readonly mandatoryTicketsCompleted: boolean;
  readonly combinedWithRecentDevGreen: boolean;
  readonly authorizedHumanReviewApproved: boolean;
  readonly unapprovedFilesInDiff: readonly string[];
}

export interface FeatureToDevIntegrationResult {
  readonly pr_mode: "draft_only" | "ready_for_review";
  readonly can_merge_to_dev: boolean;
  readonly error_code: FeatureToDevIntegrationErrorCode;
  readonly error_message: string;
}

export function evaluateFeatureToDevIntegration(
  input: FeatureToDevIntegrationInput
): FeatureToDevIntegrationResult {
  if (!input.mandatoryTicketsCompleted) {
    return {
      pr_mode: "draft_only",
      can_merge_to_dev: false,
      error_code: "INCOMPLETE_FEATURE_DRAFT_ONLY",
      error_message:
        "Incomplete feature can only open a draft PR; all mandatory sub-issues must be completed before marking ready for review (ADR-0001)."
    };
  }

  if (input.unapprovedFilesInDiff.length > 0) {
    return {
      pr_mode: "ready_for_review",
      can_merge_to_dev: false,
      error_code: "UNAPPROVED_DIFF_EXCLUDED_FROM_DEV",
      error_message: `Unapproved files in feature diff (${input.unapprovedFilesInDiff.join(", ")}) must be excluded before merging into dev.`
    };
  }

  if (!input.combinedWithRecentDevGreen) {
    return {
      pr_mode: "ready_for_review",
      can_merge_to_dev: false,
      error_code: "COMBINED_DEV_INTEGRATION_NOT_GREEN",
      error_message:
        "Feature branch must integrate recent dev changes and pass combined CI checks before merging into dev."
    };
  }

  if (!input.authorizedHumanReviewApproved) {
    return {
      pr_mode: "ready_for_review",
      can_merge_to_dev: false,
      error_code: "HUMAN_REVIEW_APPROVAL_REQUIRED",
      error_message:
        "An authorized human must submit an approving GitHub review before merging feature/* into dev (ADR-0002)."
    };
  }

  return {
    pr_mode: "ready_for_review",
    can_merge_to_dev: true,
    error_code: "NONE",
    error_message: ""
  };
}
