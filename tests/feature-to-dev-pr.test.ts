import { describe, expect, it } from "vitest";
import {
  prepareFeatureToDevPullRequest,
  type FeatureToDevPrInput
} from "../src/planning/feature-to-dev-pr.js";

describe("Ticket 15 (#16) — Open feature/* -> dev Pull Request for mandatory human review", () => {
  const BASE_INPUT: FeatureToDevPrInput = {
    repository: "Giskard-AI/consumer-app",
    planIssueNumber: 1,
    planTitle: "EPURE V1 Orchestration",
    featureBranch: "feature/1-epure-v1",
    specPath: "docs/specs/dev-automation-v1.md",
    adrPaths: ["docs/adr/0001-branching.md", "docs/adr/0002-gates.md"],
    tickets: [
      { id: 1, issueNumber: 2, title: "Ticket 1", state: "closed" },
      { id: 2, issueNumber: 3, title: "Ticket 2", state: "closed" }
    ],
    featureCiChecksGreen: true,
    attemptAutoMergeToDev: false
  };

  it.each([
    {
      id: "opens-feature-to-dev-pr-when-all-tickets-closed-and-ci-green",
      input: BASE_INPUT,
      expectedReady: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "blocks-feature-to-dev-pr-when-tickets-remain-open",
      input: {
        ...BASE_INPUT,
        tickets: [
          { id: 1, issueNumber: 2, title: "Ticket 1", state: "closed" },
          { id: 2, issueNumber: 3, title: "Ticket 2", state: "open" }
        ]
      } satisfies FeatureToDevPrInput,
      expectedReady: false,
      expectedErrorCode: "OPEN_TICKETS_REMAINING"
    },
    {
      id: "blocks-feature-to-dev-pr-when-feature-ci-checks-failing",
      input: {
        ...BASE_INPUT,
        featureCiChecksGreen: false
      } satisfies FeatureToDevPrInput,
      expectedReady: false,
      expectedErrorCode: "FEATURE_CI_CHECKS_NOT_GREEN"
    },
    {
      id: "strictly-forbids-auto-merge-on-feature-to-dev-pr",
      input: {
        ...BASE_INPUT,
        attemptAutoMergeToDev: true
      } satisfies FeatureToDevPrInput,
      expectedReady: false,
      expectedErrorCode: "FEATURE_TO_DEV_AUTO_MERGE_FORBIDDEN"
    }
  ])(
    "prepareFeatureToDevPullRequest [$id]: enforces all-tickets-closed, green CI, and mandatory human review",
    ({ input, expectedReady, expectedErrorCode }) => {
      const result = prepareFeatureToDevPullRequest(input);
      expect(result.ready_to_open).toBe(expectedReady);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.auto_merge_allowed).toBe(false);
      expect(result.human_review_required).toBe(true);

      if (expectedReady) {
        expect(result.head_branch).toBe("feature/1-epure-v1");
        expect(result.base_branch).toBe("dev");
        expect(result.pr_body).toContain("Closes #1");
        expect(result.pr_body).toContain("docs/specs/dev-automation-v1.md");
        expect(result.pr_body).toContain("#2");
        expect(result.pr_body).toContain("#3");
      }
    }
  );
});
