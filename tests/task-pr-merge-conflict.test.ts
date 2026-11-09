import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEngine, AgentSessionRequest } from "../src/agent/engine.js";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import {
  createInMemoryGitRefStateStore,
  updateIssueStateWithCas
} from "../src/state/git-ref-state.js";

const TASK_BRANCH = "task/72-slice-1-postgres-and-routes";
const RESYNC_SHA = "resync-merge-sha";

const MANIFEST = {
  planBranch: "plan/70-postgres-slice",
  specPath: "docs/specs/postgres-slice.md",
  tickets: [
    {
      ticketIssueNumber: 72,
      slug: "slice-1-postgres-and-routes",
      title: "[Ticket 1] Slice 1 Postgres and Routes",
      description: "Implement postgres store",
      acceptanceCriteria: ["Postgres store works"],
      blockedByIssueNumbers: [],
      filesToTouch: ["src/postgres.ts"]
    }
  ]
};

function gemini(payload: unknown): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    { status: 200 }
  );
}

function geminiAnswer(body: string, findings: readonly unknown[]): Response {
  const props = (
    JSON.parse(body) as { generationConfig?: { responseJsonSchema?: { properties?: Record<string, unknown> } } }
  ).generationConfig?.responseJsonSchema?.properties ?? {};
  if ("findings" in props || (findings.length > 0 && body.includes("reviewer"))) {
    return gemini({ reviewer: "standards-reviewer", summary: "LGTM", findings });
  }
  if ("verdict" in props && "unwired_modules" in props) {
    return gemini({ verdict: "CONVERGED", rationale: "wired", unwired_modules: [], stub_violations: [], unmet_criteria: [], remediation_tickets: [] });
  }
  if ("type" in props && "scope" in props && "subject" in props) {
    return gemini({ type: "feat", scope: "postgres", subject: "add postgres store", body: "Slice 1." });
  }
  return gemini({
    commit_message: "feat(ticket-72): add postgres store",
    test_summary: "ok",
    files: [{ path: "src/postgres.ts", content: "export const pg = true;\n" }],
    patches: [],
    deleted_files: []
  });
}

interface AgentScenario {
  readonly engine: AgentEngine;
  // Answers a request before the shared routes; undefined falls through.
  readonly route: (method: string, path: string) => Response | undefined;
  readonly reviewFindings: () => readonly unknown[];
}

interface Scenario {
  // Responses of `PUT /pulls/172/merge`, in order (the last one repeats).
  readonly mergeStatuses: readonly number[];
  // `POST /merges` of the feature branch into the task branch: 201 creates RESYNC_SHA, 204 = already up to date.
  readonly resyncStatus: 201 | 204;
  readonly firstMergeableState: string;
  readonly laterMergeableState?: string;
  readonly refusalMessage?: string;
  // Head of PR #172 once a 409 answered the merge (someone pushed after the review).
  readonly movedHeadSha?: string;
  readonly agent?: AgentScenario;
}

