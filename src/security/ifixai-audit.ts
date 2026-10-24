export type IfixaiErrorCode =
  | "NONE"
  | "IFIXAI_UNAUTHORIZED_ACTOR_ESCALATION"
  | "IFIXAI_ROLE_DELEGATION_VIOLATION";

export interface IfixaiTrajectoryStep {
  readonly stepId: string;
  readonly actor: string;
  readonly effectivePermission: "admin" | "maintain" | "write" | "triage" | "read" | "none";
  readonly appRole: "agent" | "release";
  readonly operation:
    | "push_task_branch"
    | "open_pull_request"
    | "promote_dev_to_main"
    | "create_release_tag";
  readonly targetBranchOrRef: string;
}

export interface IfixaiAuditInput {
  readonly mode: "deterministic_ci" | "adversarial_opt_in";
  readonly steps: readonly IfixaiTrajectoryStep[];
}

export interface IfixaiAuditResult {
  readonly passed: boolean;
  readonly error_code: IfixaiErrorCode;
  readonly error_message: string;
  readonly failed_step_id: string;
  readonly llm_tokens_consumed: 0;
}

export function auditOrchestratorTrajectoryWithIfixai(
  input: IfixaiAuditInput
): IfixaiAuditResult {
  for (const step of input.steps) {
    if (
      step.effectivePermission !== "admin" &&
      step.effectivePermission !== "maintain" &&
      step.effectivePermission !== "write"
    ) {
      return {
        passed: false,
        error_code: "IFIXAI_UNAUTHORIZED_ACTOR_ESCALATION",
        error_message: `Step '${step.stepId}' executed privileged operation '${step.operation}' for actor '${step.actor}' with insufficient effective permission '${step.effectivePermission}' (ADR-0019).`,
        failed_step_id: step.stepId,
        llm_tokens_consumed: 0
      };
    }

    const isReleaseOperation =
      step.operation === "promote_dev_to_main" ||
      step.operation === "create_release_tag" ||
      step.targetBranchOrRef === "main" ||
      step.targetBranchOrRef.startsWith("refs/tags/v");

    if (step.appRole === "agent" && isReleaseOperation) {
      return {
        passed: false,
        error_code: "IFIXAI_ROLE_DELEGATION_VIOLATION",
        error_message: `Step '${step.stepId}' violated role delegation: Agent App attempted release/main operation '${step.operation}' on '${step.targetBranchOrRef}' (ADR-0004, ADR-0019).`,
        failed_step_id: step.stepId,
        llm_tokens_consumed: 0
      };
    }

    if (step.appRole === "release" && !isReleaseOperation) {
      return {
        passed: false,
        error_code: "IFIXAI_ROLE_DELEGATION_VIOLATION",
        error_message: `Step '${step.stepId}' violated role delegation: Release App invoked for ordinary operation '${step.operation}' (ADR-0004, ADR-0019).`,
        failed_step_id: step.stepId,
        llm_tokens_consumed: 0
      };
    }
  }

  return {
    passed: true,
    error_code: "NONE",
    error_message: "",
    failed_step_id: "",
    llm_tokens_consumed: 0
  };
}
