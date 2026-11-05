import {
  toTerminalState,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import { appendEpureCommandsSpoiler } from "../formatting/comments.js";
import type { GitHubRestHelper, OrchestrateIssueResult } from "../types.js";

const FEATURE_BRANCH_PHASES: ReadonlySet<EpureIssueState["phase"]> = new Set([
  "implementation",
  "completed"
]);

/**
 * A human closed the plan issue: when its feature branch is not merged into `dev`,
 * cancel the plan, keep every branch and open PR, and tell how to resume.
 */
export async function handleEpicClosedByHuman(params: {
  readonly issueNumber: number;
  readonly actor: string;
  readonly currentState: EpureIssueState | null;
  readonly gh: GitHubRestHelper;
  readonly store: GitRefStateStore;
}): Promise<OrchestrateIssueResult> {
  const state = params.currentState;
  const featureBranch = state?.active_branch ?? "";
  const ignore = (reason: string): OrchestrateIssueResult => ({
    executed: false,
    phase: state?.phase ?? "idle",
    status: state?.status ?? "active",
    active_branch: featureBranch,
    summary_markdown: `Epic closure ignored: ${reason}.`,
    created_ticket_numbers: [],
    feature_pr_url: ""
  });

  if (!state || state.status === "cancelled" || !FEATURE_BRANCH_PHASES.has(state.phase)) {
    return ignore("no feature branch in progress");
  }
  const mergedPr = await params.gh.findMergedPullRequestByHead(featureBranch, "dev");
  if (mergedPr) {
    return ignore(`feature PR #${mergedPr.number} is already merged into dev`);
  }

  const [comparison, featurePr, taskPrs] = await Promise.all([
    params.gh.compareCommits?.("dev", featureBranch),
    params.gh.findOpenPullRequestByHead(featureBranch, "dev"),
    params.gh.listOpenPullRequestsByBase(featureBranch)
  ]);
  const openPrs = [...(featurePr ? [featurePr] : []), ...taskPrs];

  const updated = await updateIssueStateWithCas({
    issueNumber: params.issueNumber,
    store: params.store,
    mutator: (prev) => toTerminalState(prev, { status: "cancelled" })
  });
  const body = appendEpureCommandsSpoiler(
    [
      updated.issue_mirror_markdown,
      "",
      `### 🛑 Issue de pilotage #${params.issueNumber} fermée par \`@${params.actor}\` avant l'intégration dans \`dev\``,
      "",
      `- **Branche de fonctionnalité** : \`${featureBranch}\` — ${comparison?.aheadBy ?? 0} commit(s) non intégré(s) dans \`dev\``,
      "- **Statut d'orchestration** : `cancelled` (Plan annulé) ; aucune branche n'a été supprimée.",
      openPrs.length > 0
        ? `- **Pull Requests ouvertes, laissées ouvertes** : ${openPrs.map((pr) => `[#${pr.number}](${pr.html_url})`).join(", ")}`
        : "- **Pull Requests ouvertes** : aucune",
      `- **Reprise** : rouvrez l'issue #${params.issueNumber}, puis postez \`/epure continue\`.`
    ].join("\n"),
    {
      phase: "cancelled",
      status: "cancelled",
      issueNumber: params.issueNumber
    }
  );
  await params.gh.postIssueComment(params.issueNumber, body);
  return {
    executed: true,
    phase: updated.state.phase,
    status: updated.state.status,
    active_branch: featureBranch,
    summary_markdown: body,
    created_ticket_numbers: [],
    feature_pr_url: featurePr?.html_url ?? ""
  };
}
