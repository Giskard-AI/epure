import { createHash } from "node:crypto";

export type IssueOrchestrationPhase =
  | "idle"
  | "grilling"
  | "spec"
  | "tickets"
  | "implementation"
  | "review"
  | "completed";

export type IssueOrchestrationStatus =
  | "active"
  | "awaiting_human_approval"
  | "cancelled"
  | "suspended"
  | "done";

export type EpureIssueSubphase =
  | "idle"
  | "implementing_ticket"
  | "waiting_ticket_ci"
  | "remediating_ticket"
  | "auditing_epic_convergence"
  | "waiting_feature_ci"
  | "remediating_feature";

export interface EpureIssueState {
  readonly issue_number: number;
  readonly version: number;
  readonly phase: IssueOrchestrationPhase;
  readonly status: IssueOrchestrationStatus;
  readonly active_branch: string;
  readonly last_processed_comment_id: number;
  readonly code_fix_attempts_used: number;
  readonly transient_retries_used: number;
  readonly updated_at: string;
  readonly subphase?: EpureIssueSubphase | undefined;
  readonly active_ticket_number?: number | undefined;
  readonly active_task_branch?: string | undefined;
  readonly active_pr_number?: number | undefined;
  readonly active_head_sha?: string | undefined;
  readonly epic_phase?: number | undefined;
  readonly code_fix_attempts_by_ticket?:
    | Readonly<Record<string, number>>
    | undefined;
  readonly feature_code_fix_attempts_used?: number | undefined;
  readonly human_budget_grants?: number | undefined;
  readonly last_escalation?: EpureEscalationRecord | undefined;
  readonly last_synced_base_sha?: string | undefined;
  // Head of `plan/*` whose artifacts are already on `feature/*`; integration runs again only when `plan/*` moves.
  readonly integrated_plan_sha?: string | undefined;
  // Written once when the branch is created: a renamed epic keeps them, `active_branch` is display only.
  readonly plan_branch?: string | undefined;
  readonly feature_branch?: string | undefined;
  readonly cancelled_from?: CancelledFrom | undefined;
  readonly human_budget_grant_log?: readonly HumanBudgetGrant[] | undefined;
}

export interface CancelledFrom {
  readonly phase: IssueOrchestrationPhase;
  readonly status: Exclude<IssueOrchestrationStatus, "cancelled">;
}

export interface HumanBudgetGrant {
  readonly actor: string;
  readonly comment_id: number;
  readonly scope: EpureEscalationRecord["budget_scope"];
  readonly ticket: number;
}

export interface EpureEscalationRecord {
  readonly reason: string;
  readonly head_sha: string;
  readonly ticket_number: number;
  readonly budget_scope: "ticket" | "feature";
}

export type TerminalIssueStatus = Extract<
  IssueOrchestrationStatus,
  "suspended" | "done" | "cancelled"
>;

export type TerminalStateUpdate = Omit<
  Partial<EpureIssueState>,
  | "status"
  | "subphase"
  | "active_head_sha"
  | "active_pr_number"
  | "active_task_branch"
  | "active_ticket_number"
> & { readonly status: TerminalIssueStatus };

export function toTerminalState(
  prev: EpureIssueState,
  update: TerminalStateUpdate
): EpureIssueState {
  return {
    ...prev,
    ...update,
    ...(update.status === "cancelled" && prev.status !== "cancelled"
      ? { cancelled_from: { phase: prev.phase, status: prev.status } }
      : {}),
    subphase: "idle",
    active_head_sha: undefined,
    active_pr_number: undefined,
    active_task_branch: undefined,
    active_ticket_number: undefined
  };
}

/** The comment cursor only moves forward: a command older than the cursor never rewinds it. */
export function advanceCommentCursor(
  prev: EpureIssueState,
  commentId: number | undefined
): number {
  return Math.max(commentId ?? 0, prev.last_processed_comment_id);
}

export function isWaitingSubphase(
  subphase: EpureIssueSubphase | undefined
): boolean {
  return subphase === "waiting_ticket_ci" || subphase === "waiting_feature_ci";
}

export function isAutomaticallyResumable(state: EpureIssueState): boolean {
  return state.status === "active" && isWaitingSubphase(state.subphase);
}

function isFeatureSubphase(subphase: EpureIssueSubphase | undefined): boolean {
  return subphase === "waiting_feature_ci" || subphase === "remediating_feature";
}

