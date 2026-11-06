import { describe, expect, it } from "vitest";
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

function geminiAnswer(body: string): Response {
  const props = (
    JSON.parse(body) as { generationConfig?: { responseJsonSchema?: { properties?: Record<string, unknown> } } }
  ).generationConfig?.responseJsonSchema?.properties ?? {};
  if ("findings" in props) {
    return gemini({ reviewer: "standards-reviewer", summary: "LGTM", findings: [] });
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
      return geminiAnswer(body);
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
          user: { login: "epure-agent[bot]", type: "Bot" },
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
  return { result, state, mergeAttempts, mergeShas, reviewedShas, taskResyncs };
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
});
