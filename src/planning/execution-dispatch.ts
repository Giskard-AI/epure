import type { TicketGraphNode } from "./artifacts-gate.js";

export type ExecutionDispatchErrorCode =
  | "NONE"
  | "PLAN_NOT_APPROVED_BY_HUMAN"
  | "SCOPE_LOCKED_REQUIRES_HUMAN_REOPEN";

export interface LockPlanAndDispatchInput {
  readonly planIssueNumber: number;
  readonly planSlug: string;
  readonly planApprovedByHuman: boolean;
  readonly scopeAlreadyLocked: boolean;
  readonly humanRequestedScopeReopen: boolean;
  readonly attemptingScopeMutation: boolean;
  readonly maxConcurrentTasksPerFeature: number;
  readonly tickets: readonly TicketGraphNode[];
}

export interface LockPlanAndDispatchResult {
  readonly dispatched: boolean;
  readonly error_code: ExecutionDispatchErrorCode;
  readonly error_message: string;
  readonly scope_locked: boolean;
  readonly plan_branch: string;
  readonly plan_merged_to_dev: boolean;
  readonly feature_branch: string;
  readonly dispatched_ticket_ids: readonly number[];
  readonly queued_ready_ticket_ids: readonly number[];
  readonly blocked_ticket_ids: readonly number[];
}

export function lockPlanAndDispatchReadyTickets(
  input: LockPlanAndDispatchInput
): LockPlanAndDispatchResult {
  const cleanSlug = input.planSlug.trim().replace(/^\/+|\/+$/g, "");
  const planBranch = `plan/${input.planIssueNumber}-${cleanSlug}`;
  const featureBranch = `feature/${input.planIssueNumber}-${cleanSlug}`;

  if (
    input.scopeAlreadyLocked &&
    input.attemptingScopeMutation &&
    !input.humanRequestedScopeReopen
  ) {
    return {
      dispatched: false,
      error_code: "SCOPE_LOCKED_REQUIRES_HUMAN_REOPEN",
      error_message:
        "Plan scope is locked after approval; modifying ADRs, spec, or ticket breakdown requires an explicit human reopen command (ADR-0002).",
      scope_locked: true,
      plan_branch: planBranch,
      plan_merged_to_dev: false,
      feature_branch: featureBranch,
      dispatched_ticket_ids: [],
      queued_ready_ticket_ids: [],
      blocked_ticket_ids: []
    };
  }

  if (!input.planApprovedByHuman) {
    return {
      dispatched: false,
      error_code: "PLAN_NOT_APPROVED_BY_HUMAN",
      error_message:
        "Cannot lock scope or launch ticket execution before explicit human approval of the plan and ticket breakdown (ADR-0002).",
      scope_locked: false,
      plan_branch: planBranch,
      plan_merged_to_dev: false,
      feature_branch: "",
      dispatched_ticket_ids: [],
      queued_ready_ticket_ids: [],
      blocked_ticket_ids: []
    };
  }

  const stateById = new Map<number, "open" | "closed">();
  for (const t of input.tickets) {
    stateById.set(t.id, t.state);
  }

  const readyIds: number[] = [];
  const blockedIds: number[] = [];

  for (const t of input.tickets) {
    if (t.state === "closed") {
      continue;
    }
    const hasOpenBlocker = t.blockedBy.some(
      (blockerId) => stateById.get(blockerId) !== "closed"
    );
    if (hasOpenBlocker) {
      blockedIds.push(t.id);
    } else {
      readyIds.push(t.id);
    }
  }

  const maxConcurrency = Math.max(1, input.maxConcurrentTasksPerFeature);
  const dispatchedIds = readyIds.slice(0, maxConcurrency);
  const queuedReadyIds = readyIds.slice(maxConcurrency);

  return {
    dispatched: true,
    error_code: "NONE",
    error_message: "",
    scope_locked: true,
    plan_branch: planBranch,
    plan_merged_to_dev: true,
    feature_branch: featureBranch,
    dispatched_ticket_ids: dispatchedIds,
    queued_ready_ticket_ids: queuedReadyIds,
    blocked_ticket_ids: blockedIds
  };
}
