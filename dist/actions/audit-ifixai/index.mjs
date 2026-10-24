// actions/audit-ifixai/index.ts
import { appendFileSync } from "node:fs";

// src/security/ifixai-audit.ts
function auditOrchestratorTrajectoryWithIfixai(input) {
  for (const step of input.steps) {
    if (step.effectivePermission !== "admin" && step.effectivePermission !== "maintain" && step.effectivePermission !== "write") {
      return {
        passed: false,
        error_code: "IFIXAI_UNAUTHORIZED_ACTOR_ESCALATION",
        error_message: `Step '${step.stepId}' executed privileged operation '${step.operation}' for actor '${step.actor}' with insufficient effective permission '${step.effectivePermission}' (ADR-0019).`,
        failed_step_id: step.stepId,
        llm_tokens_consumed: 0
      };
    }
    const isReleaseOperation = step.operation === "promote_dev_to_main" || step.operation === "create_release_tag" || step.targetBranchOrRef === "main" || step.targetBranchOrRef.startsWith("refs/tags/v");
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

// actions/audit-ifixai/index.ts
function writeActionOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${value}
`, "utf8");
  }
}
async function main() {
  const rawMode = process.env.INPUT_MODE ?? "deterministic_ci";
  const mode = rawMode === "adversarial_opt_in" ? "adversarial_opt_in" : "deterministic_ci";
  let steps = [];
  try {
    const parsed = JSON.parse(process.env.INPUT_STEPS_JSON ?? "[]");
    if (Array.isArray(parsed)) {
      steps = parsed;
    }
  } catch {
    steps = [];
  }
  const result = auditOrchestratorTrajectoryWithIfixai({ mode, steps });
  writeActionOutputs({
    passed: String(result.passed),
    error_code: result.error_code,
    failed_step_id: result.failed_step_id
  });
  if (!result.passed) {
    process.stderr.write(`${result.error_code}: ${result.error_message}
`);
    process.exitCode = 1;
  }
}
await main();