// States written before per-ticket budgets kept a single counter for the active element.
export function readTicketCodeFixAttempts(
  state: EpureIssueState,
  ticketNumber: number
): number {
  if (state.code_fix_attempts_by_ticket !== undefined) {
    return state.code_fix_attempts_by_ticket[String(ticketNumber)] ?? 0;
  }
  return state.active_ticket_number === ticketNumber &&
    !isFeatureSubphase(state.subphase)
    ? state.code_fix_attempts_used
    : 0;
}

export function readFeatureCodeFixAttempts(state: EpureIssueState): number {
  return (
    state.feature_code_fix_attempts_used ??
    (isFeatureSubphase(state.subphase) ? state.code_fix_attempts_used : 0)
  );
}

export function activeBudgetScope(
  state: EpureIssueState
): EpureEscalationRecord["budget_scope"] {
  return isFeatureSubphase(state.subphase) ? "feature" : "ticket";
}

export function readActiveCodeFixAttempts(state: EpureIssueState): number {
  return activeBudgetScope(state) === "feature"
    ? readFeatureCodeFixAttempts(state)
    : readTicketCodeFixAttempts(
        state,
        state.active_ticket_number ?? state.issue_number
      );
}

export function readCodeFixAttemptsByTicket(
  state: EpureIssueState
): Readonly<Record<string, number>> {
  if (state.code_fix_attempts_by_ticket !== undefined) {
    return state.code_fix_attempts_by_ticket;
  }
  return state.active_ticket_number !== undefined &&
    !isFeatureSubphase(state.subphase)
    ? { [String(state.active_ticket_number)]: state.code_fix_attempts_used }
    : {};
}

export function withTicketCodeFixAttempts(
  prev: EpureIssueState,
  ticketNumber: number,
  attempts: number
): EpureIssueState {
  return {
    ...prev,
    code_fix_attempts_used: attempts,
    code_fix_attempts_by_ticket: {
      ...readCodeFixAttemptsByTicket(prev),
      [String(ticketNumber)]: attempts
    }
  };
}

export function withFeatureCodeFixAttempts(
  prev: EpureIssueState,
  attempts: number
): EpureIssueState {
  return {
    ...prev,
    code_fix_attempts_used: attempts,
    feature_code_fix_attempts_used: attempts
  };
}

/** Every human resume clears the escalation so a repeated one is reported again; an exhausted budget is refilled once. */
export function resumeAfterEscalation(
  prev: EpureIssueState,
  resumedBy: { readonly actor: string; readonly commentId: number }
): EpureIssueState {
  const escalation = prev.last_escalation;
  if (!escalation || escalation.reason !== "remediation_exhausted") {
    return { ...prev, last_escalation: undefined };
  }
  const granted =
    escalation.budget_scope === "feature"
      ? withFeatureCodeFixAttempts(prev, 0)
      : withTicketCodeFixAttempts(prev, escalation.ticket_number, 0);
  return {
    ...granted,
    human_budget_grants: (prev.human_budget_grants ?? 0) + 1,
    human_budget_grant_log: [
      ...(prev.human_budget_grant_log ?? []),
      {
        actor: resumedBy.actor,
        comment_id: resumedBy.commentId,
        scope: escalation.budget_scope,
        ticket: escalation.ticket_number
      }
    ],
    last_escalation: undefined
  };
}

export interface GitRefSnapshot {
  readonly sha: string | null;
  readonly state: EpureIssueState | null;
}

export interface GitRefStateStore {
  readRef(refName: string): Promise<GitRefSnapshot>;
  compareAndSwapRef(
    refName: string,
    expectedOldSha: string | null,
    nextState: EpureIssueState
  ): Promise<{ readonly swapped: boolean; readonly newSha: string }>;
  listIssueStates?(): Promise<readonly EpureIssueState[]>;
}

export interface UpdateIssueStateWithCasInput {
  readonly issueNumber: number;
  readonly store: GitRefStateStore;
  readonly mutator: (prevState: EpureIssueState) => EpureIssueState;
  readonly maxCasRetries?: number | undefined;
}

export interface UpdateIssueStateWithCasResult {
  readonly committed: boolean;
  readonly ref_name: string;
  readonly commit_sha: string;
  readonly state: EpureIssueState;
  readonly cas_conflicts_recovered: number;
  readonly concurrency_group: string;
  readonly issue_mirror_markdown: string;
}

