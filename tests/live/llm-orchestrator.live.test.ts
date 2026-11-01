import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LLMClient, type ProviderConfig } from "../../src/llm/index.js";
import { orchestrateIssueCommand } from "../../src/orchestrator/issue-orchestrator.js";
import { GRILL_ROUND_EVALUATION_SCHEMA } from "../../src/orchestrator/prompts/schemas.js";
import { createInMemoryGitRefStateStore } from "../../src/state/git-ref-state.js";

export interface LiveLLMTargetConfig {
  readonly id: string;
  readonly planningModel: string;
  readonly executionModel?: string | undefined;
  readonly reviewModel?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly providers?: Readonly<Record<string, ProviderConfig>> | undefined;
}

function loadLiveTestTargets(): LiveLLMTargetConfig[] {
  const inlineJson = process.env.EPURE_LIVE_TEST_TARGETS_JSON?.trim();
  if (inlineJson) {
    const parsed = JSON.parse(inlineJson) as
      | LiveLLMTargetConfig[]
      | { targets?: LiveLLMTargetConfig[] };
    return Array.isArray(parsed) ? parsed : (parsed.targets ?? []);
  }

  const configPath = resolve(
    process.env.EPURE_LIVE_TEST_CONFIG?.trim() || "epure.live-test.json"
  );
  if (!existsSync(configPath)) {
    return [];
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as
    | LiveLLMTargetConfig[]
    | { targets?: LiveLLMTargetConfig[] };
  return Array.isArray(parsed) ? parsed : (parsed.targets ?? []);
}

function buildAgentsYamlForTarget(target: LiveLLMTargetConfig): string {
  const lines: string[] = [
    "models:",
    `  planning: ${target.planningModel}`,
    `  implementation: ${target.executionModel ?? target.planningModel}`,
    `  review: ${target.reviewModel ?? target.planningModel}`
  ];

  if (target.providers && Object.keys(target.providers).length > 0) {
    lines.push("providers:");
    for (const [alias, cfg] of Object.entries(target.providers)) {
      lines.push(`  ${alias}:`);
      if (cfg.provider) {
        lines.push(`    provider: ${cfg.provider}`);
      }
      const apiKeyVal = cfg.api_key ?? cfg.apiKey;
      if (apiKeyVal) {
        lines.push(`    api_key: ${apiKeyVal}`);
      }
      const baseUrlVal = cfg.base_url ?? cfg.baseUrl;
      if (baseUrlVal) {
        lines.push(`    base_url: ${baseUrlVal}`);
      }
      const apiVersionVal = cfg.api_version ?? cfg.apiVersion;
      if (apiVersionVal) {
        lines.push(`    api_version: ${apiVersionVal}`);
      }
      if (cfg.effort) {
        lines.push(`    effort: ${cfg.effort}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function createHybridLiveFetch(params: {
  readonly target: LiveLLMTargetConfig;
  readonly issueTitle: string;
  readonly issueBody: string;
}) {
  const comments: Array<{
    id: number;
    body: string;
    user: { login: string; type: "User" | "Bot" };
    created_at: string;
  }> = [];
  const createdSubIssues: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
  }> = [];

  const branchFiles = new Map<string, Map<string, string>>();
  const blobStore = new Map<string, string>();
  let blobSeq = 1;

  const setBranchFile = (branch: string, path: string, content: string) => {
    let map = branchFiles.get(branch);
    if (!map) {
      map = new Map<string, string>();
      branchFiles.set(branch, map);
    }
    map.set(path, content);
  };

  const agentsYaml = buildAgentsYamlForTarget(params.target);
  for (const baseBranch of ["main", "dev"]) {
    setBranchFile(baseBranch, ".github/agents.yml", agentsYaml);
    setBranchFile(
      baseBranch,
      "README.md",
      "# Dice Roller Library\n\nDeterministic TypeScript dice expression evaluator (`2d6+3`).\n"
    );
    setBranchFile(
      baseBranch,
      "GLOSSARY.md",
      "# Glossary\n\n- **Dice Expression**: Standard notation `NdS+M` where `N` is dice count, `S` is sides, and `M` is modifier.\n"
    );
    setBranchFile(
      baseBranch,
      "src/dice.ts",
      "export function parseDiceExpression(expr: string): { count: number; sides: number; modifier: number } {\n  return { count: 1, sides: 6, modifier: 0 };\n}\n"
    );
  }

  const getBranchMap = (branch: string): Map<string, string> => {
    const existing = branchFiles.get(branch);
    if (existing) {
      return existing;
    }
    const cloned = new Map<string, string>(branchFiles.get("dev") ?? []);
    branchFiles.set(branch, cloned);
    return cloned;
  };

  const hybridFetch: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    // Pass all non-GitHub requests directly to the real LLM provider over the network
    if (!urlStr.includes("api.github.com")) {
      return await fetch(url, init);
    }

    const parsedUrl = new URL(urlStr);
    const pathname = parsedUrl.pathname;

    // 1. Issue metadata
    if (pathname.endsWith("/issues/42") && method === "GET") {
      return new Response(
        JSON.stringify({
          number: 42,
          title: params.issueTitle,
          body: params.issueBody,
          state: "open"
        }),
        { status: 200 }
      );
    }

    // 2. Issue comments list & post
    if (pathname.endsWith("/issues/42/comments") && method === "GET") {
      const page = Number(parsedUrl.searchParams.get("page") ?? "1");
      if (page > 1) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify(comments), { status: 200 });
    }

    if (pathname.endsWith("/issues/42/comments") && method === "POST") {
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
        body?: string;
      };
      const newComment = {
        id: 1000 + comments.length + 1,
        body: bodyObj.body ?? "",
        user: { login: "epure-agent[bot]", type: "Bot" as const },
        created_at: new Date().toISOString()
      };
      comments.push(newComment);
      return new Response(
        JSON.stringify({
          id: newComment.id,
          html_url: `https://github.com/test-org/dice-lib/issues/42#issuecomment-${newComment.id}`
        }),
        { status: 201 }
      );
    }

    // 3. Create sub-issues (/epure to-tickets)
    if (pathname.endsWith("/issues") && method === "POST") {
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
        title?: string;
        body?: string;
        labels?: string[];
      };
      const issueNum = 100 + createdSubIssues.length + 1;
      createdSubIssues.push({
        number: issueNum,
        title: bodyObj.title ?? "",
        body: bodyObj.body ?? "",
        labels: bodyObj.labels ?? []
      });
      return new Response(
        JSON.stringify({
          number: issueNum,
          html_url: `https://github.com/test-org/dice-lib/issues/${issueNum}`
        }),
        { status: 201 }
      );
    }

    // 4. Git trees & blobs for readSingleBranchFile / readBranchWorkspaceFiles / commitFilesToBranch
    if (pathname.includes("/git/trees/") && method === "GET") {
      const encodedBranch = pathname.split("/git/trees/")[1] ?? "dev";
      const branch = decodeURIComponent(encodedBranch);
      const map = getBranchMap(branch);
      const treeEntries: Array<{
        path: string;
        type: "blob";
        sha: string;
        size: number;
      }> = [];
      for (const [filePath, content] of map.entries()) {
        const sha = `blob_${blobSeq++}`;
        blobStore.set(sha, content);
        treeEntries.push({
          path: filePath,
          type: "blob",
          sha,
          size: Buffer.byteLength(content, "utf8")
        });
      }
      return new Response(JSON.stringify({ sha: "tree_root", tree: treeEntries }), {
        status: 200
      });
    }

    if (pathname.includes("/git/blobs/") && method === "GET") {
      const sha = pathname.split("/git/blobs/")[1] ?? "";
      const content = blobStore.get(sha) ?? "";
      return new Response(
        JSON.stringify({
          sha,
          encoding: "base64",
          content: Buffer.from(content, "utf8").toString("base64")
        }),
        { status: 200 }
      );
    }

    if (pathname.endsWith("/git/blobs") && method === "POST") {
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
        content?: string;
        encoding?: string;
      };
      const sha = `blob_${blobSeq++}`;
      const decoded =
        bodyObj.encoding === "base64"
          ? Buffer.from(bodyObj.content ?? "", "base64").toString("utf8")
          : (bodyObj.content ?? "");
      blobStore.set(sha, decoded);
      return new Response(JSON.stringify({ sha }), { status: 201 });
    }

    if (pathname.endsWith("/git/trees") && method === "POST") {
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
        tree?: Array<{ path?: string; sha?: string | null }>;
      };
      for (const entry of bodyObj.tree ?? []) {
        if (entry.path && entry.sha && blobStore.has(entry.sha)) {
          const content = blobStore.get(entry.sha)!;
          for (const b of branchFiles.keys()) {
            if (b.startsWith("plan/")) {
              setBranchFile(b, entry.path, content);
            }
          }
          setBranchFile(
            "plan/42-add-advantage-disadvantage-roll-mode",
            entry.path,
            content
          );
        }
      }
      return new Response(JSON.stringify({ sha: "new_tree_sha" }), {
        status: 201
      });
    }

    if (pathname.includes("/git/ref/heads/") && method === "GET") {
      const branch = decodeURIComponent(
        pathname.split("/git/ref/heads/")[1] ?? "dev"
      );
      getBranchMap(branch);
      return new Response(
        JSON.stringify({ object: { sha: "commit_sha_1" } }),
        { status: 200 }
      );
    }

    if (pathname.includes("/git/commits/") && method === "GET") {
      return new Response(
        JSON.stringify({ sha: "commit_sha_1", tree: { sha: "tree_sha_1" } }),
        { status: 200 }
      );
    }

    if (pathname.endsWith("/git/commits") && method === "POST") {
      return new Response(JSON.stringify({ sha: "commit_sha_2" }), {
        status: 201
      });
    }

    if (pathname.includes("/git/refs") && (method === "POST" || method === "PATCH")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (pathname.includes("/labels")) {
      return new Response(JSON.stringify({ name: "ready-for-agent" }), {
        status: 200
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  return {
    hybridFetch,
    comments,
    createdSubIssues,
    getBranchFile: (branch: string, path: string) =>
      branchFiles.get(branch)?.get(path) ?? null
  };
}

const liveTargets = loadLiveTestTargets();
const describeLive = liveTargets.length > 0 ? describe : describe.skip;

describeLive(
  "EPURE Live Multi-Provider LLM & Orchestrator Suite (Agnostic Target Matrix)",
  () => {
    it.each(
      liveTargets.length > 0
        ? liveTargets
        : [{ id: "skipped", planningModel: "google/gemini-3-flash-preview" }]
    )(
      "[$id] 1. executes tool calls + structured JSON output without ellipsis truncation",
      async (target) => {
        const client = new LLMClient({
          ...(target.providers ? { providers: target.providers } : {})
        });
        let toolInvocations = 0;

        const evaluation = await client.completeStructured({
          model: target.planningModel,
          apiKey: target.apiKey,
          systemInstruction:
            "Tu es l'architecte EPURE évaluant un round de grill. Utilise `read_repo_file` pour lire `src/dice.ts` avant de produire l'objet JSON.",
          userPrompt:
            "L'utilisateur demande d'ajouter le support de `2d20kh1` (advantage). Il n'a pas encore précisé le comportement en cas de nombre de dés négatif. Pose une question de suivi.",
          temperature: 0.1,
          maxToolRounds: 3,
          tools: [
            {
              name: "read_repo_file",
              description: "Lit un fichier du dépôt",
              parameters: {
                type: "OBJECT",
                properties: {
                  path: { type: "STRING", description: "Chemin du fichier" }
                },
                required: ["path"]
              }
            }
          ],
          toolHandlers: {
            read_repo_file: async () => {
              toolInvocations += 1;
              return {
                content:
                  "export function parseDiceExpression(expr: string) { return { count: 1, sides: 20, modifier: 0 }; }"
              };
            }
          },
          responseSchema: GRILL_ROUND_EVALUATION_SCHEMA
        });

        expect(toolInvocations).toBeGreaterThanOrEqual(1);
        expect(typeof evaluation.frontier_resolved).toBe("boolean");
        expect(evaluation.rationale.trim().length).toBeGreaterThan(5);
        expect(evaluation.rationale.trim()).not.toBe("...");
      },
      120_000
    );

    it.each(
      liveTargets.length > 0
        ? liveTargets
        : [{ id: "skipped", planningModel: "google/gemini-3-flash-preview" }]
    )(
      "[$id] 2. executes full 4-stage lifecycle (/epure plan -> grill replies -> /epure to-spec -> /epure to-tickets) against real LLM",
      async (target) => {
        const store = createInMemoryGitRefStateStore();
        const ghState = createHybridLiveFetch({
          target,
          issueTitle: "Add advantage/disadvantage roll mode",
          issueBody:
            "We want to support `2d20kh1` (advantage) and `2d20kl1` (disadvantage) in `src/dice.ts`."
        });

        // Stage 1: /epure plan -> grilling (active)
        const planRes = await orchestrateIssueCommand({
          repository: "test-org/dice-lib",
          issueNumber: 42,
          command: "plan",
          commandArgs: "",
          commentId: 1,
          actor: "maintainer",
          fallbackGithubToken: "ghs_test",
          llmApiKey: target.apiKey ?? "",
          stateStore: store,
          fetchImpl: ghState.hybridFetch
        });

        expect(planRes.executed).toBe(true);
        expect(planRes.phase).toBe("grilling");
        expect(planRes.status).toBe("active");
        expect(planRes.created_ticket_numbers).toEqual([]);

        // Stage 2: Human reply answering all questions and confirming everything is decided
        ghState.comments.push({
          id: 2001,
          body: "Oui je valide toutes tes recommandations : syntaxe uniquement `kh1` et `kl1` sur `NdS`, erreur synchrone `TypeError` si `N < 1` ou `S < 2`, PRNG injectable `(sides: number) => number` pour les tests déterministes, aucun autre changement.",
          user: { login: "maintainer", type: "User" },
          created_at: new Date().toISOString()
        });

        const replyRes = await orchestrateIssueCommand({
          repository: "test-org/dice-lib",
          issueNumber: 42,
          command: "reply",
          commandArgs: ghState.comments[ghState.comments.length - 1]!.body,
          commentId: 2001,
          actor: "maintainer",
          fallbackGithubToken: "ghs_test",
          llmApiKey: target.apiKey ?? "",
          stateStore: store,
          fetchImpl: ghState.hybridFetch
        });

        expect(replyRes.executed).toBe(true);
        expect(replyRes.phase).toBe("grilling");
        expect(replyRes.created_ticket_numbers).toEqual([]);

        // Stage 3: /epure to-spec -> phase="spec", status="awaiting_human_approval", 0 tickets, non-ellipsis spec committed
        const toSpecRes = await orchestrateIssueCommand({
          repository: "test-org/dice-lib",
          issueNumber: 42,
          command: "to-spec",
          commandArgs: "",
          commentId: 2002,
          actor: "maintainer",
          fallbackGithubToken: "ghs_test",
          llmApiKey: target.apiKey ?? "",
          stateStore: store,
          fetchImpl: ghState.hybridFetch
        });

        expect(toSpecRes.executed).toBe(true);
        expect(toSpecRes.phase).toBe("spec");
        expect(toSpecRes.status).toBe("awaiting_human_approval");
        expect(toSpecRes.created_ticket_numbers).toEqual([]);
        const committedSpec = ghState.getBranchFile(
          "plan/42-add-advantage-disadvantage-roll-mode",
          "docs/specs/add-advantage-disadvantage-roll-mode.md"
        );
        expect(committedSpec).toBeTruthy();
        expect(committedSpec!.trim().length).toBeGreaterThan(80);
        expect(committedSpec!.trim()).not.toBe("...");

        // Stage 4: /epure to-tickets -> phase="tickets", status="awaiting_human_approval", creates non-ellipsis sub-issues
        const toTicketsRes = await orchestrateIssueCommand({
          repository: "test-org/dice-lib",
          issueNumber: 42,
          command: "to-tickets",
          commandArgs: "",
          commentId: 2003,
          actor: "maintainer",
          fallbackGithubToken: "ghs_test",
          llmApiKey: target.apiKey ?? "",
          stateStore: store,
          fetchImpl: ghState.hybridFetch
        });

        expect(toTicketsRes.executed).toBe(true);
        expect(toTicketsRes.phase).toBe("tickets");
        expect(toTicketsRes.status).toBe("awaiting_human_approval");
        expect(toTicketsRes.created_ticket_numbers.length).toBeGreaterThanOrEqual(
          1
        );
        for (const subIssue of ghState.createdSubIssues) {
          expect(subIssue.title.trim()).not.toBe("...");
          expect(subIssue.title.trim().endsWith("...")).toBe(false);
          expect(subIssue.body).not.toContain("## Description\n...");
        }
      },
      600_000
    );
  }
);
