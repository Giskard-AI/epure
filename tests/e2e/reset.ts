import { execFileSync } from "node:child_process";
import { assertE2eSandboxRepository } from "./config.js";
import { GitHubGraphQLError, type GitHubApi } from "./github.js";

export const SEED_PATH = "tests/e2e/seed";

export interface SandboxSnapshot {
  readonly refs: readonly string[];
  readonly rulesets: ReadonlyArray<{ readonly id: number; readonly name: string; readonly source_type: string }>;
  readonly openPullRequests: readonly number[];
  readonly issues: ReadonlyArray<{ readonly number: number; readonly node_id: string }>;
  readonly activeRunIds: readonly number[];
}

export interface SandboxResetPlan {
  readonly cancelRunIds: readonly number[];
  readonly deleteRulesetIds: readonly number[];
  readonly closePullRequests: readonly number[];
  readonly deleteIssues: SandboxSnapshot["issues"];
  readonly deleteRefs: readonly string[];
}

const KEPT_REFS = new Set(["refs/heads/main", "refs/heads/dev"]);

// main and dev are force-moved to the seed instead of deleted; org rulesets and other repository rulesets stay.
export function planSandboxReset(snapshot: SandboxSnapshot): SandboxResetPlan {
  return {
    cancelRunIds: [...snapshot.activeRunIds],
    deleteRulesetIds: snapshot.rulesets
      .filter((r) => r.source_type === "Repository" && r.name.startsWith("epure-"))
      .map((r) => r.id),
    closePullRequests: [...snapshot.openPullRequests],
    deleteIssues: [...snapshot.issues],
    deleteRefs: snapshot.refs.filter((ref) => /^refs\/(heads|tags|epure)\//.test(ref) && !KEPT_REFS.has(ref))
  };
}

// `refs/heads/feature/a#1` -> `refs/heads/feature/a%231`: slashes stay path separators.
export function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

export interface RepositoryInfo {
  readonly full_name: string;
  readonly private: boolean;
  readonly permissions?: { readonly admin?: boolean | undefined } | undefined;
}

// Everything the reset and the run need, checked before the first destructive call.
export function destructiveTargetProblems(
  configured: string,
  repo: RepositoryInfo,
  oauthScopes: readonly string[] | null
): string[] {
  const problems: string[] = [];
  if (repo.full_name !== configured) {
    problems.push(`${configured} resolves to ${repo.full_name}`);
  }
  if (repo.full_name.toLowerCase() === "giskard-ai/epure-live-sandbox") {
    problems.push(`${repo.full_name} belongs to the live GitHub harness`);
  }
  if (!repo.private) {
    problems.push(`${repo.full_name} is public`);
  }
  if (!repo.permissions?.admin) {
    problems.push("the token's user is not an admin of the repository (rulesets, issue deletion)");
  }
  for (const scope of ["repo", "workflow"]) {
    if (oauthScopes && !oauthScopes.includes(scope)) {
      problems.push(`the classic token lacks the "${scope}" scope: run \`gh auth refresh -h github.com -s ${scope}\``);
    }
  }
  return problems;
}

export async function verifyDestructiveTarget(gh: GitHubApi): Promise<void> {
  assertE2eSandboxRepository(gh.repository);
  const repo = await gh.call<RepositoryInfo>("GET", `/repos/${gh.repository}`);
  const problems = destructiveTargetProblems(gh.repository, repo, await gh.oauthScopes());
  if (problems.length) {
    throw new Error(`refusing to touch ${gh.repository}: ${problems.join("; ")}`);
  }
}

export interface GitTreeEntry {
  readonly mode: string;
  readonly sha: string;
  readonly path: string;
}

// Parses `git ls-tree -r -z` output; submodules and other non-blob entries are refused.
export function parseLsTree(output: string): GitTreeEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(record);
      if (!match || match[2] !== "blob") {
        throw new Error(`unsupported git tree entry: ${record}`);
      }
      return { mode: match[1]!, sha: match[3]!, path: match[4]! };
    });
}

export interface TreeFile {
  readonly path: string;
  readonly mode: string;
  readonly content: Buffer;
}

export interface GitSeed {
  readonly treeSha: string;
  readonly files: readonly TreeFile[];
}

const git = (args: readonly string[]) => execFileSync("git", args, { encoding: "utf8" });

// The committed seed tree: untracked files such as node_modules never reach the sandbox.
export function readSeedFromGit(): GitSeed {
  const dirty = git(["status", "--porcelain", "--untracked-files=all", "--", SEED_PATH]).trim();
  if (dirty) {
    throw new Error(`uncommitted changes under ${SEED_PATH}: commit them first\n${dirty}`);
  }
  const files = parseLsTree(git(["ls-tree", "-r", "-z", `HEAD:${SEED_PATH}`])).map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    content: execFileSync("git", ["cat-file", "blob", entry.sha])
  }));
  return { treeSha: git(["rev-parse", `HEAD:${SEED_PATH}`]).trim(), files };
}