export function buildIssueStateRefName(issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issueNumber '${issueNumber}' for Git state ref.`);
  }
  return `refs/epure/state/${issueNumber}`;
}

export function createInitialIssueState(issueNumber: number): EpureIssueState {
  return {
    issue_number: issueNumber,
    version: 0,
    phase: "idle",
    status: "active",
    active_branch: "",
    last_processed_comment_id: 0,
    code_fix_attempts_used: 0,
    transient_retries_used: 0,
    updated_at: new Date().toISOString()
  };
}

export function formatIssueStateMirrorMarkdown(state: EpureIssueState): string {
  const refName = buildIssueStateRefName(state.issue_number);
  return [
    `<!-- epure-state-mirror:issue-${state.issue_number}:v${state.version} -->`,
    `### EPURE Orchestration State (\`${refName}\`)`,
    `- **Phase**: \`${state.phase}\``,
    `- **Status**: \`${state.status}\``,
    `- **Active Branch**: \`${state.active_branch || "none"}\``,
    `- **Version**: \`${state.version}\``,
    `- **Cursor**: \`last_processed_comment_id: ${state.last_processed_comment_id}\``,
    `- **Retries**: \`code_fix_attempts_used: ${state.code_fix_attempts_used}\`, \`transient_retries_used: ${state.transient_retries_used}\``
  ].join("\n");
}

function computeDeterministicSha(state: EpureIssueState): string {
  return createHash("sha1")
    .update(JSON.stringify(state), "utf8")
    .digest("hex");
}

export function createInMemoryGitRefStateStore(options?: {
  readonly simulateConflictOnFirstWrite?: boolean | undefined;
}): GitRefStateStore {
  const refs = new Map<string, { sha: string; state: EpureIssueState }>();
  let remainingSimulatedConflicts = options?.simulateConflictOnFirstWrite ? 1 : 0;

  return {
    readRef: async (refName: string): Promise<GitRefSnapshot> => {
      const current = refs.get(refName);
      if (!current) {
        return { sha: null, state: null };
      }
      return { sha: current.sha, state: current.state };
    },
    compareAndSwapRef: async (
      refName: string,
      expectedOldSha: string | null,
      nextState: EpureIssueState
    ) => {
      if (remainingSimulatedConflicts > 0) {
        remainingSimulatedConflicts -= 1;
        return { swapped: false, newSha: "" };
      }

      const current = refs.get(refName);
      const actualOldSha = current ? current.sha : null;
      if (actualOldSha !== expectedOldSha) {
        return { swapped: false, newSha: "" };
      }

      const newSha = computeDeterministicSha(nextState);
      refs.set(refName, { sha: newSha, state: nextState });
      return { swapped: true, newSha };
    },
    listIssueStates: async (): Promise<readonly EpureIssueState[]> => {
      return [...refs.values()].map((entry) => entry.state);
    }
  };
}

export async function updateIssueStateWithCas(
  input: UpdateIssueStateWithCasInput
): Promise<UpdateIssueStateWithCasResult> {
  const refName = buildIssueStateRefName(input.issueNumber);
  const maxRetries = input.maxCasRetries ?? 5;
  let conflictsRecovered = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const snapshot = await input.store.readRef(refName);
    const baseState =
      snapshot.state ?? createInitialIssueState(input.issueNumber);
    const mutated = input.mutator(baseState);
    const nextState: EpureIssueState = {
      ...mutated,
      issue_number: input.issueNumber,
      version: baseState.version + 1,
      updated_at: new Date().toISOString()
    };

    const casResult = await input.store.compareAndSwapRef(
      refName,
      snapshot.sha,
      nextState
    );

    if (casResult.swapped) {
      return {
        committed: true,
        ref_name: refName,
        commit_sha: casResult.newSha,
        state: nextState,
        cas_conflicts_recovered: conflictsRecovered,
        concurrency_group: `epure-issue-${input.issueNumber}`,
        issue_mirror_markdown: formatIssueStateMirrorMarkdown(nextState)
      };
    }

    conflictsRecovered += 1;
  }

  throw new Error(
    `CAS conflict retry budget exhausted (${maxRetries}) on '${refName}'.`
  );
}

/** A concurrent run, command or closure changed the plan: this run stops without writing. */
export class StateTransitionAbortedError extends Error {
  override readonly name = "StateTransitionAbortedError";

  constructor(
    readonly state: EpureIssueState,
    readonly reason: string
  ) {
    super(
      `Issue #${state.issue_number} state transition aborted (${state.status}/${state.phase}): ${reason}.`
    );
  }
}

const TERMINAL_STATUSES: ReadonlySet<IssueOrchestrationStatus> = new Set([
  "cancelled",
  "done"
]);

