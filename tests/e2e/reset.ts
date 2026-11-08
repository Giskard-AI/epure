import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertE2eSandboxRepository } from "./config.js";
import type { GitHubApi } from "./github.js";

export const SEED_DIR = fileURLToPath(new URL("./seed", import.meta.url));

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

export interface RepoFile {
  readonly path: string;
  readonly content: string;
}

export function readTreeFiles(root: string): RepoFile[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      return { path: relative(root, full).split(sep).join("/"), content: readFileSync(full, "utf8") };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function commitFiles(
  gh: GitHubApi,
  files: readonly RepoFile[],
  message: string,
  parents: readonly string[]
): Promise<string> {
  const R = `/repos/${gh.repository}`;
  const tree = [];
  for (const file of files) {
    const blob = await gh.call<{ sha: string }>("POST", `${R}/git/blobs`, { content: file.content, encoding: "utf-8" });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const created = await gh.call<{ sha: string }>("POST", `${R}/git/trees`, { tree });
  const commit = await gh.call<{ sha: string }>("POST", `${R}/git/commits`, { message, tree: created.sha, parents });
  return commit.sha;
}

export async function forceBranches(gh: GitHubApi, branches: readonly string[], sha: string): Promise<void> {
  const R = `/repos/${gh.repository}`;
  for (const branch of branches) {
    const exists = (await gh.status("GET", `${R}/git/ref/heads/${branch}`)) === 200;
    if (exists) {
      await gh.call("PATCH", `${R}/git/refs/heads/${branch}`, { sha, force: true });
    } else {
      await gh.call("POST", `${R}/git/refs`, { ref: `refs/heads/${branch}`, sha });
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
  readonly seedSha: string;
  readonly plan: SandboxResetPlan;
}

export async function resetSandbox(gh: GitHubApi, log: (line: string) => void): Promise<SandboxResetResult> {
  assertE2eSandboxRepository(gh.repository);
  const scopes = await gh.oauthScopes();
  if (scopes && !scopes.includes("workflow")) {
    throw new Error("the GitHub token cannot write .github/workflows: run `gh auth refresh -h github.com -s workflow`");
  }
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
    await gh.call("DELETE", `${R}/rulesets/${id}`);
  }
  // Moving main first removes the EPURE workflows, so the closures and deletions below trigger no orchestration.
  const seedSha = await commitFiles(gh, readTreeFiles(SEED_DIR), "chore: seed the EPURE e2e sandbox", []);
  await forceBranches(gh, ["main", "dev"], seedSha);
  for (const number of plan.closePullRequests) {
    await gh.call("PATCH", `${R}/pulls/${number}`, { state: "closed" });
  }
  for (const issue of plan.deleteIssues) {
    await gh.graphql("mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }", { id: issue.node_id });
  }
  for (const ref of plan.deleteRefs) {
    await gh.call("DELETE", `${R}/git/${ref}`);
  }
  log(`[reset] main and dev at seed ${seedSha}`);
  return { seedSha, plan };
}
