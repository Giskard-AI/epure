export type FeatureDevSyncErrorCode =
  | "NONE"
  | "SPEC_OR_ADR_DRIFT_DETECTED_ON_DEV"
  | "DEV_SYNC_MERGE_CONFLICT"
  | "POST_SYNC_CI_FAILED";

export interface FeatureDevSyncInput {
  readonly planIssueNumber: number;
  readonly featureBranch: string;
  readonly devHeadSha: string;
  readonly featureBaseDevSha: string;
  readonly devChangedPaths: readonly string[];
  readonly lockedPlanPaths: readonly string[];
  readonly hasGitMergeConflict: boolean;
  readonly postSyncCiGreen: boolean;
}

export interface FeatureDevSyncResult {
  readonly synced: boolean;
  readonly error_code: FeatureDevSyncErrorCode;
  readonly error_message: string;
  readonly feature_branch: string;
  readonly updated_base_dev_sha: string;
  readonly drifted_paths: readonly string[];
  readonly suspended_for_human_review: boolean;
}

export function syncFeatureBranchWithDev(
  input: FeatureDevSyncInput
): FeatureDevSyncResult {
  const lockedSet = new Set(input.lockedPlanPaths.map((p) => p.trim()));
  const driftedPaths = input.devChangedPaths.filter((p) =>
    lockedSet.has(p.trim())
  );

  if (driftedPaths.length > 0) {
    return {
      synced: false,
      error_code: "SPEC_OR_ADR_DRIFT_DETECTED_ON_DEV",
      error_message: `Locked specification or ADR files were modified on dev (${driftedPaths.join(", ")}); suspending feature branch for human review (ADR-0001, ADR-0002).`,
      feature_branch: input.featureBranch,
      updated_base_dev_sha: input.featureBaseDevSha,
      drifted_paths: driftedPaths,
      suspended_for_human_review: true
    };
  }

  if (input.hasGitMergeConflict) {
    return {
      synced: false,
      error_code: "DEV_SYNC_MERGE_CONFLICT",
      error_message: `Unresolvable Git conflict while synchronizing '${input.featureBranch}' with 'dev' (${input.devHeadSha}).`,
      feature_branch: input.featureBranch,
      updated_base_dev_sha: input.featureBaseDevSha,
      drifted_paths: [],
      suspended_for_human_review: true
    };
  }

  if (!input.postSyncCiGreen) {
    return {
      synced: false,
      error_code: "POST_SYNC_CI_FAILED",
      error_message: `CI checks failed on '${input.featureBranch}' after synchronizing with 'dev'.`,
      feature_branch: input.featureBranch,
      updated_base_dev_sha: input.featureBaseDevSha,
      drifted_paths: [],
      suspended_for_human_review: true
    };
  }

  return {
    synced: true,
    error_code: "NONE",
    error_message: "",
    feature_branch: input.featureBranch,
    updated_base_dev_sha: input.devHeadSha,
    drifted_paths: [],
    suspended_for_human_review: false
  };
}
