import { describe, expect, it } from "vitest";
import {
  syncFeatureBranchWithDev,
  type FeatureDevSyncInput
} from "../src/execution/feature-dev-sync.js";

describe("Ticket 16 (#17) — Keep feature/* synchronized with dev and detect spec/ADR drift", () => {
  it.each([
    {
      id: "syncs-cleanly-when-dev-has-non-conflicting-updates",
      input: {
        planIssueNumber: 1,
        featureBranch: "feature/1-epure-v1",
        devHeadSha: "1111111111111111111111111111111111111111",
        featureBaseDevSha: "0000000000000000000000000000000000000000",
        devChangedPaths: ["README.md", "src/utils/logger.ts"],
        lockedPlanPaths: [
          "docs/specs/dev-automation-v1.md",
          "docs/adr/0001-branching.md"
        ],
        hasGitMergeConflict: false,
        postSyncCiGreen: true
      } satisfies FeatureDevSyncInput,
      expectedSynced: true,
      expectedErrorCode: "NONE",
      expectedSuspendedForHumanReview: false
    },
    {
      id: "suspends-and-alerts-human-when-dev-mutated-locked-spec-or-adr",
      input: {
        planIssueNumber: 1,
        featureBranch: "feature/1-epure-v1",
        devHeadSha: "2222222222222222222222222222222222222222",
        featureBaseDevSha: "0000000000000000000000000000000000000000",
        devChangedPaths: ["docs/adr/0001-branching.md"],
        lockedPlanPaths: [
          "docs/specs/dev-automation-v1.md",
          "docs/adr/0001-branching.md"
        ],
        hasGitMergeConflict: false,
        postSyncCiGreen: true
      } satisfies FeatureDevSyncInput,
      expectedSynced: false,
      expectedErrorCode: "SPEC_OR_ADR_DRIFT_DETECTED_ON_DEV",
      expectedSuspendedForHumanReview: true
    },
    {
      id: "suspends-when-dev-sync-produces-unresolvable-git-conflict",
      input: {
        planIssueNumber: 1,
        featureBranch: "feature/1-epure-v1",
        devHeadSha: "3333333333333333333333333333333333333333",
        featureBaseDevSha: "0000000000000000000000000000000000000000",
        devChangedPaths: ["src/core.ts"],
        lockedPlanPaths: ["docs/specs/dev-automation-v1.md"],
        hasGitMergeConflict: true,
        postSyncCiGreen: false
      } satisfies FeatureDevSyncInput,
      expectedSynced: false,
      expectedErrorCode: "DEV_SYNC_MERGE_CONFLICT",
      expectedSuspendedForHumanReview: true
    }
  ])(
    "syncFeatureBranchWithDev [$id]: synchronizes feature/* with dev and detects drift",
    ({
      input,
      expectedSynced,
      expectedErrorCode,
      expectedSuspendedForHumanReview
    }) => {
      const result = syncFeatureBranchWithDev(input);
      expect(result.synced).toBe(expectedSynced);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.suspended_for_human_review).toBe(
        expectedSuspendedForHumanReview
      );
    }
  );
});
