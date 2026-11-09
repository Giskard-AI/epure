import { parseAgentsYaml } from "../../bootstrap/setup-repo.js";
import type {
  CheckRunAnnotationRecord,
  ExternalCheckRunRecord,
  ExternalWorkflowRunRecord
} from "../../execution/external-ci-gate.js";
import { DEFAULT_REVIEWERS_DIR } from "../../review/reviewer-roster.js";
import {
  buildIssueStateRefName,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefSnapshot,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import type {
  CollaboratorPermission,
  GitBlobRef,
  GitHubAppRef,
  GitHubRestHelper,
  IssueCommentRecord,
  IssueMetadata
} from "../types.js";
import { GitHubRateLimitError } from "./rate-limit.js";

const COLLABORATOR_PERMISSIONS: ReadonlySet<string> = new Set<CollaboratorPermission>([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none"
]);

function isCollaboratorPermission(
  value: string | undefined
): value is CollaboratorPermission {
  return value !== undefined && COLLABORATOR_PERMISSIONS.has(value);
}

export function verifyPublisherMergeBoundary(params: {
  readonly headBranch: string;
  readonly baseBranch: string;
}): void {
  const cleanHead = params.headBranch.trim().replace(/^refs\/heads\//, "");
  const cleanBase = params.baseBranch.trim().replace(/^refs\/heads\//, "");

  if (cleanBase === "main" || cleanBase === "master") {
    throw new Error(
      `HARDWARE_GUARD: Agent App is strictly forbidden from merging '${cleanHead}' into release branch '${cleanBase}' (ADR-0009, Q91).`
    );
  }

  if (cleanBase === "dev" && !cleanHead.startsWith("plan/")) {
    throw new Error(
      `HARDWARE_GUARD: Agent App is strictly forbidden from auto-merging '${cleanHead}' into 'dev'. Only human maintainers may merge 'feature/* -> dev' in the GitHub UI (ADR-0001, Q45, Q91, Q95).`
    );
  }
}

export function slugifyTitle(raw: string, fallback = "feature"): string {
  const clean = raw
    .toLowerCase()
    .replace(/\[plan\]/gi, "")
    .replace(/^\[ticket\s*\d+\]\s*/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return clean || fallback;
}

const BRANCH_COMMIT_MAX_ATTEMPTS = 3;

export class BranchUpdateConflictError extends Error {
  override readonly name = "BranchUpdateConflictError";

  constructor(
    readonly branch: string,
    readonly attempts: number,
    readonly overlappingPaths: readonly string[] = []
  ) {
    super(
      overlappingPaths.length > 0
        ? `Branch '${branch}' moved and its new head also changed ${overlappingPaths.map((p) => `'${p}'`).join(", ")}: EPURE did not overlay its stale version of these files.`
        : `Branch '${branch}' moved during ${attempts} commit attempt(s); its update was not a fast-forward and EPURE did not force it.`
    );
  }
}

export class PullRequestNotMergeableError extends Error {
  override readonly name = "PullRequestNotMergeableError";

  constructor(
    readonly prNumber: number,
    readonly githubMessage = ""
  ) {
    super(
      `GitHub refused to merge PR #${prNumber} (HTTP 405: not mergeable)${githubMessage ? `: ${githubMessage}` : "."}`
    );
  }
}

// GitHub answers 405 both for conflicts and for refusals a re-sync cannot fix (merge method disabled, rulesets, required reviews).
export function isConflictRefusal(
  refusal: PullRequestNotMergeableError,
  mergeableState: string
): boolean {
  return (
    mergeableState === "dirty" ||
    mergeableState === "behind" ||
    /not mergeable/i.test(refusal.githubMessage)
  );
}

export function describeMergeRefusal(
  refusal: PullRequestNotMergeableError,
  mergeableState: string
): string {
  return `${refusal.message} (mergeable_state: \`${mergeableState}\`)`;
}

// HTTP 409 on a merge pinned to `sha`: the PR head is no longer the reviewed commit.
export class PullRequestHeadMovedError extends Error {
  override readonly name = "PullRequestHeadMovedError";

  constructor(
    readonly prNumber: number,
    readonly expectedHeadSha: string
  ) {
    super(
      `PR #${prNumber} head moved after \`${expectedHeadSha}\` was reviewed (HTTP 409): not merged.`
    );
  }
}

export class TruncatedGitTreeError extends Error {
  override readonly name = "TruncatedGitTreeError";

  constructor(readonly commitSha: string) {
    super(
      `The recursive tree listing of ${commitSha} is truncated by GitHub: EPURE cannot tell which files exist and does not infer deletions from it.`
    );
  }
}

interface GitTreeEntry {
  readonly path?: string;
  readonly type?: string;
  readonly sha?: string;
  readonly mode?: string;
  readonly size?: number;
}

// A file written over a directory (or under a file) would silently drop every entry the commit does not delete itself,
// e.g. a file named `.github` replacing the workflows.
function assertNoFileDirectorySwap(
  branch: string,
  written: ReadonlyArray<{ readonly path: string }>,
  parentFiles: ReadonlyMap<string, string>,
  deleted: ReadonlySet<string>
): void {
  const ancestorsOf = (path: string): string[] =>
    path.split("/").slice(0, -1).map((_, i, segments) => segments.slice(0, i + 1).join("/"));
  const kept = [...parentFiles.keys()].filter((p) => !deleted.has(p));
  const keptFiles = new Set(kept);
  const keptDirs = new Set(kept.flatMap(ancestorsOf));
  const swaps = written
    .map((e) => e.path)
    .filter((p) => keptDirs.has(p) || ancestorsOf(p).some((a) => keptFiles.has(a)));
  if (swaps.length > 0) {
    throw new Error(
      `Refusing to commit ${swaps.join(", ")} to '${branch}': each would replace a directory with a file, or a file with a directory, whose other entries the commit does not delete.`
    );
  }
}

function encodeGitHubContentsPath(filePath: string): string {
  return filePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function createGitHubRestHelper(params: {
  readonly repository: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch | undefined;
}): GitHubRestHelper {
  const [owner, repo] = params.repository.trim().split("/");
  const baseUrl = "https://api.github.com";
  const fetchFn = params.fetchImpl ?? fetch;

  const headers = {
    Authorization: `Bearer ${params.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  async function apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
    expectedErrorStatuses: readonly number[] = []
  ): Promise<{ status: number; data: T | null; errorMessage?: string }> {
    let resp: Response | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      try {
        resp = await fetchFn(`${baseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        if (resp.status >= 500 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
          continue;
        }
        break;
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          throw err;
        }
        lastErr = err;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
          continue;
        }
      }
    }
    if (!resp) {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
    if (allow404 && resp.status === 404) {
      return { status: resp.status, data: null };
    }
    if (expectedErrorStatuses.includes(resp.status)) {
      const errText = await resp.text();
      let errorMessage = errText;
      try {
        errorMessage = (JSON.parse(errText) as { message?: string }).message ?? errText;
      } catch {
        // Not JSON: keep the raw body.
      }
      return { status: resp.status, data: null, errorMessage };
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `GitHub API ${method} ${path} failed (HTTP ${resp.status}): ${errText}`
      );
    }
    if (resp.status === 204) {
      return { status: 204, data: null };
    }
    const json = (await resp.json()) as T;
    return { status: resp.status, data: json };
  }

  function decodeBase64(content: string): string {
    return Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");
  }

  async function readBlob(sha: string): Promise<string | null> {
    const { data } = await apiRequest<{ content?: string; encoding?: string }>(
      "GET",
      `/repos/${owner}/${repo}/git/blobs/${sha}`,
      undefined,
      true
    );
    return data?.encoding === "base64" && typeof data.content === "string"
      ? decodeBase64(data.content)
      : null;
  }

  async function resolveCommitSha(branchOrSha: string): Promise<string | null> {
    if (/^[0-9a-f]{40}$/i.test(branchOrSha)) {
      return branchOrSha;
    }
    const { data } = await apiRequest<{ object?: { sha?: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branchOrSha)}`,
      undefined,
      true
    );
    return data?.object?.sha ?? null;
  }

  interface CommitTree {
    readonly entries: readonly GitTreeEntry[];
    readonly truncated: boolean;
  }
  const treesByCommitSha = new Map<string, Promise<CommitTree>>();

  // A commit's tree never changes, so the recursive listing is fetched once per commit SHA per run.
  async function readCommitTree(sha: string): Promise<CommitTree> {
    let pending = treesByCommitSha.get(sha);
    if (!pending) {
      pending = apiRequest<{ tree?: GitTreeEntry[]; truncated?: boolean }>(
        "GET",
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
        undefined,
        true
      ).then((res) => ({
        entries: res.data?.tree ?? [],
        truncated: res.data?.truncated === true
      }));
      treesByCommitSha.set(sha, pending);
      pending.catch(() => treesByCommitSha.delete(sha));
    }
    return await pending;
  }

  async function readBranchTree(branchOrSha: string): Promise<CommitTree> {
    const sha = await resolveCommitSha(branchOrSha);
    return sha ? await readCommitTree(sha) : { entries: [], truncated: false };
  }

  // Files missing from a truncated listing would read as deleted: callers that compare file sets need the full tree.
  async function readCompleteTree(
    branchOrSha: string
  ): Promise<readonly GitTreeEntry[]> {
    const tree = await readBranchTree(branchOrSha);
    if (tree.truncated) {
      throw new TruncatedGitTreeError(branchOrSha);
    }
    return tree.entries;
  }

  // One directory only, so a repository too large for a recursive listing still reads it in full.
  async function listDirectoryFiles(
    branch: string,
    dirPath: string
  ): Promise<readonly GitTreeEntry[]> {
    const { data } = await apiRequest<
      Array<{ type?: string; path?: string; sha?: string }> | object
    >(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodeGitHubContentsPath(dirPath)}?ref=${encodeURIComponent(branch)}`,
      undefined,
      true
    );
    if (!Array.isArray(data)) {
      return [];
    }
    // The contents API lists at most 1,000 entries of a directory.
    if (data.length >= 1000) {
      throw new TruncatedGitTreeError(`${branch}:${dirPath}`);
    }
    return data.flatMap((e) =>
      e.type === "file" && e.path && e.sha
        ? [{ type: "blob", path: e.path, sha: e.sha }]
        : []
    );
  }

  return {
    token: params.token,

    async getIssue(issueNumber: number): Promise<IssueMetadata> {
      const { data } = await apiRequest<{
        id?: number;
        number: number;
        title: string;
        body?: string | null;
        state?: string | null;
        state_reason?: "completed" | "not_planned" | "reopened" | null;
        user?: { login?: string } | null;
        performed_via_github_app?: GitHubAppRef | null;
        pull_request?: unknown;
      }>("GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
      return {
        ...(typeof data?.id === "number" ? { id: data.id } : {}),
        number: data?.number ?? issueNumber,
        title: data?.title ?? `Issue #${issueNumber}`,
        body: data?.body ?? "",
        state: data?.state ?? "open",
        state_reason: data?.state_reason ?? null,
        ...(typeof data?.user?.login === "string"
          ? { user: { login: data.user.login } }
          : {}),
        performed_via_github_app: data?.performed_via_github_app ?? null,
        is_pull_request: data?.pull_request !== undefined && data.pull_request !== null
      };
    },

    // Only the first page: a plan has far fewer than 100 tickets.
    async listSubIssueNumbers(parentIssueNumber: number): Promise<number[]> {
      const { status, data } = await apiRequest<Array<{ number?: number }>>(
        "GET",
        `/repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issues?per_page=100`,
        undefined,
        true
      );
      if (status === 404 || !Array.isArray(data)) {
        return [];
      }
      return data
        .map((s) => s.number)
        .filter((n): n is number => typeof n === "number");
    },

    // Oldest first, up to 30 pages (3,000 comments).
    async listIssueComments(issueNumber: number): Promise<IssueCommentRecord[]> {
      const comments: IssueCommentRecord[] = [];
      for (let page = 1; page <= 30; page += 1) {
        const { data } = await apiRequest<IssueCommentRecord[]>(
          "GET",
          `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100${page > 1 ? `&page=${page}` : ""}`
        );
        comments.push(...(data ?? []));
        if ((data ?? []).length < 100) {
          break;
        }
      }
      return comments;
    },

    async getCollaboratorPermission(
      username: string
    ): Promise<CollaboratorPermission> {
      const { data } = await apiRequest<{
        permission?: string;
        role_name?: string;
      }>(
        "GET",
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
        undefined,
        true
      );
      // A custom repository role has its own `role_name`; `permission` is the base role it inherits.
      const level = isCollaboratorPermission(data?.role_name)
        ? data.role_name
        : data?.permission;
      return isCollaboratorPermission(level) ? level : "none";
    },

    async postIssueComment(issueNumber: number, body: string): Promise<string> {
      const { data } = await apiRequest<{ html_url?: string }>(
        "POST",
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        { body }
      );
      return data?.html_url ?? "";
    },

    async ensureLabel(
      name: string,
      color: string,
      description: string
    ): Promise<void> {
      const existing = await apiRequest(
        "GET",
        `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
        undefined,
        true
      );
      if (existing.status === 404) {
        await apiRequest("POST", `/repos/${owner}/${repo}/labels`, {
          name,
          color,
          description
        });
      }
    },

    async addIssueLabels(
      issueNumber: number,
      labels: readonly string[]
    ): Promise<void> {
      try {
        await apiRequest(
          "POST",
          `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
          { labels: [...labels] }
        );
      } catch {
        // Non-fatal in mock tests
      }
    },

    async removeIssueLabel(
      issueNumber: number,
      label: string
    ): Promise<void> {
      try {
        await apiRequest(
          "DELETE",
          `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
          undefined,
          true
        );
      } catch {
        // Non-fatal in mock tests
      }
    },

    async createIssue(input): Promise<{
      id?: number | undefined;
      number: number;
      html_url: string;
    }> {
      const { data } = await apiRequest<{
        id?: number;
        number: number;
        html_url: string;
      }>("POST", `/repos/${owner}/${repo}/issues`, {
        title: input.title,
        body: input.body,
        labels: input.labels
      });
      if (!data) {
        throw new Error("Failed to create GitHub issue.");
      }
      return {
        ...(typeof data.id === "number" ? { id: data.id } : {}),
        number: data.number,
        html_url: data.html_url
      };
    },

    async updateIssue(
      issueNumber: number,
      input: {
        title?: string | undefined;
        body?: string | undefined;
        state?: "open" | "closed" | undefined;
      }
    ): Promise<void> {
      try {
        await apiRequest(
          "PATCH",
          `/repos/${owner}/${repo}/issues/${issueNumber}`,
          {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.state !== undefined ? { state: input.state } : {})
          }
        );
      } catch {
        // Non-fatal if issue update is unsupported in mock tests or restricted
      }
    },

    async addSubIssue(
      parentIssueNumber: number,
      subIssueDatabaseId: number
    ): Promise<void> {
      if (!Number.isFinite(subIssueDatabaseId) || subIssueDatabaseId <= 0) {
        return;
      }
      try {
        await apiRequest(
          "POST",
          `/repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issues`,
          { sub_issue_id: subIssueDatabaseId }
        );
      } catch {
        // Degraded tolerance (Q112): log/ignore if sub_issues API returns 404/422/5xx
      }
    },

    async addIssueBlockedByDependency(
      issueNumber: number,
      blockerDatabaseId: number
    ): Promise<void> {
      if (!Number.isFinite(blockerDatabaseId) || blockerDatabaseId <= 0) {
        return;
      }
      try {
        await apiRequest(
          "POST",
          `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
          { issue_id: blockerDatabaseId }
        );
      } catch {
        // Degraded tolerance (Q112): log/ignore if dependencies API returns 404/422/5xx
      }
    },

    async closeIssue(issueNumber, stateReason = "completed"): Promise<void> {
      await apiRequest(
        "PATCH",
        `/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          state: "closed",
          state_reason: stateReason
        }
      );
    },

    async getDefaultBranchSha(branch: string): Promise<string | null> {
      const res = await apiRequest<{ object?: { sha?: string } }>(
        "GET",
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        undefined,
        true
      );
      return res.data?.object?.sha ?? null;
    },

    async listDirectoryPaths(branch: string, dirPath: string): Promise<string[]> {
      return (await listDirectoryFiles(branch, dirPath)).flatMap((e) =>
        e.path ? [e.path] : []
      );
    },

    async listBranchPathHints(branch: string): Promise<string[]> {
      const tree = await readBranchTree(branch);
      const paths = tree.entries.flatMap((e) =>
        e.type === "blob" && typeof e.path === "string" ? [e.path] : []
      );
      if (tree.truncated) {
        process.stdout.write(
          `::warning title=EPURE partial file listing::GitHub truncated the file listing of ${branch}: workspace hints and prompt context use the first ${paths.length} paths only.\n`
        );
      }
      return paths;
    },

    async listBranchBlobs(
      branchOrSha: string
    ): Promise<ReadonlyMap<string, GitBlobRef>> {
      const blobs = new Map<string, GitBlobRef>();
      for (const e of await readCompleteTree(branchOrSha)) {
        if (e.type === "blob" && e.path && e.sha) {
          blobs.set(e.path, { sha: e.sha, mode: e.mode ?? "100644" });
        }
      }
      return blobs;
    },

    async readSingleBranchFile(
      branch: string,
      filePath: string
    ): Promise<string | null> {
      const cleanPath = filePath.trim().replace(/^\/+/, "");
      const { data } = await apiRequest<
        | { type?: string; sha?: string; content?: string; encoding?: string }
        | unknown[]
      >(
        "GET",
        `/repos/${owner}/${repo}/contents/${encodeGitHubContentsPath(cleanPath)}?ref=${encodeURIComponent(branch)}`,
        undefined,
        true
      );
      if (!data || Array.isArray(data) || data.type !== "file") {
        return null;
      }
      if (data.encoding === "base64" && typeof data.content === "string") {
        return decodeBase64(data.content);
      }
      // Files over 1 MB come back with `encoding: "none"`; their blob still has the content.
      return data.sha ? await readBlob(data.sha) : null;
    },

    async readBranchWorkspaceFiles(
      branch: string,
      hintText = "",
      pinnedPaths: readonly string[] = [],
      reviewersDir: string = DEFAULT_REVIEWERS_DIR
    ): Promise<Map<string, string>> {
      const filesMap = new Map<string, string>();
      const { entries } = await readBranchTree(branch);
      const candidates = entries.filter((entry) => {
        if (entry.type !== "blob" || !entry.path || !entry.sha) {
          return false;
        }
        const p = entry.path;
        if (
          p.startsWith(".github/") ||
          p.startsWith(`${reviewersDir}/`) ||
          p.startsWith(".agents/") ||
          p.startsWith("docs/") ||
          p === ".gitignore" ||
          p === "renovate.json" ||
          p === "GLOSSARY.md" ||
          /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/i.test(
            p
          ) ||
          /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp3|ogg|wav|mp4|webm|pdf|zip|tar|gz)$/i.test(
            p
          )
        ) {
          return false;
        }
        if (typeof entry.size === "number" && entry.size > 260_000) {
          return false;
        }
        return true;
      });

      let selectedEntries = candidates;
      if (candidates.length > 40) {
        const stopWords = new Set([
          "read","write","test","tests","spec","from","with","when","that","this","into","only","once","does",
          "after","before","still","never","drop","wait","waits","full","user","users","data","file","files",
          "route","routes","check","pass","fail","true","false","null","type","name","code","list","item",
          "page","view","open","close","keep","make","call","send","load","save","state","store","table",
          "live","token","tokens","what","build","acceptance","criteria","part","issue",
          "client","server","socket","request","response","error","errors","value","values","update","updates",
          "create","delete","remove","existing","current","second","first","other","same","each","more","less"
        ]);
        const lowerHint = hintText.toLowerCase();
        const backtickedTokens = Array.from(
          hintText.matchAll(/`([A-Za-z0-9_./-]+)`/g)
        )
          .map((m) => m[1]!.trim().toLowerCase())
          .filter((t) => t.length >= 3 && !stopWords.has(t));
        const wordTokens = Array.from(
          new Set(
            lowerHint
              .split(/[^a-z0-9_]+/)
              .filter((w) => w.length >= 5 && !stopWords.has(w))
          )
        );

        const maxTotalBytes = 380_000;
        const maxPinnedBytes = Math.floor(maxTotalBytes * 0.35);
        const normalizedPinnedSet = new Set(
          pinnedPaths
            .map((p) => p.trim().replace(/^\/+/, "").toLowerCase())
            .filter((p) => p.length > 0)
        );
        for (const bt of backtickedTokens) {
          if (bt.includes("/") || /\.[a-z0-9]{1,6}$/i.test(bt)) {
            normalizedPinnedSet.add(bt.replace(/^\/+/, ""));
          }
        }

        const picked: typeof candidates = [];
        const pickedPathsSet = new Set<string>();
        let totalBytes = 0;
        let pinnedBytes = 0;

        // 1. Dynamically pin explicit pinnedPaths, exact backticked paths, and polyglot build manifests (up to 35% byte budget)
        const isBuildOrEntrypointManifest = (lowerPath: string): boolean =>
          /(?:^|\/)(?:package\.json|cargo\.toml|pyproject\.toml|go\.mod|makefile|justfile|taskfile\.ya?ml|turbo\.json)$/i.test(
            lowerPath
          );

        for (const entry of candidates) {
          const p = entry.path!;
          const lowerPath = p.toLowerCase();
          const isExplicitlyPinned =
            normalizedPinnedSet.has(lowerPath) ||
            Array.from(normalizedPinnedSet).some(
              (pin) => pin.length >= 4 && lowerPath.endsWith(`/${pin}`)
            );
          if (!isExplicitlyPinned && !isBuildOrEntrypointManifest(lowerPath)) {
            continue;
          }
          const entrySize = entry.size ?? 4000;
          if (pinnedBytes + entrySize > maxPinnedBytes) {
            continue;
          }
          picked.push(entry);
          pickedPathsSet.add(p);
          pinnedBytes += entrySize;
          totalBytes += entrySize;
        }

        const scored = candidates
          .filter((entry) => !pickedPathsSet.has(entry.path!))
          .map((entry) => {
            const p = entry.path!;
            const lowerPath = p.toLowerCase();
            const baseName = lowerPath.split("/").pop() ?? lowerPath;
            const stem = baseName
              .replace(
                /\.(?:e2e\.test|integration\.test|test|spec)\.[a-z0-9]+$/i,
                ""
              )
              .replace(/\.[a-z0-9]+$/i, "");
            let score = 0;

            for (const bt of backtickedTokens) {
              if (
                lowerPath === bt ||
                lowerPath.endsWith(`/${bt}`) ||
                baseName === bt
              ) {
                score += 150;
              } else if (bt.length >= 4 && stem === bt) {
                score += 100;
              } else if (
                bt.length >= 6 &&
                (stem.includes(bt) || bt.includes(stem)) &&
                stem.length >= 5
              ) {
                score += 70;
              }
            }
            if (
              stem.length >= 5 &&
              !stopWords.has(stem) &&
              lowerHint.includes(stem)
            ) {
              score += 60;
            }
            for (const w of wordTokens) {
              if (stem === w) {
                score += 45;
              } else if (w.length >= 6 && stem.includes(w)) {
                score += 25;
              }
            }
            if (score > 0 && /(?:\.test\.|__tests__)/.test(lowerPath)) {
              score += 10;
            }
            return { entry, score, size: entry.size ?? 4000 };
          });

        scored.sort((a, b) => b.score - a.score);
        for (const s of scored) {
          if (s.score < 25 || picked.length >= 28) {
            break;
          }
          if (totalBytes + s.size > maxTotalBytes) {
            continue;
          }
          picked.push(s.entry);
          totalBytes += s.size;
        }
        selectedEntries = picked;
      }

      for (const entry of selectedEntries) {
        const content = entry.sha ? await readBlob(entry.sha) : null;
        if (entry.path && content !== null) {
          filesMap.set(entry.path, content);
        }
      }
      return filesMap;
    },

    async readTrustedBaseRosterFiles(
      branch: string,
      reviewersDir: string = DEFAULT_REVIEWERS_DIR
    ): Promise<Map<string, string>> {
      const filesMap = new Map<string, string>();
      const dirPath = reviewersDir.replace(/\/+$/, "");
      for (const entry of await listDirectoryFiles(branch, dirPath)) {
        if (
          !entry.path ||
          !entry.sha ||
          !/^[a-z0-9-]+\.md$/i.test(entry.path.slice(dirPath.length + 1))
        ) {
          continue;
        }
        const content = await readBlob(entry.sha);
        if (content !== null) {
          filesMap.set(entry.path, content);
        }
      }
      const designMarkdown = await this.readSingleBranchFile(branch, "DESIGN.md");
      if (designMarkdown !== null) {
        filesMap.set("DESIGN.md", designMarkdown);
      }
      return filesMap;
    },

    async readDevWorkflowsMap(branch: string): Promise<Map<string, string>> {
      const workflowsMap = new Map<string, string>();
      for (const entry of await listDirectoryFiles(branch, ".github/workflows")) {
        if (!entry.path || !entry.sha || !/\.ya?ml$/i.test(entry.path)) {
          continue;
        }
        const content = await readBlob(entry.sha);
        if (content !== null) {
          workflowsMap.set(entry.path, content);
        }
      }
      return workflowsMap;
    },

    async ensureBranch(branch: string, fromBranch = "main"): Promise<string> {
      const existingSha = await this.getDefaultBranchSha(branch);
      if (existingSha) {
        return existingSha;
      }
      let baseSha = await this.getDefaultBranchSha(fromBranch);
      if (!baseSha) {
        baseSha = await this.getDefaultBranchSha("main");
      }
      if (!baseSha) {
        throw new Error(
          `Cannot create branch '${branch}': neither '${fromBranch}' nor 'main' exists.`
        );
      }
      const created = await apiRequest(
        "POST",
        `/repos/${owner}/${repo}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: baseSha },
        false,
        [422]
      );
      if (created.status === 422) {
        // Another writer created the branch first: build on its head.
        const concurrentSha = await this.getDefaultBranchSha(branch);
        if (!concurrentSha) {
          throw new Error(`Cannot create branch '${branch}': GitHub rejected the ref.`);
        }
        return concurrentSha;
      }
      return baseSha;
    },

    async commitFilesToBranch(input): Promise<string> {
      // ensureBranch returns the head it read or created, so a just-created ref is never re-read (it can 404 briefly).
      let parentCommitSha = await this.ensureBranch(
        input.branch,
        input.fromBranch ?? "main"
      );

      // `mode` undefined: the parent's mode for an existing file, 100644 for a new one.
      const treeEntries: Array<{
        path: string;
        mode: string | undefined;
        type: "blob";
        sha: string | null;
      }> = [];

      const seenTreePaths = new Set<string>();
      for (const file of input.files) {
        const cleanPath = file.path.trim().replace(/^\/+/, "");
        const blobRes = await apiRequest<{ sha: string }>(
          "POST",
          `/repos/${owner}/${repo}/git/blobs`,
          {
            content: file.content,
            encoding: "utf-8"
          }
        );
        seenTreePaths.add(cleanPath);
        treeEntries.push({
          path: cleanPath,
          mode: file.mode,
          type: "blob",
          sha: blobRes.data!.sha
        });
      }
      // Existing blobs keep their SHA and mode: binaries, executables and symlinks are not re-encoded.
      for (const blob of input.blobs ?? []) {
        const cleanPath = blob.path.trim().replace(/^\/+/, "");
        if (seenTreePaths.has(cleanPath)) {
          continue;
        }
        seenTreePaths.add(cleanPath);
        treeEntries.push({
          path: cleanPath,
          mode: blob.mode,
          type: "blob",
          sha: blob.sha
        });
      }

      const pendingDeletedPaths: string[] = [];
      for (const delPath of input.deletedFiles ?? []) {
        const cleanPath = delPath.trim().replace(/^\/+/, "");
        if (!cleanPath || seenTreePaths.has(cleanPath)) {
          continue;
        }
        seenTreePaths.add(cleanPath);
        pendingDeletedPaths.push(cleanPath);
      }

      const touchedPaths = [...seenTreePaths];
      // Paths this commit writes or deletes that `toSha` changed since `fromSha` (all of them when a listing is truncated).
      const touchedPathsChanged = async (
        fromSha: string,
        toSha: string
      ): Promise<readonly string[]> => {
        const [before, after] = await Promise.all([
          readCommitTree(fromSha),
          readCommitTree(toSha)
        ]);
        if (before.truncated || after.truncated) {
          return touchedPaths;
        }
        const blobAt = (tree: CommitTree) =>
          new Map(tree.entries.map((e) => [e.path, e.sha]));
        const [beforeBlobs, afterBlobs] = [blobAt(before), blobAt(after)];
        return touchedPaths.filter(
          (p) => beforeBlobs.get(p) !== afterBlobs.get(p)
        );
      };

      // A rejected fast-forward means someone pushed meanwhile: the same changes are rebuilt on the new head
      // only when it left every touched path alone, never forced.
      for (let attempt = 1; ; attempt += 1) {
        const parentCommit = await apiRequest<{ tree: { sha: string } }>(
          "GET",
          `/repos/${owner}/${repo}/git/commits/${parentCommitSha}`
        );
        const baseTreeSha = parentCommit.data!.tree.sha;

        const parentTree =
          treeEntries.length > 0 || pendingDeletedPaths.length > 0
            ? await readCommitTree(parentCommitSha)
            : { entries: [], truncated: true };
        const parentFiles = parentTree.truncated
          ? null
          : new Map(
              parentTree.entries.flatMap((e) =>
                e.type !== "tree" && e.path ? [[e.path, e.mode ?? "100644"] as const] : []
              )
            );
        if (parentFiles) {
          assertNoFileDirectorySwap(input.branch, treeEntries, parentFiles, new Set(pendingDeletedPaths));
        }
        const attemptEntries = treeEntries.map((e) => ({
          ...e,
          mode: e.mode ?? (parentFiles?.get(e.path) === "100755" ? "100755" : "100644")
        }));
        if (pendingDeletedPaths.length > 0) {
          const existingTreePaths = parentTree.truncated
            ? null
            : new Set(
                parentTree.entries.flatMap((e) =>
                  e.type === "blob" && e.path ? [e.path] : []
                )
              );

          for (const cleanPath of pendingDeletedPaths) {
            if (existingTreePaths && !existingTreePaths.has(cleanPath)) {
              continue;
            }
            attemptEntries.push({
              path: cleanPath,
              mode: "100644",
              type: "blob",
              sha: null
            });
          }
        }

        if (attemptEntries.length === 0 && !input.mergeParentSha) {
          return parentCommitSha;
        }

        const treeSha =
          attemptEntries.length === 0
            ? baseTreeSha
            : (
                await apiRequest<{ sha: string }>(
                  "POST",
                  `/repos/${owner}/${repo}/git/trees`,
                  {
                    base_tree: baseTreeSha,
                    tree: attemptEntries
                  }
                )
              ).data!.sha;
        if (treeSha === baseTreeSha && !input.mergeParentSha) {
          return parentCommitSha;
        }

        const newCommit = await apiRequest<{ sha: string }>(
          "POST",
          `/repos/${owner}/${repo}/git/commits`,
          {
            message: input.commitMessage,
            tree: treeSha,
            parents: input.mergeParentSha
              ? [parentCommitSha, input.mergeParentSha]
              : [parentCommitSha]
          }
        );

        const update = await apiRequest(
          "PATCH",
          `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(input.branch)}`,
          { sha: newCommit.data!.sha, force: false },
          false,
          [422]
        );
        if (update.status !== 422) {
          return newCommit.data!.sha;
        }
        const movedHead = await this.getDefaultBranchSha(input.branch);
        if (movedHead === parentCommitSha) {
          throw new Error(
            `GitHub refused to update branch '${input.branch}' (HTTP 422) although it did not move: a repository ruleset or branch protection blocks direct pushes by the EPURE App (for feature/*, re-run setup-repo --apply --apply-github-settings).`
          );
        }
        if (!movedHead || attempt >= BRANCH_COMMIT_MAX_ATTEMPTS) {
          throw new BranchUpdateConflictError(input.branch, attempt);
        }
        const overlapping = await touchedPathsChanged(parentCommitSha, movedHead);
        if (overlapping.length > 0) {
          throw new BranchUpdateConflictError(input.branch, attempt, overlapping);
        }
        parentCommitSha = movedHead;
      }
    },

    async listPullRequestFiles(
      prNumber: number
    ): Promise<
      ReadonlyArray<{
        readonly filename: string;
        readonly status: string;
        readonly patch?: string | undefined;
        readonly previous_filename?: string | undefined;
      }>
    > {
      try {
        const existing = await apiRequest<
          Array<{
            filename?: string;
            status?: string;
            patch?: string;
            previous_filename?: string;
          }>
        >(
          "GET",
          `/repos/${owner}/${repo}/pulls/${prNumber}/files`,
          undefined,
          true
        );
        if (Array.isArray(existing.data)) {
          return existing.data
            .filter(
              (
                item
              ): item is {
                filename: string;
                status?: string;
                patch?: string;
                previous_filename?: string;
              } =>
                typeof item?.filename === "string" &&
                item.filename.trim().length > 0
            )
            .map((item) => ({
              filename: item.filename.trim().replace(/^\/+/, ""),
              status: item.status ?? "modified",
              ...(typeof item.patch === "string" ? { patch: item.patch } : {}),
              ...(typeof item.previous_filename === "string"
                ? { previous_filename: item.previous_filename.trim().replace(/^\/+/, "") }
                : {})
            }));
        }
      } catch {
        // Non-fatal in mock tests
      }
      return [];
    },

    async findOpenPullRequestByHead(
      headBranch: string,
      baseBranch: string
    ): Promise<{
      number: number;
      html_url: string;
      head_sha: string;
      title: string;
      body: string;
    } | null> {
      const existing = await apiRequest<
        Array<{
          number: number;
          html_url: string;
          title?: string;
          body?: string | null;
          head?: { sha?: string };
        }>
      >(
        "GET",
        `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(
          `${owner}:${headBranch}`
        )}&base=${encodeURIComponent(baseBranch)}`,
        undefined,
        true
      );
      const first = existing.data?.[0];
      const headSha = first?.head?.sha;
      return first && headSha
        ? {
            number: first.number,
            html_url: first.html_url,
            head_sha: headSha,
            title: first.title ?? "",
            body: first.body ?? ""
          }
        : null;
    },

    async findMergedPullRequestByHead(
      headBranch: string,
      baseBranch: string
    ): Promise<{ number: number; html_url: string } | null> {
      const closed = await apiRequest<
        Array<{ number: number; html_url: string; merged_at?: string | null }>
      >(
        "GET",
        `/repos/${owner}/${repo}/pulls?state=closed&head=${encodeURIComponent(
          `${owner}:${headBranch}`
        )}&base=${encodeURIComponent(baseBranch)}`,
        undefined,
        true
      );
      const merged = closed.data?.find((pr) => pr.merged_at);
      return merged ? { number: merged.number, html_url: merged.html_url } : null;
    },

    async listOpenPullRequestsByBase(
      baseBranch: string
    ): Promise<ReadonlyArray<{ number: number; html_url: string }>> {
      const open = await apiRequest<Array<{ number: number; html_url: string }>>(
        "GET",
        `/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&per_page=100`,
        undefined,
        true
      );
      return (open.data ?? []).map((pr) => ({ number: pr.number, html_url: pr.html_url }));
    },

    async listBranchesByPrefix(prefix: string): Promise<string[]> {
      const { data } = await apiRequest<Array<{ ref: string }>>(
        "GET",
        `/repos/${owner}/${repo}/git/matching-refs/heads/${encodeGitHubContentsPath(prefix)}`,
        undefined,
        true
      );
      return (data ?? []).map((r) => r.ref.replace(/^refs\/heads\//, ""));
    },

    async openPullRequest(input): Promise<{
      number: number;
      html_url: string;
      head_sha: string;
    }> {
      const existingPr = await this.findOpenPullRequestByHead(
        input.head,
        input.base
      );
      if (existingPr) {
        return {
          number: existingPr.number,
          html_url: existingPr.html_url,
          head_sha: existingPr.head_sha
        };
      }

      const created = await apiRequest<{
        number: number;
        html_url: string;
        head: { sha: string };
      }>("POST", `/repos/${owner}/${repo}/pulls`, {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body
      });
      return {
        number: created.data!.number,
        html_url: created.data!.html_url,
        head_sha: created.data!.head.sha
      };
    },

    async updatePullRequest(
      prNumber: number,
      input: {
        title?: string | undefined;
        body?: string | undefined;
        state?: "open" | "closed" | undefined;
      }
    ): Promise<{ head_sha: string }> {
      const payload: Record<string, string> = {};
      if (input.title !== undefined) {
        payload.title = input.title;
      }
      if (input.body !== undefined) {
        payload.body = input.body;
      }
      if (input.state !== undefined) {
        payload.state = input.state;
      }
      const { data } = await apiRequest<{ head?: { sha?: string } }>(
        "PATCH",
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
        payload
      );
      return {
        head_sha: data?.head?.sha ?? ""
      };
    },

    async mergeBranches(input: {
      base: string;
      head: string;
      commitMessage?: string | undefined;
    }): Promise<{
      status: "merged" | "up_to_date" | "conflict";
      sha: string;
    }> {
      const resp = await fetchFn(`${baseUrl}/repos/${owner}/${repo}/merges`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          base: input.base,
          head: input.head,
          commit_message:
            input.commitMessage ??
            `chore(sync): merge ${input.head} into ${input.base}`
        })
      });
      if (resp.status === 204) {
        const currentSha = (await this.getDefaultBranchSha(input.base)) ?? "";
        return { status: "up_to_date", sha: currentSha };
      }
      if (resp.status === 409) {
        return { status: "conflict", sha: "" };
      }
      if (resp.ok) {
        try {
          const data = (await resp.json()) as { sha?: string };
          return {
            status: data.sha ? "merged" : "up_to_date",
            sha:
              data.sha ?? (await this.getDefaultBranchSha(input.base)) ?? ""
          };
        } catch {
          return {
            status: "up_to_date",
            sha: (await this.getDefaultBranchSha(input.base)) ?? ""
          };
        }
      }
      const errText = await resp.text();
      throw new Error(
        `GitHub API POST /repos/${owner}/${repo}/merges failed (HTTP ${resp.status}): ${errText}`
      );
    },

    async compareCommits(
      base: string,
      head: string
    ): Promise<{
      mergeBaseSha: string;
      changedFiles: readonly string[];
      aheadBy: number;
    }> {
      const res = await apiRequest<{
        merge_base_commit?: { sha?: string };
        files?: Array<{ filename?: string }>;
        ahead_by?: number;
      }>(
        "GET",
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        undefined,
        true
      );
      const mergeBaseSha = res.data?.merge_base_commit?.sha;
      if (!mergeBaseSha) {
        throw new Error(
          `GitHub compare ${base}...${head} returned no merge base (HTTP ${res.status}): the branches cannot be compared.`
        );
      }
      const changedFiles = (res.data?.files ?? [])
        .map((f) => f.filename?.trim().replace(/^\/+/, "") ?? "")
        .filter((p) => p.length > 0);
      return { mergeBaseSha, changedFiles, aheadBy: res.data?.ahead_by ?? 0 };
    },

    async postPullRequestReview(
      prNumber: number,
      input: { commitId: string; body: string }
    ): Promise<void> {
      try {
        await apiRequest(
          "POST",
          `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
          {
            commit_id: input.commitId,
            body: input.body,
            event: "COMMENT"
          }
        );
      } catch {
        try {
          await apiRequest(
            "POST",
            `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
            { body: input.body }
          );
        } catch {
          // Non-fatal
        }
      }
    },

    async getPullRequestMergeableState(prNumber: number): Promise<string> {
      const { data } = await apiRequest<{ mergeable_state?: string }>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${prNumber}`
      );
      return data?.mergeable_state ?? "unknown";
    },

    async mergePullRequest(prNumber, input): Promise<void> {
      verifyPublisherMergeBoundary({
        headBranch: input.headBranch,
        baseBranch: input.baseBranch
      });

      const merged = await apiRequest(
        "PUT",
        `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        {
          commit_title: input.commitTitle,
          commit_message: input.commitMessage ?? "",
          merge_method: "squash",
          sha: input.expectedHeadSha
        },
        false,
        [405, 409]
      );
      if (merged.status === 409) {
        throw new PullRequestHeadMovedError(prNumber, input.expectedHeadSha);
      }
      if (merged.status === 405) {
        throw new PullRequestNotMergeableError(prNumber, merged.errorMessage);
      }

      const cleanHead = input.headBranch.trim().replace(/^refs\/heads\//, "");
      if (cleanHead.startsWith("task/") || cleanHead.startsWith("plan/")) {
        try {
          await apiRequest(
            "DELETE",
            `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(cleanHead)}`
          );
        } catch {
          // Ignore if already deleted by delete_branch_on_merge
        }
      }
    },

    async publishCheckRun(input): Promise<void> {
      try {
        await apiRequest("POST", `/repos/${owner}/${repo}/check-runs`, {
          name: input.name,
          head_sha: input.headSha,
          status: "completed",
          conclusion: input.conclusion,
          output: {
            title: `EPURE ${input.name} (${input.conclusion})`,
            summary: input.summary
          }
        });
      } catch {
        // Non-fatal if token lacks checks:write
      }
    },

    async listWorkflowRunsForSha(
      headSha: string
    ): Promise<readonly ExternalWorkflowRunRecord[]> {
      try {
        const res = await apiRequest<{
          workflow_runs?: ExternalWorkflowRunRecord[];
        }>(
          "GET",
          `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
          undefined,
          true
        );
        return Array.isArray(res.data?.workflow_runs)
          ? res.data!.workflow_runs!
          : [];
      } catch {
        return [];
      }
    },

    async listCheckRunsForRef(
      headSha: string
    ): Promise<readonly ExternalCheckRunRecord[]> {
      try {
        const res = await apiRequest<{
          check_runs?: ExternalCheckRunRecord[];
        }>(
          "GET",
          `/repos/${owner}/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
          undefined,
          true
        );
        return Array.isArray(res.data?.check_runs)
          ? res.data!.check_runs!
          : [];
      } catch {
        return [];
      }
    },

    async listCheckRunAnnotations(
      checkRunId: number
    ): Promise<readonly CheckRunAnnotationRecord[]> {
      try {
        const res = await apiRequest<CheckRunAnnotationRecord[]>(
          "GET",
          `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=50`,
          undefined,
          true
        );
        return Array.isArray(res.data) ? res.data : [];
      } catch {
        return [];
      }
    },

    async getActionJobLogs(jobId: number): Promise<string> {
      try {
        const resp = await fetchFn(
          `${baseUrl}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
          {
            method: "GET",
            headers
          }
        );
        if (!resp.ok) {
          return "";
        }
        const text = await resp.text();
        if (text.trim() === '{"ok":true}') {
          return "";
        }
        return text;
      } catch {
        return "";
      }
    },

    async rerunFailedWorkflowJobs(runId: number): Promise<void> {
      try {
        await apiRequest(
          "POST",
          `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`,
          {}
        );
      } catch {
        // Non-fatal in mock tests
      }
    }
  };
}

export async function loadRepoAgentsConfig(
  gh: Pick<GitHubRestHelper, "readSingleBranchFile">,
  branch = "dev"
): Promise<ReturnType<typeof parseAgentsYaml> | null> {
  const rawYaml =
    (await gh.readSingleBranchFile(branch, ".github/agents.yml")) ??
    (await gh.readSingleBranchFile(branch, ".github/agents.yaml"));
  if (!rawYaml) {
    return null;
  }
  try {
    return parseAgentsYaml(rawYaml);
  } catch (err) {
    throw new Error(
      `Invalid .github/agents.yml on '${branch}': ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

// Read from dev (else main) through the API, never from a checkout an agent may have modified.
export async function loadTrustedAgentsProviders(
  gh: Pick<GitHubRestHelper, "readSingleBranchFile">
): Promise<ReturnType<typeof parseAgentsYaml>["providers"]> {
  const config =
    (await loadRepoAgentsConfig(gh, "dev")) ?? (await loadRepoAgentsConfig(gh, "main"));
  return config?.providers;
}

export async function loadOrchestratorStateFromGitRef(
  store: GitRefStateStore,
  issueNumber: number
): Promise<GitRefSnapshot> {
  const refName = buildIssueStateRefName(issueNumber);
  return await store.readRef(refName);
}

export async function persistOrchestratorStateToGitRef(params: {
  readonly issueNumber: number;
  readonly store: GitRefStateStore;
  readonly mutator: (prevState: EpureIssueState) => EpureIssueState;
}): Promise<EpureIssueState> {
  const updated = await updateIssueStateWithCas({
    issueNumber: params.issueNumber,
    store: params.store,
    mutator: params.mutator
  });
  return updated.state;
}