/**
 * Writes over a `cancelled` or `done` state throw StateTransitionAbortedError, except over the
 * snapshot `allowedTerminalSha` that an explicit human command started from.
 */
export function guardTerminalStates(
  store: GitRefStateStore,
  allowedTerminalSha: string | null
): GitRefStateStore {
  const statesBySha = new Map<string, EpureIssueState>();
  return {
    readRef: async (refName) => {
      const snapshot = await store.readRef(refName);
      if (snapshot.sha !== null && snapshot.state !== null) {
        statesBySha.set(snapshot.sha, snapshot.state);
      }
      return snapshot;
    },
    compareAndSwapRef: async (refName, expectedOldSha, nextState) => {
      const prev =
        expectedOldSha === null ? undefined : statesBySha.get(expectedOldSha);
      if (
        prev !== undefined &&
        TERMINAL_STATUSES.has(prev.status) &&
        expectedOldSha !== allowedTerminalSha
      ) {
        throw new StateTransitionAbortedError(
          prev,
          `the plan became \`${prev.status}\` while this run was working`
        );
      }
      const result = await store.compareAndSwapRef(
        refName,
        expectedOldSha,
        nextState
      );
      if (result.swapped) {
        statesBySha.set(result.newSha, nextState);
      }
      return result;
    },
    ...(store.listIssueStates
      ? { listIssueStates: store.listIssueStates.bind(store) }
      : {})
  };
}

