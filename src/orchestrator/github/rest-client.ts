import { parseAgentsYaml } from "../../bootstrap/setup-repo.js";
import type {
  CheckRunAnnotationRecord,
  ExternalCheckRunRecord,
  ExternalWorkflowRunRecord
} from "../../execution/external-ci-gate.js";
import {
  buildIssueStateRefName,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefSnapshot,
  type GitRefStateStore
} from "../../state/git-ref-state.js";
import type {
  GitHubRestHelper,
  IssueCommentRecord,
  IssueMetadata
} from "../types.js";

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

export function slugifyTitle(raw: string): string {
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

export function encodeGitHubContentsPath(filePath: string): string {
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
        state_reason?: "completed" | "not_planned" | "reopened" | null;
      }>("GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
      return {
        number: data?.number ?? issueNumber,
        title: data?.title ?? `Issue #${issueNumber}`,
        body: data?.body ?? "",
        state: data?.state ?? "open",
        state_reason: data?.state_reason ?? null
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
      await apiRequest(
        "PATCH",
        `/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          state: "closed",
          state_reason: "completed"
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
        const blobRes = await apiRequest<{
          content?: string;
          encoding?: string;
        }>("GET", `/repos/${owner}/${repo}/git/blobs/${match.sha}`, undefined, true);
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

    async readBranchWorkspaceFiles(
      branch: string,
      hintText = ""
    ): Promise<Map<string, string>> {
      const filesMap = new Map<string, string>();
      try {
        const treeRes = await apiRequest<{
          tree?: Array<{
            path?: string;
            type?: string;
            sha?: string;
            size?: number;
          }>;
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
            /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(
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

          const scored = candidates.map((entry) => {
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
          const blobRes = await apiRequest<{
            content?: string;
            encoding?: string;
          }>(
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

    async readTrustedBaseRosterFiles(
      branch: string
    ): Promise<Map<string, string>> {
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
          if (
            !/^\.cursor\/agents\/[a-z0-9-]+\.md$/i.test(p) &&
            p !== "DESIGN.md"
          ) {
            continue;
          }
          const blobRes = await apiRequest<{
            content?: string;
            encoding?: string;
          }>(
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
          const blobRes = await apiRequest<{
            content?: string;
            encoding?: string;
          }>(
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
  } catch {
    return null;
  }
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
