import { describe, expect, it } from "vitest";
import {
  evaluateRenovateMigrationAction,
  type RenovateMigrationActionInput
} from "../src/renovate/renovate-auto-migrate.js";

describe("Ticket 27 (#28) — Repair failing Renovate migration only when authorized and verified", () => {
  const BASE_INPUT: RenovateMigrationActionInput = {
    authenticRenovateProvenance: true,
    autoMigrateEnabledInApprovedConfig: true,
    failureKind: "breaking_code_incompatibility",
    migrationGuideSummary: "Replace deprecated parseConfig() with loadConfig()",
    transientCiRetriesUsed: 0,
    maxTransientApiRetries: 4
  };

  it.each([
    {
      id: "proposes-code-patch-when-auto-migrate-enabled-and-breaking-change-documented",
      input: BASE_INPUT,
      expectedDecision: "propose_migration_patch",
      expectedPrivilegedAgentStarted: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "reruns-ci-without-code-patch-when-failure-is-transient-runner-or-network",
      input: {
        ...BASE_INPUT,
        failureKind: "transient_runner_or_network_error"
      } satisfies RenovateMigrationActionInput,
      expectedDecision: "rerun_ci_without_code_patch",
      expectedPrivilegedAgentStarted: false,
      expectedErrorCode: "NONE"
    },
    {
      id: "refuses-privileged-agent-when-auto-migrate-disabled",
      input: {
        ...BASE_INPUT,
        autoMigrateEnabledInApprovedConfig: false
      } satisfies RenovateMigrationActionInput,
      expectedDecision: "blocked",
      expectedPrivilegedAgentStarted: false,
      expectedErrorCode: "AUTO_MIGRATE_DISABLED"
    },
    {
      id: "refuses-privileged-agent-when-renovate-provenance-is-unverified",
      input: {
        ...BASE_INPUT,
        authenticRenovateProvenance: false
      } satisfies RenovateMigrationActionInput,
      expectedDecision: "blocked",
      expectedPrivilegedAgentStarted: false,
      expectedErrorCode: "RENOVATE_PROVENANCE_UNVERIFIED"
    }
  ])(
    "evaluateRenovateMigrationAction [$id]: distinguishes transient CI failure from authorized code migration",
    ({
      input,
      expectedDecision,
      expectedPrivilegedAgentStarted,
      expectedErrorCode
    }) => {
      const result = evaluateRenovateMigrationAction(input);
      expect(result.decision).toBe(expectedDecision);
      expect(result.privileged_agent_started).toBe(
        expectedPrivilegedAgentStarted
      );
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.auto_merge_to_dev_allowed).toBe(false);
      expect(result.human_approval_required_for_dev_merge).toBe(true);
    }
  );
});
