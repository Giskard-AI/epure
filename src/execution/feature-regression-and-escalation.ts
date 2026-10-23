export interface FeatureRegressionCandidateTicket {
  readonly ticketId: number;
  readonly issueNumber: number;
  readonly codeFixAttemptsUsed: number;
  readonly blockedByTicketIds: readonly number[];
}

export interface FeatureFailureAndRegressionInput {
  readonly planIssueNumber: number;
  readonly featureBranch: string;
  readonly maxCodeFixAttempts: number;
  readonly postMergeRegressionDetectedOnFeature: boolean;
  readonly regressionSummary: string;
  readonly tickets: readonly FeatureRegressionCandidateTicket[];
}

export interface FeatureFailureAndRegressionResult {
  readonly needs_human_ticket_ids: readonly number[];
  readonly continuing_independent_ticket_ids: readonly number[];
  readonly feature_merges_frozen: boolean;
  readonly corrective_issue_created: boolean;
  readonly corrective_issue_body: string;
  readonly shared_history_rewritten: false;
}

export function evaluateFeatureFailuresAndRegressions(
  input: FeatureFailureAndRegressionInput
): FeatureFailureAndRegressionResult {
  if (input.postMergeRegressionDetectedOnFeature) {
    return {
      needs_human_ticket_ids: [],
      continuing_independent_ticket_ids: [],
      feature_merges_frozen: true,
      corrective_issue_created: true,
      corrective_issue_body: `### Post-Merge Feature Regression on \`${input.featureBranch}\`\n- ${input.regressionSummary}\n- Future feature merges are frozen until resolved via a forward corrective PR (no force-push).`,
      shared_history_rewritten: false
    };
  }

  const needsHumanIds = new Set<number>();
  for (const t of input.tickets) {
    if (t.codeFixAttemptsUsed >= input.maxCodeFixAttempts) {
      needsHumanIds.add(t.ticketId);
    }
  }

  const continuingIds: number[] = [];
  for (const t of input.tickets) {
    if (needsHumanIds.has(t.ticketId)) {
      continue;
    }
    const blockedByFailedTicket = t.blockedByTicketIds.some((id) =>
      needsHumanIds.has(id)
    );
    if (!blockedByFailedTicket) {
      continuingIds.push(t.ticketId);
    }
  }

  return {
    needs_human_ticket_ids: [...needsHumanIds],
    continuing_independent_ticket_ids: continuingIds,
    feature_merges_frozen: false,
    corrective_issue_created: false,
    corrective_issue_body: "",
    shared_history_rewritten: false
  };
}
