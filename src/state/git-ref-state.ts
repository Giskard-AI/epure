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

export interface GitApiRefStateStoreOptions {
  readonly repository: string;
  readonly githubToken: string;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export function createGitHubApiRefStateStore(
  options: GitApiRefStateStoreOptions
): GitRefStateStore {
  const [owner, repo] = options.repository.trim().split("/");
  const baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const fetchFn = options.fetchImpl ?? fetch;

  const headers = {
    Authorization: `Bearer ${options.githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  return {
    readRef: async (refName: string): Promise<GitRefSnapshot> => {
      const normalizedRef = refName.replace(/^refs\//, "");
      const refResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/ref/${normalizedRef}`,
        { method: "GET", headers }
      );
      if (refResp.status === 404) {
        return { sha: null, state: null };
      }
      if (!refResp.ok) {
        throw new Error(
          `Failed to read Git ref '${refName}' (HTTP ${refResp.status}).`
        );
      }
      const refData = (await refResp.json()) as {
        object?: { sha?: string };
      };
      const blobSha = refData.object?.sha;
      if (!blobSha) {
        return { sha: null, state: null };
      }

      const blobResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
        { method: "GET", headers }
      );
      if (!blobResp.ok) {
        return { sha: null, state: null };
      }
      const blobData = (await blobResp.json()) as {
        content?: string;
        encoding?: string;
      };
      const rawJson = Buffer.from(
        blobData.content ?? "",
        blobData.encoding === "base64" ? "base64" : "utf8"
      ).toString("utf8");
      const parsed = JSON.parse(rawJson) as EpureIssueState;
      return { sha: blobSha, state: parsed };
    },

    compareAndSwapRef: async (
      refName: string,
      expectedOldSha: string | null,
      nextState: EpureIssueState
    ): Promise<{ readonly swapped: boolean; readonly newSha: string }> => {
      const normalizedRef = refName.replace(/^refs\//, "");

      // Verify current ref SHA matches expectedOldSha
      const checkResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/ref/${normalizedRef}`,
        { method: "GET", headers }
      );
      if (expectedOldSha === null) {
        if (checkResp.status !== 404) {
          return { swapped: false, newSha: "" };
        }
      } else {
        if (!checkResp.ok) {
          return { swapped: false, newSha: "" };
        }
        const currentRef = (await checkResp.json()) as {
          object?: { sha?: string };
        };
        if (currentRef.object?.sha !== expectedOldSha) {
          return { swapped: false, newSha: "" };
        }
      }

      // Create blob for nextState
      const createBlobResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/blobs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: JSON.stringify(nextState, null, 2),
            encoding: "utf-8"
          })
        }
      );
      if (!createBlobResp.ok) {
        return { swapped: false, newSha: "" };
      }
      const blobCreated = (await createBlobResp.json()) as { sha?: string };
      const newSha = blobCreated.sha ?? "";
      if (!newSha) {
        return { swapped: false, newSha: "" };
      }

      if (expectedOldSha === null) {
        const createRefResp = await fetchFn(
          `${baseUrl}/repos/${owner}/${repo}/git/refs`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ref: refName.startsWith("refs/") ? refName : `refs/${refName}`,
              sha: newSha
            })
          }
        );
        return { swapped: createRefResp.ok, newSha: createRefResp.ok ? newSha : "" };
      }

      const updateRefResp = await fetchFn(
        `${baseUrl}/repos/${owner}/${repo}/git/refs/${normalizedRef}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            sha: newSha,
            force: true
          })
        }
      );
      return { swapped: updateRefResp.ok, newSha: updateRefResp.ok ? newSha : "" };
    },

    listIssueStates: async (): Promise<readonly EpureIssueState[]> => {
      try {
        const listResp = await fetchFn(
          `${baseUrl}/repos/${owner}/${repo}/git/matching-refs/epure/state/`,
          { method: "GET", headers }
        );
        if (!listResp.ok) {
          return [];
        }
        const entries = (await listResp.json()) as Array<{
          ref?: string;
          object?: { sha?: string };
        }>;
        if (!Array.isArray(entries)) {
          return [];
        }
        const states: EpureIssueState[] = [];
        for (const entry of entries) {
          const blobSha = entry.object?.sha;
          if (!blobSha) {
            continue;
          }
          const blobResp = await fetchFn(
            `${baseUrl}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
            { method: "GET", headers }
          );
          if (!blobResp.ok) {
            continue;
          }
          const blobData = (await blobResp.json()) as {
            content?: string;
            encoding?: string;
          };
          const rawJson = Buffer.from(
            blobData.content ?? "",
            blobData.encoding === "base64" ? "base64" : "utf8"
          ).toString("utf8");
          states.push(JSON.parse(rawJson) as EpureIssueState);
        }
        return states;
      } catch {
        return [];
      }
    }
  };
}

