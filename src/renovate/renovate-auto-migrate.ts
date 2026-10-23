export type RenovateMigrationDecision =
  | "propose_migration_patch"
  | "rerun_ci_without_code_patch"
  | "blocked";

export type RenovateMigrationErrorCode =
  | "NONE"
  | "RENOVATE_PROVENANCE_UNVERIFIED"
  | "AUTO_MIGRATE_DISABLED"
  | "TRANSIENT_CI_RETRIES_EXHAUSTED";

export interface RenovateMigrationActionInput {
  readonly authenticRenovateProvenance: boolean;
  readonly autoMigrateEnabledInApprovedConfig: boolean;
  readonly failureKind:
    | "transient_runner_or_network_error"
    | "breaking_code_incompatibility";
  readonly migrationGuideSummary: string;
  readonly transientCiRetriesUsed: number;
  readonly maxTransientApiRetries: number;
}

export interface RenovateMigrationActionResult {
  readonly decision: RenovateMigrationDecision;
  readonly privileged_agent_started: boolean;
  readonly error_code: RenovateMigrationErrorCode;
  readonly error_message: string;
  readonly auto_merge_to_dev_allowed: false;
  readonly human_approval_required_for_dev_merge: true;
}

export function evaluateRenovateMigrationAction(
  input: RenovateMigrationActionInput
): RenovateMigrationActionResult {
  if (!input.authenticRenovateProvenance) {
    return {
      decision: "blocked",
      privileged_agent_started: false,
      error_code: "RENOVATE_PROVENANCE_UNVERIFIED",
      error_message:
        "Cannot start privileged migration agent when Renovate PR provenance is unverified (ADR-0015).",
      auto_merge_to_dev_allowed: false,
      human_approval_required_for_dev_merge: true
    };
  }

  if (!input.autoMigrateEnabledInApprovedConfig) {
    return {
      decision: "blocked",
      privileged_agent_started: false,
      error_code: "AUTO_MIGRATE_DISABLED",
      error_message:
        "auto_migrate is disabled in approved configuration; no privileged migration agent started.",
      auto_merge_to_dev_allowed: false,
      human_approval_required_for_dev_merge: true
    };
  }

  if (input.failureKind === "transient_runner_or_network_error") {
    if (input.transientCiRetriesUsed >= input.maxTransientApiRetries) {
      return {
        decision: "blocked",
        privileged_agent_started: false,
        error_code: "TRANSIENT_CI_RETRIES_EXHAUSTED",
        error_message:
          "Transient CI retries exhausted on Renovate PR; awaiting human intervention without generating a code patch.",
        auto_merge_to_dev_allowed: false,
        human_approval_required_for_dev_merge: true
      };
    }

    return {
      decision: "rerun_ci_without_code_patch",
      privileged_agent_started: false,
      error_code: "NONE",
      error_message: "",
      auto_merge_to_dev_allowed: false,
      human_approval_required_for_dev_merge: true
    };
  }

  return {
    decision: "propose_migration_patch",
    privileged_agent_started: true,
    error_code: "NONE",
    error_message: "",
    auto_merge_to_dev_allowed: false,
    human_approval_required_for_dev_merge: true
  };
}
