import { describe, expect, it } from "vitest";
import {
  routePlanningCommand,
  type PlanningCommandInput
} from "../src/planning/skill-router.js";
import { createInMemoryGitRefStateStore } from "../src/state/git-ref-state.js";

describe("Ticket 11 (#12) — Matt Pocock planning skill router (/grill-me, /to-spec, /to-tickets)", () => {
  it.each([
    {
      id: "routes-grill-me-to-grilling-skill-on-plan-branch-with-zero-code-generation",
      input: {
        issueNumber: 12,
        planSlug: "auth-redesign",
        commandText: "/grill-me on the token rotation edge cases",
        specApprovedByHuman: false,
        proposedFilesToWrite: ["docs/DECISIONS.md", "GLOSSARY.md"]
      } satisfies Omit<PlanningCommandInput, "store">,
      expectedAllowed: true,
      expectedErrorCode: "NONE",
      expectedSkill: "grilling",
      expectedPhase: "grilling",
      expectedStatus: "active",
      expectedPlanBranch: "plan/12-auth-redesign"
    },
    {
      id: "routes-grill-with-docs-to-grilling-and-domain-modeling",
      input: {
        issueNumber: 12,
        planSlug: "auth-redesign",
        commandText: "/grill-with-docs check ADRs and glossary",
        specApprovedByHuman: false,
        proposedFilesToWrite: [
          "docs/DECISIONS.md",
          "GLOSSARY.md",
          "docs/adr/0001-token.md"
        ]
      } satisfies Omit<PlanningCommandInput, "store">,
      expectedAllowed: true,
      expectedErrorCode: "NONE",
      expectedSkill: "grilling+domain-modeling",
      expectedPhase: "grilling",
      expectedStatus: "active",
      expectedPlanBranch: "plan/12-auth-redesign"
    },
    {
      id: "routes-to-spec-and-awaits-human-approval",
      input: {
        issueNumber: 12,
        planSlug: "auth-redesign",
        commandText: "/to-spec",
        specApprovedByHuman: false,
        proposedFilesToWrite: ["docs/specs/auth-redesign.md"]
      } satisfies Omit<PlanningCommandInput, "store">,
      expectedAllowed: true,
      expectedErrorCode: "NONE",
      expectedSkill: "to-spec",
      expectedPhase: "spec",
      expectedStatus: "awaiting_human_approval",
      expectedPlanBranch: "plan/12-auth-redesign"
    },
    {
      id: "blocks-to-tickets-when-spec-not-approved-by-human",
      input: {
        issueNumber: 12,
        planSlug: "auth-redesign",
        commandText: "/to-tickets",
        specApprovedByHuman: false,
        proposedFilesToWrite: ["planning/auth-redesign/BACKLOG.md"]
      } satisfies Omit<PlanningCommandInput, "store">,
      expectedAllowed: false,
      expectedErrorCode: "SPEC_NOT_APPROVED_BY_HUMAN",
      expectedSkill: "to-tickets",
      expectedPhase: "idle",
      expectedStatus: "active",
      expectedPlanBranch: "plan/12-auth-redesign"
    },
    {
      id: "routes-to-tickets-once-spec-is-approved-by-human",
      input: {
        issueNumber: 12,
        planSlug: "auth-redesign",
        commandText: "/to-tickets",
        specApprovedByHuman: true,
        proposedFilesToWrite: [
          "planning/auth-redesign/BACKLOG.md",
          "planning/auth-redesign/tickets.json"
        ]
      } satisfies Omit<PlanningCommandInput, "store">,
      expectedAllowed: true,
      expectedErrorCode: "NONE",
      expectedSkill: "to-tickets",
      expectedPhase: "tickets",
      expectedStatus: "awaiting_human_approval",
      expectedPlanBranch: "plan/12-auth-redesign"
    },
    {
      id: "forbids-application-code-generation-during-planning-phases",
      input: {
        issueNumber: 12,
        planSlug: "auth-redesign",
        commandText: "/to-spec",
        specApprovedByHuman: false,
        proposedFilesToWrite: [
          "docs/specs/auth-redesign.md",
          "src/auth/new-service.ts"
        ]
      } satisfies Omit<PlanningCommandInput, "store">,
      expectedAllowed: false,
      expectedErrorCode: "CODE_GENERATION_FORBIDDEN_DURING_PLANNING",
      expectedSkill: "to-spec",
      expectedPhase: "idle",
      expectedStatus: "active",
      expectedPlanBranch: "plan/12-auth-redesign"
    }
  ])(
    "routePlanningCommand [$id]: enforces Matt Pocock planning lifecycle and living plan/* branch",
    async ({
      input,
      expectedAllowed,
      expectedErrorCode,
      expectedSkill,
      expectedPhase,
      expectedStatus,
      expectedPlanBranch
    }) => {
      const store = createInMemoryGitRefStateStore();
      const result = await routePlanningCommand({
        ...input,
        store
      });

      expect(result.routed).toBe(expectedAllowed);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.skill).toBe(expectedSkill);
      expect(result.plan_branch).toBe(expectedPlanBranch);
      expect(result.state.phase).toBe(expectedPhase);
      expect(result.state.status).toBe(expectedStatus);
      expect(result.application_code_generated).toBe(false);
    }
  );
});
