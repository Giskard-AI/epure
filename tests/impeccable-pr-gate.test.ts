import { describe, expect, it } from "vitest";
import {
  evaluateImpeccableFrontendPr,
  type ImpeccablePrFinding
} from "../src/frontend/impeccable-pr-gate.js";

describe("Ticket 34 (#35) — Block new Impeccable objective/DESIGN.md violations on frontend PRs", () => {
  it.each([
    {
      id: "fails-check-on-new-wcag-or-design-md-violation",
      findings: [
        {
          id: "f-wcag-contrast",
          category: "wcag_aria_contrast_keyboard",
          message: "Contrast ratio 2.8:1 below 4.5:1 threshold",
          isPreExistingInBaseline: false,
          hasApprovedException: false
        }
      ] satisfies readonly ImpeccablePrFinding[],
      expectedConclusion: "failure",
      expectedBlockingCount: 1,
      expectedInformationalCount: 0
    },
    {
      id: "fails-check-on-new-design-system-or-surface-rule-violation",
      findings: [
        {
          id: "f-design-token",
          category: "design_md_or_surface_rule",
          message: "Raw hex #ff0000 used instead of DESIGN.md token --color-danger",
          isPreExistingInBaseline: false,
          hasApprovedException: false
        }
      ] satisfies readonly ImpeccablePrFinding[],
      expectedConclusion: "failure",
      expectedBlockingCount: 1,
      expectedInformationalCount: 0
    },
    {
      id: "passes-when-violation-is-pre-existing-in-baseline-or-has-approved-exception",
      findings: [
        {
          id: "f-legacy-layout",
          category: "responsive_layout_overflow",
          message: "Legacy table overflow on 320px",
          isPreExistingInBaseline: true,
          hasApprovedException: false
        },
        {
          id: "f-approved-exception",
          category: "missing_loading_error_empty_state",
          message: "Static banner has no loading state",
          isPreExistingInBaseline: false,
          hasApprovedException: true
        }
      ] satisfies readonly ImpeccablePrFinding[],
      expectedConclusion: "success",
      expectedBlockingCount: 0,
      expectedInformationalCount: 0
    },
    {
      id: "passes-when-only-subjective-aesthetic-suggestions-are-present",
      findings: [
        {
          id: "f-aesthetic",
          category: "subjective_aesthetic_suggestion",
          message: "Consider slightly softer border radius",
          isPreExistingInBaseline: false,
          hasApprovedException: false
        }
      ] satisfies readonly ImpeccablePrFinding[],
      expectedConclusion: "success",
      expectedBlockingCount: 0,
      expectedInformationalCount: 1
    }
  ])(
    "evaluateImpeccableFrontendPr [$id]: blocks objective/DESIGN.md regressions while keeping aesthetics informational",
    ({
      findings,
      expectedConclusion,
      expectedBlockingCount,
      expectedInformationalCount
    }) => {
      const result = evaluateImpeccableFrontendPr({ findings });
      expect(result.conclusion).toBe(expectedConclusion);
      expect(result.blocking_findings).toHaveLength(expectedBlockingCount);
      expect(result.informational_findings).toHaveLength(
        expectedInformationalCount
      );
    }
  );
});
