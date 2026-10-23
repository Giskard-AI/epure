export type FeatureToDevPrErrorCode =
  | "NONE"
  | "OPEN_TICKETS_REMAINING"
  | "FEATURE_CI_CHECKS_NOT_GREEN"
  | "FEATURE_TO_DEV_AUTO_MERGE_FORBIDDEN";

export interface FeaturePlanTicketSummary {
  readonly id: number;
  readonly issueNumber: number;
  readonly title: string;
  readonly state: "open" | "closed";
}

export interface FeatureToDevPrInput {
  readonly repository: string;
  readonly planIssueNumber: number;
  readonly planTitle: string;
  readonly featureBranch: string;
  readonly specPath: string;
  readonly adrPaths: readonly string[];
  readonly tickets: readonly FeaturePlanTicketSummary[];
  readonly featureCiChecksGreen: boolean;
  readonly attemptAutoMergeToDev: boolean;
}

export interface FeatureToDevPrResult {
  readonly ready_to_open: boolean;
  readonly error_code: FeatureToDevPrErrorCode;
  readonly error_message: string;
  readonly head_branch: string;
  readonly base_branch: "dev";
  readonly auto_merge_allowed: false;
  readonly human_review_required: true;
  readonly pr_title: string;
  readonly pr_body: string;
}

export function prepareFeatureToDevPullRequest(
  input: FeatureToDevPrInput
): FeatureToDevPrResult {
  const prTitle = `feat(plan-${input.planIssueNumber}): ${input.planTitle}`;

  if (input.attemptAutoMergeToDev) {
    return {
      ready_to_open: false,
      error_code: "FEATURE_TO_DEV_AUTO_MERGE_FORBIDDEN",
      error_message:
        "Automatic merge from feature/* into dev is strictly forbidden; human review and approval are mandatory (ADR-0001, ADR-0002).",
      head_branch: input.featureBranch,
      base_branch: "dev",
      auto_merge_allowed: false,
      human_review_required: true,
      pr_title: prTitle,
      pr_body: ""
    };
  }

  const openTickets = input.tickets.filter((t) => t.state !== "closed");
  if (openTickets.length > 0) {
    return {
      ready_to_open: false,
      error_code: "OPEN_TICKETS_REMAINING",
      error_message: `Cannot open feature -> dev PR while ${openTickets.length} ticket(s) remain open.`,
      head_branch: input.featureBranch,
      base_branch: "dev",
      auto_merge_allowed: false,
      human_review_required: true,
      pr_title: prTitle,
      pr_body: ""
    };
  }

  if (!input.featureCiChecksGreen) {
    return {
      ready_to_open: false,
      error_code: "FEATURE_CI_CHECKS_NOT_GREEN",
      error_message:
        "Cannot open feature -> dev PR before all feature branch CI checks are green.",
      head_branch: input.featureBranch,
      base_branch: "dev",
      auto_merge_allowed: false,
      human_review_required: true,
      pr_title: prTitle,
      pr_body: ""
    };
  }

  const ticketLines = input.tickets.map(
    (t) => `- [x] #${t.issueNumber} — ${t.title}`
  );
  const adrLines = input.adrPaths.map((p) => `- \`${p}\``);

  const prBody = [
    "## Summary",
    `Integrates completed feature branch \`${input.featureBranch}\` into \`dev\` for mandatory human review.`,
    `- **Specification**: \`${input.specPath}\``,
    ...adrLines,
    "",
    `Closes #${input.planIssueNumber}`,
    "",
    "### Completed Sub-Issues",
    ...ticketLines,
    "",
    "## Evidence",
    "- All vertical-slice sub-issues resolved and verified on `feature/*`.",
    "- Feature branch CI checks: `green`.",
    "",
    "## Merge Danger",
    "- **Door**: Human-gated integration into `dev` (`auto_merge_allowed: false`).",
    `- **Blast Radius**: ${input.tickets.length} integrated ticket(s).`
  ].join("\n");

  return {
    ready_to_open: true,
    error_code: "NONE",
    error_message: "",
    head_branch: input.featureBranch,
    base_branch: "dev",
    auto_merge_allowed: false,
    human_review_required: true,
    pr_title: prTitle,
    pr_body: prBody
  };
}
