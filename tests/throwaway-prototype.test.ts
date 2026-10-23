import { describe, expect, it } from "vitest";
import {
  evaluateThrowawayPrototypeIsolation,
  type ThrowawayPrototypeInput
} from "../src/frontend/throwaway-prototype.js";

describe("Ticket 32 (#33) — Prototype design uncertainty without reusing exploratory code in production", () => {
  it.each([
    {
      id: "runs-isolated-prototype-on-uncertain-question-and-starts-production-from-clean-base",
      input: {
        issueNumber: 33,
        topicSlug: "drawer-animation",
        hasUnresolvedDesignUncertainty: true,
        prototypeConclusionSummary: "Use CSS grid transition at 200ms",
        screenshotsAttached: ["artifacts/drawer-desktop.png"],
        productionStartBaseBranch: "feature/1-epure-v1",
        copiedExploratoryPrototypeFilesIntoProduction: []
      } satisfies ThrowawayPrototypeInput,
      expectedPrototypeCreated: true,
      expectedAllowedForProduction: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "skips-prototype-when-design-change-is-clear-and-unambiguous",
      input: {
        issueNumber: 33,
        topicSlug: "button-label",
        hasUnresolvedDesignUncertainty: false,
        prototypeConclusionSummary: "",
        screenshotsAttached: [],
        productionStartBaseBranch: "feature/1-epure-v1",
        copiedExploratoryPrototypeFilesIntoProduction: []
      } satisfies ThrowawayPrototypeInput,
      expectedPrototypeCreated: false,
      expectedAllowedForProduction: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "blocks-production-task-that-copies-exploratory-prototype-code-or-branches-from-prototype",
      input: {
        issueNumber: 33,
        topicSlug: "drawer-animation",
        hasUnresolvedDesignUncertainty: true,
        prototypeConclusionSummary: "Use CSS grid transition",
        screenshotsAttached: ["artifacts/drawer-desktop.png"],
        productionStartBaseBranch: "prototype/33-drawer-animation",
        copiedExploratoryPrototypeFilesIntoProduction: [
          "prototypes/drawer-hack.tsx"
        ]
      } satisfies ThrowawayPrototypeInput,
      expectedPrototypeCreated: true,
      expectedAllowedForProduction: false,
      expectedErrorCode: "EXPLORATORY_PROTOTYPE_CODE_REUSE_FORBIDDEN"
    }
  ])(
    "evaluateThrowawayPrototypeIsolation [$id]: isolates throwaway prototypes from production branches",
    ({
      input,
      expectedPrototypeCreated,
      expectedAllowedForProduction,
      expectedErrorCode
    }) => {
      const result = evaluateThrowawayPrototypeIsolation(input);
      expect(result.prototype_created).toBe(expectedPrototypeCreated);
      expect(result.production_branch_clean).toBe(expectedAllowedForProduction);
      expect(result.error_code).toBe(expectedErrorCode);
    }
  );
});
