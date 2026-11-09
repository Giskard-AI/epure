import type { NeedsHumanEscalationReason } from "../../src/execution/external-ci-gate.js";
import type { ArtifactsGateErrorCode } from "../../src/planning/artifacts-gate.js";

// internal: EPURE or its configuration is at fault, so the run measures a bug, not the work.
// legitimate: the work, a guard or an external system stopped the run as designed.
export type EscalationClass = "internal" | "legitimate";

// Reasons EPURE records in `last_escalation`.
export const RECORDED_REASON_CLASS: Readonly<Record<NeedsHumanEscalationReason, EscalationClass>> = {
  remediation_exhausted: "legitimate",
  epic_convergence_exhausted: "legitimate",
  grace_window_timeout: "legitimate",
  sensitive_path_violation: "legitimate",
  merge_conflict_unresolved: "legitimate",
  merge_conflict_stage1_failed: "legitimate",
  pr_not_mergeable: "legitimate",
  resync_verification_failed: "internal",
  wall_clock_budget_exhausted: "legitimate",
  transient_llm_api_exhausted: "legitimate",
  llm_quota_or_auth_failure: "legitimate",
  llm_request_invalid: "internal",
  llm_refusal: "legitimate",
  model_config_missing: "internal",
  github_rate_limited: "legitimate",
  branch_update_conflict: "internal",
  ambiguous_feature_branch: "internal",
  plan_manifest_missing: "internal",
  agent_timeout: "legitimate",
  agent_request_cap_reached: "legitimate",
  agent_engine_failed: "internal",
  sandbox_isolation_unavailable: "internal",
  agent_diff_too_large: "legitimate",
  agent_secret_leak_blocked: "legitimate",
  agent_no_changes: "legitimate",
  job_budget_exhausted: "legitimate",
  internal_error: "internal"
};

export type GateEscalationCode = Exclude<ArtifactsGateErrorCode, "NONE"> | "UNPROVEN_BLOCKER_CLOSURE";

// Gates that suspend without `last_escalation`: the code is in the escalation comment heading.
export const GATE_CODE_CLASS: Readonly<Record<GateEscalationCode, EscalationClass>> = {
  GLOSSARY_MISSING_FOR_DOMAIN_TERMS: "legitimate",
  ADR_MISSING_OR_INCOMPLETE: "legitimate",
  SPEC_MISSING_OR_INCOMPLETE: "legitimate",
  TICKET_GRAPH_EMPTY: "legitimate",
  TICKET_GRAPH_CYCLE_DETECTED: "legitimate",
  // Only a human closing a blocker as not planned triggers it; the harness never does.
  UNPROVEN_BLOCKER_CLOSURE: "internal"
};

const CLASS_BY_REASON: Readonly<Record<string, EscalationClass>> = { ...RECORDED_REASON_CLASS, ...GATE_CODE_CLASS };

// Fails closed: a reason missing from both tables counts against the run.
export function classifyEscalation(reason: string): EscalationClass | "unclassified" {
  return Object.hasOwn(CLASS_BY_REASON, reason) ? CLASS_BY_REASON[reason]! : "unclassified";
}
