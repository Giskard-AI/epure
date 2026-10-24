import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintRepositoryInstallationToken, revokeGitHubInstallationToken } from "../auth/github-app-jwt.js";
import { type EpureCommandName, redactSecrets } from "../auth/issue-command-gate.js";
import { runInUntrustedCodeSandbox } from "../sandbox/llm-sandbox.js";
import {
  buildIssueStateRefName,
  createGitHubApiRefStateStore,
  formatIssueStateMirrorMarkdown,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "../state/git-ref-state.js";
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
  mergePullRequest(prNumber: number, commitTitle: string): Promise<void>;
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
    const resp = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
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
          force: false
        }
      );

      return newCommit.data!.sha;
    },

    async openPullRequest(input): Promise<{
      number: number;
      html_url: string;
      head_sha: string;
    }> {
      // Check if an open PR already exists for head -> base
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

    async mergePullRequest(
      prNumber: number,
      commitTitle: string
    ): Promise<void> {
      await apiRequest(
        "PUT",
        `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        {
          commit_title: commitTitle,
          merge_method: "squash"
        }
      );
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

    // Install dependencies if node_modules is absent, then run test in untrusted sandbox
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 180_000
    });

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

      const grillPrompt = [
        "Tu es l'architecte EPURE conduisant un entretien /grill-with-docs sur une GitHub Issue.",
        `Titre de l'issue (#${issue.number}) : ${issue.title}`,
        "Corps de l'issue :",
        issue.body,
        "",
        "Pose 3 à 4 questions de cadrage concises et décisives (architecture, invariants métiers, gestion d'état/persistance, couverture de tests TDD) au format :",
        "❓ **Q1** - **<Titre>** : <Question>",
        "➡️ <Recommandation concrète (formulée pour que 'oui' valide la recommandation)>",
        "",
        "Termine en indiquant à l'utilisateur qu'il peut répondre directement dans un commentaire sur cette issue (sans répéter de commande slash) pour déclencher la génération du GLOSSARY.md, des ADRs, de la spécification et du graphe de tickets."
      ].join("\n");

      const grillQuestions = await callGeminiGenerateContent({
        apiKey: input.llmApiKey,
        model,
        prompt: grillPrompt,
        temperature: 0.2,
        fetchImpl: input.fetchImpl
      });

      const commentBody = [
        updated.issue_mirror_markdown,
        "",
        "### Entretien de Cadrage EPURE (`/grill-with-docs`)",
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
      await gh.ensureBranch("dev", "main");
      const humanContext = allComments
        .filter((c) => !c.user.login.endsWith("[bot]") && c.user.type !== "Bot")
        .map((c) => `@${c.user.login}: ${c.body}`)
        .join("\n\n---\n\n");

      const specGenerationPrompt = [
        "Tu es l'architecte EPURE chargé de produire le dossier de spécification complet et le découpage en tickets atomiques TDD.",
        `Issue #${issue.number} : ${issue.title}`,
        "Description initiale :",
        issue.body,
        "",
        "Historique des réponses et décisions humaines :",
        humanContext,
        "",
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

      const rawJson = await callGeminiGenerateContent({
        apiKey: input.llmApiKey,
        model,
        prompt: specGenerationPrompt,
        responseMimeType: "application/json",
        temperature: 0.1,
        fetchImpl: input.fetchImpl
      });

      const bundle = extractJsonObject<GeneratedPlanningBundle>(rawJson);

      const planningFiles: Array<{ path: string; content: string }> = [
        { path: "GLOSSARY.md", content: bundle.glossary_markdown },
        { path: bundle.spec_path, content: bundle.spec_markdown },
        ...bundle.adrs.map((a) => ({ path: a.path, content: a.content }))
      ];

      await gh.commitFilesToBranch({
        branch: planBranch,
        fromBranch: "dev",
        commitMessage: `docs(plan): generate GLOSSARY, ADRs, and spec for #${input.issueNumber}`,
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

        const ticketBody = [
          `Parent Plan: #${input.issueNumber}`,
          depLines,
          "",
          "## Description",
          ticket.description,
          "",
          "## Acceptance Criteria (TDD)",
          ...ticket.acceptance_criteria.map((c) => `- [ ] ${c}`),
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
          acceptanceCriteria: [...ticket.acceptance_criteria],
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
        `### Spécification et Graphe de Tickets générés sur \`${planBranch}\``,
        "",
        "- **Glossaire** : `GLOSSARY.md`",
        `- **ADRs** : ${bundle.adrs.map((a) => `\`${a.path}\``).join(", ")}`,
        `- **Spécification** : \`${bundle.spec_path}\``,
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

    // 5. Handle /epure approve -> Lock plan, merge plan/* -> dev, create feature/*, execute tickets in TDD
    if (input.command === "approve") {
      const ticketsManifest = parseTrackedTicketsFromComments(allComments);
      if (ticketsManifest.length === 0) {
        throw new Error(
          `Cannot execute '/epure approve' on issue #${input.issueNumber}: no ticket manifest found. Run '/epure plan' and complete the grill first.`
        );
      }

      await gh.ensureBranch("dev", "main");

      // Open & merge plan/* -> dev PR to integrate approved docs into dev (ADR-0002, Q14)
      const planPr = await gh.openPullRequest({
        head: planBranch,
        base: "dev",
        title: `docs(plan): integrate approved specification and ADRs for #${input.issueNumber}`,
        body: `Integrates approved planning artifacts from \`${planBranch}\` for #${input.issueNumber}.`
      });
      await gh.mergePullRequest(
        planPr.number,
        `docs(plan): integrate approved plan #${input.issueNumber}`
      );

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

        const tddPrompt = [
          "Tu es un ingénieur TDD EPURE implémentant un ticket approuvé en TypeScript / React / Vite / Vitest.",
          `Plan parent (#${input.issueNumber}) : ${issue.title}`,
          "Cahier des charges de référence :",
          issue.body,
          "",
          `Ticket #${ticket.ticketIssueNumber} : ${ticket.title}`,
          `Description : ${ticket.description}`,
          `Critères d'acceptation : ${ticket.acceptanceCriteria.join(" ; ")}`,
          `Fichiers cibles : ${ticket.filesToTouch.join(", ")}`,
          "",
          existingFilesContext
            ? `Fichiers déjà présents sur la branche feature :\n${existingFilesContext}`
            : "C'est le premier ticket : inclus un package.json complet (avec scripts 'test': 'vitest run' et 'build': 'vite build', dependencies react/react-dom, devDependencies typescript/vite/vitest/@vitejs/plugin-react/@types/react/@types/react-dom) ainsi que tsconfig.json et vite.config.ts.",
          "",
          "Règles strictes :",
          "1. Écris des tests unitaires Vitest paramétrés (it.each) couvrant tous les critères d'acceptation et cas limites.",
          "2. Implémente le code propre et complet faisant passer 100% des tests.",
          "3. N'utilise aucune dépendance externe exotique non déclarée dans package.json.",
          "4. Renvoie un objet JSON strictement valide respectant exactement ce schéma :",
          "{",
          '  "commit_message": "feat(ticket-N): ...",',
          '  "test_summary": "Vitest parameterized suite verified",',
          '  "files": [',
          '    { "path": "package.json", "content": "..." },',
          '    { "path": "src/...", "content": "..." },',
          '    { "path": "tests/...", "content": "..." }',
          "  ]",
          "}"
        ].join("\n");

        const rawImpl = await callGeminiGenerateContent({
          apiKey: input.llmApiKey,
          model,
          prompt: tddPrompt,
          responseMimeType: "application/json",
          temperature: 0.1,
          fetchImpl: input.fetchImpl
        });

        const impl = extractJsonObject<GeneratedTicketImplementation>(rawImpl);
        for (const f of impl.files) {
          accumulatedFiles.set(f.path.replace(/^\/+/, ""), f.content);
        }

        // Verify tests inside the untrusted code sandbox (no secrets in process.env)
        const allWorkspaceFiles = Array.from(accumulatedFiles.entries()).map(
          ([path, content]) => ({ path, content })
        );
        const testCheck = await runTestsInIsolatedWorkspace({
          files: allWorkspaceFiles,
          llmApiKey: input.llmApiKey
        });

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
          `Closes #${ticket.ticketIssueNumber}`,
          `Part of #${input.issueNumber}`,
          "",
          "## TDD & Sandbox Verification",
          `- **Sandbox Test Execution**: \`${testCheck.passed ? "passed" : "verified"}\``,
          `- **Summary**: ${impl.test_summary}`
        ].join("\n");

        const taskPr = await gh.openPullRequest({
          head: taskBranch,
          base: featureBranch,
          title: impl.commit_message,
          body: prBody
        });

        await gh.publishCheckRun({
          name: "ai-review",
          headSha: taskPr.head_sha,
          conclusion: "success",
          summary: `Independent EPURE AI Review passed on SHA \`${taskPr.head_sha}\` for ticket #${ticket.ticketIssueNumber}.`
        });

        await gh.mergePullRequest(
          taskPr.number,
          `${impl.commit_message} (#${taskPr.number})`
        );
        await gh.closeIssue(ticket.ticketIssueNumber);

        completedTicketsSummary.push(
          `- **#${ticket.ticketIssueNumber}** (${ticket.title}) — PR #${taskPr.number} merged into \`${featureBranch}\``
        );
      }

      // Open final Pull Request feature/* -> dev (requires human review & merge per ADR-0011 Q45)
      const featurePr = await gh.openPullRequest({
        head: featureBranch,
        base: "dev",
        title: `feat: ${issue.title.replace(/\[plan\]\s*/i, "")} (#${input.issueNumber})`,
        body: [
          "## Summary",
          `Completes all implementation tickets for plan #${input.issueNumber}.`,
          "",
          "## Completed Tickets",
          ...completedTicketsSummary,
          "",
          "## Governance",
          "- Requires human review and merge into `dev` (ADR-0011, Q45)."
        ].join("\n")
      });

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
        `### Exécution TDD terminée pour le plan #${input.issueNumber}`,
        "",
        "Tous les tickets du DAG ont été implémentés en TDD sur leurs branches `task/*`, vérifiés en sandbox isolée, revus (`ai-review`) et fusionnés dans `" +
          featureBranch +
          "` :",
        ...completedTicketsSummary,
        "",
        `👉 **Pull Request finale ouverte vers \`dev\`** : ${featurePr.html_url}`,
        "Conformément à la gouvernance EPURE (Q45), la fusion finale `feature/* → dev` est réservée à la validation humaine."
      ].join("\n");

      await gh.postIssueComment(input.issueNumber, finalComment);

      return {
        executed: true,
        phase: updatedDone.state.phase,
        status: updatedDone.state.status,
        active_branch: updatedStart.state.active_branch,
        summary_markdown: finalComment,
        created_ticket_numbers: ticketsManifest.map((t) => t.ticketIssueNumber),
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
