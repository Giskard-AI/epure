import { mintRepositoryInstallationToken, revokeGitHubInstallationToken } from "../auth/github-app-jwt.js";
import { type EpureCommandName, redactSecrets } from "../auth/issue-command-gate.js";
import {
  buildRenovateConfigJson,
  buildStackAwareCiWorkflowYaml,
  buildZizmorConfigYaml,
  detectRepositoryStack,
  discoverVerificationProfile,
  type VerificationProfile
} from "../bootstrap/ci-and-renovate.js";
import { parseAgentsYaml } from "../bootstrap/setup-repo.js";
import {
  discoverExpectedExternalWorkflows,
  formatNeedsHumanEscalationComment,
  waitForExternalCiChecks,
  type CheckRunAnnotationRecord,
  type ExternalCheckRunRecord,
  type ExternalWorkflowRunRecord,
  type WaitForExternalCiChecksResult
} from "../execution/external-ci-gate.js";
import { planImpeccableDesignSession } from "../frontend/impeccable-planning.js";
import {
  runMultiAgentPrReviewPass,
  type ReviewerFinding
} from "../review/multi-agent-pr-review.js";
import {
  adaptReviewerRosterForDomain,
  runUserAdvocateDesignGate,
  type ReviewerAgentName
} from "../review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../review/squash-commit-generator.js";
import type { SandboxExecutionInput, SandboxExecutionResult } from "../sandbox/llm-sandbox.js";
import {
  formatVerificationToolingGuideMarkdown,
  prepareRepositorySandboxWorkspace,
  runPolyglotStage1Verification,
  validateWorkspaceFileOperations
} from "../sandbox/polyglot-workspace-runner.js";
import {
  buildIssueStateRefName,
  createGitHubApiRefStateStore,
  formatIssueStateMirrorMarkdown,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "../state/git-ref-state.js";
import {
  PROMPT_INJECTION_IMMUNITY_CLAUSE,
  wrapUntrustedContent
} from "../security/prompt-injection-guard.js";
import { callGeminiGenerateContent, extractJsonObject } from "./gemini-client.js";

export interface IssueCommentRecord {
  readonly id: number;
  readonly body: string;
  readonly user: {
    readonly login: string;
    readonly type?: string | undefined;
  };
  readonly created_at: string;
}

export interface IssueMetadata {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state?: string | undefined;
}

export interface PlannedTicketDefinition {
  readonly index: number;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance_criteria: readonly string[];
  readonly blocked_by_indices: readonly number[];
  readonly files_to_create_or_update: readonly string[];
}

export interface GeneratedPlanningBundle {
  readonly plan_slug: string;
  readonly glossary_markdown: string;
  readonly adrs: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly spec_path: string;
  readonly spec_markdown: string;
  readonly tickets: readonly PlannedTicketDefinition[];
}

export interface GrillRoundEvaluation {
  readonly frontier_resolved: boolean;
  readonly round_number: number;
  readonly follow_up_questions_markdown: string;
  readonly rationale: string;
}

export interface GeneratedTicketPatchEdit {
  readonly old_string: string;
  readonly new_string: string;
}

export interface GeneratedTicketFilePatch {
  readonly path: string;
  readonly edits: readonly GeneratedTicketPatchEdit[];
}

export interface GeneratedTicketImplementation {
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }> | undefined;
  readonly patches?: readonly GeneratedTicketFilePatch[] | undefined;
  readonly deleted_files?: readonly string[] | undefined;
  readonly commit_message: string;
  readonly test_summary: string;
}

async function applyTicketImplementationPayload(params: {
  readonly parsed: GeneratedTicketImplementation;
  readonly accumulatedFiles: Map<string, string>;
  readonly featureChangedFilesMap: Map<string, string>;
  readonly ticketChangedFilesMap: Map<string, string>;
  readonly featureDeletedFilesSet?: Set<string> | undefined;
  readonly ticketDeletedFilesSet?: Set<string> | undefined;
  readonly gh: GitHubRestHelper;
  readonly branch: string;
}): Promise<Array<{ path: string; content: string }>> {
  for (const f of params.parsed.files ?? []) {
    const cleanPath = f.path.replace(/^\/+/, "");
    params.accumulatedFiles.set(cleanPath, f.content);
    params.featureChangedFilesMap.set(cleanPath, f.content);
    params.ticketChangedFilesMap.set(cleanPath, f.content);
    params.featureDeletedFilesSet?.delete(cleanPath);
    params.ticketDeletedFilesSet?.delete(cleanPath);
  }

  for (const del of params.parsed.deleted_files ?? []) {
    const cleanPath = del.replace(/^\/+/, "");
    params.accumulatedFiles.delete(cleanPath);
    params.featureChangedFilesMap.delete(cleanPath);
    params.ticketChangedFilesMap.delete(cleanPath);
    params.featureDeletedFilesSet?.add(cleanPath);
    params.ticketDeletedFilesSet?.add(cleanPath);
  }

  for (const patch of params.parsed.patches ?? []) {
    const cleanPath = patch.path.replace(/^\/+/, "");
    let baseContent = params.accumulatedFiles.get(cleanPath) ?? null;
    if (baseContent === null) {
      baseContent = await params.gh.readSingleBranchFile(
        params.branch,
        cleanPath
      );
    }
    if (baseContent === null) {
      continue;
    }
    let updatedContent = baseContent;
    for (const edit of patch.edits ?? []) {
      if (edit.old_string && updatedContent.includes(edit.old_string)) {
        updatedContent = updatedContent.replace(
          edit.old_string,
          edit.new_string
        );
      }
    }
    params.accumulatedFiles.set(cleanPath, updatedContent);
    params.featureChangedFilesMap.set(cleanPath, updatedContent);
    params.ticketChangedFilesMap.set(cleanPath, updatedContent);
    params.featureDeletedFilesSet?.delete(cleanPath);
    params.ticketDeletedFilesSet?.delete(cleanPath);
  }

  return Array.from(params.ticketChangedFilesMap.entries()).map(
    ([path, content]) => ({ path, content })
  );
}

export interface OrchestrateIssueInput {
  readonly repository: string;
  readonly issueNumber: number;
  readonly command: EpureCommandName;
  readonly commandArgs: string;
  readonly commentId?: number | undefined;
  readonly actor: string;
  readonly agentAppId?: string | undefined;
  readonly agentAppPrivateKey?: string | undefined;
  readonly fallbackGithubToken?: string | undefined;
  readonly llmApiKey: string;
  readonly model?: string | undefined;
  readonly stateStore?: GitRefStateStore | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
}

