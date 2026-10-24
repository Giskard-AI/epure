export interface ProvenDependencyTicket {
  readonly ticketId: number;
  readonly issueNumber: number;
  readonly state: "open" | "closed";
  readonly stateReason: "completed" | "not_planned" | "reopened" | null;
  readonly hasMergedPrOnFeatureBranch: boolean;
  readonly humanOverrideApproved: boolean;
  readonly blockedByTicketIds: readonly number[];
}

export interface ReconcileDependenciesInput {
  readonly tickets: readonly ProvenDependencyTicket[];
}

export interface ReconcileDependenciesResult {
  readonly ready_ticket_ids: readonly number[];
  readonly blocked_ticket_ids: readonly number[];
  readonly unproven_blocker_ticket_ids: readonly number[];
}

function isProvenResolved(ticket: ProvenDependencyTicket): boolean {
  if (ticket.state !== "closed") {
    return false;
  }
  if (ticket.humanOverrideApproved) {
    return true;
  }
  return (
    ticket.stateReason === "completed" && ticket.hasMergedPrOnFeatureBranch
  );
}

export function reconcileProvenTicketDependencies(
  input: ReconcileDependenciesInput
): ReconcileDependenciesResult {
  const byId = new Map<number, ProvenDependencyTicket>();
  const unprovenBlockerIds: number[] = [];

  for (const t of input.tickets) {
    byId.set(t.ticketId, t);
    if (t.state === "closed" && !isProvenResolved(t)) {
      unprovenBlockerIds.push(t.ticketId);
    }
  }

  const readyIds: number[] = [];
  const blockedIds: number[] = [];

  for (const t of input.tickets) {
    if (t.state === "closed") {
      continue;
    }

    const allBlockersProven = t.blockedByTicketIds.every((blockerId) => {
      const blocker = byId.get(blockerId);
      return blocker ? isProvenResolved(blocker) : false;
    });

    if (allBlockersProven) {
      readyIds.push(t.ticketId);
    } else {
      blockedIds.push(t.ticketId);
    }
  }

  return {
    ready_ticket_ids: readyIds,
    blocked_ticket_ids: blockedIds,
    unproven_blocker_ticket_ids: unprovenBlockerIds
  };
}
