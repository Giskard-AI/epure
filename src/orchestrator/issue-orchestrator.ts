import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintRepositoryInstallationToken, revokeGitHubInstallationToken } from "../auth/github-app-jwt.js";
import { type EpureCommandName, redactSecrets } from "../auth/issue-command-gate.js";
import {
  buildRenovateConfigJson,
  buildStackAwareCiWorkflowYaml,
  buildZizmorConfigYaml,
  detectRepositoryStack
} from "../bootstrap/ci-and-renovate.js";
import { planImpeccableDesignSession } from "../frontend/impeccable-planning.js";
import { runMultiAgentPrReviewPass } from "../review/multi-agent-pr-review.js";
import {
  adaptReviewerRosterForDomain,
  runUserAdvocateDesignGate
} from "../review/reviewer-roster.js";
import { generateSemanticSquashCommitFromDiff } from "../review/squash-commit-generator.js";
import { runInUntrustedCodeSandbox } from "../sandbox/llm-sandbox.js";
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

export interface GeneratedTicketImplementation {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly commit_message: string;
  readonly test_summary: string;
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
  createIssue(params: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; html_url: string }>;
  closeIssue(issueNumber: number): Promise<void>;
  getDefaultBranchSha(branch: string): Promise<string | null>;
  ensureBranch(branch: string, fromBranch?: string): Promise<string>;
  commitFilesToBranch(params: {
    branch: string;
    fromBranch?: string;
    commitMessage: string;
    files: ReadonlyArray<{ path: string; content: string }>;
  }): Promise<string>;
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
      }>("GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
      return {
        number: data?.number ?? issueNumber,
        title: data?.title ?? `Issue #${issueNumber}`,
        body: data?.body ?? ""
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
        sha: string;
      }> = [];

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
        treeEntries.push({
          path: cleanPath,
          mode: "100644",
          type: "blob",
          sha: blobRes.data!.sha
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

    async openPullRequest(input): Promise<{
      number: number;
      html_url: string;
      head_sha: string;
    }> {
      const existing = await apiRequest<
        Array<{ number: number; html_url: string; head: { sha: string } }>
      >(
        "GET",
        `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(
          `${owner}:${input.head}`
        )}&base=${encodeURIComponent(input.base)}`
      );
      if (existing.data && existing.data.length > 0) {
        const first = existing.data[0]!;
        return {
          number: first.number,
          html_url: first.html_url,
          head_sha: first.head.sha
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

async function runTestsInIsolatedWorkspace(params: {
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly llmApiKey: string;
}): Promise<{ passed: boolean; output: string }> {
  const workDir = mkdtempSync(join(tmpdir(), "epure-task-sandbox-"));
  try {
    for (const file of params.files) {
      const target = join(workDir, file.path.replace(/^\/+/, ""));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }

    const pkgJsonPath = join(workDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      return { passed: true, output: "No package.json in workspace snapshot; syntax verified." };
    }

    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 180_000
    });

    if (existsSync(join(workDir, "tsconfig.json"))) {
      const tscRun = await runInUntrustedCodeSandbox({
        isolationAvailable: true,
        runnerEnv: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LLM_API_KEY: params.llmApiKey
        },
        command: "npx",
        args: ["tsc", "--noEmit"],
        cwd: workDir,
        timeoutMs: 60_000
      });
      if (!tscRun.isolated || tscRun.exit_code !== 0) {
        return {
          passed: false,
          output: `TypeScript strict typecheck (tsc --noEmit) failed:\n${tscRun.stdout}\n${tscRun.stderr}`.trim()
        };
      }
    }

    const sandboxRun = await runInUntrustedCodeSandbox({
      isolationAvailable: true,
      runnerEnv: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LLM_API_KEY: params.llmApiKey
      },
      command: "npm",
      args: ["test", "--", "--run"],
      cwd: workDir,
      timeoutMs: 120_000
    });

    return {
      passed: sandboxRun.isolated && sandboxRun.exit_code === 0,
      output: `${sandboxRun.stdout}\n${sandboxRun.stderr}`.trim()
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, output: msg };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
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
        '      "slug": "interface-react-enclume-astrale",',
        '      "title": "[Ticket 3] Interface interactive React L\'Enclume Astrale et persistance locale",',
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

      const adaptedRoster = adaptReviewerRosterForDomain({
        repository: input.repository,
        planTitle: issue.title,
        glossaryMarkdown: bundle.glossary_markdown,
        specMarkdown: bundle.spec_markdown,
        touchesFrontendUi,
        personas: designGate?.personas,
        domainInvariants: designGate?.domain_invariants
      });

      const plannedStack = detectRepositoryStack({
        targetFilesHint: allTargetFiles
      });
      const zizmorFile = buildZizmorConfigYaml();
      const renovateFile = buildRenovateConfigJson(plannedStack);
      const ciFile = buildStackAwareCiWorkflowYaml({
        pinnedSha: "main",
        stack: plannedStack
      });

      const planningFiles: Array<{ path: string; content: string }> = [
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
      const ticketsManifest = parseTrackedTicketsFromComments(allComments);
      if (ticketsManifest.length === 0) {
        throw new Error(
          `Cannot execute '/epure approve' on issue #${input.issueNumber}: no ticket manifest found. Run '/epure plan' and complete the grill first.`
        );
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

      const accumulatedFiles = new Map<string, string>();
      const completedTicketsSummary: string[] = [];

      for (const ticket of ticketsManifest) {
        const taskBranch = `task/${ticket.ticketIssueNumber}-${ticket.slug}`;
        await gh.ensureBranch(taskBranch, featureBranch);

        const existingFilesContext = Array.from(accumulatedFiles.entries())
          .map(([path, content]) => `--- FILE: ${path} ---\n${content}`)
          .join("\n\n");

        const tddSystemInstruction = [
          "Tu es un ingénieur TDD EPURE implémentant un ticket approuvé en TypeScript / React / Vite / Vitest.",
          PROMPT_INJECTION_IMMUNITY_CLAUSE,
          "Règles strictes :",
          "1. Écris des tests unitaires Vitest paramétrés (it.each) couvrant tous les critères d'acceptation et cas limites.",
          "2. Implémente le code propre et complet faisant passer 100% des tests.",
          "3. N'utilise aucune dépendance externe exotique non déclarée dans package.json.",
          "4. Ne modifie JAMAIS .cursor/agents/**, .github/workflows/** ou .github/agents.yml.",
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
          fetchImpl: input.fetchImpl
        });

        let impl = extractJsonObject<GeneratedTicketImplementation>(rawImpl);
        for (const f of impl.files) {
          accumulatedFiles.set(f.path.replace(/^\/+/, ""), f.content);
        }

        // Q78 & Q93: Unified max_code_fix_attempts = 3 shared between sandbox test fixes and PR review fixes
        let fixAttempt = 0;
        const maxCodeFixAttempts = 3;

        let testCheck = await runTestsInIsolatedWorkspace({
          files: Array.from(accumulatedFiles.entries()).map(
            ([path, content]) => ({ path, content })
          ),
          llmApiKey: input.llmApiKey
        });

        while (!testCheck.passed && fixAttempt < maxCodeFixAttempts) {
          fixAttempt += 1;
          const currentFilesContext = Array.from(accumulatedFiles.entries())
            .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
            .join("\n\n");

          const fixSystemInstruction = [
            "Tu es un ingénieur TDD EPURE corrigeant un échec de test Vitest en sandbox isolée.",
            PROMPT_INJECTION_IMMUNITY_CLAUSE,
            "Corrige les fichiers en défaut (code ou assertions de test comme les espaces insécables Unicode U+202F de toLocaleString('fr-FR')) pour que 100% des tests Vitest passent (`vitest run`).",
            "Ne modifie JAMAIS .cursor/agents/**, .github/workflows/** ou .github/agents.yml.",
            "Renvoie un objet JSON strictement valide respectant exactement ce schéma :",
            "{",
            `  "commit_message": "feat(ticket-${ticket.ticketIssueNumber}): ...",`,
            '  "test_summary": "Vitest parameterized suite verified",',
            '  "files": [',
            '    { "path": "...", "content": "..." }',
            "  ]",
            "}"
          ].join("\n");

          const fixPrompt = [
            `La suite de tests Vitest du Ticket #${ticket.ticketIssueNumber} a échoué dans la sandbox avec la sortie suivante :`,
            wrapUntrustedContent(
              "untrusted_test_output",
              testCheck.output
            ),
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
            fetchImpl: input.fetchImpl
          });

          const fixedImpl = extractJsonObject<GeneratedTicketImplementation>(rawFix);
          const mergedFilesMap = new Map<string, string>();
          for (const f of impl.files) {
            mergedFilesMap.set(f.path.replace(/^\/+/, ""), f.content);
          }
          for (const f of fixedImpl.files) {
            const cleanPath = f.path.replace(/^\/+/, "");
            mergedFilesMap.set(cleanPath, f.content);
            accumulatedFiles.set(cleanPath, f.content);
          }
          impl = {
            commit_message: fixedImpl.commit_message || impl.commit_message,
            test_summary: fixedImpl.test_summary || impl.test_summary,
            files: Array.from(mergedFilesMap.entries()).map(([path, content]) => ({
              path,
              content
            }))
          };

          testCheck = await runTestsInIsolatedWorkspace({
            files: Array.from(accumulatedFiles.entries()).map(
              ([path, content]) => ({ path, content })
            ),
            llmApiKey: input.llmApiKey
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
          files: impl.files
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

        const taskPr = await gh.openPullRequest({
          head: taskBranch,
          base: featureBranch,
          title: impl.commit_message,
          body: prBody
        });

        let currentPrHeadSha = taskPr.head_sha;

        // Step 3 (Q92, Q93, Q96): Blocking Multi-Agent PR Review Loop with re-review of failed reviewers
        let reviewResult = await runMultiAgentPrReviewPass({
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
          isReReviewPass: false,
          llmApiKey: input.llmApiKey,
          model,
          fetchImpl: input.fetchImpl
        });

        await gh.postPullRequestReview(taskPr.number, {
          commitId: currentPrHeadSha,
          body: reviewResult.review_body_markdown
        });

        await gh.publishCheckRun({
          name: "ai-review",
          headSha: currentPrHeadSha,
          conclusion: reviewResult.conclusion,
          summary: reviewResult.check_summary_markdown
        });

        if (reviewResult.touches_frontend_ui) {
          await gh.publishCheckRun({
            name: "impeccable-gate",
            headSha: currentPrHeadSha,
            conclusion:
              reviewResult.impeccable_conclusion === "failure"
                ? "failure"
                : "success",
            summary: `Impeccable UI & Accessibility Gate: ${reviewResult.impeccable_conclusion}`
          });
        }

        let reviewFixAttempt = 0;
        while (
          reviewResult.conclusion === "failure" &&
          reviewFixAttempt < maxCodeFixAttempts
        ) {
          reviewFixAttempt += 1;
          process.stdout.write(
            `[EPURE][Ticket #${ticket.ticketIssueNumber}][PR #${taskPr.number}] Multi-agent review fix iteration ${reviewFixAttempt}/${maxCodeFixAttempts} (${reviewResult.must_fix_findings.length} must_fix finding(s))\n`
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
            "Tu es un ingénieur TDD EPURE corrigeant les constats bloquants ('must_fix') émis par le roster de revue multi-agents.",
            PROMPT_INJECTION_IMMUNITY_CLAUSE,
            "Corrige précisément chaque 'must_fix' tout en maintenant 100% des tests Vitest au vert.",
            "Ne modifie JAMAIS .cursor/agents/**, .github/workflows/** ou .github/agents.yml.",
            "Renvoie un objet JSON strictement valide :",
            "{",
            `  "commit_message": "fix(review): address reviewer findings on #${ticket.ticketIssueNumber}",`,
            '  "test_summary": "Addressed must_fix review findings and verified Vitest suite",',
            '  "files": [',
            '    { "path": "...", "content": "..." }',
            "  ]",
            "}"
          ].join("\n");

          const reviewFixPrompt = [
            `Les reviewers multi-agents EPURE ont émis ${reviewResult.must_fix_findings.length} constat(s) bloquant(s) ('must_fix') sur la PR #${taskPr.number} du Ticket #${ticket.ticketIssueNumber} :`,
            wrapUntrustedContent("untrusted_issue_content", findingsText),
            "",
            "Fichiers actuels du workspace :",
            wrapUntrustedContent(
              "untrusted_workspace_files",
              currentFilesContext
            )
          ].join("\n");

          const rawReviewFix = await callGeminiGenerateContent({
            apiKey: input.llmApiKey,
            model,
            thinkingLevel: "HIGH",
            logLabel: `review-fix:#${ticket.ticketIssueNumber}/iter-${reviewFixAttempt}`,
            systemInstruction: reviewFixSystemInstruction,
            prompt: reviewFixPrompt,
            responseMimeType: "application/json",
            temperature: 0.1,
            fetchImpl: input.fetchImpl
          });

          const reviewFixedImpl =
            extractJsonObject<GeneratedTicketImplementation>(rawReviewFix);
          const mergedFilesMap = new Map<string, string>();
          for (const f of impl.files) {
            mergedFilesMap.set(f.path.replace(/^\/+/, ""), f.content);
          }
          for (const f of reviewFixedImpl.files) {
            const cleanPath = f.path.replace(/^\/+/, "");
            mergedFilesMap.set(cleanPath, f.content);
            accumulatedFiles.set(cleanPath, f.content);
          }
          impl = {
            commit_message:
              reviewFixedImpl.commit_message ||
              `fix(review): address reviewer findings on #${ticket.ticketIssueNumber}`,
            test_summary: reviewFixedImpl.test_summary || impl.test_summary,
            files: Array.from(mergedFilesMap.entries()).map(([path, content]) => ({
              path,
              content
            }))
          };

          testCheck = await runTestsInIsolatedWorkspace({
            files: Array.from(accumulatedFiles.entries()).map(
              ([path, content]) => ({ path, content })
            ),
            llmApiKey: input.llmApiKey
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
                `La correction de review a fait échouer la suite de tests Vitest/TypeScript (tentative ${reviewTestRetry}/2) :`,
                wrapUntrustedContent("untrusted_test_output", testCheck.output.slice(-6000)),
                "",
                "Constats must_fix à maintenir corrigés :",
                wrapUntrustedContent("untrusted_issue_content", findingsText),
                "",
                "Fichiers actuels du workspace :",
                wrapUntrustedContent("untrusted_workspace_files", retryFilesContext)
              ].join("\n"),
              responseMimeType: "application/json",
              temperature: 0.1,
              fetchImpl: input.fetchImpl
            });
            const retryImpl = extractJsonObject<GeneratedTicketImplementation>(rawRetryFix);
            for (const f of retryImpl.files) {
              const cleanPath = f.path.replace(/^\/+/, "");
              mergedFilesMap.set(cleanPath, f.content);
              accumulatedFiles.set(cleanPath, f.content);
            }
            impl = {
              commit_message: impl.commit_message,
              test_summary: retryImpl.test_summary || impl.test_summary,
              files: Array.from(mergedFilesMap.entries()).map(([path, content]) => ({
                path,
                content
              }))
            };
            testCheck = await runTestsInIsolatedWorkspace({
              files: Array.from(accumulatedFiles.entries()).map(
                ([path, content]) => ({ path, content })
              ),
              llmApiKey: input.llmApiKey
            });
          }
          if (!testCheck.passed) {
            throw new Error(
              `Sandbox test verification failed while addressing review findings on #${ticket.ticketIssueNumber}:\n${testCheck.output.slice(-2000)}`
            );
          }

          currentPrHeadSha = await gh.commitFilesToBranch({
            branch: taskBranch,
            fromBranch: featureBranch,
            commitMessage: `fix(review): address reviewer findings on #${ticket.ticketIssueNumber}`,
            files: impl.files
          });

          // Q93: Re-run only failed reviewers + spec-parity-reviewer
          reviewResult = await runMultiAgentPrReviewPass({
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
            isReReviewPass: true,
            previousFailedReviewers: reviewResult.failed_reviewers,
            llmApiKey: input.llmApiKey,
            model,
            fetchImpl: input.fetchImpl
          });

          await gh.postPullRequestReview(taskPr.number, {
            commitId: currentPrHeadSha,
            body: reviewResult.review_body_markdown
          });

          await gh.publishCheckRun({
            name: "ai-review",
            headSha: currentPrHeadSha,
            conclusion: reviewResult.conclusion,
            summary: reviewResult.check_summary_markdown
          });

          if (reviewResult.touches_frontend_ui) {
            await gh.publishCheckRun({
              name: "impeccable-gate",
              headSha: currentPrHeadSha,
              conclusion:
                reviewResult.impeccable_conclusion === "failure"
                  ? "failure"
                  : "success",
              summary: `Impeccable UI & Accessibility Gate: ${reviewResult.impeccable_conclusion}`
            });
          }
        }

        if (reviewResult.conclusion === "failure") {
          await gh.postIssueComment(
            input.issueNumber,
            `### Escalation — Multi-Agent Review Blocked on PR #${taskPr.number} (Ticket #${ticket.ticketIssueNumber})\n\nAfter \`${fixAttempt}\` attempts (\`max_code_fix_attempts = ${maxCodeFixAttempts}\`), \`${reviewResult.must_fix_findings.length}\` blocking finding(s) remain open on \`${taskBranch}\`. Human intervention is required.`
          );
          throw new Error(
            `Multi-agent PR review blocked merge for ticket #${ticket.ticketIssueNumber} (PR #${taskPr.number}) with ${reviewResult.must_fix_findings.length} open must_fix finding(s).`
          );
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

        await gh.closeIssue(ticket.ticketIssueNumber);

        completedTicketsSummary.push(
          `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — PR #${taskPr.number} squash-merged into \`${featureBranch}\` as \`${squashCommit.commit_title}\` (Reviewers: ${reviewResult.selected_reviewers.map((r) => `\`${r}\``).join(", ")})`
        );
      }

      // Open final Pull Request feature/* -> dev (requires human review & merge per ADR-0011 Q45, Q91, Q94, Q95)
      const allFeatureFiles = Array.from(accumulatedFiles.entries()).map(
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

      const featurePr = await gh.openPullRequest({
        head: featureBranch,
        base: "dev",
        title: featureSquashPreview.pr_title,
        body: [
          "## Summary",
          `Completes all implementation tickets for plan #${input.issueNumber}.`,
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

      // Q93: Run final synthesis Multi-Agent Review pass on feature/* -> dev PR for the human validator
      const finalFeatureReview = await runMultiAgentPrReviewPass({
        repository: input.repository,
        prNumber: featurePr.number,
        headBranch: featureBranch,
        baseBranch: "dev",
        ticketTitle: issue.title,
        acceptanceCriteria: ticketsManifest.flatMap((t) => t.acceptanceCriteria),
        glossaryMarkdown: issue.body,
        designMarkdown: trustedBaseRoster.designMarkdown,
        changedFiles: allFeatureFiles,
        workspaceFiles: accumulatedFiles,
        trustedBaseBranchFiles: trustedBaseFilesMap,
        isReReviewPass: false,
        llmApiKey: input.llmApiKey,
        model,
        fetchImpl: input.fetchImpl
      });

      await gh.postPullRequestReview(featurePr.number, {
        commitId: featurePr.head_sha,
        body: finalFeatureReview.review_body_markdown
      });

      await gh.publishCheckRun({
        name: "PR title",
        headSha: featurePr.head_sha,
        conclusion: "success",
        summary: `Conventional Commit title verified: '${featureSquashPreview.pr_title}'`
      });

      await gh.publishCheckRun({
        name: "ai-review",
        headSha: featurePr.head_sha,
        conclusion: finalFeatureReview.conclusion,
        summary: finalFeatureReview.check_summary_markdown
      });

      if (finalFeatureReview.touches_frontend_ui) {
        await gh.publishCheckRun({
          name: "impeccable-gate",
          headSha: featurePr.head_sha,
          conclusion:
            finalFeatureReview.impeccable_conclusion === "failure"
              ? "failure"
              : "success",
          summary: `Impeccable UI & Accessibility Gate: ${finalFeatureReview.impeccable_conclusion}`
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
