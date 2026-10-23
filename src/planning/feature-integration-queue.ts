export interface FeatureQueueCandidate {
  readonly ticketId: number;
  readonly issueNumber: number;
  readonly taskBranch: string;
  readonly blockedByTicketIds: readonly number[];
  readonly duplicateOfTicketId?: number | undefined;
  readonly checksGreen: boolean;
  readonly reviewApproved: boolean;
  readonly rebaseConflictsCount: number;
}

export interface FeatureQueueInput {
  readonly planIssueNumber: number;
  readonly featureBranch: string;
  readonly maxCodeFixAttempts: number;
  readonly candidates: readonly FeatureQueueCandidate[];
}

export interface FeatureQueueResult {
  readonly concurrency_group: string;
  readonly feature_branch: string;
  readonly merged_ticket_ids: readonly number[];
  readonly deduplicated_closed_ticket_ids: readonly number[];
  readonly escalated_conflict_ticket_ids: readonly number[];
  readonly rebased_branches: readonly string[];
}

export function reconcileAndIntegrateFeatureQueue(
  input: FeatureQueueInput
): FeatureQueueResult {
  const deduplicatedClosedIds: number[] = [];
  const activeCandidates: FeatureQueueCandidate[] = [];

  for (const candidate of input.candidates) {
    if (typeof candidate.duplicateOfTicketId === "number") {
      deduplicatedClosedIds.push(candidate.ticketId);
      continue;
    }
    activeCandidates.push(candidate);
  }

  const mergedIds = new Set<number>();
  const mergedOrder: number[] = [];
  const escalatedIds: number[] = [];
  const rebasedBranches: string[] = [];

  const remaining = [...activeCandidates];
  let progress = true;

  while (progress && remaining.length > 0) {
    progress = false;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (!candidate) {
        continue;
      }

      const blockersSatisfied = candidate.blockedByTicketIds.every((id) =>
        mergedIds.has(id)
      );

      if (!blockersSatisfied) {
        continue;
      }

      remaining.splice(i, 1);
      progress = true;

      if (candidate.rebaseConflictsCount > input.maxCodeFixAttempts) {
        escalatedIds.push(candidate.ticketId);
        break;
      }

      if (candidate.checksGreen && candidate.reviewApproved) {
        mergedIds.add(candidate.ticketId);
        mergedOrder.push(candidate.ticketId);
        for (const rem of remaining) {
          rebasedBranches.push(rem.taskBranch);
        }
      }
      break;
    }
  }

  return {
    concurrency_group: `feature-merge-${input.planIssueNumber}`,
    feature_branch: input.featureBranch,
    merged_ticket_ids: mergedOrder,
    deduplicated_closed_ticket_ids: deduplicatedClosedIds,
    escalated_conflict_ticket_ids: escalatedIds,
    rebased_branches: rebasedBranches
  };
}