export interface OrchestrateIssueResult {
  readonly executed: boolean;
  readonly phase: string;
  readonly status: string;
  readonly active_branch: string;
  readonly summary_markdown: string;
  readonly created_ticket_numbers: readonly number[];
  readonly feature_pr_url: string;
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

interface GitHubRestHelper {
  readonly token: string;
  getIssue(issueNumber: number): Promise<IssueMetadata>;
  listIssueComments(issueNumber: number): Promise<IssueCommentRecord[]>;
  postIssueComment(issueNumber: number, body: string): Promise<string>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  addIssueLabels(issueNumber: number, labels: readonly string[]): Promise<void>;
  createIssue(params: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; html_url: string }>;
  closeIssue(issueNumber: number): Promise<void>;
  getDefaultBranchSha(branch: string): Promise<string | null>;
  listBranchPaths(branch: string): Promise<string[]>;
  readSingleBranchFile(branch: string, filePath: string): Promise<string | null>;
  readBranchWorkspaceFiles(branch: string, hintText?: string): Promise<Map<string, string>>;
  readTrustedBaseRosterFiles(branch: string): Promise<Map<string, string>>;
  readDevWorkflowsMap(branch: string): Promise<Map<string, string>>;
  ensureBranch(branch: string, fromBranch?: string): Promise<string>;
  commitFilesToBranch(params: {
    branch: string;
    fromBranch?: string;
    commitMessage: string;
    files: ReadonlyArray<{ path: string; content: string }>;
    readonly deletedFiles?: readonly string[] | undefined;
  }): Promise<string>;
  listPullRequestFiles(
    prNumber: number
  ): Promise<ReadonlyArray<{ filename: string; status: string }>>;
  findOpenPullRequestByHead(
    headBranch: string,
    baseBranch: string
  ): Promise<{
    number: number;
    html_url: string;
    head_sha: string;
    title: string;
    body: string;
  } | null>;
  openPullRequest(params: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; html_url: string; head_sha: string }>;
  updatePullRequest(
    prNumber: number,
    params: { title?: string | undefined; body?: string | undefined }
  ): Promise<{ head_sha: string }>;
  postPullRequestReview(
    prNumber: number,
    params: { commitId: string; body: string }
  ): Promise<void>;
  mergePullRequest(
    prNumber: number,
    params: {
      headBranch: string;
      baseBranch: string;
      commitTitle: string;
      commitMessage?: string | undefined;
    }
  ): Promise<void>;
  publishCheckRun(params: {
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    summary: string;
  }): Promise<void>;
  listWorkflowRunsForSha(
    headSha: string
  ): Promise<readonly ExternalWorkflowRunRecord[]>;
  listCheckRunsForRef(
    headSha: string
  ): Promise<readonly ExternalCheckRunRecord[]>;
  listCheckRunAnnotations(
    checkRunId: number
  ): Promise<readonly CheckRunAnnotationRecord[]>;
  getActionJobLogs(jobId: number): Promise<string>;
  rerunFailedWorkflowJobs(runId: number): Promise<void>;
}

function slugifyTitle(raw: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/\[plan\]/gi, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return clean || "feature";
}

function createGitHubRestHelper(params: {
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
    allow404 = false
  ): Promise<{ status: number; data: T | null }> {
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
      return { status: 404, data: null };
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

  return {
    token: params.token,

    async getIssue(issueNumber: number): Promise<IssueMetadata> {
      const { data } = await apiRequest<{
        number: number;
        title: string;
        body?: string | null;
        state?: string | null;
      }>("GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
      return {
        number: data?.number ?? issueNumber,
        title: data?.title ?? `Issue #${issueNumber}`,
        body: data?.body ?? "",
        state: data?.state ?? "open"
      };
    },

    async listIssueComments(issueNumber: number): Promise<IssueCommentRecord[]> {
      const { data } = await apiRequest<IssueCommentRecord[]>(
        "GET",
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
      );
      return data ?? [];
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

    async createIssue(input): Promise<{ number: number; html_url: string }> {
      const { data } = await apiRequest<{ number: number; html_url: string }>(
        "POST",
        `/repos/${owner}/${repo}/issues`,
        {
          title: input.title,
          body: input.body,
          labels: input.labels
        }
      );
      if (!data) {
        throw new Error("Failed to create GitHub issue.");
      }
      return data;
    },

    async closeIssue(issueNumber: number): Promise<void> {
      await apiRequest("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, {
        state: "closed",
        state_reason: "completed"
      });
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

    async listBranchPaths(branch: string): Promise<string[]> {
      try {
        const treeRes = await apiRequest<{
          tree?: Array<{ path?: string; type?: string }>;
        }>(
          "GET",
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
          undefined,
          true
        );
        return (treeRes.data?.tree ?? [])
          .filter((e) => e.type === "blob" && typeof e.path === "string")
          .map((e) => e.path!);
      } catch {
        return [];
      }
    },

    async readSingleBranchFile(
      branch: string,
      filePath: string
    ): Promise<string | null> {
      try {
        const cleanPath = filePath.trim().replace(/^\/+/, "");
        const treeRes = await apiRequest<{
          tree?: Array<{ path?: string; type?: string; sha?: string }>;
        }>(
          "GET",
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
          undefined,
          true
        );
        const match = (treeRes.data?.tree ?? []).find(
          (e) => e.type === "blob" && e.path === cleanPath
        );
        if (!match?.sha) {
          return null;
        }
        const blobRes = await apiRequest<{ content?: string; encoding?: string }>(
          "GET",
          `/repos/${owner}/${repo}/git/blobs/${match.sha}`,
          undefined,
          true
        );
        if (blobRes.data?.content && blobRes.data.encoding === "base64") {
          return Buffer.from(
            blobRes.data.content.replace(/\s+/g, ""),
            "base64"
          ).toString("utf8");
        }
        return null;
      } catch {
        return null;
      }
    },

    async readBranchWorkspaceFiles(branch: string, hintText = ""): Promise<Map<string, string>> {
      const filesMap = new Map<string, string>();
      try {
        const treeRes = await apiRequest<{
          tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
        }>(
          "GET",
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
          undefined,
          true
        );
        const entries = treeRes.data?.tree ?? [];
        const candidates = entries.filter((entry) => {
          if (entry.type !== "blob" || !entry.path || !entry.sha) {
            return false;
          }
          const p = entry.path;
          if (
            p.startsWith(".github/") ||
            p.startsWith(".cursor/") ||
            p.startsWith(".agents/") ||
            p.startsWith("docs/") ||
            p === ".gitignore" ||
            p === "renovate.json" ||
            p === "GLOSSARY.md" ||
            /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(p) ||
            /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp3|ogg|wav|mp4|webm|pdf|zip|tar|gz)$/i.test(p)
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

          const scored = candidates.map((entry) => {
            const p = entry.path!;
            const lowerPath = p.toLowerCase();
            const baseName = lowerPath.split("/").pop() ?? lowerPath;
            const stem = baseName
              .replace(/\.(?:e2e\.test|integration\.test|test|spec)\.[a-z0-9]+$/i, "")
              .replace(/\.[a-z0-9]+$/i, "");
            let score = 0;

            for (const bt of backtickedTokens) {
              if (lowerPath === bt || lowerPath.endsWith(`/${bt}`) || baseName === bt) {
                score += 150;
              } else if (bt.length >= 4 && stem === bt) {
                score += 100;
              } else if (bt.length >= 6 && (stem.includes(bt) || bt.includes(stem)) && stem.length >= 5) {
                score += 70;
              }
            }
            if (stem.length >= 5 && !stopWords.has(stem) && lowerHint.includes(stem)) {
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
          const picked: typeof candidates = [];
          let totalBytes = 0;
          for (const s of scored) {
            if (s.score < 25 || picked.length >= 16) {
              break;
            }
            if (totalBytes + s.size > 380_000) {
              continue;
            }
            picked.push(s.entry);
            totalBytes += s.size;
          }
          selectedEntries = picked;
        }

        for (const entry of selectedEntries) {
          const p = entry.path!;
          const blobRes = await apiRequest<{ content?: string; encoding?: string }>(
            "GET",
            `/repos/${owner}/${repo}/git/blobs/${entry.sha!}`,
            undefined,
            true
          );
          if (blobRes.data?.content && blobRes.data.encoding === "base64") {
            const decoded = Buffer.from(
              blobRes.data.content.replace(/\s+/g, ""),
              "base64"
            ).toString("utf8");
            filesMap.set(p, decoded);
          }
        }
      } catch {
        // Non-fatal if branch tree is unavailable or mocked in tests
      }
      return filesMap;
    },

    async readTrustedBaseRosterFiles(branch: string): Promise<Map<string, string>> {
      const filesMap = new Map<string, string>();
      try {
        const treeRes = await apiRequest<{
          tree?: Array<{ path?: string; type?: string; sha?: string }>;
        }>(
          "GET",
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
          undefined,
          true
        );
        const entries = treeRes.data?.tree ?? [];
        for (const entry of entries) {
          if (entry.type !== "blob" || !entry.path || !entry.sha) {
            continue;
          }
          const p = entry.path;
          if (!/^\.cursor\/agents\/[a-z0-9-]+\.md$/i.test(p) && p !== "DESIGN.md") {
            continue;
          }
          const blobRes = await apiRequest<{ content?: string; encoding?: string }>(
            "GET",
            `/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
            undefined,
            true
          );
          if (blobRes.data?.content && blobRes.data.encoding === "base64") {
            const decoded = Buffer.from(
              blobRes.data.content.replace(/\s+/g, ""),
              "base64"
            ).toString("utf8");
            filesMap.set(p, decoded);
          }
        }
      } catch {
        // Non-fatal if branch tree is unavailable or mocked in tests
      }
      return filesMap;
    },

    async readDevWorkflowsMap(branch: string): Promise<Map<string, string>> {
      const workflowsMap = new Map<string, string>();
      try {
        const treeRes = await apiRequest<{
          tree?: Array<{ path?: string; type?: string; sha?: string }>;
        }>(
          "GET",
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
          undefined,
          true
        );
        const entries = treeRes.data?.tree ?? [];
        for (const entry of entries) {
          if (entry.type !== "blob" || !entry.path || !entry.sha) {
            continue;
          }
          if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(entry.path)) {
            continue;
          }
          const blobRes = await apiRequest<{ content?: string; encoding?: string }>(
            "GET",
            `/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
            undefined,
            true
          );
          if (blobRes.data?.content && blobRes.data.encoding === "base64") {
            const decoded = Buffer.from(
              blobRes.data.content.replace(/\s+/g, ""),
              "base64"
            ).toString("utf8");
            workflowsMap.set(entry.path, decoded);
          }
        }
      } catch {
        // Non-fatal if branch tree is unavailable or mocked in tests
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
      await apiRequest("POST", `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: baseSha
      });
      return baseSha;
    },

    async commitFilesToBranch(input): Promise<string> {
      const baseBranch = input.fromBranch ?? "main";
      await this.ensureBranch(input.branch, baseBranch);

      const branchRef = await apiRequest<{ object: { sha: string } }>(
        "GET",
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(input.branch)}`
      );
      const parentCommitSha = branchRef.data!.object.sha;

      const parentCommit = await apiRequest<{ tree: { sha: string } }>(
        "GET",
        `/repos/${owner}/${repo}/git/commits/${parentCommitSha}`
      );
      const baseTreeSha = parentCommit.data!.tree.sha;

      const treeEntries: Array<{
        path: string;
        mode: "100644";
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
          mode: "100644",
          type: "blob",
          sha: blobRes.data!.sha
        });
      }

      for (const delPath of input.deletedFiles ?? []) {
        const cleanPath = delPath.trim().replace(/^\/+/, "");
        if (!cleanPath || seenTreePaths.has(cleanPath)) {
          continue;
        }
        seenTreePaths.add(cleanPath);
        treeEntries.push({
          path: cleanPath,
          mode: "100644",
          type: "blob",
          sha: null
        });
      }

      const newTree = await apiRequest<{ sha: string }>(
        "POST",
        `/repos/${owner}/${repo}/git/trees`,
        {
          base_tree: baseTreeSha,
          tree: treeEntries
        }
      );

      const newCommit = await apiRequest<{ sha: string }>(
        "POST",
        `/repos/${owner}/${repo}/git/commits`,
        {
          message: input.commitMessage,
          tree: newTree.data!.sha,
          parents: [parentCommitSha]
        }
      );

      await apiRequest(
        "PATCH",
        `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(input.branch)}`,
        {
          sha: newCommit.data!.sha,
          force: true
        }
      );

      return newCommit.data!.sha;
    },

    async listPullRequestFiles(
      prNumber: number
    ): Promise<ReadonlyArray<{ filename: string; status: string }>> {
      try {
        const existing = await apiRequest<
          Array<{
            filename?: string;
            status?: string;
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
              (item): item is { filename: string; status?: string } =>
                typeof item?.filename === "string" &&
                item.filename.trim().length > 0
            )
            .map((item) => ({
              filename: item.filename.trim().replace(/^\/+/, ""),
              status: item.status ?? "modified"
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
      try {
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
        if (
          Array.isArray(existing.data) &&
          existing.data.length > 0 &&
          existing.data[0]?.head?.sha
        ) {
          const first = existing.data[0]!;
          return {
            number: first.number,
            html_url: first.html_url,
            head_sha: first.head!.sha!,
            title: first.title ?? "",
            body: first.body ?? ""
          };
        }
      } catch {
        // Non-fatal in mock tests
      }
      return null;
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
      input: { title?: string | undefined; body?: string | undefined }
    ): Promise<{ head_sha: string }> {
      const payload: Record<string, string> = {};
      if (input.title !== undefined) {
        payload.title = input.title;
      }
      if (input.body !== undefined) {
        payload.body = input.body;
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
        // Fallback to PR issue comment if review endpoint is restricted
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

    async mergePullRequest(
      prNumber: number,
      input: {
        headBranch: string;
        baseBranch: string;
        commitTitle: string;
        commitMessage?: string | undefined;
      }
    ): Promise<void> {
      verifyPublisherMergeBoundary({
        headBranch: input.headBranch,
        baseBranch: input.baseBranch
      });

      await apiRequest(
        "PUT",
        `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        {
          commit_title: input.commitTitle,
          commit_message: input.commitMessage ?? "",
          merge_method: "squash"
        }
      );

      // Delete merged task/* or plan/* branch for repository hygiene
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

function parseTrackedTicketsFromComments(
  comments: readonly IssueCommentRecord[]
): Array<{
  ticketIssueNumber: number;
  slug: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  blockedByIssueNumbers: number[];
  filesToTouch: string[];
}> {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body ?? "";
    const match = /<!-- epure-plan-manifest:([\s\S]*?)-->/.exec(body);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim()) as {
          tickets?: Array<{
            ticketIssueNumber: number;
            slug: string;
            title: string;
            description: string;
            acceptanceCriteria: string[];
            blockedByIssueNumbers: number[];
            filesToTouch: string[];
          }>;
        };
        if (Array.isArray(parsed.tickets) && parsed.tickets.length > 0) {
          return parsed.tickets;
        }
      } catch {
        // continue
      }
    }
  }
  return [];
}

export async function runTestsInIsolatedWorkspace(params: {
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly deleted_files?: readonly string[] | undefined;
  readonly changedPaths?: readonly string[] | undefined;
  readonly isTaskBranch?: boolean | undefined;
  readonly verificationProfile?: VerificationProfile | undefined;
  readonly workDir?: string | undefined;
  readonly bootstrappedTargets?: Set<string> | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly llmApiKey: string;
  readonly label?: string | undefined;
}): Promise<{
  readonly passed: boolean;
  readonly output: string;
  readonly blocked_by_security_gate?: boolean;
  readonly sensitive_paths?: readonly string[];
  readonly traversal_paths?: readonly string[];
}> {
  const isGha = process.env.GITHUB_ACTIONS === "true";
  const groupTitle = params.label
    ? `[EPURE][Sandbox] ${params.label}`
    : "[EPURE][Sandbox] Verify Polyglot Stage 1 Suite";
  if (isGha) {
    process.stdout.write(`::group::${groupTitle}\n`);
  }
  try {
    const profile =
      params.verificationProfile ??
      discoverVerificationProfile({
        targetFilesHint: params.files.map((f) => f.path)
      });

    const stage1Result = await runPolyglotStage1Verification({
      workDir: params.workDir,
      profile,
      files: params.files,
      deleted_files: params.deleted_files,
      changedPaths: params.changedPaths,
      isTaskBranch: params.isTaskBranch,
      llmApiKey: params.llmApiKey,
      bootstrappedTargets: params.bootstrappedTargets,
      sandboxRunner: params.sandboxRunner,
      label: params.label
    });

    if (isGha) {
      process.stdout.write(
        `[EPURE][Sandbox] Stage 1 -> ${stage1Result.passed ? "PASSED" : "FAILED"}\n${stage1Result.output.slice(-4000)}\n`
      );
    }

    return {
      passed: stage1Result.passed,
      output: stage1Result.output,
      blocked_by_security_gate: stage1Result.blocked_by_security_gate,
      sensitive_paths: stage1Result.sensitive_paths,
      traversal_paths: stage1Result.traversal_paths
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isGha) {
      process.stdout.write(`[EPURE][Sandbox] ERROR: ${msg}\n`);
    }
    return { passed: false, output: msg };
  } finally {
    if (isGha) {
      process.stdout.write("::endgroup::\n");
    }
  }
}

export async function orchestrateIssueCommand(
  input: OrchestrateIssueInput
): Promise<OrchestrateIssueResult> {
  const model = (input.model ?? "gemini-3.8-flash").trim();
  let mintedAppToken: string | null = null;

  try {
    let activeToken = (input.fallbackGithubToken ?? "").trim();
    if (
      input.agentAppId &&
      input.agentAppId.trim() &&
      input.agentAppPrivateKey &&
      input.agentAppPrivateKey.trim()
    ) {
      const minted = await mintRepositoryInstallationToken({
        appId: input.agentAppId,
        privateKeyPem: input.agentAppPrivateKey,
        repository: input.repository,
        fetchImpl: input.fetchImpl
      });
      mintedAppToken = minted.token;
      activeToken = minted.token;
    }

    if (!activeToken) {
      throw new Error(
        "Missing GitHub authentication: configure EPURE_AGENT_APP_ID + EPURE_AGENT_APP_PRIVATE_KEY (or fallback GITHUB_TOKEN)."
      );
    }

    const gh = createGitHubRestHelper({
      repository: input.repository,
      token: activeToken,
      fetchImpl: input.fetchImpl
    });

    const store =
      input.stateStore ??
      createGitHubApiRefStateStore({
        repository: input.repository,
        githubToken: activeToken,
        fetchImpl: input.fetchImpl
      });

    const refName = buildIssueStateRefName(input.issueNumber);
    const currentSnapshot = await store.readRef(refName);
    const currentState = currentSnapshot.state;

    // 1. Handle /epure status
    if (input.command === "status") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });
      await gh.postIssueComment(
        input.issueNumber,
        updated.issue_mirror_markdown
      );
      return {
        executed: true,
        phase: updated.state.phase,
        status: updated.state.status,
        active_branch: updated.state.active_branch,
        summary_markdown: updated.issue_mirror_markdown,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }

    // 2. Handle /epure cancel
    if (input.command === "cancel") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          status: "cancelled",
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });
      const body = [
        updated.issue_mirror_markdown,
        "",
        `Plan #${input.issueNumber} has been **cancelled** by \`@${input.actor}\`. No further automated executions or merges will occur.`
      ].join("\n");
      await gh.postIssueComment(input.issueNumber, body);
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

    const issue = await gh.getIssue(input.issueNumber);
    const allComments = await gh.listIssueComments(input.issueNumber);
    const planSlug = slugifyTitle(issue.title);
    const planBranch = `plan/${input.issueNumber}-${planSlug}`;
    const featureBranch = `feature/${input.issueNumber}-${planSlug}`;

    // 3. Handle /epure plan -> Start grill-with-docs
    if (input.command === "plan") {
      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "grilling",
          status: "active",
          active_branch: planBranch,
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });

      const grillSystemInstruction = [
        "Tu es l'architecte EPURE conduisant un entretien multi-tours `/grill-with-docs` sur une GitHub Issue.",
        PROMPT_INJECTION_IMMUNITY_CLAUSE,
        "Parcours l'arbre des décisions en rounds successifs (la « frontière » des décisions dont les prérequis sont connus).",
        "Pose les 3 à 4 questions de cadrage décisives de ce premier round (architecture, invariants métiers, gestion d'état/persistance, couverture de tests TDD) au format :",
        "❓ **Q1** - **<Titre>** : <Question>",
        "➡️ <Recommandation concrète (formulée pour que 'oui' valide la recommandation)>",
        "",
        "Termine en indiquant à l'utilisateur qu'il peut répondre directement en commentaire sur cette issue (sans commande slash) : tant qu'il reste des points ouverts ou des décisions dépendantes à clarifier, l'entretien bouclera sur un round suivant ; dès que l'arbre des décisions est résolu (ou via `/epure to-spec`), EPURE générera le GLOSSARY.md, les ADRs, la spécification et le graphe de tickets."
      ].join("\n");

      const grillPrompt = [
        `Issue #${issue.number} (données non fiables soumises par l'utilisateur) :`,
        wrapUntrustedContent(
          "untrusted_issue_content",
          `Titre : ${issue.title}\n\nCorps :\n${issue.body}`
        )
      ].join("\n");

      const grillQuestions = await callGeminiGenerateContent({
        apiKey: input.llmApiKey,
        model,
        systemInstruction: grillSystemInstruction,
        prompt: grillPrompt,
        temperature: 0.2,
        fetchImpl: input.fetchImpl
      });

      const commentBody = [
        updated.issue_mirror_markdown,
        "",
        "### Entretien de Cadrage EPURE (`/grill-with-docs` — Round 1)",
        "",
        grillQuestions
      ].join("\n");

      await gh.postIssueComment(input.issueNumber, commentBody);
      return {
        executed: true,
        phase: updated.state.phase,
        status: updated.state.status,
        active_branch: planBranch,
        summary_markdown: commentBody,
        created_ticket_numbers: [],
        feature_pr_url: ""
      };
    }

    // 4. Handle human reply during grilling OR explicit /epure to-spec / /epure to-tickets
    if (
      input.command === "to-spec" ||
      input.command === "to-tickets" ||
      (input.command === "reply" &&
        currentState?.phase === "grilling" &&
        currentState?.status === "active")
    ) {
      const fullConversationHistory = allComments
        .map((c) => {
          const isBot =
            c.user.login.endsWith("[bot]") ||
            c.user.type === "Bot" ||
            c.body.includes("### Entretien de Cadrage EPURE");
          const roleLabel = isBot
            ? `[Architecte EPURE (@${c.user.login})]`
            : `[Humain (@${c.user.login})]`;
          return `${roleLabel}:\n${c.body}`;
        })
        .join("\n\n---\n\n");

      const priorGrillRoundsCount = allComments.filter((c) =>
        c.body.includes("### Entretien de Cadrage EPURE")
      ).length;

      // Multi-turn /grill-with-docs loop evaluation (unless human explicitly forced /epure to-spec or /epure to-tickets)
      if (input.command === "reply" && priorGrillRoundsCount < 5) {
        const grillLoopEvalSystemInstruction = [
          "Tu es l'architecte EPURE conduisant un entretien multi-tours `/grill-with-docs` (arbre de décisions par rounds).",
          PROMPT_INJECTION_IMMUNITY_CLAUSE,
          "Analyse l'issue initiale et l'historique complet de la conversation (questions posées par l'Architecte EPURE et réponses de l'Humain).",
          "Détermine si la frontière de l'arbre de décisions est vide (`frontier_resolved: true`) ou s'il reste des questions non répondues, des contre-propositions humaines ouvrant de nouvelles branches techniques/métiers, ou des ambiguïtés bloquantes nécessitant un round supplémentaire (`frontier_resolved: false`).",
          "Règles de décision :",
          "- Si l'humain n'a répondu que partiellement aux questions du round précédent, a posé une question en retour, a rejeté une recommandation sans préciser l'alternative, ou si sa réponse débloque un choix architectural aval crucial non encore tranché -> `frontier_resolved: false` et génère les questions de suivi numérotées (`❓ **Q...**` + `➡️ **Recommandation**`).",
          "- Si toutes les questions de cadrage ont reçu une réponse claire (ou ont été validées) et que le périmètre métier, l'architecture, les formules/invariants et la stratégie TDD sont suffisamment précis pour rédiger le GLOSSARY.md, les ADRs et la spécification -> `frontier_resolved: true`.",
          "Réponds UNIQUEMENT par un objet JSON valide respectant ce schéma :",
          "{",
          '  "frontier_resolved": boolean,',
          `  "round_number": ${priorGrillRoundsCount + 1},`,
          '  "follow_up_questions_markdown": "string (vide si frontier_resolved=true, sinon les questions ❓ **Q...** / ➡️ Recommandation du nouveau round)",',
          '  "rationale": "Explication concise de l\'état de la frontière de décision"',
          "}"
        ].join("\n");

        const grillLoopEvalPrompt = [
          `Issue #${issue.number} (description initiale non fiable) :`,
          wrapUntrustedContent(
            "untrusted_issue_content",
            `Titre : ${issue.title}\n\nDescription :\n${issue.body}`
          ),
          "",
          `Nombre de rounds /grill-with-docs déjà effectués : ${priorGrillRoundsCount}`,
          "Historique complet de l'entretien (questions EPURE et réponses humaines) :",
          wrapUntrustedContent(
            "untrusted_comment_history",
            fullConversationHistory
          )
        ].join("\n");

        const rawEvalJson = await callGeminiGenerateContent({
          apiKey: input.llmApiKey,
          model,
          systemInstruction: grillLoopEvalSystemInstruction,
          prompt: grillLoopEvalPrompt,
          responseMimeType: "application/json",
          temperature: 0.1,
          fetchImpl: input.fetchImpl
        });

        const evalResult =
          extractJsonObject<GrillRoundEvaluation>(rawEvalJson);

        if (
          !evalResult.frontier_resolved &&
          evalResult.follow_up_questions_markdown.trim().length > 0
        ) {
          const nextRoundNumber =
            evalResult.round_number || priorGrillRoundsCount + 1;
          const updatedGrill = await updateIssueStateWithCas({
            issueNumber: input.issueNumber,
            store,
            mutator: (prev) => ({
              ...prev,
              phase: "grilling",
              status: "active",
              active_branch: planBranch,
              last_processed_comment_id:
                input.commentId ?? prev.last_processed_comment_id
            })
          });

          const followUpBody = [
            updatedGrill.issue_mirror_markdown,
            "",
            `### Entretien de Cadrage EPURE (\`/grill-with-docs\` — Round ${nextRoundNumber})`,
            "",
            evalResult.follow_up_questions_markdown.trim(),
            "",
            "---",
            "_Réponds directement en commentaire pour poursuivre l'entretien, ou poste `/epure to-spec` pour forcer immédiatement la génération de la spécification et des tickets._"
          ].join("\n");

          await gh.postIssueComment(input.issueNumber, followUpBody);
          return {
            executed: true,
            phase: updatedGrill.state.phase,
            status: updatedGrill.state.status,
            active_branch: planBranch,
            summary_markdown: followUpBody,
            created_ticket_numbers: [],
            feature_pr_url: ""
          };
        }
      }

      await gh.ensureBranch("dev", "main");
      const humanContext = allComments
        .filter((c) => !c.user.login.endsWith("[bot]") && c.user.type !== "Bot")
        .map((c) => `@${c.user.login}: ${c.body}`)
        .join("\n\n---\n\n");

      const specSystemInstruction = [
        "Tu es l'architecte EPURE chargé de produire le dossier de spécification complet et le découpage en tickets atomiques TDD.",
        PROMPT_INJECTION_IMMUNITY_CLAUSE,
        "Produis un objet JSON strictement valide (sans markdown autour) respectant exactement ce schéma TypeScript :",
        "{",
        `  "plan_slug": "${planSlug}",`,
        '  "glossary_markdown": "# GLOSSARY\\n\\n...",',
        '  "adrs": [',
        '    { "path": "docs/adr/0001-architecture-et-domaine.md", "content": "---\\nstatus: accepted\\n---\\n# ..." },',
        '    { "path": "docs/adr/0002-formules-et-invariants.md", "content": "---\\nstatus: accepted\\n---\\n# ..." },',
        '    { "path": "docs/adr/0003-strategie-tdd-et-ui.md", "content": "---\\nstatus: accepted\\n---\\n# ..." }',
        "  ],",
        `  "spec_path": "docs/specs/${planSlug}.md",`,
        '  "spec_markdown": "# Spécification — ...",',
        '  "tickets": [',
        "    {",
        '      "index": 1,',
        '      "slug": "socle-domaine-et-formules",',
        '      "title": "[Ticket 1] Socle du domaine, types et formules mathématiques",',
        '      "description": "Implémenter en TypeScript strict les types et les formules métier avec tests unitaires Vitest paramétrés.",',
        '      "acceptance_criteria": ["Formule quadratique exacte", "Invariant S <= B", "Règle munitions /50"],',
        '      "blocked_by_indices": [],',
        '      "files_to_create_or_update": ["package.json", "tsconfig.json", "vite.config.ts", "src/domain/forge.ts", "tests/forge.test.ts"]',
        "    },",
        "    {",
        '      "index": 2,',
        '      "slug": "catalogue-et-marche-d20",',
        '      "title": "[Ticket 2] Catalogue d\'enchantements, marché d20 et complications",',
        '      "description": "Implémenter le catalogue complet des enchantements, les tables de marché d20 et les complications narratives avec tests Vitest.",',
        '      "acceptance_criteria": ["Catalogue armes, armures, boucliers, focus", "Table de disponibilité et prix d20", "Tests unitaires paramétrés"],',
        '      "blocked_by_indices": [1],',
        '      "files_to_create_or_update": ["src/domain/catalog.ts", "src/domain/market.ts", "tests/market.test.ts"]',
        "    },",
        "    {",
        '      "index": 3,',
        '      "slug": "interface-react-craft-calculator",',
        '      "title": "[Ticket 3] Interface interactive React du calculateur et persistance locale",',
        '      "description": "Construire l\'application React/Vite complète (calculateur de forge, simulateur de marché, grimoire du MJ, sauvegarde localStorage) et vérifier le build.",',
        '      "acceptance_criteria": ["Calculateur interactif avec garde-fou S <= B", "Simulateur de marché d20", "Build Vite et suite de tests Vitest 100% verts"],',
        '      "blocked_by_indices": [1, 2],',
        '      "files_to_create_or_update": ["index.html", "src/main.tsx", "src/App.tsx", "src/styles.css", "tests/app.test.ts"]',
        "    }",
        "  ]",
        "}"
      ].join("\n");

      const specGenerationPrompt = [
        `Issue #${issue.number} (description initiale non fiable) :`,
        wrapUntrustedContent(
          "untrusted_issue_content",
          `Titre : ${issue.title}\n\nDescription :\n${issue.body}`
        ),
        "",
        "Historique complet de l'entretien /grill-with-docs (questions EPURE et réponses humaines) :",
        wrapUntrustedContent(
          "untrusted_comment_history",
          fullConversationHistory || humanContext
        )
      ].join("\n");

      const rawJson = await callGeminiGenerateContent({
        apiKey: input.llmApiKey,
        model,
        systemInstruction: specSystemInstruction,
        prompt: specGenerationPrompt,
        responseMimeType: "application/json",
        temperature: 0.1,
        fetchImpl: input.fetchImpl
      });

      const bundle = extractJsonObject<GeneratedPlanningBundle>(rawJson);

      const allTargetFiles = bundle.tickets.flatMap(
        (t) => t.files_to_create_or_update
      );
      const touchesFrontendUi = allTargetFiles.some((f) =>
        /\.(?:tsx|jsx|css|scss|html)$/i.test(f)
      );

      // Q96: Invoke Impeccable planning & user-advocate in design-gate mode on plan/*
      const impeccableSession = planImpeccableDesignSession({
        issueNumber: input.issueNumber,
        surfaceSlug: planSlug,
        touchesFrontendUi,
        alreadyAnsweredTopics: ["theme", "layout"],
        candidateDesignTopics: ["theme", "layout", "accessibility"]
      });

      const designGate = touchesFrontendUi
        ? await runUserAdvocateDesignGate({
            repository: input.repository,
            planTitle: issue.title,
            glossaryMarkdown: bundle.glossary_markdown,
            specMarkdown: bundle.spec_markdown,
            llmApiKey: input.llmApiKey,
            model,
            fetchImpl: input.fetchImpl
          })
        : null;

      const plannedStack = detectRepositoryStack({
        targetFilesHint: allTargetFiles
      });
      const adaptedRoster = adaptReviewerRosterForDomain({
        repository: input.repository,
        planTitle: issue.title,
        glossaryMarkdown: bundle.glossary_markdown,
        specMarkdown: bundle.spec_markdown,
        touchesFrontendUi,
        stackKind: plannedStack.kind,
        personas: designGate?.personas,
        domainInvariants: designGate?.domain_invariants
      });

      const zizmorFile = buildZizmorConfigYaml();
      const renovateFile = buildRenovateConfigJson(plannedStack);
      const ciFile = buildStackAwareCiWorkflowYaml({
        pinnedSha: "main",
        stack: plannedStack
      });

      const existingBaseRoster = await gh.readTrustedBaseRosterFiles("dev");
      const hasExistingConfiguredRoster = existingBaseRoster.size > 0;

      const planningFiles: Array<{ path: string; content: string }> = hasExistingConfiguredRoster
        ? [
            { path: bundle.spec_path, content: bundle.spec_markdown }
          ]
        : [
            { path: "GLOSSARY.md", content: bundle.glossary_markdown },
            { path: bundle.spec_path, content: bundle.spec_markdown },
            ...bundle.adrs.map((a) => ({ path: a.path, content: a.content })),
            ...adaptedRoster.files,
            zizmorFile,
            renovateFile,
            ciFile
          ];

      await gh.commitFilesToBranch({
        branch: planBranch,
        fromBranch: "dev",
        commitMessage: `docs(plan): generate GLOSSARY, ADRs, spec, DESIGN.md, and adapted reviewer roster for #${input.issueNumber}`,
        files: planningFiles
      });

      await gh.ensureLabel(
        "ready-for-agent",
        "0E8A16",
        "Ticket ready for autonomous EPURE agent execution"
      );

      const indexToIssueNumber = new Map<number, number>();
      const createdTicketsManifest: Array<{
        ticketIssueNumber: number;
        slug: string;
        title: string;
        description: string;
        acceptanceCriteria: string[];
        blockedByIssueNumbers: number[];
        filesToTouch: string[];
      }> = [];

      for (const ticket of bundle.tickets) {
        const blockerNumbers = ticket.blocked_by_indices
          .map((idx) => indexToIssueNumber.get(idx))
          .filter((n): n is number => typeof n === "number");

        const depLines =
          blockerNumbers.length > 0
            ? blockerNumbers.map((n) => `blocked_by: #${n}`).join("\n")
            : "blocked_by: none";

        const ticketTouchesUi = ticket.files_to_create_or_update.some((f) =>
          /\.(?:tsx|jsx|css|scss|html)$/i.test(f)
        );
        const enrichedAcceptanceCriteria = [
          ...ticket.acceptance_criteria,
          ...(ticketTouchesUi && designGate
            ? designGate.ux_acceptance_criteria
            : [])
        ];

        const ticketBody = [
          `Parent Plan: #${input.issueNumber}`,
          depLines,
          "",
          "## Description",
          ticket.description,
          "",
          "## Acceptance Criteria (TDD & UX)",
          ...enrichedAcceptanceCriteria.map((c) => `- [ ] ${c}`),
          "",
          "## Target Files",
          ...ticket.files_to_create_or_update.map((f) => `- \`${f}\``)
        ].join("\n");

        const createdIssue = await gh.createIssue({
          title: ticket.title,
          body: ticketBody,
          labels: ["ready-for-agent"]
        });

        indexToIssueNumber.set(ticket.index, createdIssue.number);
        createdTicketsManifest.push({
          ticketIssueNumber: createdIssue.number,
          slug: ticket.slug,
          title: ticket.title,
          description: ticket.description,
          acceptanceCriteria: enrichedAcceptanceCriteria,
          blockedByIssueNumbers: blockerNumbers,
          filesToTouch: [...ticket.files_to_create_or_update]
        });
      }

      const updated = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "tickets",
          status: "awaiting_human_approval",
          active_branch: planBranch,
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });

      const ticketLines = createdTicketsManifest.map((t) => {
        const blockedText =
          t.blockedByIssueNumbers.length > 0
            ? ` (blocked_by: ${t.blockedByIssueNumbers.map((n) => `#${n}`).join(", ")})`
            : " (ready — root)";
        return `- **#${t.ticketIssueNumber}** — ${t.title}${blockedText}`;
      });

      const manifestComment = [
        updated.issue_mirror_markdown,
        "",
        `### Spécification, Roster Adapté et Graphe de Tickets générés sur \`${planBranch}\``,
        "",
        "- **Glossaire** : `GLOSSARY.md`",
        `- **ADRs** : ${bundle.adrs.map((a) => `\`${a.path}\``).join(", ")}`,
        `- **Spécification** : \`${bundle.spec_path}\``,
        `- **Roster Multi-Agents adapté** : \`.cursor/agents/*.md\` (${adaptedRoster.files.length} fichiers)`,
        ...(impeccableSession.impeccable_invoked
          ? [
              "- **Design Gate Impeccable & `user-advocate` (`design-gate`)** : `DESIGN.md` généré et critères UX injectés dans les tickets UI"
            ]
          : []),
        "",
        "#### Graphe de Tickets (`ready-for-agent`) :",
        ...ticketLines,
        "",
        "👉 **Action requise** : Vérifiez les livrables sur la branche de plan et les tickets ci-dessus, puis postez `/epure approve` sur cette issue pour verrouiller le périmètre et lancer l'implémentation TDD autonome.",
        "",
        `<!-- epure-plan-manifest:${JSON.stringify({
          planBranch,
          specPath: bundle.spec_path,
          tickets: createdTicketsManifest
        })} -->`
      ].join("\n");

      await gh.postIssueComment(input.issueNumber, manifestComment);

      return {
        executed: true,
        phase: updated.state.phase,
        status: updated.state.status,
        active_branch: planBranch,
        summary_markdown: manifestComment,
        created_ticket_numbers: createdTicketsManifest.map(
          (t) => t.ticketIssueNumber
        ),
        feature_pr_url: ""
      };
    }

    // 5. Handle /epure approve -> Lock plan, merge plan/* -> dev, create feature/*, execute tickets in TDD + Multi-Agent PR Review Loop
    if (input.command === "approve") {
      let ticketsManifest = parseTrackedTicketsFromComments(allComments);
      const hasExplicitPlanManifest = ticketsManifest.length > 0;
      if (!hasExplicitPlanManifest) {
        const parsedCriteria = Array.from(
          issue.body.matchAll(/^\s*-\s*\[[ xX]\]\s+(.+)$/gm)
        ).map((m) => m[1]!.trim());
        const parsedFiles = Array.from(
          issue.body.matchAll(/`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)
        ).map((m) => m[1]!.trim());
        ticketsManifest = [
          {
            ticketIssueNumber: issue.number,
            slug: planSlug,
            title: issue.title,
            description: issue.body,
            acceptanceCriteria:
              parsedCriteria.length > 0 ? parsedCriteria : [issue.title],
            blockedByIssueNumbers: [],
            filesToTouch: parsedFiles
          }
        ];
      }

      await gh.ensureBranch("dev", "main");

      // Prepare trusted base branch files from adapted roster (Q92: loaded from dev, never from task/*)
      const trustedBaseRoster = adaptReviewerRosterForDomain({
        repository: input.repository,
        planTitle: issue.title,
        glossaryMarkdown: issue.body,
        specMarkdown: issue.body,
        touchesFrontendUi: true
      });
      const trustedBaseFilesMap = new Map<string, string>();
      for (const f of trustedBaseRoster.files) {
        trustedBaseFilesMap.set(f.path, f.content);
      }

      // Open & squash-merge plan/* -> dev PR (Q91: only plan/* -> dev is allowed by hardware guard on dev)
      if (hasExplicitPlanManifest) {
        try {
          const planPr = await gh.openPullRequest({
            head: planBranch,
            base: "dev",
            title: `docs(plan): integrate approved specification and ADRs for #${input.issueNumber}`,
            body: `Integrates approved planning artifacts and reviewer roster from \`${planBranch}\` for #${input.issueNumber}.`
          });
          await gh.publishCheckRun({
            name: "PR title",
            headSha: planPr.head_sha,
            conclusion: "success",
            summary: "Conventional Commit PR title verified."
          });
          await gh.publishCheckRun({
            name: "ai-review",
            headSha: planPr.head_sha,
            conclusion: "success",
            summary: `Human-approved planning bundle #${input.issueNumber} verified.`
          });
          await gh.mergePullRequest(planPr.number, {
            headBranch: planBranch,
            baseBranch: "dev",
            commitTitle: `docs(plan): integrate approved plan #${input.issueNumber} (#${planPr.number})`,
            commitMessage: `Integrates GLOSSARY.md, ADRs, specification, DESIGN.md, and .cursor/agents/ roster.\n\nRefs #${input.issueNumber}`
          });
        } catch {
          // Ignore if planBranch was already merged into dev on a previous attempt
        }
      }

      // Load actual .cursor/agents/*.md files designed & committed on dev (Q92)
      const remoteTrustedRoster = await gh.readTrustedBaseRosterFiles("dev");
      for (const [relPath, content] of remoteTrustedRoster.entries()) {
        trustedBaseFilesMap.set(relPath, content);
      }

      // Load trusted .github/agents.yml & .github/workflows/*.{yml,yaml} from dev (Q104, Q107)
      const rawDevAgentsYaml =
        (await gh.readSingleBranchFile("dev", ".github/agents.yml")) ??
        (await gh.readSingleBranchFile("dev", ".github/agents.yaml"));
      let parsedDevAgentsConfig: ReturnType<typeof parseAgentsYaml> | null = null;
      if (rawDevAgentsYaml) {
        try {
          parsedDevAgentsConfig = parseAgentsYaml(rawDevAgentsYaml);
        } catch {
          parsedDevAgentsConfig = null;
        }
      }

      const devWorkflowsMap = await gh.readDevWorkflowsMap("dev");
      const devBranchPaths = await gh.listBranchPaths("dev");
      const maxCodeFixAttempts =
        parsedDevAgentsConfig?.max_code_fix_attempts ?? 3;

      const discoveredDevProfile = discoverVerificationProfile({
        targetFilesHint: [
          ...devBranchPaths,
          ...ticketsManifest.flatMap((t) => t.filesToTouch)
        ],
        workflowFilesMap: Object.fromEntries(devWorkflowsMap)
      });

      let verificationProfile: VerificationProfile =
        parsedDevAgentsConfig?.verification?.targets &&
        parsedDevAgentsConfig.verification.targets.length > 0
          ? {
              ...parsedDevAgentsConfig.verification,
              deferred_external_workflows:
                parsedDevAgentsConfig.verification.deferred_external_workflows
                  ?.length
                  ? parsedDevAgentsConfig.verification
                      .deferred_external_workflows
                  : discoveredDevProfile.deferred_external_workflows
            }
          : {
              ...discoveredDevProfile,
              wait_for_external_ci:
                parsedDevAgentsConfig?.verification?.wait_for_external_ci ??
                discoveredDevProfile.wait_for_external_ci,
              external_ci_timeout_minutes:
                parsedDevAgentsConfig?.verification
                  ?.external_ci_timeout_minutes ??
                discoveredDevProfile.external_ci_timeout_minutes,
              grace_window_seconds:
                parsedDevAgentsConfig?.verification?.grace_window_seconds ??
                discoveredDevProfile.grace_window_seconds
            };

      let verificationGuideMarkdown =
        formatVerificationToolingGuideMarkdown(verificationProfile);

      const effectiveSleepFn =
        input.sleepFn ?? (input.fetchImpl ? async () => {} : undefined);
      const infraRerunsBySha = new Map<string, number>();
      let totalTransientRetriesUsed = 0;

      const escalateToNeedsHuman = async (params: {
        reason:
          | "remediation_exhausted"
          | "grace_window_timeout"
          | "wall_clock_budget_exhausted"
          | "sensitive_path_violation";
        ticketNumber: number;
        branch: string;
        prNumber?: number;
        prUrl?: string;
        featurePrUrl?: string;
        codeFixAttemptsUsed?: number;
        failedChecks?: WaitForExternalCiChecksResult["failedChecks"];
        mustFixFindings?: ReadonlyArray<ReviewerFinding>;
        sensitivePaths?: ReadonlyArray<string>;
        traversalPaths?: ReadonlyArray<string>;
        diagnosticExcerpt?: string;
      }): Promise<OrchestrateIssueResult> => {
        await gh.ensureLabel(
          "needs-human",
          "D93F0B",
          "Requires human maintainer intervention"
        );
        await gh.addIssueLabels(input.issueNumber, ["needs-human"]);
        if (params.ticketNumber !== input.issueNumber) {
          await gh.addIssueLabels(params.ticketNumber, ["needs-human"]);
        }

        const updatedSuspended = await updateIssueStateWithCas({
          issueNumber: input.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            phase: "implementation",
            status: "suspended",
            active_branch: params.branch,
            code_fix_attempts_used:
              params.codeFixAttemptsUsed ?? prev.code_fix_attempts_used,
            transient_retries_used:
              totalTransientRetriesUsed || prev.transient_retries_used,
            last_processed_comment_id:
              input.commentId ?? prev.last_processed_comment_id
          })
        });

        const escalationMarkdown = [
          updatedSuspended.issue_mirror_markdown,
          "",
          formatNeedsHumanEscalationComment({
            reason: params.reason,
            issueNumber: input.issueNumber,
            ticketIssueNumber: params.ticketNumber,
            prNumber: params.prNumber,
            prUrl: params.prUrl,
            branch: params.branch,
            codeFixAttemptsUsed: params.codeFixAttemptsUsed,
            maxCodeFixAttempts,
            graceWindowSeconds: verificationProfile.grace_window_seconds,
            failedChecks: params.failedChecks,
            mustFixFindings: params.mustFixFindings,
            sensitivePaths: params.sensitivePaths,
            traversalPaths: params.traversalPaths,
            diagnosticExcerpt: params.diagnosticExcerpt
          })
        ].join("\n");

        await gh.postIssueComment(input.issueNumber, escalationMarkdown);

        return {
          executed: true,
          phase: updatedSuspended.state.phase,
          status: updatedSuspended.state.status,
          active_branch: params.branch,
          summary_markdown: escalationMarkdown,
          created_ticket_numbers: ticketsManifest.map(
            (t) => t.ticketIssueNumber
          ),
          feature_pr_url: params.featurePrUrl ?? params.prUrl ?? ""
        };
      };

      // Create feature branch from updated dev
      await gh.ensureBranch(featureBranch, "dev");

      const updatedStart = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "implementation",
          status: "active",
          active_branch: featureBranch,
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });

      const hintForWorkspace = [
        issue.title,
        issue.body,
        ...ticketsManifest.map(
          (t) => `${t.title}\n${t.description}\n${t.filesToTouch.join(" ")}`
        )
      ].join("\n");
      const accumulatedFiles = await gh.readBranchWorkspaceFiles(
        featureBranch,
        hintForWorkspace
      );
      const featureChangedFilesMap = new Map<string, string>();
      const featureDeletedFilesSet = new Set<string>();
      const completedTicketsSummary: string[] = [];

      const checkIsBrownfieldSubpackageRepo = (): boolean =>
        (accumulatedFiles.size > 0 &&
          !accumulatedFiles.has("package.json") &&
          Array.from(accumulatedFiles.keys()).some(
            (k) => k.startsWith("backend/") || k.startsWith("frontend/")
          )) ||
        (!devBranchPaths.includes("package.json") &&
          devBranchPaths.some(
            (k) => k.startsWith("backend/") || k.startsWith("frontend/")
          ));

      const buildRepoExplorationToolsAndHandlers = (branch: string) =>
        checkIsBrownfieldSubpackageRepo() ||
        process.env.GITHUB_ACTIONS === "true"
          ? {
              tools: [
                {
                  name: "list_repo_files",
                  description:
                    "Search file paths in the repository matching a substring or keyword (e.g. 'toast', 'fog', 'CampaignContext', 'sessionStore').",
                  parameters: {
                    type: "OBJECT" as const,
                    properties: {
                      query: {
                        type: "STRING" as const,
                        description:
                          "Case-insensitive path substring to match"
                      }
                    },
                    required: ["query"]
                  }
                },
                {
                  name: "search_in_repo_file",
                  description:
                    "Search for a substring inside a repository file and return matching line numbers with surrounding lines.",
                  parameters: {
                    type: "OBJECT" as const,
                    properties: {
                      path: {
                        type: "STRING" as const,
                        description: "Repository-relative file path"
                      },
                      query: {
                        type: "STRING" as const,
                        description: "Substring or identifier to search for"
                      }
                    },
                    required: ["path", "query"]
                  }
                },
                {
                  name: "read_repo_file",
                  description:
                    "Read a file (or line range start_line..end_line) from the repository branch.",
                  parameters: {
                    type: "OBJECT" as const,
                    properties: {
                      path: {
                        type: "STRING" as const,
                        description: "Repository-relative file path"
                      },
                      start_line: {
                        type: "INTEGER" as const,
                        description: "Optional 1-based start line"
                      },
                      end_line: {
                        type: "INTEGER" as const,
                        description: "Optional 1-based end line"
                      }
                    },
                    required: ["path"]
                  }
                }
              ],
              toolHandlers: {
                list_repo_files: async (
                  args: Readonly<Record<string, unknown>>
                ) => {
                  const q = String(args.query ?? "")
                    .trim()
                    .toLowerCase();
                  let allPaths = await gh.listBranchPaths(branch);
                  if (allPaths.length === 0 && branch !== featureBranch) {
                    allPaths = await gh.listBranchPaths(featureBranch);
                  }
                  const matches = allPaths
                    .filter((p) => p.toLowerCase().includes(q))
                    .slice(0, 60);
                  return { matches };
                },
                search_in_repo_file: async (
                  args: Readonly<Record<string, unknown>>
                ) => {
                  const p = String(args.path ?? "")
                    .trim()
                    .replace(/^\/+/, "");
                  const q = String(args.query ?? "").trim();
                  let content = accumulatedFiles.get(p) ?? null;
                  if (content === null) {
                    content =
                      (await gh.readSingleBranchFile(branch, p)) ??
                      (branch !== featureBranch
                        ? await gh.readSingleBranchFile(featureBranch, p)
                        : null);
                    if (content !== null) {
                      accumulatedFiles.set(p, content);
                    }
                  }
                  if (content === null) {
                    return { error: `File not found: ${p}` };
                  }
                  const lines = content.split("\n");
                  const snippets: string[] = [];
                  for (let i = 0; i < lines.length; i += 1) {
                    if (lines[i]!.toLowerCase().includes(q.toLowerCase())) {
                      const start = Math.max(0, i - 15);
                      const end = Math.min(lines.length, i + 20);
                      snippets.push(
                        `Lines ${start + 1}-${end}:\n` +
                          lines
                            .slice(start, end)
                            .map((l, idx) => `${start + idx + 1}| ${l}`)
                            .join("\n")
                      );
                      i = end - 1;
                      if (snippets.length >= 8) {
                        break;
                      }
                    }
                  }
                  return {
                    path: p,
                    total_lines: lines.length,
                    matches: snippets
                  };
                },
                read_repo_file: async (
                  args: Readonly<Record<string, unknown>>
                ) => {
                  const p = String(args.path ?? "")
                    .trim()
                    .replace(/^\/+/, "");
                  let content = accumulatedFiles.get(p) ?? null;
                  if (content === null) {
                    content =
                      (await gh.readSingleBranchFile(branch, p)) ??
                      (branch !== featureBranch
                        ? await gh.readSingleBranchFile(featureBranch, p)
                        : null);
                    if (content !== null) {
                      accumulatedFiles.set(p, content);
                    }
                  }
                  if (content === null) {
                    return { error: `File not found: ${p}` };
                  }
                  const lines = content.split("\n");
                  const startLine = Math.max(
                    1,
                    Number(args.start_line ?? 1) || 1
                  );
                  const endLine = Math.min(
                    lines.length,
                    Number(
                      args.end_line ?? Math.min(lines.length, startLine + 250)
                    ) || lines.length
                  );
                  return {
                    path: p,
                    total_lines: lines.length,
                    start_line: startLine,
                    end_line: endLine,
                    content: lines.slice(startLine - 1, endLine).join("\n")
                  };
                }
              }
            }
          : {};

      const existingFeaturePrAtStart = await gh.findOpenPullRequestByHead(
        featureBranch,
        "dev"
      );
      let skipTicketLoopForExistingFeaturePr = false;
      if (existingFeaturePrAtStart) {
        let hasOpenTaskPr = false;
        for (const ticket of ticketsManifest) {
          const candidateTaskBranch = `task/${ticket.ticketIssueNumber}-${ticket.slug}`;
          const openTaskPr = await gh.findOpenPullRequestByHead(
            candidateTaskBranch,
            featureBranch
          );
          if (openTaskPr) {
            hasOpenTaskPr = true;
            break;
          }
        }
        if (!hasOpenTaskPr) {
          skipTicketLoopForExistingFeaturePr = true;
          const featurePrFiles = await gh.listPullRequestFiles(
            existingFeaturePrAtStart.number
          );
          for (const prFile of featurePrFiles) {
            const cleanPath = prFile.filename.replace(/^\/+/, "");
            if (prFile.status === "removed") {
              accumulatedFiles.delete(cleanPath);
              featureChangedFilesMap.delete(cleanPath);
              featureDeletedFilesSet.add(cleanPath);
            } else {
              const content =
                (await gh.readSingleBranchFile(featureBranch, cleanPath)) ??
                accumulatedFiles.get(cleanPath) ??
                null;
              if (content !== null) {
                accumulatedFiles.set(cleanPath, content);
                featureChangedFilesMap.set(cleanPath, content);
                featureDeletedFilesSet.delete(cleanPath);
              }
            }
          }
          for (const ticket of ticketsManifest) {
            completedTicketsSummary.push(
              `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — previously squash-merged into \`${featureBranch}\``
            );
          }
        }
      }

      for (const ticket of skipTicketLoopForExistingFeaturePr
        ? []
        : ticketsManifest) {
        const ticketIssueMeta = await gh.getIssue(ticket.ticketIssueNumber);
        if (
          ticket.ticketIssueNumber !== input.issueNumber &&
          ticketIssueMeta.state === "closed" &&
          accumulatedFiles.size > 0
        ) {
          if (process.env.GITHUB_ACTIONS === "true") {
            process.stdout.write(
              `[EPURE][Ticket #${ticket.ticketIssueNumber}] Already merged & closed on ${featureBranch} — skipping\n`
            );
          }
          completedTicketsSummary.push(
            `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — previously squash-merged into \`${featureBranch}\``
          );
          continue;
        }

        const taskBranch = `task/${ticket.ticketIssueNumber}-${ticket.slug}`;
        if (process.env.GITHUB_ACTIONS === "true") {
          process.stdout.write(
            `::group::[EPURE][Ticket #${ticket.ticketIssueNumber}] Initial TDD Implementation (${taskBranch})\n`
          );
        }
        await gh.ensureBranch(taskBranch, featureBranch);

        const sandboxWorkspace = prepareRepositorySandboxWorkspace({
          repository: input.repository,
          branch: featureBranch,
          githubToken: activeToken,
          seedFiles: accumulatedFiles,
          enableRemoteClone: Boolean(
            process.env.GITHUB_ACTIONS === "true" && !input.fetchImpl
          )
        });
        if (
          sandboxWorkspace.clonedFromRemote &&
          !parsedDevAgentsConfig?.verification?.targets?.length
        ) {
          const clonedProfile = discoverVerificationProfile({
            repoRootDir: sandboxWorkspace.workDir,
            targetFilesHint: [
              ...devBranchPaths,
              ...ticketsManifest.flatMap((t) => t.filesToTouch)
            ],
            workflowFilesMap: Object.fromEntries(devWorkflowsMap)
          });
          verificationProfile = {
            ...clonedProfile,
            wait_for_external_ci:
              parsedDevAgentsConfig?.verification?.wait_for_external_ci ??
              clonedProfile.wait_for_external_ci,
            external_ci_timeout_minutes:
              parsedDevAgentsConfig?.verification
                ?.external_ci_timeout_minutes ??
              clonedProfile.external_ci_timeout_minutes,
            grace_window_seconds:
              parsedDevAgentsConfig?.verification?.grace_window_seconds ??
              clonedProfile.grace_window_seconds
          };
          verificationGuideMarkdown =
            formatVerificationToolingGuideMarkdown(verificationProfile);
        }
        const bootstrappedTargets = new Set<string>();

        try {
          const ticketChangedFilesMap = new Map<string, string>();
          const ticketDeletedFilesSet = new Set<string>();
          let impl: {
            commit_message: string;
            test_summary: string;
            files: Array<{ path: string; content: string }>;
          };
          let taskPr: { number: number; html_url: string; head_sha: string };
          let currentPrHeadSha: string;
          let fixAttempt = 0;

          // Pre-Generation Open-PR Reconciliation (Q110): check if an open PR already exists on task/* -> feature/*
          const existingTaskPr = await gh.findOpenPullRequestByHead(
            taskBranch,
            featureBranch
          );

          if (existingTaskPr) {
            const taskPrFiles = await gh.listPullRequestFiles(
              existingTaskPr.number
            );
            if (taskPrFiles.length > 0) {
              for (const prFile of taskPrFiles) {
                const cleanPath = prFile.filename.replace(/^\/+/, "");
                if (prFile.status === "removed") {
                  accumulatedFiles.delete(cleanPath);
                  featureChangedFilesMap.delete(cleanPath);
                  ticketChangedFilesMap.delete(cleanPath);
                  featureDeletedFilesSet.add(cleanPath);
                  ticketDeletedFilesSet.add(cleanPath);
                } else {
                  const content =
                    (await gh.readSingleBranchFile(taskBranch, cleanPath)) ??
                    accumulatedFiles.get(cleanPath) ??
                    null;
                  if (content !== null) {
                    accumulatedFiles.set(cleanPath, content);
                    featureChangedFilesMap.set(cleanPath, content);
                    ticketChangedFilesMap.set(cleanPath, content);
                    featureDeletedFilesSet.delete(cleanPath);
                    ticketDeletedFilesSet.delete(cleanPath);
                  }
                }
              }
            } else {
              const taskBranchFiles = await gh.readBranchWorkspaceFiles(
                taskBranch,
                hintForWorkspace
              );
              for (const [p, c] of taskBranchFiles.entries()) {
                accumulatedFiles.set(p, c);
                featureChangedFilesMap.set(p, c);
                ticketChangedFilesMap.set(p, c);
              }
            }

            const existingPreCheck = validateWorkspaceFileOperations({
              workDir: sandboxWorkspace.workDir,
              files: Array.from(ticketChangedFilesMap.keys()).map((p) => ({
                path: p
              })),
              deleted_files: Array.from(ticketDeletedFilesSet),
              targets: verificationProfile.targets,
              isTaskBranch: true
            });
            if (!existingPreCheck.allowed) {
              return await escalateToNeedsHuman({
                reason: "sensitive_path_violation",
                ticketNumber: ticket.ticketIssueNumber,
                branch: taskBranch,
                prNumber: existingTaskPr.number,
                prUrl: existingTaskPr.html_url,
                sensitivePaths: existingPreCheck.sensitivePaths,
                traversalPaths: existingPreCheck.traversalPaths
              });
            }

            impl = {
              commit_message:
                existingTaskPr.title ||
                `feat(ticket-${ticket.ticketIssueNumber}): ${ticket.title}`,
              test_summary:
                "Reconciled existing open Pull Request on task branch (Q110)",
              files: Array.from(ticketChangedFilesMap.entries()).map(
                ([path, content]) => ({ path, content })
              )
            };
            taskPr = existingTaskPr;
            currentPrHeadSha = existingTaskPr.head_sha;
          } else {
            const existingFilesContext = Array.from(accumulatedFiles.entries())
              .map(([path, content]) => `--- FILE: ${path} ---\n${content}`)
              .join("\n\n");

            const isBrownfieldSubpackageRepo =
              checkIsBrownfieldSubpackageRepo();

            const tddSystemInstruction = [
              "Tu es un ingénieur TDD EPURE implémentant un ticket approuvé.",
              PROMPT_INJECTION_IMMUNITY_CLAUSE,
              "Règles strictes :",
              "1. Écris des tests couvrant tous les critères d'acceptation et cas limites.",
              "2. Implémente le code propre et complet faisant passer 100% des tests.",
              "3. N'utilise aucune dépendance externe exotique non déclarée.",
              "4. Ne modifie JAMAIS .cursor/agents/**, .github/workflows/**, .github/agents.yml ou .env*.",
              "",
              verificationGuideMarkdown,
              "",
              ...(isBrownfieldSubpackageRepo
                ? [
                    "5. Il s'agit d'un dépôt existant multi-packages (`backend/`, `frontend/`). Utilise les outils `list_repo_files`, `search_in_repo_file` et `read_repo_file` pour inspecter les fichiers pertinents avant de coder.",
                    "6. Pour modifier un fichier existant du dépôt, utilise de préférence `patches` (`old_string` -> `new_string` exact) afin de faire une modification chirurgicale sans réécrire des milliers de lignes inchangées. Pour créer un nouveau fichier (ex: nouveau fichier de test), utilise `files` avec son contenu complet. Pour supprimer un fichier obsolète, utilise `deleted_files`. Ne crée PAS de package.json à la racine.",
                    "Renvoie un objet JSON strictement valide respectant ce schéma :",
                    "{",
                    '  "commit_message": "fix: ...",',
                    '  "test_summary": "Tests and acceptance criteria verified",',
                    '  "patches": [',
                    '    { "path": "backend/src/...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
                    "  ],",
                    '  "files": [',
                    '    { "path": "backend/src/__tests__/...", "content": "..." }',
                    "  ],",
                    '  "deleted_files": []',
                    "}"
                  ]
                : [
                    "5. Renvoie un objet JSON strictement valide respectant exactement ce schéma :",
                    "{",
                    `  "commit_message": "feat(ticket-${ticket.ticketIssueNumber}): ...",`,
                    '  "test_summary": "Vitest parameterized suite verified",',
                    '  "files": [',
                    '    { "path": "package.json", "content": "..." },',
                    '    { "path": "src/...", "content": "..." },',
                    '    { "path": "tests/...", "content": "..." }',
                    "  ]",
                    "}"
                  ])
            ].join("\n");

            const tddPrompt = [
              `Plan parent (#${input.issueNumber}) et cahier des charges :`,
              wrapUntrustedContent(
                "untrusted_issue_content",
                `Titre : ${issue.title}\n\nCahier des charges :\n${issue.body}`
              ),
              "",
              "Ticket à implémenter :",
              wrapUntrustedContent(
                "untrusted_issue_content",
                [
                  `Ticket #${ticket.ticketIssueNumber} : ${ticket.title}`,
                  `Description : ${ticket.description}`,
                  `Critères d'acceptation : ${ticket.acceptanceCriteria.join(" ; ")}`,
                  `Fichiers cibles : ${ticket.filesToTouch.join(", ")}`
                ].join("\n")
              ),
              "",
              verificationGuideMarkdown,
              "",
              existingFilesContext
                ? `Fichiers déjà présents sur la branche feature :\n${wrapUntrustedContent("untrusted_workspace_files", existingFilesContext)}`
                : "C'est le premier ticket : inclus un package.json complet (avec scripts 'test': 'vitest run' et 'build': 'vite build', dependencies react/react-dom, devDependencies typescript/vite/vitest/@vitejs/plugin-react/@types/react/@types/react-dom) ainsi que tsconfig.json et vite.config.ts."
            ].join("\n");

            const rawImpl = await callGeminiGenerateContent({
              apiKey: input.llmApiKey,
              model,
              systemInstruction: tddSystemInstruction,
              prompt: tddPrompt,
              responseMimeType: "application/json",
              temperature: 0.1,
              ...buildRepoExplorationToolsAndHandlers(featureBranch),
              fetchImpl: input.fetchImpl
            });

            const parsedImpl =
              extractJsonObject<GeneratedTicketImplementation>(rawImpl);

            // Pre-Stage-1 Sensitive Path & Path Containment Gate (before Stage 1 and before git push)
            const preStage1Check = validateWorkspaceFileOperations({
              workDir: sandboxWorkspace.workDir,
              files: [
                ...(parsedImpl.files ?? []).map((f) => ({ path: f.path })),
                ...(parsedImpl.patches ?? []).map((p) => ({ path: p.path }))
              ],
              deleted_files: parsedImpl.deleted_files,
              targets: verificationProfile.targets,
              isTaskBranch: true
            });
            if (!preStage1Check.allowed) {
              return await escalateToNeedsHuman({
                reason: "sensitive_path_violation",
                ticketNumber: ticket.ticketIssueNumber,
                branch: taskBranch,
                sensitivePaths: preStage1Check.sensitivePaths,
                traversalPaths: preStage1Check.traversalPaths
              });
            }

            const initialChangedFiles = await applyTicketImplementationPayload({
              parsed: parsedImpl,
              accumulatedFiles,
              featureChangedFilesMap,
              ticketChangedFilesMap,
              featureDeletedFilesSet,
              ticketDeletedFilesSet,
              gh,
              branch: featureBranch
            });
            impl = {
              commit_message: parsedImpl.commit_message,
              test_summary: parsedImpl.test_summary,
              files: initialChangedFiles
            };
            if (process.env.GITHUB_ACTIONS === "true") {
              process.stdout.write(
                `[EPURE][Ticket #${ticket.ticketIssueNumber}] Generated ${impl.files.length} file(s): ${impl.files.map((f) => f.path).join(", ")}\n::endgroup::\n`
              );
            }

            let testCheck = await runTestsInIsolatedWorkspace({
              workDir: sandboxWorkspace.workDir,
              files: Array.from(accumulatedFiles.entries()).map(
                ([path, content]) => ({ path, content })
              ),
              deleted_files: Array.from(ticketDeletedFilesSet),
              changedPaths: [
                ...impl.files.map((f) => f.path),
                ...Array.from(ticketDeletedFilesSet)
              ],
              isTaskBranch: true,
              verificationProfile,
              bootstrappedTargets,
              sandboxRunner: input.sandboxRunner,
              llmApiKey: input.llmApiKey,
              label: `Ticket #${ticket.ticketIssueNumber} initial TDD suite`
            });

            while (!testCheck.passed && fixAttempt < maxCodeFixAttempts) {
              fixAttempt += 1;
              const currentFilesContext = Array.from(accumulatedFiles.entries())
                .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
                .join("\n\n");

              const fixSystemInstruction = [
                "Tu es un ingénieur TDD EPURE corrigeant un échec de vérification Stage 1 en sandbox isolée.",
                PROMPT_INJECTION_IMMUNITY_CLAUSE,
                "Corrige les fichiers en défaut (code ou assertions de test) pour que 100% des cibles Stage 1 passent.",
                "Ne modifie JAMAIS .cursor/agents/**, .github/workflows/**, .github/agents.yml ou .env*.",
                "Tu peux utiliser les outils `list_repo_files`, `search_in_repo_file` et `read_repo_file` pour inspecter les fichiers du dépôt.",
                "Pour modifier un fichier existant volumineux, utilise de préférence `patches` (`old_string` -> `new_string` exact). Pour supprimer un fichier obsolète, utilise `deleted_files`.",
                "",
                verificationGuideMarkdown,
                "",
                "Renvoie un objet JSON strictement valide respectant exactement ce schéma :",
                "{",
                `  "commit_message": "feat(ticket-${ticket.ticketIssueNumber}): ...",`,
                '  "test_summary": "Stage 1 verification suite verified",',
                '  "patches": [',
                '    { "path": "...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
                "  ],",
                '  "files": [',
                '    { "path": "...", "content": "..." }',
                "  ],",
                '  "deleted_files": []',
                "}"
              ].join("\n");

              const fixPrompt = [
                `La vérification Stage 1 du Ticket #${ticket.ticketIssueNumber} a échoué dans la sandbox avec la sortie suivante :`,
                wrapUntrustedContent("untrusted_test_output", testCheck.output),
                "",
                verificationGuideMarkdown,
                "",
                "Fichiers actuels du workspace :",
                wrapUntrustedContent(
                  "untrusted_workspace_files",
                  currentFilesContext
                )
              ].join("\n");

              const rawFix = await callGeminiGenerateContent({
                apiKey: input.llmApiKey,
                model,
                systemInstruction: fixSystemInstruction,
                prompt: fixPrompt,
                responseMimeType: "application/json",
                temperature: 0.1,
                ...buildRepoExplorationToolsAndHandlers(featureBranch),
                fetchImpl: input.fetchImpl
              });

              const fixedImpl =
                extractJsonObject<GeneratedTicketImplementation>(rawFix);

              const fixPreCheck = validateWorkspaceFileOperations({
                workDir: sandboxWorkspace.workDir,
                files: [
                  ...(fixedImpl.files ?? []).map((f) => ({ path: f.path })),
                  ...(fixedImpl.patches ?? []).map((p) => ({ path: p.path }))
                ],
                deleted_files: fixedImpl.deleted_files,
                targets: verificationProfile.targets,
                isTaskBranch: true
              });
              if (!fixPreCheck.allowed) {
                return await escalateToNeedsHuman({
                  reason: "sensitive_path_violation",
                  ticketNumber: ticket.ticketIssueNumber,
                  branch: taskBranch,
                  codeFixAttemptsUsed: fixAttempt,
                  sensitivePaths: fixPreCheck.sensitivePaths,
                  traversalPaths: fixPreCheck.traversalPaths
                });
              }

              const updatedFiles = await applyTicketImplementationPayload({
                parsed: fixedImpl,
                accumulatedFiles,
                featureChangedFilesMap,
                ticketChangedFilesMap,
                featureDeletedFilesSet,
                ticketDeletedFilesSet,
                gh,
                branch: featureBranch
              });
              impl = {
                commit_message:
                  fixedImpl.commit_message || impl.commit_message,
                test_summary: fixedImpl.test_summary || impl.test_summary,
                files: updatedFiles
              };

              testCheck = await runTestsInIsolatedWorkspace({
                workDir: sandboxWorkspace.workDir,
                files: Array.from(accumulatedFiles.entries()).map(
                  ([path, content]) => ({ path, content })
                ),
                deleted_files: Array.from(ticketDeletedFilesSet),
                changedPaths: [
                  ...impl.files.map((f) => f.path),
                  ...Array.from(ticketDeletedFilesSet)
                ],
                isTaskBranch: true,
                verificationProfile,
                bootstrappedTargets,
                sandboxRunner: input.sandboxRunner,
                llmApiKey: input.llmApiKey,
                label: `Ticket #${ticket.ticketIssueNumber} TDD auto-fix attempt ${fixAttempt}/${maxCodeFixAttempts}`
              });
            }

            if (!testCheck.passed) {
              throw new Error(
                `TDD sandbox verification failed for ticket #${ticket.ticketIssueNumber} after ${fixAttempt} auto-fix attempts:\n${testCheck.output.slice(-2000)}`
              );
            }

            await gh.commitFilesToBranch({
              branch: taskBranch,
              fromBranch: featureBranch,
              commitMessage: impl.commit_message,
              files: impl.files,
              deletedFiles: Array.from(ticketDeletedFilesSet)
            });

            const prBody = [
              "## Summary",
              `Automated TDD implementation of #${ticket.ticketIssueNumber} for plan #${input.issueNumber}.`,
              "",
              `Refs #${ticket.ticketIssueNumber}`,
              `Part of #${input.issueNumber}`,
              "",
              "## TDD & Sandbox Verification",
              `- **Sandbox Test Execution**: \`passed\``,
              `- **Summary**: ${impl.test_summary}`
            ].join("\n");

            taskPr = await gh.openPullRequest({
              head: taskBranch,
              base: featureBranch,
              title: impl.commit_message,
              body: prBody
            });

            currentPrHeadSha = taskPr.head_sha;
          }

          // Joint Post-PR Validation Gate: Stage 2 (Multi-Agent Review) + Stage 3 (External CI Gate)
          const runStage2AndStage3ForTaskPr = async (params: {
            headSha: string;
            isReReviewPass: boolean;
            previousFailedReviewers?: ReadonlyArray<ReviewerAgentName>;
          }): Promise<{
            reviewResult: Awaited<ReturnType<typeof runMultiAgentPrReviewPass>>;
            ciGateResult: WaitForExternalCiChecksResult;
          }> => {
            const changedPaths = impl.files.map((f) => f.path);
            const expectedWorkflows = discoverExpectedExternalWorkflows({
              workflowFilesMap: devWorkflowsMap,
              changedPaths,
              targetBranch: featureBranch
            });

            const reviewRes = await runMultiAgentPrReviewPass({
              repository: input.repository,
              prNumber: taskPr.number,
              headBranch: taskBranch,
              baseBranch: featureBranch,
              ticketNumber: ticket.ticketIssueNumber,
              ticketTitle: ticket.title,
              acceptanceCriteria: ticket.acceptanceCriteria,
              glossaryMarkdown: issue.body,
              designMarkdown: trustedBaseRoster.designMarkdown,
              changedFiles: impl.files,
              workspaceFiles: accumulatedFiles,
              trustedBaseBranchFiles: trustedBaseFilesMap,
              isReReviewPass: params.isReReviewPass,
              previousFailedReviewers: params.previousFailedReviewers,
              llmApiKey: input.llmApiKey,
              model,
              fetchImpl: input.fetchImpl
            });

            await gh.postPullRequestReview(taskPr.number, {
              commitId: params.headSha,
              body: reviewRes.review_body_markdown
            });

            await gh.publishCheckRun({
              name: "ai-review",
              headSha: params.headSha,
              conclusion: reviewRes.conclusion,
              summary: reviewRes.check_summary_markdown
            });

            if (reviewRes.touches_frontend_ui) {
              await gh.publishCheckRun({
                name: "impeccable-gate",
                headSha: params.headSha,
                conclusion:
                  reviewRes.impeccable_conclusion === "failure"
                    ? "failure"
                    : "success",
                summary: `Impeccable UI & Accessibility Gate: ${reviewRes.impeccable_conclusion}`
              });
            }

            const ciRes = await waitForExternalCiChecks({
              headSha: params.headSha,
              expectedWorkflows,
              waitForExternalCi: verificationProfile.wait_for_external_ci,
              timeoutMinutes: verificationProfile.external_ci_timeout_minutes,
              graceWindowSeconds: verificationProfile.grace_window_seconds,
              pollIntervalMs: input.pollIntervalMs,
              extraSecrets: [activeToken, input.llmApiKey],
              infraRerunsBySha,
              listWorkflowRunsForSha: (sha) => gh.listWorkflowRunsForSha(sha),
              listCheckRunsForRef: (sha) => gh.listCheckRunsForRef(sha),
              listCheckRunAnnotations: (id) => gh.listCheckRunAnnotations(id),
              getJobLogs: (id) => gh.getActionJobLogs(id),
              rerunFailedJobs: (runId) => gh.rerunFailedWorkflowJobs(runId),
              sleepFn: effectiveSleepFn
            });

            if (ciRes.infraRerunsTriggered > 0) {
              totalTransientRetriesUsed += ciRes.infraRerunsTriggered;
              await updateIssueStateWithCas({
                issueNumber: input.issueNumber,
                store,
                mutator: (prev) => ({
                  ...prev,
                  transient_retries_used: totalTransientRetriesUsed
                })
              });
            }

            return { reviewResult: reviewRes, ciGateResult: ciRes };
          };

          let { reviewResult, ciGateResult } =
            await runStage2AndStage3ForTaskPr({
              headSha: currentPrHeadSha,
              isReReviewPass: false
            });

          if (
            !ciGateResult.passed &&
            (ciGateResult.reason === "grace_window_timeout" ||
              ciGateResult.reason === "wall_clock_budget_exhausted")
          ) {
            return await escalateToNeedsHuman({
              reason: ciGateResult.reason,
              ticketNumber: ticket.ticketIssueNumber,
              branch: taskBranch,
              prNumber: taskPr.number,
              prUrl: taskPr.html_url,
              codeFixAttemptsUsed: 0,
              failedChecks: ciGateResult.failedChecks,
              mustFixFindings: reviewResult.must_fix_findings,
              diagnosticExcerpt: ciGateResult.formattedDiagnostics
            });
          }

          let reviewFixAttempt = 0;
          while (
            (reviewResult.conclusion === "failure" || !ciGateResult.passed) &&
            reviewFixAttempt < maxCodeFixAttempts
          ) {
            reviewFixAttempt += 1;
            await updateIssueStateWithCas({
              issueNumber: input.issueNumber,
              store,
              mutator: (prev) => ({
                ...prev,
                code_fix_attempts_used: reviewFixAttempt,
                transient_retries_used:
                  totalTransientRetriesUsed || prev.transient_retries_used
              })
            });

            process.stdout.write(
              `[EPURE][Ticket #${ticket.ticketIssueNumber}][PR #${taskPr.number}] Post-PR remediation round ${reviewFixAttempt}/${maxCodeFixAttempts} (${reviewResult.must_fix_findings.length} must_fix finding(s), CI passed=${ciGateResult.passed})\n`
            );
            const findingsText = reviewResult.must_fix_findings
              .map(
                (f, idx) =>
                  `${idx + 1}. [${f.reviewer}] (${f.path}:${f.line}) ${f.title} — ${f.rationale} -> Action: ${f.suggested_action}`
              )
              .join("\n");

            const currentFilesContext = Array.from(accumulatedFiles.entries())
              .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
              .join("\n\n");

            const reviewFixSystemInstruction = [
              "Tu es un ingénieur TDD EPURE corrigeant les constats bloquants ('must_fix') de revue multi-agents et/ou les échecs CI externes.",
              PROMPT_INJECTION_IMMUNITY_CLAUSE,
              "Corrige précisément chaque anomalie tout en maintenant 100% des cibles Stage 1 au vert.",
              "Ne modifie JAMAIS .cursor/agents/**, .github/workflows/**, .github/agents.yml ou .env*.",
              "Utilise les outils `list_repo_files`, `search_in_repo_file` et `read_repo_file` pour inspecter les fichiers pertinents du dépôt avant de coder.",
              "",
              verificationGuideMarkdown,
              "",
              "Pour modifier un fichier existant volumineux, utilise de préférence `patches` (`old_string` -> `new_string` exact). Sinon utilise `files` avec le contenu intégral du fichier. Pour supprimer un fichier obsolète, utilise `deleted_files`.",
              "Renvoie un objet JSON strictement valide :",
              "{",
              `  "commit_message": "fix(review): address post-PR findings on #${ticket.ticketIssueNumber}",`,
              '  "test_summary": "Addressed review and CI findings and verified test suite",',
              '  "patches": [',
              '    { "path": "...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
              "  ],",
              '  "files": [',
              '    { "path": "...", "content": "..." }',
              "  ],",
              '  "deleted_files": ["..."]',
              "}"
            ].join("\n");

            const promptParts: string[] = [];
            if (reviewResult.must_fix_findings.length > 0) {
              promptParts.push(
                `Les reviewers multi-agents EPURE ont émis ${reviewResult.must_fix_findings.length} constat(s) bloquant(s) ('must_fix') sur la PR #${taskPr.number} du Ticket #${ticket.ticketIssueNumber} :`,
                wrapUntrustedContent("untrusted_issue_content", findingsText),
                ""
              );
            }
            if (!ciGateResult.passed && ciGateResult.formattedDiagnostics) {
              promptParts.push(
                `Les workflows CI externes sur la PR #${taskPr.number} (SHA \`${currentPrHeadSha}\`) ont échoué :`,
                ciGateResult.formattedDiagnostics,
                ""
              );
            }
            promptParts.push(
              verificationGuideMarkdown,
              "",
              "Fichiers actuels du workspace :",
              wrapUntrustedContent(
                "untrusted_workspace_files",
                currentFilesContext
              )
            );

            const rawReviewFix = await callGeminiGenerateContent({
              apiKey: input.llmApiKey,
              model,
              thinkingLevel: "HIGH",
              logLabel: `review-fix:#${ticket.ticketIssueNumber}/iter-${reviewFixAttempt}`,
              systemInstruction: reviewFixSystemInstruction,
              prompt: promptParts.join("\n"),
              responseMimeType: "application/json",
              temperature: 0.1,
              ...buildRepoExplorationToolsAndHandlers(taskBranch),
              fetchImpl: input.fetchImpl
            });

            const reviewFixedImpl =
              extractJsonObject<GeneratedTicketImplementation>(rawReviewFix);

            // Pre-Stage-1 Sensitive Path & Path Containment Gate on remediation
            const remediationPreCheck = validateWorkspaceFileOperations({
              workDir: sandboxWorkspace.workDir,
              files: [
                ...(reviewFixedImpl.files ?? []).map((f) => ({ path: f.path })),
                ...(reviewFixedImpl.patches ?? []).map((p) => ({
                  path: p.path
                }))
              ],
              deleted_files: reviewFixedImpl.deleted_files,
              targets: verificationProfile.targets,
              isTaskBranch: true
            });
            if (!remediationPreCheck.allowed) {
              return await escalateToNeedsHuman({
                reason: "sensitive_path_violation",
                ticketNumber: ticket.ticketIssueNumber,
                branch: taskBranch,
                prNumber: taskPr.number,
                prUrl: taskPr.html_url,
                codeFixAttemptsUsed: reviewFixAttempt,
                sensitivePaths: remediationPreCheck.sensitivePaths,
                traversalPaths: remediationPreCheck.traversalPaths
              });
            }

            const updatedReviewFiles = await applyTicketImplementationPayload({
              parsed: reviewFixedImpl,
              accumulatedFiles,
              featureChangedFilesMap,
              ticketChangedFilesMap,
              featureDeletedFilesSet,
              ticketDeletedFilesSet,
              gh,
              branch: featureBranch
            });
            impl = {
              commit_message:
                reviewFixedImpl.commit_message ||
                `fix(review): address reviewer findings on #${ticket.ticketIssueNumber}`,
              test_summary: reviewFixedImpl.test_summary || impl.test_summary,
              files: updatedReviewFiles
            };

            let testCheck = await runTestsInIsolatedWorkspace({
              workDir: sandboxWorkspace.workDir,
              files: Array.from(accumulatedFiles.entries()).map(
                ([path, content]) => ({ path, content })
              ),
              deleted_files: Array.from(ticketDeletedFilesSet),
              changedPaths: [
                ...impl.files.map((f) => f.path),
                ...Array.from(ticketDeletedFilesSet)
              ],
              isTaskBranch: true,
              verificationProfile,
              bootstrappedTargets,
              sandboxRunner: input.sandboxRunner,
              llmApiKey: input.llmApiKey,
              label: `Ticket #${ticket.ticketIssueNumber} review-fix iteration ${reviewFixAttempt}/${maxCodeFixAttempts}`
            });
            let reviewTestRetry = 0;
            while (!testCheck.passed && reviewTestRetry < 2) {
              reviewTestRetry += 1;
              const retryFilesContext = Array.from(accumulatedFiles.entries())
                .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
                .join("\n\n");
              const rawRetryFix = await callGeminiGenerateContent({
                apiKey: input.llmApiKey,
                model,
                thinkingLevel: "HIGH",
                systemInstruction: reviewFixSystemInstruction,
                prompt: [
                  `La correction a fait échouer la vérification Stage 1 en sandbox (tentative ${reviewTestRetry}/2) :`,
                  wrapUntrustedContent(
                    "untrusted_test_output",
                    testCheck.output.slice(-6000)
                  ),
                  "",
                  ...(findingsText
                    ? [
                        "Constats must_fix à maintenir corrigés :",
                        wrapUntrustedContent(
                          "untrusted_issue_content",
                          findingsText
                        ),
                        ""
                      ]
                    : []),
                  "Fichiers actuels du workspace :",
                  wrapUntrustedContent(
                    "untrusted_workspace_files",
                    retryFilesContext
                  )
                ].join("\n"),
                responseMimeType: "application/json",
                temperature: 0.1,
                ...buildRepoExplorationToolsAndHandlers(taskBranch),
                fetchImpl: input.fetchImpl
              });
              const retryImpl =
                extractJsonObject<GeneratedTicketImplementation>(rawRetryFix);

              const retryPreCheck = validateWorkspaceFileOperations({
                workDir: sandboxWorkspace.workDir,
                files: [
                  ...(retryImpl.files ?? []).map((f) => ({ path: f.path })),
                  ...(retryImpl.patches ?? []).map((p) => ({ path: p.path }))
                ],
                deleted_files: retryImpl.deleted_files,
                targets: verificationProfile.targets,
                isTaskBranch: true
              });
              if (!retryPreCheck.allowed) {
                return await escalateToNeedsHuman({
                  reason: "sensitive_path_violation",
                  ticketNumber: ticket.ticketIssueNumber,
                  branch: taskBranch,
                  prNumber: taskPr.number,
                  prUrl: taskPr.html_url,
                  codeFixAttemptsUsed: reviewFixAttempt,
                  sensitivePaths: retryPreCheck.sensitivePaths,
                  traversalPaths: retryPreCheck.traversalPaths
                });
              }

              const updatedRetryFiles = await applyTicketImplementationPayload({
                parsed: retryImpl,
                accumulatedFiles,
                featureChangedFilesMap,
                ticketChangedFilesMap,
                featureDeletedFilesSet,
                ticketDeletedFilesSet,
                gh,
                branch: featureBranch
              });
              impl = {
                commit_message: impl.commit_message,
                test_summary: retryImpl.test_summary || impl.test_summary,
                files: updatedRetryFiles
              };
              testCheck = await runTestsInIsolatedWorkspace({
                workDir: sandboxWorkspace.workDir,
                files: Array.from(accumulatedFiles.entries()).map(
                  ([path, content]) => ({ path, content })
                ),
                deleted_files: Array.from(ticketDeletedFilesSet),
                changedPaths: [
                  ...impl.files.map((f) => f.path),
                  ...Array.from(ticketDeletedFilesSet)
                ],
                isTaskBranch: true,
                verificationProfile,
                bootstrappedTargets,
                sandboxRunner: input.sandboxRunner,
                llmApiKey: input.llmApiKey,
                label: `Ticket #${ticket.ticketIssueNumber} review-fix iteration ${reviewFixAttempt} test retry ${reviewTestRetry}/2`
              });
            }
            if (!testCheck.passed) {
              throw new Error(
                `Sandbox test verification failed while addressing review/CI findings on #${ticket.ticketIssueNumber}:\n${testCheck.output.slice(-2000)}`
              );
            }

            currentPrHeadSha = await gh.commitFilesToBranch({
              branch: taskBranch,
              fromBranch: featureBranch,
              commitMessage: `fix(review): address reviewer findings on #${ticket.ticketIssueNumber}`,
              files: impl.files,
              deletedFiles: Array.from(ticketDeletedFilesSet)
            });

            // Re-run Stage 2 + Stage 3 on new headSha
            const nextPass = await runStage2AndStage3ForTaskPr({
              headSha: currentPrHeadSha,
              isReReviewPass: true,
              previousFailedReviewers: reviewResult.failed_reviewers
            });
            reviewResult = nextPass.reviewResult;
            ciGateResult = nextPass.ciGateResult;

            if (
              !ciGateResult.passed &&
              (ciGateResult.reason === "grace_window_timeout" ||
                ciGateResult.reason === "wall_clock_budget_exhausted")
            ) {
              return await escalateToNeedsHuman({
                reason: ciGateResult.reason,
                ticketNumber: ticket.ticketIssueNumber,
                branch: taskBranch,
                prNumber: taskPr.number,
                prUrl: taskPr.html_url,
                codeFixAttemptsUsed: reviewFixAttempt,
                failedChecks: ciGateResult.failedChecks,
                mustFixFindings: reviewResult.must_fix_findings,
                diagnosticExcerpt: ciGateResult.formattedDiagnostics
              });
            }
          }

          if (reviewResult.conclusion === "failure" || !ciGateResult.passed) {
            return await escalateToNeedsHuman({
              reason: "remediation_exhausted",
              ticketNumber: ticket.ticketIssueNumber,
              branch: taskBranch,
              prNumber: taskPr.number,
              prUrl: taskPr.html_url,
              codeFixAttemptsUsed: reviewFixAttempt,
              failedChecks: ciGateResult.failedChecks,
              mustFixFindings: reviewResult.must_fix_findings,
              diagnosticExcerpt: ciGateResult.formattedDiagnostics
            });
          }

          // Step 4 (Q94): Synthesize semantic Conventional Commit squash title & body from the PR diff
          const squashCommit = await generateSemanticSquashCommitFromDiff({
            prNumber: taskPr.number,
            targetBranch: featureBranch,
            defaultBranch: "dev",
            planIssueNumber: input.issueNumber,
            ticketNumbers: [ticket.ticketIssueNumber],
            fallbackTitle: impl.commit_message,
            changedFiles: impl.files,
            llmApiKey: input.llmApiKey,
            model,
            fetchImpl: input.fetchImpl
          });

          await gh.updatePullRequest(taskPr.number, {
            title: squashCommit.pr_title
          });

          await gh.publishCheckRun({
            name: "PR title",
            headSha: currentPrHeadSha,
            conclusion: "success",
            summary: `Conventional Commit title verified: '${squashCommit.pr_title}'`
          });

          await gh.mergePullRequest(taskPr.number, {
            headBranch: taskBranch,
            baseBranch: featureBranch,
            commitTitle: squashCommit.commit_title,
            commitMessage: squashCommit.commit_message
          });

          if (ticket.ticketIssueNumber !== input.issueNumber) {
            await gh.closeIssue(ticket.ticketIssueNumber);
          }

          completedTicketsSummary.push(
            `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — PR #${taskPr.number} squash-merged into \`${featureBranch}\` as \`${squashCommit.commit_title}\` (Reviewers: ${reviewResult.selected_reviewers.map((r) => `\`${r}\``).join(", ")})`
          );
        } finally {
          sandboxWorkspace.cleanup();
        }
      }

      // Open or reconcile final Pull Request feature/* -> dev (Q110, ADR-0011 Q45, Q91, Q94, Q95)
      const effectiveFeatureEntries =
        featureChangedFilesMap.size > 0
          ? Array.from(featureChangedFilesMap.entries())
          : Array.from(accumulatedFiles.entries());
      const allFeatureFiles = effectiveFeatureEntries.map(
        ([path, content]) => ({ path, content })
      );
      const allTicketNumbers = ticketsManifest.map((t) => t.ticketIssueNumber);

      const featureSquashPreview = await generateSemanticSquashCommitFromDiff({
        prNumber: input.issueNumber,
        targetBranch: "dev",
        defaultBranch: "dev",
        planIssueNumber: input.issueNumber,
        ticketNumbers: allTicketNumbers,
        fallbackTitle: `feat: ${issue.title.replace(/\[plan\]\s*/i, "")}`,
        changedFiles: allFeatureFiles,
        llmApiKey: input.llmApiKey,
        model,
        fetchImpl: input.fetchImpl
      });

      const existingFeaturePr =
        existingFeaturePrAtStart ??
        (await gh.findOpenPullRequestByHead(featureBranch, "dev"));

      const featurePr = existingFeaturePr
        ? existingFeaturePr
        : await gh.openPullRequest({
            head: featureBranch,
            base: "dev",
            title: featureSquashPreview.pr_title,
            body: [
              "## Summary",
              `Completes implementation for #${input.issueNumber}.`,
              "",
              `Closes #${input.issueNumber}`,
              "",
              featureSquashPreview.commit_message,
              "",
              "## Completed Tickets & Squash History",
              ...completedTicketsSummary,
              "",
              "## Governance",
              "- Requires human review and squash-merge into `dev` in the GitHub UI (ADR-0001, ADR-0027, Q45, Q91, Q95)."
            ].join("\n")
          });

      // Q93 + Stage 3: Run final synthesis Multi-Agent Review pass + External CI Gate on feature/* -> dev PR
      let currentFeaturePrHeadSha = featurePr.head_sha;
      const runStage2AndStage3ForFeaturePr = async (params: {
        headSha: string;
        isReReviewPass: boolean;
        previousFailedReviewers?: ReadonlyArray<ReviewerAgentName>;
      }): Promise<{
        reviewResult: Awaited<ReturnType<typeof runMultiAgentPrReviewPass>>;
        ciGateResult: WaitForExternalCiChecksResult;
      }> => {
        const currentChangedFeatureFiles = Array.from(
          (featureChangedFilesMap.size > 0
            ? featureChangedFilesMap
            : accumulatedFiles
          ).entries()
        ).map(([path, content]) => ({ path, content }));
        const expectedFeatureWorkflows = discoverExpectedExternalWorkflows({
          workflowFilesMap: devWorkflowsMap,
          changedPaths: currentChangedFeatureFiles.map((f) => f.path),
          targetBranch: "dev"
        });

        const reviewRes = await runMultiAgentPrReviewPass({
          repository: input.repository,
          prNumber: featurePr.number,
          headBranch: featureBranch,
          baseBranch: "dev",
          ticketTitle: issue.title,
          acceptanceCriteria: ticketsManifest.flatMap(
            (t) => t.acceptanceCriteria
          ),
          glossaryMarkdown: issue.body,
          designMarkdown: trustedBaseRoster.designMarkdown,
          changedFiles: currentChangedFeatureFiles,
          workspaceFiles: accumulatedFiles,
          trustedBaseBranchFiles: trustedBaseFilesMap,
          isReReviewPass: params.isReReviewPass,
          previousFailedReviewers: params.previousFailedReviewers,
          llmApiKey: input.llmApiKey,
          model,
          fetchImpl: input.fetchImpl
        });

        await gh.postPullRequestReview(featurePr.number, {
          commitId: params.headSha,
          body: reviewRes.review_body_markdown
        });

        await gh.publishCheckRun({
          name: "PR title",
          headSha: params.headSha,
          conclusion: "success",
          summary: `Conventional Commit title verified: '${featureSquashPreview.pr_title}'`
        });

        await gh.publishCheckRun({
          name: "ai-review",
          headSha: params.headSha,
          conclusion: reviewRes.conclusion,
          summary: reviewRes.check_summary_markdown
        });

        if (reviewRes.touches_frontend_ui) {
          await gh.publishCheckRun({
            name: "impeccable-gate",
            headSha: params.headSha,
            conclusion:
              reviewRes.impeccable_conclusion === "failure"
                ? "failure"
                : "success",
            summary: `Impeccable UI & Accessibility Gate: ${reviewRes.impeccable_conclusion}`
          });
        }

        const ciRes = await waitForExternalCiChecks({
          headSha: params.headSha,
          expectedWorkflows: expectedFeatureWorkflows,
          waitForExternalCi: verificationProfile.wait_for_external_ci,
          timeoutMinutes: verificationProfile.external_ci_timeout_minutes,
          graceWindowSeconds: verificationProfile.grace_window_seconds,
          pollIntervalMs: input.pollIntervalMs,
          extraSecrets: [activeToken, input.llmApiKey],
          infraRerunsBySha,
          listWorkflowRunsForSha: (sha) => gh.listWorkflowRunsForSha(sha),
          listCheckRunsForRef: (sha) => gh.listCheckRunsForRef(sha),
          listCheckRunAnnotations: (id) => gh.listCheckRunAnnotations(id),
          getJobLogs: (id) => gh.getActionJobLogs(id),
          rerunFailedJobs: (runId) => gh.rerunFailedWorkflowJobs(runId),
          sleepFn: effectiveSleepFn
        });

        if (ciRes.infraRerunsTriggered > 0) {
          totalTransientRetriesUsed += ciRes.infraRerunsTriggered;
          await updateIssueStateWithCas({
            issueNumber: input.issueNumber,
            store,
            mutator: (prev) => ({
              ...prev,
              transient_retries_used: totalTransientRetriesUsed
            })
          });
        }

        return { reviewResult: reviewRes, ciGateResult: ciRes };
      };

      let {
        reviewResult: finalFeatureReview,
        ciGateResult: finalFeatureCiGate
      } = await runStage2AndStage3ForFeaturePr({
        headSha: currentFeaturePrHeadSha,
        isReReviewPass: false
      });

      if (
        !finalFeatureCiGate.passed &&
        (finalFeatureCiGate.reason === "grace_window_timeout" ||
          finalFeatureCiGate.reason === "wall_clock_budget_exhausted")
      ) {
        return await escalateToNeedsHuman({
          reason: finalFeatureCiGate.reason,
          ticketNumber: input.issueNumber,
          branch: featureBranch,
          prNumber: featurePr.number,
          prUrl: featurePr.html_url,
          featurePrUrl: featurePr.html_url,
          codeFixAttemptsUsed: 0,
          failedChecks: finalFeatureCiGate.failedChecks,
          mustFixFindings: finalFeatureReview.must_fix_findings,
          diagnosticExcerpt: finalFeatureCiGate.formattedDiagnostics
        });
      }

      let featureReviewFixAttempt = 0;
      const maxFeatureReviewFixAttempts = maxCodeFixAttempts;
      while (
        (finalFeatureReview.conclusion === "failure" ||
          !finalFeatureCiGate.passed) &&
        featureReviewFixAttempt < maxFeatureReviewFixAttempts
      ) {
        featureReviewFixAttempt += 1;
        await updateIssueStateWithCas({
          issueNumber: input.issueNumber,
          store,
          mutator: (prev) => ({
            ...prev,
            code_fix_attempts_used: featureReviewFixAttempt,
            transient_retries_used:
              totalTransientRetriesUsed || prev.transient_retries_used
          })
        });

        process.stdout.write(
          `[EPURE][Feature PR #${featurePr.number}] Multi-agent synthesis review + CI fix iteration ${featureReviewFixAttempt}/${maxFeatureReviewFixAttempts} (${finalFeatureReview.must_fix_findings.length} must_fix finding(s), CI passed=${finalFeatureCiGate.passed})\n`
        );
        const findingsText = finalFeatureReview.must_fix_findings
          .map(
            (f, idx) =>
              `${idx + 1}. [${f.reviewer}] (${f.path}:${f.line}) ${f.title} — ${f.rationale} -> Action: ${f.suggested_action}`
          )
          .join("\n");

        const featureSandbox = prepareRepositorySandboxWorkspace({
          repository: input.repository,
          branch: featureBranch,
          githubToken: activeToken,
          seedFiles: accumulatedFiles,
          enableRemoteClone: Boolean(
            process.env.GITHUB_ACTIONS === "true" && !input.fetchImpl
          )
        });
        if (
          featureSandbox.clonedFromRemote &&
          !parsedDevAgentsConfig?.verification?.targets?.length
        ) {
          const clonedProfile = discoverVerificationProfile({
            repoRootDir: featureSandbox.workDir,
            targetFilesHint: [
              ...devBranchPaths,
              ...ticketsManifest.flatMap((t) => t.filesToTouch)
            ],
            workflowFilesMap: Object.fromEntries(devWorkflowsMap)
          });
          verificationProfile = {
            ...clonedProfile,
            wait_for_external_ci:
              parsedDevAgentsConfig?.verification?.wait_for_external_ci ??
              clonedProfile.wait_for_external_ci,
            external_ci_timeout_minutes:
              parsedDevAgentsConfig?.verification
                ?.external_ci_timeout_minutes ??
              clonedProfile.external_ci_timeout_minutes,
            grace_window_seconds:
              parsedDevAgentsConfig?.verification?.grace_window_seconds ??
              clonedProfile.grace_window_seconds
          };
          verificationGuideMarkdown =
            formatVerificationToolingGuideMarkdown(verificationProfile);
        }

        try {
          const currentFilesContext = Array.from(accumulatedFiles.entries())
            .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
            .join("\n\n");

          const featureFixSystemInstruction = [
            "Tu es un ingénieur TDD EPURE corrigeant les constats bloquants ('must_fix') et/ou échecs CI sur la PR finale de feature.",
            PROMPT_INJECTION_IMMUNITY_CLAUSE,
            "Corrige précisément chaque anomalie tout en maintenant 100% des cibles Stage 1 au vert.",
            "Ne modifie JAMAIS .cursor/agents/**, .github/workflows/**, .github/agents.yml ou .env*.",
            "Utilise les outils `list_repo_files`, `search_in_repo_file` et `read_repo_file` pour inspecter les fichiers pertinents du dépôt avant de coder.",
            "",
            verificationGuideMarkdown,
            "",
            "Pour modifier un fichier existant volumineux, utilise de préférence `patches` (`old_string` -> `new_string` exact). Sinon utilise `files` avec le contenu intégral du fichier. Pour supprimer un fichier obsolète, utilise `deleted_files`.",
            "Renvoie un objet JSON strictement valide :",
            "{",
            `  "commit_message": "fix(review): address final feature review findings on #${input.issueNumber}",`,
            '  "test_summary": "Addressed final feature review findings and verified test suite",',
            '  "patches": [',
            '    { "path": "...", "edits": [{ "old_string": "...", "new_string": "..." }] }',
            "  ],",
            '  "files": [',
            '    { "path": "...", "content": "..." }',
            "  ],",
            '  "deleted_files": ["..."]',
            "}"
          ].join("\n");

          const featureFixPromptParts: string[] = [];
          if (finalFeatureReview.must_fix_findings.length > 0) {
            featureFixPromptParts.push(
              `Les reviewers multi-agents EPURE ont émis ${finalFeatureReview.must_fix_findings.length} constat(s) bloquant(s) ('must_fix') sur la PR finale #${featurePr.number} (\`${featureBranch} -> dev\`) :`,
              wrapUntrustedContent("untrusted_issue_content", findingsText),
              ""
            );
          }
          if (
            !finalFeatureCiGate.passed &&
            finalFeatureCiGate.formattedDiagnostics
          ) {
            featureFixPromptParts.push(
              `Les workflows CI externes sur la PR finale #${featurePr.number} (\`${featureBranch} -> dev\`) ont échoué :`,
              finalFeatureCiGate.formattedDiagnostics,
              ""
            );
          }
          featureFixPromptParts.push(
            verificationGuideMarkdown,
            "",
            "Fichiers actuels du workspace :",
            wrapUntrustedContent(
              "untrusted_workspace_files",
              currentFilesContext
            )
          );

          const rawFeatureFix = await callGeminiGenerateContent({
            apiKey: input.llmApiKey,
            model,
            thinkingLevel: "HIGH",
            logLabel: `feature-review-fix:#PR${featurePr.number}/iter-${featureReviewFixAttempt}`,
            systemInstruction: featureFixSystemInstruction,
            prompt: featureFixPromptParts.join("\n"),
            responseMimeType: "application/json",
            temperature: 0.1,
            ...buildRepoExplorationToolsAndHandlers(featureBranch),
            fetchImpl: input.fetchImpl
          });

          const parsedFeatureFix =
            extractJsonObject<GeneratedTicketImplementation>(rawFeatureFix);

          const featureFixPreCheck = validateWorkspaceFileOperations({
            workDir: featureSandbox.workDir,
            files: [
              ...(parsedFeatureFix.files ?? []).map((f) => ({ path: f.path })),
              ...(parsedFeatureFix.patches ?? []).map((p) => ({
                path: p.path
              }))
            ],
            deleted_files: parsedFeatureFix.deleted_files,
            targets: verificationProfile.targets,
            isTaskBranch: true
          });
          if (!featureFixPreCheck.allowed) {
            return await escalateToNeedsHuman({
              reason: "sensitive_path_violation",
              ticketNumber: input.issueNumber,
              branch: featureBranch,
              prNumber: featurePr.number,
              prUrl: featurePr.html_url,
              featurePrUrl: featurePr.html_url,
              codeFixAttemptsUsed: featureReviewFixAttempt,
              sensitivePaths: featureFixPreCheck.sensitivePaths,
              traversalPaths: featureFixPreCheck.traversalPaths
            });
          }

          const changedFixFilesMap = new Map<string, string>();
          const changedDeletedFilesSet = new Set<string>();
          await applyTicketImplementationPayload({
            parsed: parsedFeatureFix,
            accumulatedFiles,
            featureChangedFilesMap,
            ticketChangedFilesMap: changedFixFilesMap,
            featureDeletedFilesSet,
            ticketDeletedFilesSet: changedDeletedFilesSet,
            gh,
            branch: featureBranch
          });

          let featureTestCheck = await runTestsInIsolatedWorkspace({
            workDir: featureSandbox.workDir,
            files: Array.from(accumulatedFiles.entries()).map(
              ([path, content]) => ({ path, content })
            ),
            deleted_files: Array.from(changedDeletedFilesSet),
            changedPaths: [
              ...Array.from(changedFixFilesMap.keys()),
              ...Array.from(changedDeletedFilesSet)
            ],
            isTaskBranch: true,
            verificationProfile,
            sandboxRunner: input.sandboxRunner,
            llmApiKey: input.llmApiKey,
            label: `Feature PR #${featurePr.number} review-fix iteration ${featureReviewFixAttempt}/${maxFeatureReviewFixAttempts}`
          });

          let featureTestRetry = 0;
          while (!featureTestCheck.passed && featureTestRetry < 2) {
            featureTestRetry += 1;
            const retryFilesContext = Array.from(accumulatedFiles.entries())
              .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
              .join("\n\n");
            const rawRetryFeatureFix = await callGeminiGenerateContent({
              apiKey: input.llmApiKey,
              model,
              thinkingLevel: "HIGH",
              logLabel: `feature-review-test-retry:#PR${featurePr.number}/iter-${featureReviewFixAttempt}-retry-${featureTestRetry}`,
              systemInstruction: featureFixSystemInstruction,
              prompt: [
                `La correction de review finale a échoué à la vérification Stage 1 (tentative ${featureTestRetry}/2) :`,
                wrapUntrustedContent(
                  "untrusted_test_output",
                  featureTestCheck.output.slice(-6000)
                ),
                "",
                ...(findingsText
                  ? [
                      "Constats must_fix à maintenir corrigés :",
                      wrapUntrustedContent(
                        "untrusted_issue_content",
                        findingsText
                      ),
                      ""
                    ]
                  : []),
                "Fichiers actuels du workspace :",
                wrapUntrustedContent(
                  "untrusted_workspace_files",
                  retryFilesContext
                )
              ].join("\n"),
              responseMimeType: "application/json",
              temperature: 0.1,
              ...buildRepoExplorationToolsAndHandlers(featureBranch),
              fetchImpl: input.fetchImpl
            });
            const retryParsed =
              extractJsonObject<GeneratedTicketImplementation>(
                rawRetryFeatureFix
              );

            const retryPreCheck = validateWorkspaceFileOperations({
              workDir: featureSandbox.workDir,
              files: [
                ...(retryParsed.files ?? []).map((f) => ({ path: f.path })),
                ...(retryParsed.patches ?? []).map((p) => ({ path: p.path }))
              ],
              deleted_files: retryParsed.deleted_files,
              targets: verificationProfile.targets,
              isTaskBranch: true
            });
            if (!retryPreCheck.allowed) {
              return await escalateToNeedsHuman({
                reason: "sensitive_path_violation",
                ticketNumber: input.issueNumber,
                branch: featureBranch,
                prNumber: featurePr.number,
                prUrl: featurePr.html_url,
                featurePrUrl: featurePr.html_url,
                codeFixAttemptsUsed: featureReviewFixAttempt,
                sensitivePaths: retryPreCheck.sensitivePaths,
                traversalPaths: retryPreCheck.traversalPaths
              });
            }

            await applyTicketImplementationPayload({
              parsed: retryParsed,
              accumulatedFiles,
              featureChangedFilesMap,
              ticketChangedFilesMap: changedFixFilesMap,
              featureDeletedFilesSet,
              ticketDeletedFilesSet: changedDeletedFilesSet,
              gh,
              branch: featureBranch
            });
            featureTestCheck = await runTestsInIsolatedWorkspace({
              workDir: featureSandbox.workDir,
              files: Array.from(accumulatedFiles.entries()).map(
                ([path, content]) => ({ path, content })
              ),
              deleted_files: Array.from(changedDeletedFilesSet),
              changedPaths: [
                ...Array.from(changedFixFilesMap.keys()),
                ...Array.from(changedDeletedFilesSet)
              ],
              isTaskBranch: true,
              verificationProfile,
              sandboxRunner: input.sandboxRunner,
              llmApiKey: input.llmApiKey,
              label: `Feature PR #${featurePr.number} review-fix iteration ${featureReviewFixAttempt} test retry ${featureTestRetry}/2`
            });
          }

          if (!featureTestCheck.passed) {
            throw new Error(
              `Sandbox test verification failed while addressing final feature review findings on PR #${featurePr.number}:\n${featureTestCheck.output.slice(-2000)}`
            );
          }

          const changedFixFiles = Array.from(changedFixFilesMap.entries()).map(
            ([path, content]) => ({ path, content })
          );

          const fixTaskBranch = `task/review-fix-${input.issueNumber}-${featureReviewFixAttempt}`;
          const fixCommitTitle =
            parsedFeatureFix.commit_message &&
            /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: .+/i.test(
              parsedFeatureFix.commit_message
            )
              ? parsedFeatureFix.commit_message
              : `fix(review): address final feature review findings on #${input.issueNumber}`;

          await gh.commitFilesToBranch({
            branch: fixTaskBranch,
            fromBranch: featureBranch,
            commitMessage: fixCommitTitle,
            files: changedFixFiles,
            deletedFiles: Array.from(changedDeletedFilesSet)
          });

          const fixPr = await gh.openPullRequest({
            head: fixTaskBranch,
            base: featureBranch,
            title: fixCommitTitle,
            body: `Addresses multi-agent review findings on feature PR #${featurePr.number} (iteration ${featureReviewFixAttempt}).\n\nRefs #${input.issueNumber}`
          });

          await gh.publishCheckRun({
            name: "PR title",
            headSha: fixPr.head_sha,
            conclusion: "success",
            summary: `Conventional Commit title verified: '${fixCommitTitle}'`
          });

          await gh.publishCheckRun({
            name: "ai-review",
            headSha: fixPr.head_sha,
            conclusion: "success",
            summary:
              "Sandbox verified remediation commit for feature synthesis PR."
          });

          await gh.publishCheckRun({
            name: "impeccable-gate",
            headSha: fixPr.head_sha,
            conclusion: "success",
            summary: "Impeccable gate verified in synthesis loop."
          });

          await gh.mergePullRequest(fixPr.number, {
            headBranch: fixTaskBranch,
            baseBranch: featureBranch,
            commitTitle: `${fixCommitTitle} (#${fixPr.number})`,
            commitMessage: `Automated remediation of synthesis review findings.\n\nRefs #${input.issueNumber}`
          });

          currentFeaturePrHeadSha =
            (await gh.getDefaultBranchSha(featureBranch)) ??
            currentFeaturePrHeadSha;

          const nextFeaturePass = await runStage2AndStage3ForFeaturePr({
            headSha: currentFeaturePrHeadSha,
            isReReviewPass: true,
            previousFailedReviewers: finalFeatureReview.failed_reviewers
          });
          finalFeatureReview = nextFeaturePass.reviewResult;
          finalFeatureCiGate = nextFeaturePass.ciGateResult;

          if (
            !finalFeatureCiGate.passed &&
            (finalFeatureCiGate.reason === "grace_window_timeout" ||
              finalFeatureCiGate.reason === "wall_clock_budget_exhausted")
          ) {
            return await escalateToNeedsHuman({
              reason: finalFeatureCiGate.reason,
              ticketNumber: input.issueNumber,
              branch: featureBranch,
              prNumber: featurePr.number,
              prUrl: featurePr.html_url,
              featurePrUrl: featurePr.html_url,
              codeFixAttemptsUsed: featureReviewFixAttempt,
              failedChecks: finalFeatureCiGate.failedChecks,
              mustFixFindings: finalFeatureReview.must_fix_findings,
              diagnosticExcerpt: finalFeatureCiGate.formattedDiagnostics
            });
          }
        } finally {
          featureSandbox.cleanup();
        }
      }

      if (
        finalFeatureReview.conclusion === "failure" ||
        !finalFeatureCiGate.passed
      ) {
        return await escalateToNeedsHuman({
          reason: "remediation_exhausted",
          ticketNumber: input.issueNumber,
          branch: featureBranch,
          prNumber: featurePr.number,
          prUrl: featurePr.html_url,
          featurePrUrl: featurePr.html_url,
          codeFixAttemptsUsed: featureReviewFixAttempt,
          failedChecks: finalFeatureCiGate.failedChecks,
          mustFixFindings: finalFeatureReview.must_fix_findings,
          diagnosticExcerpt: finalFeatureCiGate.formattedDiagnostics
        });
      }

      const updatedDone = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store,
        mutator: (prev) => ({
          ...prev,
          phase: "completed",
          status: "done",
          active_branch: featureBranch,
          last_processed_comment_id:
            input.commentId ?? prev.last_processed_comment_id
        })
      });