export async function commitTree(
  gh: GitHubApi,
  files: readonly TreeFile[],
  message: string,
  parents: readonly string[],
  baseTree?: string
): Promise<{ readonly commitSha: string; readonly treeSha: string }> {
  const R = `/repos/${gh.repository}`;
  const tree = [];
  for (const file of files) {
    const blob = await gh.call<{ sha: string }>("POST", `${R}/git/blobs`, { content: file.content.toString("base64"), encoding: "base64" });
    tree.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
  }
  const created = await gh.call<{ sha: string }>("POST", `${R}/git/trees`, { tree, ...(baseTree ? { base_tree: baseTree } : {}) });
  const commit = await gh.call<{ sha: string }>("POST", `${R}/git/commits`, { message, tree: created.sha, parents });
  return { commitSha: commit.sha, treeSha: created.sha };
}

// A replayed request finds its work done: the ref already created (422), the target already deleted (404).
export async function forceBranches(gh: GitHubApi, branches: readonly string[], sha: string): Promise<void> {
  const R = `/repos/${gh.repository}`;
  for (const branch of branches) {
    const exists = (await gh.status("GET", `${R}/git/ref/heads/${branch}`)) === 200;
    const created = !exists && (await gh.status("POST", `${R}/git/refs`, { ref: `refs/heads/${branch}`, sha })) === 201;
    if (!created) {
      await gh.call("PATCH", `${R}/git/refs/heads/${branch}`, { sha, force: true });
    }
  }
}

export async function deleteIssue(gh: GitHubApi, nodeId: string): Promise<void> {
  try {
    await gh.graphql("mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }", { id: nodeId });
  } catch (err) {
    if (!(err instanceof GitHubGraphQLError && err.errors.every((e) => e.type === "NOT_FOUND"))) {
      throw err;
    }
  }
}

const ACTIVE_RUN_STATUSES = ["queued", "in_progress", "waiting", "requested", "pending"] as const;

export async function listActiveRunIds(gh: GitHubApi): Promise<number[]> {
  const ids: number[] = [];
  for (const status of ACTIVE_RUN_STATUSES) {
    const runs = await gh.paginate<{ id: number }>(
      `/repos/${gh.repository}/actions/runs?status=${status}`,
      (page) => (page as { workflow_runs: Array<{ id: number }> }).workflow_runs
    );
    ids.push(...runs.map((r) => r.id));
  }
  return ids;
}

async function takeSnapshot(gh: GitHubApi): Promise<SandboxSnapshot> {
  const R = `/repos/${gh.repository}`;
  const refs = await gh.call<Array<{ ref: string }>>("GET", `${R}/git/matching-refs/`);
  const rulesets = await gh.call<SandboxSnapshot["rulesets"]>("GET", `${R}/rulesets?includes_parents=true`);
  const pulls = await gh.paginate<{ number: number }>(`${R}/pulls?state=open`);
  const issues = await gh.paginate<{ number: number; node_id: string; pull_request?: unknown }>(`${R}/issues?state=all`);
  return {
    refs: refs.map((r) => r.ref),
    rulesets,
    openPullRequests: pulls.map((p) => p.number),
    issues: issues.filter((i) => i.pull_request === undefined).map(({ number, node_id }) => ({ number, node_id })),
    activeRunIds: await listActiveRunIds(gh)
  };
}

async function waitForNoActiveRuns(gh: GitHubApi, timeoutMs: number): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const active = await listActiveRunIds(gh);
    if (active.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`workflow runs still active after cancellation: ${active.join(", ")}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

export interface SandboxResetResult {
  readonly seedCommitSha: string;
  readonly seedTreeSha: string;
  readonly plan: SandboxResetPlan;
}

export async function resetSandbox(gh: GitHubApi, log: (line: string) => void): Promise<SandboxResetResult> {
  const seed = readSeedFromGit();
  await verifyDestructiveTarget(gh);
  const R = `/repos/${gh.repository}`;
  const plan = planSandboxReset(await takeSnapshot(gh));
  log(
    `[reset] runs=${plan.cancelRunIds.length} rulesets=${plan.deleteRulesetIds.length} prs=${plan.closePullRequests.length} issues=${plan.deleteIssues.length} refs=${plan.deleteRefs.length}`
  );

  for (const id of plan.cancelRunIds) {
    await gh.call("POST", `${R}/actions/runs/${id}/cancel`, undefined, [202, 409]);
  }
  await waitForNoActiveRuns(gh, 180_000);
  for (const id of plan.deleteRulesetIds) {
    await gh.call("DELETE", `${R}/rulesets/${id}`, undefined, [204, 404]);
  }
  const { commitSha, treeSha } = await commitTree(gh, seed.files, "chore: seed the EPURE e2e sandbox", []);
  if (treeSha !== seed.treeSha) {
    throw new Error(`the uploaded seed tree ${treeSha} differs from git's ${SEED_PATH} tree ${seed.treeSha}`);
  }
  // Moving main first removes the EPURE workflows, so the closures and deletions below trigger no orchestration.
  await forceBranches(gh, ["main", "dev"], commitSha);
  for (const number of plan.closePullRequests) {
    await gh.call("PATCH", `${R}/pulls/${number}`, { state: "closed" });
  }
  for (const issue of plan.deleteIssues) {
    await deleteIssue(gh, issue.node_id);
  }
  for (const ref of plan.deleteRefs) {
    await gh.call("DELETE", `${R}/git/${encodeRefPath(ref)}`, undefined, [204, 404]);
  }
  log(`[reset] main and dev at seed ${commitSha} (tree ${treeSha})`);
  return { seedCommitSha: commitSha, seedTreeSha: treeSha, plan };
}
