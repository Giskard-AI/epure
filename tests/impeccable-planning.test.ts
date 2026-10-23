import { describe, expect, it } from "vitest";
import {
  planImpeccableDesignSession,
  type ImpeccableDesignSessionInput
} from "../src/frontend/impeccable-planning.js";

describe("Ticket 31 (#32) — Elaborate Impeccable UX & design system during planning interview", () => {
  it.each([
    {
      id: "runs-impeccable-shape-on-frontend-feature-retaining-answered-questions-and-producing-design-artifacts",
      input: {
        issueNumber: 32,
        surfaceSlug: "checkout-drawer",
        touchesFrontendUi: true,
        alreadyAnsweredTopics: ["target_audience", "brand_tone"],
        candidateDesignTopics: [
          "target_audience",
          "brand_tone",
          "responsive_breakpoints",
          "empty_and_error_states"
        ]
      } satisfies ImpeccableDesignSessionInput,
      expectedImpeccableInvoked: true,
      expectedRemainingQuestions: [
        "responsive_breakpoints",
        "empty_and_error_states"
      ],
      expectedGeneratedPaths: [
        ".impeccable.md",
        "DESIGN.md",
        ".impeccable/surfaces/checkout-drawer.md"
      ]
    },
    {
      id: "skips-impeccable-on-purely-backend-feature",
      input: {
        issueNumber: 32,
        surfaceSlug: "queue-worker",
        touchesFrontendUi: false,
        alreadyAnsweredTopics: [],
        candidateDesignTopics: ["responsive_breakpoints"]
      } satisfies ImpeccableDesignSessionInput,
      expectedImpeccableInvoked: false,
      expectedRemainingQuestions: [],
      expectedGeneratedPaths: []
    }
  ])(
    "planImpeccableDesignSession [$id]: deduplicates grilling answers and generates versioned Impeccable artifacts",
    ({
      input,
      expectedImpeccableInvoked,
      expectedRemainingQuestions,
      expectedGeneratedPaths
    }) => {
      const result = planImpeccableDesignSession(input);
      expect(result.impeccable_invoked).toBe(expectedImpeccableInvoked);
      expect(result.open_design_questions).toEqual(expectedRemainingQuestions);
      expect(result.versioned_artifact_paths).toEqual(expectedGeneratedPaths);
    }
  );
});
