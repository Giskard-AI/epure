export type TaskPrAutoMergeErrorCode =
  | "NONE"
  | "PROTECTED_TARGET_BRANCH_FORBIDDEN"
  | "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS"
  | "SELF_REVIEW_FORBIDDEN"
  | "CI_CHECKS_NOT_GREEN"
  | "OPEN_BLOCKER_FINDINGS"
  | "STRICT_POLICY_REQUIRES_ZERO_WARNINGS_AND_APPROVAL";

export interface TaskPrAutoMergeInput {
  readonly mergePolicy: "strict" | "relaxed";
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly branchProtectionsActive: boolean;
  readonly ciChecksGreen: boolean;
  readonly implementerJobId: string;
  readonly reviewerJobId: string;
  readonly openBlockerFindingsCount: number;
  readonly openWarningFindingsCount: number;
  readonly humanApprovedPr: boolean;
}

export interface TaskPrAutoMergeResult {
  readonly auto_merge_allowed: boolean;
  readonly error_code: TaskPrAutoMergeErrorCode;
  readonly error_message: string;
}

export function evaluateTaskPrAutoMerge(
  input: TaskPrAutoMergeInput
): TaskPrAutoMergeResult {
  const base = input.baseBranch.trim().replace(/^refs\/heads\//, "");
  if (!base.startsWith("feature/")) {
    return {
      auto_merge_allowed: false,
      error_code: "PROTECTED_TARGET_BRANCH_FORBIDDEN",
      error_message: `Task PR auto-merge is only permitted onto 'feature/*' branches; target '${base}' is forbidden (ADR-0001).`
    };
  }

  if (!input.branchProtectionsActive) {
    return {
      auto_merge_allowed: false,
      error_code: "AUTO_MERGE_DISABLED_MISSING_PROTECTIONS",
      error_message:
        "Task PR auto-merge is disabled because required branch protections or CI checks are not active (ADR-0011)."
    };
  }

  if (
    !input.implementerJobId.trim() ||
    !input.reviewerJobId.trim() ||
    input.implementerJobId.trim() === input.reviewerJobId.trim()
  ) {
    return {
      auto_merge_allowed: false,
      error_code: "SELF_REVIEW_FORBIDDEN",
      error_message:
        "Independent review must execute in a separate job/run from the implementation agent (ADR-0017)."
    };
  }

  if (!input.ciChecksGreen) {
    return {
      auto_merge_allowed: false,
      error_code: "CI_CHECKS_NOT_GREEN",
      error_message: "Cannot auto-merge task PR while CI checks are not green."
    };
  }

  if (input.openBlockerFindingsCount > 0) {
    return {
      auto_merge_allowed: false,
      error_code: "OPEN_BLOCKER_FINDINGS",
      error_message: `Cannot auto-merge task PR with ${input.openBlockerFindingsCount} open blocker finding(s).`
    };
  }

  if (
    input.mergePolicy === "strict" &&
    (input.openWarningFindingsCount > 0 || !input.humanApprovedPr)
  ) {
    return {
      auto_merge_allowed: false,
      error_code: "STRICT_POLICY_REQUIRES_ZERO_WARNINGS_AND_APPROVAL",
      error_message:
        "Strict merge policy requires zero warning findings and explicit human PR approval."
    };
  }

  return {
    auto_merge_allowed: true,
    error_code: "NONE",
    error_message: ""
  };
}
