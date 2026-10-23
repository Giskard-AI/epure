import { describe, expect, it } from "vitest";
import {
  validatePlanningArtifactsAndGraph,
  type PlanningArtifactsBundle
} from "../src/planning/artifacts-gate.js";

describe("Ticket 12 (#13) — Require ADRs, spec, glossary, and acyclic ticket dependency graph", () => {
  const VALID_BUNDLE: PlanningArtifactsBundle = {
    introducesDomainTerms: true,
    glossaryContent: "# Glossary\n\n- **Isolated Publisher**: Validates and applies proposals.",
    adrFiles: [
      {
        path: "docs/adr/0001-branching.md",
        content: "# ADR-0001\n## Status\nAccepted\n## Context\n...\n## Decision\n..."
      }
    ],
    specPath: "docs/specs/dev-automation-v1.md",
    specContent: "# Spec\n## Objectif\n...\n## Critères d'acceptation\n...",
    tickets: [
      {
        id: 1,
        issueNumber: 2,
        title: "Ticket 1",
        state: "open",
        blockedBy: []
      },
      {
        id: 2,
        issueNumber: 3,
        title: "Ticket 2",
        state: "open",
        blockedBy: [1]
      },
      {
        id: 3,
        issueNumber: 4,
        title: "Ticket 3",
        state: "open",
        blockedBy: [1]
      }
    ]
  };

  it.each([
    {
      id: "accepts-complete-adr-spec-glossary-and-computes-ready-frontier",
      bundle: VALID_BUNDLE,
      expectedValid: true,
      expectedErrorCode: "NONE",
      expectedReadyTicketIds: [1],
      expectedBlockedTicketIds: [2, 3]
    },
    {
      id: "unblocks-dependent-tickets-when-blocker-is-closed",
      bundle: {
        ...VALID_BUNDLE,
        tickets: [
          {
            id: 1,
            issueNumber: 2,
            title: "Ticket 1",
            state: "closed",
            blockedBy: []
          },
          {
            id: 2,
            issueNumber: 3,
            title: "Ticket 2",
            state: "open",
            blockedBy: [1]
          },
          {
            id: 3,
            issueNumber: 4,
            title: "Ticket 3",
            state: "open",
            blockedBy: [2]
          }
        ]
      } satisfies PlanningArtifactsBundle,
      expectedValid: true,
      expectedErrorCode: "NONE",
      expectedReadyTicketIds: [2],
      expectedBlockedTicketIds: [3]
    },
    {
      id: "rejects-when-domain-terms-introduced-without-glossary",
      bundle: {
        ...VALID_BUNDLE,
        introducesDomainTerms: true,
        glossaryContent: ""
      } satisfies PlanningArtifactsBundle,
      expectedValid: false,
      expectedErrorCode: "GLOSSARY_MISSING_FOR_DOMAIN_TERMS",
      expectedReadyTicketIds: [],
      expectedBlockedTicketIds: []
    },
    {
      id: "rejects-when-adr-missing-or-malformed",
      bundle: {
        ...VALID_BUNDLE,
        adrFiles: []
      } satisfies PlanningArtifactsBundle,
      expectedValid: false,
      expectedErrorCode: "ADR_MISSING_OR_INCOMPLETE",
      expectedReadyTicketIds: [],
      expectedBlockedTicketIds: []
    },
    {
      id: "rejects-when-spec-missing-or-empty",
      bundle: {
        ...VALID_BUNDLE,
        specContent: "   "
      } satisfies PlanningArtifactsBundle,
      expectedValid: false,
      expectedErrorCode: "SPEC_MISSING_OR_INCOMPLETE",
      expectedReadyTicketIds: [],
      expectedBlockedTicketIds: []
    },
    {
      id: "rejects-when-ticket-dependency-graph-contains-a-cycle",
      bundle: {
        ...VALID_BUNDLE,
        tickets: [
          {
            id: 1,
            issueNumber: 2,
            title: "Ticket 1",
            state: "open",
            blockedBy: [2]
          },
          {
            id: 2,
            issueNumber: 3,
            title: "Ticket 2",
            state: "open",
            blockedBy: [1]
          }
        ]
      } satisfies PlanningArtifactsBundle,
      expectedValid: false,
      expectedErrorCode: "TICKET_GRAPH_CYCLE_DETECTED",
      expectedReadyTicketIds: [],
      expectedBlockedTicketIds: []
    }
  ])(
    "validatePlanningArtifactsAndGraph [$id]: enforces ADR/Spec/Glossary & DAG invariants",
    ({
      bundle,
      expectedValid,
      expectedErrorCode,
      expectedReadyTicketIds,
      expectedBlockedTicketIds
    }) => {
      const result = validatePlanningArtifactsAndGraph(bundle);
      expect(result.valid).toBe(expectedValid);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.ready_ticket_ids).toEqual(expectedReadyTicketIds);
      expect(result.blocked_ticket_ids).toEqual(expectedBlockedTicketIds);
    }
  );
});