export interface GitApiRefStateStoreOptions {
  readonly repository: string;
  readonly githubToken: string;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

// State is the message of an empty-tree commit chained on the previous state commit. REST
// `PATCH git/refs` has no precondition outside refs/heads/*, so updates go through GraphQL
// `updateRefs`, which rejects them when the ref no longer points at `beforeOid`. `updateRefs`
// cannot move a ref that points at a blob: legacy JSON-blob refs migrate with a checked PATCH.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const UPDATE_REFS_MUTATION =
  "mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: {repositoryId: $repositoryId, refUpdates: $refUpdates}) { clientMutationId } }";

interface GitRefObject {
  readonly sha: string;
  readonly type: string;
}

export function createGitHubApiRefStateStore(
  options: GitApiRefStateStoreOptions
): Required<GitRefStateStore> {
  const [owner, repo] = options.repository.trim().split("/");
  const baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const repoUrl = `${baseUrl}/repos/${owner}/${repo}`;
  const fetchFn = options.fetchImpl ?? fetch;

  const headers = {
    Authorization: `Bearer ${options.githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  let repositoryNodeId: string | undefined;
  const fetchRepositoryNodeId = async (): Promise<string> => {
    const repoResp = await fetchFn(repoUrl, { method: "GET", headers });
    if (!repoResp.ok) {
      throw new Error(
        `Failed to read repository '${owner}/${repo}' (HTTP ${repoResp.status}).`
      );
    }
    return ((await repoResp.json()) as { node_id: string }).node_id;
  };

  const getRefObject = async (refName: string): Promise<GitRefObject | null> => {
    const refResp = await fetchFn(
      `${repoUrl}/git/ref/${refName.replace(/^refs\//, "")}`,
      { method: "GET", headers }
    );
    if (refResp.status === 404) {
      return null;
    }
    if (!refResp.ok) {
      throw new Error(
        `Failed to read Git ref '${refName}' (HTTP ${refResp.status}).`
      );
    }
    const refData = (await refResp.json()) as {
      object?: { sha?: string; type?: string };
    };
    const sha = refData.object?.sha;
    return sha ? { sha, type: refData.object?.type ?? "commit" } : null;
  };

  const readStateObject = async (
    object: GitRefObject
  ): Promise<EpureIssueState | null> => {
    const kind = object.type === "commit" ? "commits" : "blobs";
    const resp = await fetchFn(`${repoUrl}/git/${kind}/${object.sha}`, {
      method: "GET",
      headers
    });
    if (resp.status === 404) {
      return null;
    }
    if (!resp.ok) {
      throw new Error(
        `Failed to read state object '${object.sha}' (HTTP ${resp.status}).`
      );
    }
    if (object.type === "commit") {
      const commit = (await resp.json()) as { message?: string };
      return JSON.parse(commit.message ?? "") as EpureIssueState;
    }
    const blobData = (await resp.json()) as {
      content?: string;
      encoding?: string;
    };
    const rawJson = Buffer.from(
      blobData.content ?? "",
      blobData.encoding === "base64" ? "base64" : "utf8"
    ).toString("utf8");
    return JSON.parse(rawJson) as EpureIssueState;
  };

  // A rejected write landed when the ref is now at `newSha`, is a CAS conflict when the ref moved
  // elsewhere, and an error otherwise.
  const rejectedWriteLanded = async (
    refName: string,
    current: GitRefObject | null,
    newSha: string,
    resp: Response
  ): Promise<boolean> => {
    const now = await getRefObject(refName);
    if (now?.sha === newSha) {
      return true;
    }
    if ((now?.sha ?? null) !== (current?.sha ?? null)) {
      return false;
    }
    throw new Error(
      `Failed to update Git ref '${refName}' (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`
    );
  };

  const writeRef = async (
    refName: string,
    current: GitRefObject | null,
    newSha: string
  ): Promise<boolean> => {
    if (current === null) {
      // POST git/refs fails with 422 when the ref already exists.
      const createRefResp = await fetchFn(`${repoUrl}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ref: refName, sha: newSha })
      });
      return (
        createRefResp.ok ||
        (await rejectedWriteLanded(refName, current, newSha, createRefResp))
      );
    }
    if (current.type !== "commit") {
      const migrateResp = await fetchFn(`${repoUrl}/git/${refName}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sha: newSha })
      });
      return (
        migrateResp.ok ||
        (await rejectedWriteLanded(refName, current, newSha, migrateResp))
      );
    }
    repositoryNodeId ??= await fetchRepositoryNodeId();
    const updateRefsResp = await fetchFn(`${baseUrl}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: UPDATE_REFS_MUTATION,
        variables: {
          repositoryId: repositoryNodeId,
          refUpdates: [
            { name: refName, beforeOid: current.sha, afterOid: newSha }
          ]
        }
      })
    });
    // GitHub answers a stale `beforeOid` with HTTP 200 and an opaque error, like any other failure.
    if (updateRefsResp.ok) {
      const payload = (await updateRefsResp.clone().json()) as {
        data?: { updateRefs?: unknown };
      };
      if (payload.data?.updateRefs) {
        return true;
      }
    }
    return await rejectedWriteLanded(refName, current, newSha, updateRefsResp);
  };

  return {
    readRef: async (refName: string): Promise<GitRefSnapshot> => {
      const object = await getRefObject(refName);
      if (!object) {
        return { sha: null, state: null };
      }
      const state = await readStateObject(object);
      return state ? { sha: object.sha, state } : { sha: null, state: null };
    },

    compareAndSwapRef: async (
      refName: string,
      expectedOldSha: string | null,
      nextState: EpureIssueState
    ): Promise<{ readonly swapped: boolean; readonly newSha: string }> => {
      const notSwapped = { swapped: false, newSha: "" } as const;
      const fullRefName = refName.startsWith("refs/") ? refName : `refs/${refName}`;
      const current = await getRefObject(fullRefName);
      if ((current?.sha ?? null) !== expectedOldSha) {
        return notSwapped;
      }

      const createCommitResp = await fetchFn(`${repoUrl}/git/commits`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: JSON.stringify(nextState),
          tree: EMPTY_TREE_SHA,
          parents: current?.type === "commit" ? [current.sha] : []
        })
      });
      const newSha = createCommitResp.ok
        ? ((await createCommitResp.json()) as { sha?: string }).sha
        : undefined;
      if (!newSha) {
        throw new Error(
          `Failed to create the state commit for '${fullRefName}' (HTTP ${createCommitResp.status}).`
        );
      }

      return (await writeRef(fullRefName, current, newSha))
        ? { swapped: true, newSha }
        : notSwapped;
    },

    listIssueStates: async (): Promise<readonly EpureIssueState[]> => {
      const listResp = await fetchFn(
        `${repoUrl}/git/matching-refs/epure/state/`,
        { method: "GET", headers }
      );
      if (!listResp.ok) {
        throw new Error(
          `Failed to list EPURE state refs (HTTP ${listResp.status}).`
        );
      }
      const entries = (await listResp.json()) as Array<{
        ref?: string;
        object?: { sha?: string; type?: string };
      }>;
      const states: EpureIssueState[] = [];
      for (const entry of entries) {
        const sha = entry.object?.sha;
        if (!sha) {
          continue;
        }
        const state = await readStateObject({
          sha,
          type: entry.object?.type ?? "commit"
        });
        if (state) {
          states.push(state);
        }
      }
      return states;
    }
  };
}
