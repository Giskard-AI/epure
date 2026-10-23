import { describe, expect, it } from "vitest";
import {
  auditOrchestratorTrajectoryWithIfixai,
  type IfixaiAuditInput
} from "../src/security/ifixai-audit.js";

describe("Ticket 30 (#31) — Audit orchestrator authorization & delegation trajectories with iFixAi", () => {
  it.each([
    {
      id: "passes-deterministic-audit-on-valid-trajectory-with-zero-llm-tokens",
      input: {
        mode: "deterministic_ci",
        steps: [
          {
            stepId: "s1",
            actor: "maintainer",
            effectivePermission: "write",
            appRole: "agent",
            operation: "push_task_branch",
            targetBranchOrRef: "task/31-ifixai"
          },
          {
            stepId: "s2",
            actor: "maintainer",
            effectivePermission: "admin",
            appRole: "release",
            operation: "promote_dev_to_main",
            targetBranchOrRef: "main"
          }
        ]
      } satisfies IfixaiAuditInput,
      expectedPassed: true,
      expectedErrorCode: "NONE",
      expectedLlmTokensConsumed: 0
    },
    {
      id: "fails-audit-on-privilege-escalation-by-read-only-actor",
      input: {
        mode: "deterministic_ci",
        steps: [
          {
            stepId: "s1",
            actor: "external-reader",
            effectivePermission: "read",
            appRole: "agent",
            operation: "push_task_branch",
            targetBranchOrRef: "task/31-ifixai"
          }
        ]
      } satisfies IfixaiAuditInput,
      expectedPassed: false,
      expectedErrorCode: "IFIXAI_UNAUTHORIZED_ACTOR_ESCALATION",
      expectedLlmTokensConsumed: 0
    },
    {
      id: "fails-audit-when-agent-app-attempts-release-or-protected-branch-push",
      input: {
        mode: "deterministic_ci",
        steps: [
          {
            stepId: "s1",
            actor: "maintainer",
            effectivePermission: "write",
            appRole: "agent",
            operation: "promote_dev_to_main",
            targetBranchOrRef: "main"
          }
        ]
      } satisfies IfixaiAuditInput,
      expectedPassed: false,
      expectedErrorCode: "IFIXAI_ROLE_DELEGATION_VIOLATION",
      expectedLlmTokensConsumed: 0
    },
    {
      id: "supports-explicit-opt-in-adversarial-llm-audit-mode",
      input: {
        mode: "adversarial_opt_in",
        steps: [
          {
            stepId: "s1",
            actor: "maintainer",
            effectivePermission: "write",
            appRole: "agent",
            operation: "push_task_branch",
            targetBranchOrRef: "task/31-ifixai"
          }
        ]
      } satisfies IfixaiAuditInput,
      expectedPassed: true,
      expectedErrorCode: "NONE",
      expectedLlmTokensConsumed: 0
    }
  ])(
    "auditOrchestratorTrajectoryWithIfixai [$id]: detects authorization/delegation flaws deterministically",
    ({
      input,
      expectedPassed,
      expectedErrorCode,
      expectedLlmTokensConsumed
    }) => {
      const result = auditOrchestratorTrajectoryWithIfixai(input);
      expect(result.passed).toBe(expectedPassed);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.llm_tokens_consumed).toBe(expectedLlmTokensConsumed);
    }
  );
});