async function runTicket(scenario: Scenario) {
  const store = createInMemoryGitRefStateStore();
  await updateIssueStateWithCas({
    issueNumber: 70,
    store,
    mutator: (s) => ({
      ...s,
      phase: "tickets",
      status: "awaiting_human_approval",
      spec_sha: "spec-sha-70",
      active_branch: "plan/70-postgres-slice"
    })
  });
  const requests: Array<{ method: string; path: string; body: string }> = [];
  let mergeAttempts = 0;
  let mergeableReads = 0;
  let merged = false;

  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    const path = `${u.pathname}${u.search}`;
    requests.push({ method, path, body });
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

    if (u.hostname === "generativelanguage.googleapis.com") {
      return geminiAnswer(body, scenario.agent?.reviewFindings() ?? []);
    }
    const routed = scenario.agent?.route(method, path);
    if (routed) {
      return routed;
    }
    if (path.endsWith("/issues/70") && method === "GET") {
      return reply({ id: 7000, number: 70, title: "[Plan] Slice 1 Postgres", body: "Plan body", state: "open" });
    }
    if (path.endsWith("/issues/72") && method === "GET") {
      return reply({ id: 7200, number: 72, title: MANIFEST.tickets[0]!.title, body: "Ticket body", state: "open" });
    }
    if (path.includes("/issues/70/comments") && method === "GET") {
      return reply([
        {
          id: 701,
          body: `<!-- epure-plan-manifest:${JSON.stringify(MANIFEST)} -->`,
          user: { login: "github-actions[bot]", type: "Bot" },
          performed_via_github_app: { id: 15368 },
          created_at: "2026-10-31T10:00:00Z"
        }
      ]);
    }
    if (path.includes("/git/trees/") && method === "GET") {
      return reply({ tree: [{ path: "package.json", type: "blob", size: 100 }] });
    }
    if (path.includes("/contents/package.json")) {
      return reply({
        content: Buffer.from(JSON.stringify({ name: "slice", scripts: { test: "vitest run" } })).toString("base64"),
        encoding: "base64"
      });
    }
    if (path.includes("/git/ref/heads/")) {
      return reply({ object: { sha: "base-sha-70" } });
    }
    if (path.includes("/git/commits/") && method === "GET") {
      return reply({ sha: "commit-sha-70", tree: { sha: "tree-sha-70" } });
    }
    if (path.endsWith("/git/blobs") || path.endsWith("/git/trees")) {
      return reply({ sha: "object-sha-70" }, 201);
    }
    if (path.endsWith("/git/commits") && method === "POST") {
      return reply({ sha: "new-commit-sha-70" }, 201);
    }
    if (path.endsWith("/merges") && method === "POST") {
      const { base } = JSON.parse(body) as { base: string };
      if (base === TASK_BRANCH && scenario.resyncStatus === 201) {
        return reply({ sha: RESYNC_SHA }, 201);
      }
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/pulls/172") && method === "GET") {
      mergeableReads += 1;
      return reply({
        number: 172,
        mergeable_state: mergeableReads === 1 ? scenario.firstMergeableState : (scenario.laterMergeableState ?? "clean")
      });
    }
    if (path.endsWith("/pulls/172/merge") && method === "PUT") {
      const status = scenario.mergeStatuses[Math.min(mergeAttempts, scenario.mergeStatuses.length - 1)]!;
      mergeAttempts += 1;
      if (status === 409) {
        return reply({ message: "Head branch was modified. Review and try the merge again." }, 409);
      }
      if (status === 405) {
        return reply({ message: scenario.refusalMessage ?? "Pull Request is not mergeable" }, 405);
      }
      merged = true;
      return reply({ merged: true, sha: "merged-sha-172" });
    }
    if (path.includes("/pulls?state=open") && method === "GET" && scenario.movedHeadSha && mergeAttempts > 0 && !merged) {
      return reply([{ number: 172, html_url: "https://github.com/acme/repo/pull/172", title: "feat", head: { sha: scenario.movedHeadSha } }]);
    }
    if (path.includes("/pulls") && method === "GET") {
      return reply([]);
    }
    if (path.endsWith("/pulls") && method === "POST") {
      const number = (JSON.parse(body) as { head: string }).head === TASK_BRANCH ? 172 : 173;
      return reply({ number, html_url: `https://github.com/acme/repo/pull/${number}`, head: { sha: "new-commit-sha-70" } }, 201);
    }
    if (path.includes("/actions/workflows")) {
      return reply({ total_count: 0, workflows: [] });
    }
    return reply({ ok: true });
  };

  const result = await orchestrateIssueCommand({
    repository: "acme/repo",
    issueNumber: 70,
    command: "approve",
    commandArgs: "",
    model: "google/gemini-3.8-flash",
    commentId: 999,
    actor: "Maintainer",
    fallbackGithubToken: "ghs_mock_token",
    llmApiKey: "AIzaMockKey",
    stateStore: store,
    fetchImpl,
    agentEngine: scenario.agent?.engine,
    sandboxRunner: async () => ({
      isolated: true,
      error_code: "NONE",
      error_message: "",
      exit_code: 0,
      stdout: "All tests passed",
      stderr: "",
      duration_ms: 1,
      proxy_url: "http://127.0.0.1:0"
    })
  });
  const state = (await store.readRef("refs/epure/state/70")).state!;
  const reviewedShas = requests
    .filter((r) => r.method === "POST" && r.path.endsWith("/pulls/172/reviews"))
    .map((r) => (JSON.parse(r.body) as { commit_id: string }).commit_id);
  const taskResyncs = requests.filter(
    (r) => r.method === "POST" && r.path.endsWith("/merges") && r.body.includes(`"base":"${TASK_BRANCH}"`)
  ).length;
  const mergeShas = requests
    .filter((r) => r.method === "PUT" && r.path.endsWith("/pulls/172/merge"))
    .map((r) => (JSON.parse(r.body) as { sha: string }).sha);
  const committedBlobs = requests
    .filter((r) => r.method === "POST" && r.path.endsWith("/git/blobs"))
    .map((r) => JSON.parse(r.body) as { content: string });
  return { result, state, mergeAttempts, mergeShas, reviewedShas, taskResyncs, committedBlobs };
}