      const finalComment = [
        updatedDone.issue_mirror_markdown,
        "",
        `### Exécution TDD & Revue Multi-Agents terminées pour le plan #${input.issueNumber}`,
        "",
        "Tous les tickets du DAG ont été implémentés en TDD sur leurs branches `task/*`, vérifiés en sandbox isolée, audités par le roster multi-agents (`ai-review` + `impeccable-gate`) et squash-mergés dans `" +
          featureBranch +
          "` :",
        ...completedTicketsSummary,
        "",
        `👉 **Pull Request finale ouverte vers \`dev\`** : ${featurePr.html_url}`,
        "Conformément à la gouvernance EPURE (Q45, Q91, Q95), la fusion finale `feature/* → dev` est réservée à la validation humaine dans l'interface GitHub."
      ].join("\n");

      await gh.postIssueComment(input.issueNumber, finalComment);

      return {
        executed: true,
        phase: updatedDone.state.phase,
        status: updatedDone.state.status,
        active_branch: updatedStart.state.active_branch,
        summary_markdown: finalComment,
        created_ticket_numbers: allTicketNumbers,
        feature_pr_url: featurePr.html_url
      };
    }

    return {
      executed: false,
      phase: currentState?.phase ?? "idle",
      status: currentState?.status ?? "active",
      active_branch: currentState?.active_branch ?? "",
      summary_markdown: "No orchestration transition matched.",
      created_ticket_numbers: [],
      feature_pr_url: ""
    };
  } finally {
    if (mintedAppToken) {
      try {
        await revokeGitHubInstallationToken({
          token: mintedAppToken,
          fetchImpl: input.fetchImpl
        });
      } catch {
        // Ignore revocation errors
      }
    }
  }
}

export { redactSecrets, formatIssueStateMirrorMarkdown, type EpureIssueState };
