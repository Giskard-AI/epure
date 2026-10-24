import { describe, expect, it } from "vitest";
import {
  verifyRenovatePullRequestProvenance,
  type RenovatePrProvenanceInput
} from "../src/renovate/renovate-provenance.js";

describe("Ticket 26 (#27) — Verify Renovate PR provenance targeting dev and block spoofed forks", () => {
  const BASE_INPUT: RenovatePrProvenanceInput = {
    baseRepository: "Giskard-AI/consumer-app",
    headRepository: "Giskard-AI/consumer-app",
    headBranch: "renovate/typescript-5.x",
    baseBranch: "dev",
    authorLogin: "renovate[bot]",
    authorType: "Bot",
    verifiedGitHubAppSlug: "renovate",
    expectedRenovateAppSlugs: ["renovate"]
  };

  it.each([
    {
      id: "accepts-authentic-same-repo-renovate-app-pr-targeting-dev",
      input: BASE_INPUT,
      expectedAuthentic: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "rejects-external-fork-spoofing-renovate-branch-and-label",
      input: {
        ...BASE_INPUT,
        headRepository: "attacker-fork/consumer-app"
      } satisfies RenovatePrProvenanceInput,
      expectedAuthentic: false,
      expectedErrorCode: "SPOOFED_RENOVATE_FORK_FORBIDDEN"
    },
    {
      id: "rejects-unverified-user-or-spoofed-app-claiming-renovate-name",
      input: {
        ...BASE_INPUT,
        authorLogin: "renovate-lookalike",
        authorType: "User",
        verifiedGitHubAppSlug: null
      } satisfies RenovatePrProvenanceInput,
      expectedAuthentic: false,
      expectedErrorCode: "UNVERIFIED_RENOVATE_APP_IDENTITY"
    },
    {
      id: "rejects-renovate-pr-targeting-main-directly-instead-of-dev",
      input: {
        ...BASE_INPUT,
        baseBranch: "main"
      } satisfies RenovatePrProvenanceInput,
      expectedAuthentic: false,
      expectedErrorCode: "RENOVATE_MUST_TARGET_DEV"
    }
  ])(
    "verifyRenovatePullRequestProvenance [$id]: verifies real Renovate App identity and same-repo dev target",
    ({ input, expectedAuthentic, expectedErrorCode }) => {
      const result = verifyRenovatePullRequestProvenance(input);
      expect(result.authentic_renovate_pr).toBe(expectedAuthentic);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.human_approval_required_for_dev_merge).toBe(true);
    }
  );
});