describe("ticket execution — a conflicting task PR is re-synced instead of waiting or failing (#105)", () => {
  it.each([
    {
      id: "dirty-pr-is-re-synced-before-review-and-ci-then-merged",
      scenario: { mergeStatuses: [200], resyncStatus: 201, firstMergeableState: "dirty" },
      expected: { status: "done", reason: undefined, mergeAttempts: 1, reviewedShas: [RESYNC_SHA] }
    },
    {
      id: "merge-refused-once-re-syncs-re-verifies-the-new-head-and-merges",
      scenario: { mergeStatuses: [405, 200], resyncStatus: 201, firstMergeableState: "clean" },
      expected: { status: "done", reason: undefined, mergeAttempts: 2, reviewedShas: ["new-commit-sha-70", RESYNC_SHA] }
    },
    {
      id: "merge-refused-twice-escalates-merge_conflict_unresolved",
      scenario: { mergeStatuses: [405], resyncStatus: 201, firstMergeableState: "clean" },
      expected: { status: "suspended", reason: "merge_conflict_unresolved", mergeAttempts: 2, reviewedShas: ["new-commit-sha-70", RESYNC_SHA] }
    },
    {
      id: "merge-refused-on-an-up-to-date-branch-escalates-pr_not_mergeable-without-retrying",
      scenario: { mergeStatuses: [405], resyncStatus: 204, firstMergeableState: "clean" },
      expected: { status: "suspended", reason: "pr_not_mergeable", mergeAttempts: 1, reviewedShas: ["new-commit-sha-70"] }
    }
  ] as const)("$id", async ({ scenario, expected }) => {
    const { result, state, mergeAttempts, mergeShas, reviewedShas, taskResyncs } = await runTicket(scenario);

    expect(result.status).toBe(expected.status);
    expect(state.last_escalation?.reason).toBe(expected.reason);
    expect(mergeAttempts).toBe(expected.mergeAttempts);
    expect(mergeShas).toEqual(reviewedShas.slice(0, expected.mergeAttempts));
    expect(reviewedShas).toEqual(expected.reviewedShas);
    expect(taskResyncs).toBeGreaterThan(0);
    if (expected.reason) {
      expect(result.summary_markdown).toContain(
        "GitHub refused to merge PR #172 (HTTP 405: not mergeable): Pull Request is not mergeable (mergeable_state: `clean`)"
      );
    }
  });

  it("merge-refused-by-a-ruleset-escalates-pr_not_mergeable-without-re-syncing", async () => {
    const { result, state, mergeAttempts, reviewedShas } = await runTicket({
      mergeStatuses: [405],
      resyncStatus: 201,
      firstMergeableState: "clean",
      refusalMessage: "Repository rule violations found",
      laterMergeableState: "blocked"
    });

    expect(state.last_escalation?.reason).toBe("pr_not_mergeable");
    expect(mergeAttempts).toBe(1);
    expect(reviewedShas).toEqual(["new-commit-sha-70"]);
    expect(result.summary_markdown).toContain("Repository rule violations found (mergeable_state: `blocked`)");
  });

  it("agent-session-after-a-mid-ticket-re-sync-sees-and-commits-the-merged-files", async () => {
    const MERGED_POSTGRES = "export const pg = true;\nexport const merged = 'from-feature';\n";
    const FEATURE_ONLY = "export const featureOnly = 1;\n";
    const base64File = (text: string) =>
      new Response(JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") }), { status: 200 });
    const requests: AgentSessionRequest[] = [];
    const worktreeSeenByFixer: Record<string, string | null> = {};
    const engine: AgentEngine = {
      name: "scripted",
      run: async (request) => {
        requests.push(request);
        if (request.role === "fixer") {
          for (const path of ["src/postgres.ts", "src/feature-only.ts"]) {
            const abs = join(request.worktree, path);
            worktreeSeenByFixer[path] = existsSync(abs) ? readFileSync(abs, "utf8") : null;
          }
          return { finalMessage: "Fixed.", diff: { files: [{ path: "src/fix.ts", content: "export const fix = 1;\n", mode: "100644" }], deleted_files: [], skipped: [] } };
        }
        return { finalMessage: "Wrote.", diff: { files: [{ path: "src/postgres.ts", content: "export const pg = true;\n", mode: "100644" }], deleted_files: [], skipped: [] } };
      }
    };

    const { result, committedBlobs } = await runTicket({
      mergeStatuses: [200],
      resyncStatus: 201,
      firstMergeableState: "dirty",
      agent: {
        engine,
        reviewFindings: () =>
          requests.some((r) => r.role === "fixer")
            ? []
            : [{ category: "must_fix", severity: "high", path: "src/postgres.ts", line: 1, title: "Missing fix", rationale: "Add src/fix.ts." }],
        route: (method, path) => {
          if (method === "GET" && path.includes("/pulls/172/files")) {
            return new Response(JSON.stringify([{ filename: "src/postgres.ts", status: "modified", patch: "@@ -1 +1 @@" }]), { status: 200 });
          }
          if (method === "GET" && path.includes(`/compare/new-commit-sha-70...${RESYNC_SHA}`)) {
            return new Response(
              JSON.stringify({ merge_base_commit: { sha: "base-sha-70" }, files: [{ filename: "src/postgres.ts" }, { filename: "src/feature-only.ts" }], ahead_by: 1 }),
              { status: 200 }
            );
          }
          if (method === "GET" && path.includes(`/contents/src/postgres.ts?ref=${RESYNC_SHA}`)) {
            return base64File(MERGED_POSTGRES);
          }
          if (method === "GET" && path.includes(`/contents/src/feature-only.ts?ref=${RESYNC_SHA}`)) {
            return base64File(FEATURE_ONLY);
          }
          return undefined;
        }
      }
    });

    expect(requests.map((r) => r.role)).toEqual(["implementer", "fixer"]);
    expect(worktreeSeenByFixer).toEqual({ "src/postgres.ts": MERGED_POSTGRES, "src/feature-only.ts": FEATURE_ONLY });
    expect(committedBlobs.map((b) => b.content)).toContain(MERGED_POSTGRES);
    expect(committedBlobs.map((b) => b.content)).not.toContain(FEATURE_ONLY);
    expect(result.status).toBe("done");
  });

  it("merge-refused-because-the-head-moved-re-reviews-the-new-head-and-merges-it", async () => {
    const { result, state, mergeShas, reviewedShas } = await runTicket({
      mergeStatuses: [409, 200],
      resyncStatus: 204,
      firstMergeableState: "clean",
      movedHeadSha: "human-push-sha"
    });

    expect(result.status).toBe("done");
    expect(state.last_escalation).toBeUndefined();
    expect(reviewedShas).toEqual(["new-commit-sha-70", "human-push-sha"]);
    expect(mergeShas).toEqual(["new-commit-sha-70", "human-push-sha"]);
  });

  const MULTI_HUNK_POSTGRES = [
    "export const header = 'base';",
    "",
    "export function keepMiddle() {",
    "  const a = 1;",
    "  const b = 2;",
    "  const c = 3;",
    "  const d = 4;",
    "  return a + b + c + d;",
    "}",
    "",
    "export const footer = 'base';",
    ""
  ].join("\n");

  it.each([
    {
      id: "dirty-pr-with-409-and-disjoint-hunks-merges-locally-without-calling-conflict_resolver",
      taskVersion: MULTI_HUNK_POSTGRES.replace("header = 'base'", "header = 'task'"),
      featureVersion: MULTI_HUNK_POSTGRES.replace("footer = 'base'", "footer = 'feature'"),
      expectedRoles: ["implementer"]
    },
    {
      id: "dirty-pr-with-409-and-overlapping-hunks-invokes-conflict_resolver-on-checkout",
      taskVersion: MULTI_HUNK_POSTGRES.replace("header = 'base'", "header = 'task'"),
      featureVersion: MULTI_HUNK_POSTGRES.replace("header = 'base'", "header = 'feature'"),
      expectedRoles: ["implementer", "conflict_resolver"]
    }
  ])("$id", async ({ taskVersion, featureVersion, expectedRoles }) => {
    const base64File = (text: string) =>
      new Response(
        JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") }),
        { status: 200 }
      );
    const seenRoles: string[] = [];
    const engine: AgentEngine = {
      name: "scripted",
      run: async (req) => {
        seenRoles.push(req.role);
        if (req.role === "conflict_resolver") {
          const onDisk = readFileSync(join(req.worktree, "src/postgres.ts"), "utf8");
          expect(onDisk).toContain("<<<<<<<");
          const resolved = MULTI_HUNK_POSTGRES.replace("header = 'base'", "header = 'task+feature'");
          return {
            finalMessage: "Resolved conflict.",
            diff: {
              files: [{ path: "src/postgres.ts", content: resolved, mode: "100644" }],
              deleted_files: [],
              skipped: []
            }
          };
        }
        return {
          finalMessage: "Implemented.",
          diff: {
            files: [{ path: "src/postgres.ts", content: taskVersion, mode: "100644" }],
            deleted_files: [],
            skipped: []
          }
        };
      }
    };

    const ANC_SHA = "a".repeat(40);
    const FEAT_SHA = "f".repeat(40);
    const TASK_SHA = "b".repeat(40);
    let conflictTriggered = false;

    const { result } = await runTicket({
      mergeStatuses: [200],
      resyncStatus: 204,
      firstMergeableState: "dirty",
      agent: {
        engine,
        reviewFindings: () => [],
        route: (method, path) => {
          if (!seenRoles.includes("implementer")) {
            return undefined;
          }
          if (method === "POST" && path.endsWith("/merges") && !conflictTriggered) {
            conflictTriggered = true;
            return new Response(JSON.stringify({ message: "Merge conflict" }), { status: 409 });
          }
          if (method === "GET" && path.includes("/git/ref/heads/feature%2F")) {
            return new Response(JSON.stringify({ object: { sha: FEAT_SHA } }), { status: 200 });
          }
          if (method === "GET" && path.includes(`/git/ref/heads/${encodeURIComponent(TASK_BRANCH)}`)) {
            return new Response(JSON.stringify({ object: { sha: TASK_SHA } }), { status: 200 });
          }
          if (method === "GET" && path.includes(`/compare/${TASK_SHA}...${FEAT_SHA}`)) {
            return new Response(
              JSON.stringify({ merge_base_commit: { sha: ANC_SHA }, files: [{ filename: "src/postgres.ts" }], ahead_by: 1 }),
              { status: 200 }
            );
          }
          if (method === "GET" && path.includes("/compare/new-commit-sha-70...")) {
            return new Response(
              JSON.stringify({ merge_base_commit: { sha: ANC_SHA }, files: [{ filename: "src/postgres.ts" }], ahead_by: 1 }),
              { status: 200 }
            );
          }
          if (method === "GET" && path.includes(`/git/trees/${ANC_SHA}`)) {
            return new Response(
              JSON.stringify({ sha: ANC_SHA, truncated: false, tree: [{ path: "src/postgres.ts", mode: "100644", type: "blob", sha: "blob-anc", size: 50 }] }),
              { status: 200 }
            );
          }
          if (method === "GET" && path.includes(`/git/trees/${FEAT_SHA}`)) {
            return new Response(
              JSON.stringify({ sha: FEAT_SHA, truncated: false, tree: [{ path: "src/postgres.ts", mode: "100644", type: "blob", sha: "blob-feat", size: 50 }] }),
              { status: 200 }
            );
          }
          if (method === "GET" && path.includes(`/git/trees/${TASK_SHA}`)) {
            return new Response(
              JSON.stringify({ sha: TASK_SHA, truncated: false, tree: [{ path: "src/postgres.ts", mode: "100644", type: "blob", sha: "blob-task", size: 50 }] }),
              { status: 200 }
            );
          }
          if (method === "GET" && path.includes(`/contents/src/postgres.ts?ref=${ANC_SHA}`)) {
            return base64File(MULTI_HUNK_POSTGRES);
          }
          if (method === "GET" && path.includes(`/contents/src/postgres.ts?ref=${FEAT_SHA}`)) {
            return base64File(featureVersion);
          }
          if (method === "GET" && path.includes(`/contents/src/postgres.ts?ref=${TASK_SHA}`)) {
            return base64File(taskVersion);
          }
          if (method === "GET" && path.includes("/contents/src/postgres.ts?ref=")) {
            return base64File(MULTI_HUNK_POSTGRES);
          }
          if (method === "GET" && path.includes("/pulls/172/files")) {
            return new Response(
              JSON.stringify([{ filename: "src/postgres.ts", status: "modified", patch: "@@ -1 +1 @@" }]),
              { status: 200 }
            );
          }
          return undefined;
        }
      }
    });

    expect(seenRoles).toEqual(expectedRoles);
    expect(result.status).toBe("done");
  });
});
