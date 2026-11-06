import {
  toTerminalState,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import { appendEpureCommandsSpoiler } from "../formatting/comments.js";
import type {
  CollaboratorPermission,
  GitHubRestHelper,
  OrchestrateIssueResult
} from "../types.js";

const FEATURE_BRANCH_PHASES: ReadonlySet<EpureIssueState["phase"]> = new Set([
  "implementation",
  "review",
  "completed"
]);
const PLANNING_PHASES: ReadonlySet<EpureIssueState["phase"]> = new Set([
  "grilling",
  "spec",
  "tickets"
]);
const CAN_CANCEL: ReadonlySet<CollaboratorPermission> = new Set([
  "write",
  "maintain",
  "admin"
]);

/** States written before `feature_branch` only name it in `active_branch` (a task branch while a ticket runs) or on GitHub. */
export async function findExistingFeatureBranch(
  gh: Pick<GitHubRestHelper, "listBranchesByPrefix">,
  state: EpureIssueState
): Promise<string | undefined> {
  if (state.feature_branch) {
    return state.feature_branch;
  }
  const prefix = `feature/${state.issue_number}-`;
  if (state.active_branch.startsWith(prefix)) {
    return state.active_branch;
  }
  return (await gh.listBranchesByPrefix(prefix))[0];
}

/**
 * A human closed the plan issue during planning, or before its feature branch reached `dev`:
 * a closer with `write` or higher cancels the plan, keeps every branch and open PR, and gets
 * told how to resume; anyone else leaves the plan untouched (Actions summary only).
 */
export async function handleEpicClosedByHuman(params: {
  readonly issueNumber: number;
  readonly actor: string;
  readonly currentState: EpureIssueState | null;
  readonly gh: GitHubRestHelper;
  readonly store: GitRefStateStore;
}): Promise<OrchestrateIssueResult> {
  const state = params.currentState;
  const ignore = (reason: string): OrchestrateIssueResult => ({
    executed: false,
    phase: state?.phase ?? "idle",
    status: state?.status ?? "active",
    active_branch: state?.active_branch ?? "",
    summary_markdown: `Epic closure ignored: ${reason}.`,
    created_ticket_numbers: [],
    feature_pr_url: ""
  });

  const planning = state !== null && PLANNING_PHASES.has(state.phase);
  if (
    !state ||
    state.status === "cancelled" ||
    (!planning && !FEATURE_BRANCH_PHASES.has(state.phase))
  ) {
    return ignore("no plan in progress");
  }
  // The event is delivered late: a reopened issue keeps its plan.
  if ((await params.gh.getIssue(params.issueNumber)).state === "open") {
    return ignore(`issue #${params.issueNumber} was reopened`);
  }
  const featureBranch = planning
    ? undefined
    : await findExistingFeatureBranch(params.gh, state);
  if (featureBranch) {
    const mergedPr = await params.gh.findMergedPullRequestByHead(featureBranch, "dev");
    if (mergedPr) {
      return ignore(`feature PR #${mergedPr.number} is already merged into dev`);
    }
  }

  // No issue comment: anyone able to close an issue could otherwise make EPURE post on demand.
  const permission = await params.gh.getCollaboratorPermission(params.actor);
  if (!CAN_CANCEL.has(permission)) {
    return ignore(
      `closer @${params.actor} has permission ${permission}; only write or higher cancels the plan, which stays ${state.status} in phase ${state.phase}`
    );
  }

  if (planning) {
    const updated = await updateIssueStateWithCas({
      issueNumber: params.issueNumber,
      store: params.store,
      mutator: (prev) => toTerminalState(prev, { status: "cancelled" })
    });
    const body = appendEpureCommandsSpoiler(
      [
        updated.issue_mirror_markdown,
        "",
        `### 🛑 Issue de pilotage #${params.issueNumber} fermée par \`@${params.actor}\` pendant la phase \`${state.phase}\``,
        "",
        "- **Statut d'orchestration** : `cancelled` (Plan annulé) ; aucune branche n'a été supprimée.",
        `- **Reprise** : rouvrez l'issue #${params.issueNumber}, puis postez \`/epure continue\`.`
      ].join("\n"),
      { phase: "cancelled", status: "cancelled", issueNumber: params.issueNumber }
    );
    await params.gh.postIssueComment(params.issueNumber, body);
    return {
      executed: true,
      phase: updated.state.phase,
      status: updated.state.status,
      active_branch: updated.state.active_branch,
      summary_markdown: body,
      created_ticket_numbers: [],
      feature_pr_url: ""
    };
  }

  const [comparison, featurePr, taskPrs] = featureBranch
    ? await Promise.all([
        params.gh.compareCommits("dev", featureBranch),
        params.gh.findOpenPullRequestByHead(featureBranch, "dev"),
        params.gh.listOpenPullRequestsByBase(featureBranch)
      ])
    : [null, null, []];
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
      featureBranch && comparison
        ? `- **Branche de fonctionnalité** : \`${featureBranch}\` — ${comparison.aheadBy} commit(s) non intégré(s) dans \`dev\``
        : `- **Branche de fonctionnalité** : aucune branche \`feature/${params.issueNumber}-*\` sur GitHub`,
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
    active_branch: featureBranch ?? updated.state.active_branch,
    summary_markdown: body,
    created_ticket_numbers: [],
    feature_pr_url: featurePr?.html_url ?? ""
  };
}
