import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInitialIssueState, type EpureIssueState } from "../src/state/git-ref-state.js";
import { assertE2eSandboxRepository, loadE2eConfig, resolveGitHubToken } from "./e2e/config.js";
import { codeUnderTestProblems, installCiVerdict, lostComment, ranOnRunner, stepDone, stepProgress, thinkingLevelFor } from "./e2e/driver.js";
import { classifyEscalation, GATE_CODE_CLASS, RECORDED_REASON_CLASS } from "./e2e/escalations.js";
import { createGitHubApi, createOnce, GitHubOutcomeUnknownError } from "./e2e/github.js";
import {
  actionsMinutes,
  assessComparability,
  attributeUsage,
  decideEscalation,
  deriveEngine,
  escalationReasonFromComment,
  evaluateRun,
  parseUsageLines,
  PhaseClock,
  renderMarkdownReport,
  RESUME_POLICY,
  summarizeUsage,
  summarizeUsageByPhase,
  type E2eRunResult,
  type EscalationEvent,
  type UsageRecord
} from "./e2e/report.js";
import {
  deleteIssue,
  destructiveTargetProblems,
  encodeRefPath,
  forceBranches,
  parseLsTree,
  planSandboxReset,
  readSeedFromGit,
  type SandboxSnapshot
} from "./e2e/reset.js";

describe("assertE2eSandboxRepository", () => {
  it.each([
    { id: "e2e-sandbox", repository: "Giskard-AI/epure-e2e-sandbox" },
    { id: "sandbox-in-mixed-case", repository: "someone/My-SandBox-Repo" }
  ])("accepts $id", ({ repository }) => {
    expect(() => assertE2eSandboxRepository(repository)).not.toThrow();
  });

  it.each([
    { id: "name-without-sandbox", repository: "Giskard-AI/epure-e2e", error: /must contain "sandbox"/ },
    { id: "sandbox-only-in-owner", repository: "sandbox-org/app", error: /must contain "sandbox"/ },
    { id: "live-github-sandbox", repository: "Giskard-AI/epure-live-sandbox", error: /reserved/ },
    { id: "live-github-sandbox-other-case", repository: "giskard-ai/EPURE-LIVE-SANDBOX", error: /reserved/ },
    { id: "epure-itself", repository: "Giskard-AI/epure", error: /reserved/ },
    { id: "not-a-slug", repository: "epure-e2e-sandbox", error: /invalid repository slug/ }
  ])("refuses $id", ({ repository, error }) => {
    expect(() => assertE2eSandboxRepository(repository)).toThrow(error);
  });
});

describe("loadE2eConfig", () => {
  const withConfigFile = <T>(file: object, run: (path: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "epure-e2e-config-"));
    try {
      const path = join(dir, "epure.e2e.json");
      writeFileSync(path, JSON.stringify(file));
      return run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const file = { repository: "Giskard-AI/epure-e2e-sandbox", epureRef: "dev", agentAppId: 11 };

  it.each([
    {
      id: "file-values-without-env",
      env: {},
      expected: { repository: "Giskard-AI/epure-e2e-sandbox", epureRef: "dev", model: "", agentAppId: 11 }
    },
    {
      id: "env-fills-a-setting-the-file-lacks",
      env: { EPURE_E2E_MODEL: "google/gemini-3.8-flash", EPURE_E2E_RELEASE_APP_ID: "22" },
      expected: { model: "google/gemini-3.8-flash", releaseAppId: 22 }
    },
    {
      id: "env-equal-to-the-file-is-accepted",
      env: { EPURE_E2E_REPOSITORY: "Giskard-AI/epure-e2e-sandbox", EPURE_E2E_AGENT_APP_ID: "11" },
      expected: { repository: "Giskard-AI/epure-e2e-sandbox", agentAppId: 11 }
    },
    {
      id: "unset-settings-take-their-defaults",
      env: {},
      expected: {
        llmEnvironment: "epure-agent",
        outputDir: ".scratch/e2e",
        pricingSource: "",
        maxGrillReplies: 3,
        planningStepTimeoutMinutes: 30,
        implementationTimeoutMinutes: 240,
        installCiTimeoutMinutes: 20
      }
    }
  ])("$id", ({ env, expected }) => {
    const config = withConfigFile(file, (path) => loadE2eConfig({ EPURE_E2E_CONFIG: path, ...env }));

    expect(config).toMatchObject(expected);
  });

  it.each([
    {
      id: "env-repository-differs-from-the-file",
      file,
      env: { EPURE_E2E_REPOSITORY: "Giskard-AI/other-sandbox" },
      error: /EPURE_E2E_REPOSITORY=Giskard-AI\/other-sandbox conflicts with "repository"/
    },
    { id: "env-ref-differs-from-the-file", file, env: { EPURE_E2E_EPURE_REF: "main" }, error: /conflicts with "epureRef"/ },
    { id: "env-app-id-differs-from-the-file", file, env: { EPURE_E2E_AGENT_APP_ID: "12" }, error: /conflicts with "agentAppId"/ },
    { id: "no-repository-anywhere", file: {}, env: {}, error: /no sandbox repository/ },
    {
      id: "env-repository-that-is-not-a-sandbox",
      file: {},
      env: { EPURE_E2E_REPOSITORY: "Giskard-AI/epure" },
      error: /reserved/
    }
  ])("refuses $id", ({ file: content, env, error }) => {
    expect(() => withConfigFile(content, (path) => loadE2eConfig({ EPURE_E2E_CONFIG: path, ...env }))).toThrow(error);
  });
});

describe("resolveGitHubToken", () => {
  it.each([
    {
      id: "sandbox-token-wins-over-everything",
      env: { EPURE_E2E_GITHUB_TOKEN: "e2e", GH_TOKEN: "gh", GITHUB_TOKEN: "gha" },
      expected: { token: "e2e", source: "EPURE_E2E_GITHUB_TOKEN" }
    },
    { id: "gh-token-before-github-token", env: { GH_TOKEN: "gh", GITHUB_TOKEN: "gha" }, expected: { token: "gh", source: "GH_TOKEN" } },
    { id: "github-token-before-gh-cli", env: { GITHUB_TOKEN: "gha" }, expected: { token: "gha", source: "GITHUB_TOKEN" } },
    { id: "blank-env-falls-back-to-gh-cli", env: { EPURE_E2E_GITHUB_TOKEN: "  " }, expected: { token: "cli", source: "gh auth token" } }
  ])("$id", ({ env, expected }) => {
    expect(resolveGitHubToken(env, () => "cli")).toEqual(expected);
  });

  it("fails when no variable is set and gh has no token", () => {
    expect(() => resolveGitHubToken({}, () => "")).toThrow(/no GitHub token: set EPURE_E2E_GITHUB_TOKEN/);
  });
});

describe("destructiveTargetProblems", () => {
  const sandbox = { full_name: "Giskard-AI/epure-e2e-sandbox", private: true, permissions: { admin: true } };

  it.each([
    { id: "private-sandbox-with-admin-and-fine-grained-token", repo: sandbox, scopes: null, expected: [] },
    { id: "classic-token-with-repo-and-workflow", repo: sandbox, scopes: ["repo", "workflow", "read:org"], expected: [] },
    {
      id: "renamed-repository-resolving-elsewhere",
      repo: { ...sandbox, full_name: "Giskard-AI/production" },
      scopes: null,
      expected: ["Giskard-AI/epure-e2e-sandbox resolves to Giskard-AI/production"]
    },
    {
      id: "repository-resolving-to-the-live-sandbox",
      repo: { ...sandbox, full_name: "Giskard-AI/epure-live-sandbox" },
      scopes: null,
      expected: [
        "Giskard-AI/epure-e2e-sandbox resolves to Giskard-AI/epure-live-sandbox",
        "Giskard-AI/epure-live-sandbox belongs to the live GitHub harness"
      ]
    },
    { id: "public-repository", repo: { ...sandbox, private: false }, scopes: null, expected: ["Giskard-AI/epure-e2e-sandbox is public"] },
    {
      id: "user-without-admin",
      repo: { ...sandbox, permissions: { admin: false } },
      scopes: null,
      expected: ["the token's user is not an admin of the repository (rulesets, issue deletion)"]
    },
    {
      id: "classic-token-without-workflow",
      repo: sandbox,
      scopes: ["repo"],
      expected: ['the classic token lacks the "workflow" scope: run `gh auth refresh -h github.com -s workflow`']
    }
  ])("$id", ({ repo, scopes, expected }) => {
    expect(destructiveTargetProblems("Giskard-AI/epure-e2e-sandbox", repo, scopes)).toEqual(expected);
  });
});

describe("encodeRefPath", () => {
  it.each([
    { id: "plain-branch", ref: "refs/heads/feature/1-x", expected: "refs/heads/feature/1-x" },
    { id: "hash-and-question-mark", ref: "refs/heads/task/2-a#b?c", expected: "refs/heads/task/2-a%23b%3Fc" },
    { id: "percent-and-space", ref: "refs/tags/v1 100%", expected: "refs/tags/v1%20100%25" }
  ])("$id", ({ ref, expected }) => {
    expect(encodeRefPath(ref)).toBe(expected);
  });
});

describe("planSandboxReset", () => {
  const empty: SandboxSnapshot = { refs: [], rulesets: [], openPullRequests: [], issues: [], activeRunIds: [] };

  it.each([
    {
      id: "deletes-every-branch-tag-and-state-ref-except-main-and-dev",
      snapshot: {
        ...empty,
        refs: ["refs/heads/main", "refs/heads/dev", "refs/heads/feature/1-x", "refs/heads/task/2-y", "refs/tags/v1.0.0", "refs/epure/state/1"]
      },
      expected: { deleteRefs: ["refs/heads/feature/1-x", "refs/heads/task/2-y", "refs/tags/v1.0.0", "refs/epure/state/1"] }
    },
    {
      id: "ignores-refs-outside-heads-tags-and-epure",
      snapshot: { ...empty, refs: ["refs/pull/3/head", "refs/notes/commits"] },
      expected: { deleteRefs: [] }
    },
    {
      id: "deletes-only-repository-rulesets-named-epure",
      snapshot: {
        ...empty,
        rulesets: [
          { id: 1, name: "epure-dev-governance", source_type: "Repository" },
          { id: 2, name: "Main basic protection", source_type: "Organization" },
          { id: 3, name: "epure-org-wide", source_type: "Organization" },
          { id: 4, name: "team-rule", source_type: "Repository" }
        ]
      },
      expected: { deleteRulesetIds: [1] }
    },
    {
      id: "cancels-active-runs-closes-open-prs-and-deletes-issues",
      snapshot: { ...empty, activeRunIds: [10, 11], openPullRequests: [5], issues: [{ number: 4, node_id: "I_4" }] },
      expected: { cancelRunIds: [10, 11], closePullRequests: [5], deleteIssues: [{ number: 4, node_id: "I_4" }] }
    }
  ])("$id", ({ snapshot, expected }) => {
    expect(planSandboxReset(snapshot)).toMatchObject(expected);
  });
});

describe("reset replays", () => {
  const sandbox = (answers: Response[]) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace("https://api.github.com/repos/o/sandbox", "")}`);
      return answers.shift() ?? new Response("", { status: 500 });
    }) as typeof fetch;
    return { calls, gh: createGitHubApi("t", "o/sandbox", { fetchImpl, sleep: async () => undefined }) };
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it.each<{ id: string; answers: Response[]; calls: string[] }>([
    { id: "existing-branch-is-force-moved", answers: [json(200, {}), json(200, {})], calls: ["GET /git/ref/heads/main", "PATCH /git/refs/heads/main"] },
    { id: "missing-branch-is-created", answers: [json(404, {}), json(201, {})], calls: ["GET /git/ref/heads/main", "POST /git/refs"] },
    {
      id: "creation-replayed-after-it-landed-moves-the-ref",
      answers: [json(404, {}), json(502, {}), json(422, { message: "Reference already exists" }), json(200, {})],
      calls: ["GET /git/ref/heads/main", "POST /git/refs", "POST /git/refs", "PATCH /git/refs/heads/main"]
    }
  ])("forceBranches: $id", async ({ answers, calls }) => {
    const { gh, calls: made } = sandbox(answers);

    await forceBranches(gh, ["main"], "a".repeat(40));
    expect(made).toEqual(calls);
  });

  it.each<{ id: string; answer: Response; error: RegExp | null }>([
    { id: "deleted", answer: json(200, { data: { deleteIssue: { clientMutationId: null } } }), error: null },
    { id: "already-deleted-by-a-replay", answer: json(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }] }), error: null },
    { id: "refused", answer: json(200, { errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }), error: /Resource not accessible/ }
  ])("deleteIssue: $id", async ({ answer, error }) => {
    const { gh } = sandbox([answer]);
    const deleted = deleteIssue(gh, "I_1");

    await (error ? expect(deleted).rejects.toThrow(error) : expect(deleted).resolves.toBeUndefined());
  });
});

describe("parseLsTree", () => {
  const sha = "a".repeat(40);

  it.each([
    {
      id: "keeps-the-executable-bit-and-nested-paths",
      output: `100644 blob ${sha}\tpackage.json\x00100755 blob ${sha}\tscripts/run.sh\x00`,
      expected: [
        { mode: "100644", sha, path: "package.json" },
        { mode: "100755", sha, path: "scripts/run.sh" }
      ]
    },
    { id: "path-with-a-tab-and-newline", output: `100644 blob ${sha}\ta\tb\nc\0`, expected: [{ mode: "100644", sha, path: "a\tb\nc" }] },
    { id: "empty-tree", output: "", expected: [] }
  ])("$id", ({ output, expected }) => {
    expect(parseLsTree(output)).toEqual(expected);
  });

  it("refuses a submodule", () => {
    expect(() => parseLsTree(`160000 commit ${sha}\tvendor/lib\0`)).toThrow(/unsupported git tree entry/);
  });
});

describe("seed project from git", () => {
  it("holds a test suite, a lockfile and a CI workflow named CI, and no node_modules", () => {
    const seed = readSeedFromGit();
    const paths = seed.files.map((f) => f.path);

    expect(seed.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(paths).toEqual(
      expect.arrayContaining(["package.json", "package-lock.json", "src/stats.js", "test/stats.test.js", ".github/workflows/ci.yml"])
    );
    expect(paths.filter((p) => p.startsWith("node_modules/"))).toEqual([]);
    expect(seed.files.find((f) => f.path === ".github/workflows/ci.yml")?.content.toString("utf8")).toMatch(/^name: "CI"$/m);
  });
});

describe("createGitHubApi", () => {
  type Step = Response | Error;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fake = (steps: Step[]) => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const step = steps.shift();
      if (!step || step instanceof Error) {
        throw step ?? new Error("no more responses");
      }
      return step;
    }) as typeof fetch;
    return { calls, api: createGitHubApi("t", "o/sandbox", { fetchImpl, sleep: async () => undefined }) };
  };

  it.each([
    { id: "retries-a-502-then-returns-the-data", steps: [json(502, {}), json(200, { ok: 1 })], calls: 2 },
    { id: "retries-a-network-error-then-returns-the-data", steps: [new TypeError("fetch failed"), json(200, { ok: 1 })], calls: 2 },
    {
      id: "retries-a-request-aborted-by-its-timeout",
      steps: [new DOMException("The operation was aborted due to timeout", "TimeoutError"), json(200, { ok: 1 })],
      calls: 2
    },
    {
      id: "waits-out-a-secondary-rate-limit",
      steps: [json(403, { message: "You have exceeded a secondary rate limit" }), json(200, { ok: 1 })],
      calls: 2
    },
    {
      id: "rides-out-five-transient-failures",
      steps: [new TypeError("fetch failed"), json(502, {}), json(503, {}), json(504, {}), new TypeError("fetch failed"), json(200, { ok: 1 })],
      calls: 6
    },
    {
      id: "retries-a-get-whose-body-breaks-off",
      steps: [
        new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError("terminated")) }), { status: 200 }),
        json(200, { ok: 1 })
      ],
      calls: 2
    }
  ])("$id", async ({ steps, calls }) => {
    const { api, calls: made } = fake(steps);

    await expect(api.call("GET", "/repos/o/sandbox")).resolves.toEqual({ ok: 1 });
    expect(made).toHaveLength(calls);
    expect(made.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it.each([
    {
      id: "gives-up-after-six-transient-failures",
      method: "GET",
      path: "/repos/o/sandbox",
      steps: Array.from({ length: 6 }, () => json(503, {})),
      error: /HTTP 503/,
      calls: 6
    },
    {
      id: "keeps-the-status-of-a-non-json-error",
      method: "GET",
      path: "/repos/o/sandbox",
      steps: [new Response("<html>Not Found</html>", { status: 404 })],
      error: /^GET \/repos\/o\/sandbox: HTTP 404 <html>Not Found<\/html>$/,
      calls: 1
    },
    {
      id: "never-replays-a-comment-creation",
      method: "POST",
      path: "/repos/o/sandbox/issues/1/comments",
      steps: [json(502, {})],
      error: /HTTP 502/,
      calls: 1
    },
    {
      id: "never-replays-an-issue-creation",
      method: "POST",
      path: "/repos/o/sandbox/issues",
      steps: [new TypeError("socket hang up")],
      error: /socket hang up/,
      calls: 1
    },
    {
      id: "reports-a-redirect-instead-of-following-it",
      method: "GET",
      path: "/repos/o/sandbox",
      steps: [new Response("", { status: 301, headers: { location: "https://api.github.com/repositories/1" } })],
      error: /HTTP 301/,
      calls: 1
    }
  ])("$id", async ({ method, path, steps, error, calls }) => {
    const { api, calls: made } = fake(steps);

    await expect(api.call(method, path, method === "POST" ? { body: "x" } : undefined)).rejects.toThrow(error);
    expect(made).toHaveLength(calls);
    expect(made.every((c) => c.init?.redirect === "manual")).toBe(true);
  });

  it("follows a job log redirect once, without the token", async () => {
    const { api, calls } = fake([
      new Response("", { status: 302, headers: { location: "https://logs.example/job.txt?sig=1" } }),
      new Response("2026-11-08T10:00:00.0000000Z hello", { status: 200 })
    ]);

    await expect(api.text("/repos/o/sandbox/actions/jobs/1/logs")).resolves.toBe("2026-11-08T10:00:00.0000000Z hello");
    expect(calls[1]?.url).toBe("https://logs.example/job.txt?sig=1");
    expect(calls[1]?.init).toMatchObject({ redirect: "error" });
    expect(calls[1]?.init?.headers).toBeUndefined();
  });

  const logRedirect = () => new Response("", { status: 302, headers: { location: "https://logs.example/job.txt?sig=1" } });

  it.each<{ id: string; steps: Step[]; expected: string | null | RegExp; calls: number }>([
    { id: "fresh-log-url-after-a-storage-network-error", steps: [logRedirect(), new TypeError("fetch failed"), logRedirect(), new Response("log")], expected: "log", calls: 4 },
    { id: "fresh-log-url-after-a-storage-503", steps: [logRedirect(), new Response("", { status: 503 }), logRedirect(), new Response("log")], expected: "log", calls: 4 },
    {
      id: "storage-failing-until-the-retries-run-out-throws",
      steps: Array.from({ length: 6 }, () => [logRedirect(), new TypeError("fetch failed")]).flat(),
      expected: /fetch failed/,
      calls: 12
    },
    { id: "storage-answering-404-is-a-missing-log", steps: [logRedirect(), new Response("", { status: 404 })], expected: null, calls: 2 }
  ])("$id", async ({ steps, expected, calls }) => {
    const { api, calls: made } = fake(steps);
    const read = api.text("/repos/o/sandbox/actions/jobs/1/logs");

    await (expected instanceof RegExp ? expect(read).rejects.toThrow(expected) : expect(read).resolves.toBe(expected));
    expect(made).toHaveLength(calls);
  });

  it("retries the reads of a fetch consumer such as the state store", async () => {
    const { api, calls } = fake([json(502, {}), json(200, { object: { sha: "a" } })]);

    const resp = await api.fetch("https://api.github.com/repos/o/sandbox/git/ref/epure/state/12", { method: "GET" });

    await expect(resp.json()).resolves.toEqual({ object: { sha: "a" } });
    expect(calls).toHaveLength(2);
  });

  it.each<{ id: string; input: string | Request; init?: RequestInit; method: string; body: string | null }>([
    { id: "plain-object-headers", input: "https://api.github.com/repos/o/sandbox/git/refs", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, method: "POST", body: "{}" },
    { id: "headers-instance", input: "https://api.github.com/repos/o/sandbox/git/refs", init: { method: "POST", headers: new Headers({ "Content-Type": "application/json" }), body: "{}" }, method: "POST", body: "{}" },
    { id: "header-pairs", input: "https://api.github.com/repos/o/sandbox/git/refs", init: { method: "POST", headers: [["Content-Type", "application/json"]], body: "{}" }, method: "POST", body: "{}" },
    {
      id: "request-object",
      input: new Request("https://api.github.com/repos/o/sandbox/git/refs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      method: "POST",
      body: "{}"
    }
  ])("fetch keeps the method, body and headers of $id next to the token", async ({ input, init, method, body }) => {
    const { api, calls } = fake([json(201, {})]);

    await api.fetch(input, init);
    const sent = calls[0]!;
    const headers = new Headers(sent.init?.headers);
    const sentBody = sent.init?.body;

    expect({
      url: sent.url,
      method: sent.init?.method,
      body: sentBody === undefined || sentBody === null ? null : typeof sentBody === "string" ? sentBody : new TextDecoder().decode(sentBody as ArrayBuffer),
      contentType: headers.get("content-type"),
      authorization: headers.get("authorization")
    }).toEqual({ url: "https://api.github.com/repos/o/sandbox/git/refs", method, body, contentType: "application/json", authorization: "Bearer t" });
  });

  it.each([
    { id: "comment-creation-lost-in-a-502", path: "/repos/o/sandbox/issues/1/comments", step: json(502, {}) },
    { id: "comment-creation-lost-on-the-network", path: "/repos/o/sandbox/issues/1/comments", step: new TypeError("fetch failed") },
    { id: "issue-creation-lost-on-the-network", path: "/repos/o/sandbox/issues", step: new TypeError("other side closed") }
  ])("reports a $id as an unknown outcome without replaying it", async ({ path, step }) => {
    const { api, calls } = fake([step]);

    await expect(api.call("POST", path, { body: "x" })).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    expect(calls).toHaveLength(1);
  });

  it.each([
    { id: "job-without-a-log-is-null", status: 404, expected: null },
    { id: "log-forbidden-to-the-token-throws", status: 403, expected: /HTTP 403/ }
  ])("$id", async ({ status, expected }) => {
    const { api } = fake([new Response("{}", { status })]);
    const read = api.text("/repos/o/sandbox/actions/jobs/1/logs");

    await (expected === null ? expect(read).resolves.toBeNull() : expect(read).rejects.toThrow(expected));
  });
});

describe("createOnce", () => {
  const lost = () => new GitHubOutcomeUnknownError("POST", "/repos/o/sandbox/issues/1/comments", "fetch failed");

  type Outcome = "ok" | "lost" | "422";
  type Listing = "landed" | null | "throws";

  it.each<{ id: string; outcomes: Outcome[]; landed: Listing[]; expected: string | RegExp | typeof GitHubOutcomeUnknownError; posts: number; probes: number; logs: number }>([
    { id: "created-at-once", outcomes: ["ok"], landed: [], expected: "created", posts: 1, probes: 0, logs: 0 },
    { id: "lost-response-but-the-comment-landed", outcomes: ["lost"], landed: ["landed"], expected: "landed", posts: 1, probes: 1, logs: 0 },
    { id: "comment-listed-only-after-the-listing-lag", outcomes: ["lost"], landed: [null, "landed"], expected: "landed", posts: 1, probes: 2, logs: 0 },
    { id: "lost-response-and-nothing-landed-posts-again", outcomes: ["lost", "ok"], landed: [null, null], expected: "created", posts: 2, probes: 2, logs: 0 },
    { id: "definite-refusal-is-not-retried", outcomes: ["422"], landed: [], expected: /HTTP 422/, posts: 1, probes: 0, logs: 0 },
    { id: "landed-probe-throwing-stops-without-posting-again", outcomes: ["lost", "ok"], landed: ["throws"], expected: /listing failed/, posts: 1, probes: 1, logs: 0 },
    {
      id: "last-lost-response-found-by-the-final-probe",
      outcomes: ["lost", "lost", "lost", "lost"],
      landed: [null, null, null, null, null, null, null, "landed"],
      expected: "landed",
      posts: 4,
      probes: 8,
      logs: 0
    },
    {
      id: "gives-up-and-logs-after-four-lost-responses",
      outcomes: ["lost", "lost", "lost", "lost"],
      landed: [null, null, null, null, null, null, null, null],
      expected: GitHubOutcomeUnknownError,
      posts: 4,
      probes: 8,
      logs: 1
    }
  ])("$id", async ({ outcomes, landed, expected, posts, probes, logs }) => {
    let posted = 0;
    let probed = 0;
    const logged: string[] = [];
    const create = async () => {
      const outcome = outcomes[posted++];
      if (outcome === "lost") {
        throw lost();
      }
      if (outcome === "422") {
        throw new Error("POST /repos/o/sandbox/issues/1/comments: HTTP 422");
      }
      return "created";
    };
    const probe = async () => {
      const listing = landed[probed++] ?? null;
      if (listing === "throws") {
        throw new Error("GET comments: listing failed");
      }
      return listing;
    };

    const result = createOnce(create, probe, { sleep: async () => undefined, log: (line) => logged.push(line) });

    await (typeof expected === "string" ? expect(result).resolves.toBe(expected) : expect(result).rejects.toThrow(expected));
    expect({ posted, probed, logged: logged.length }).toEqual({ posted: posts, probed: probes, logged: logs });
  });
});

describe("lostComment", () => {
  const comment = (id: number, body: string, app: number | null = null) => ({
    id,
    body,
    performed_via_github_app: app === null ? null : { id: app }
  });

  it.each([
    {
      id: "unrecorded-harness-comment-is-the-lost-one",
      comments: [comment(1, "/epure plan"), comment(2, "/epure to-tickets")],
      body: "/epure to-tickets",
      posted: [1],
      expected: 2
    },
    { id: "earlier-identical-command-is-not-the-lost-one", comments: [comment(5, "/epure to-spec")], body: "/epure to-spec", posted: [5], expected: null },
    {
      id: "resume-repost-finds-the-new-identical-command",
      comments: [comment(5, "/epure to-spec"), comment(9, "/epure to-spec")],
      body: "/epure to-spec",
      posted: [5],
      expected: 9
    },
    { id: "app-comment-with-the-same-body-is-ignored", comments: [comment(7, "/epure to-tickets", 5666371)], body: "/epure to-tickets", posted: [], expected: null },
    { id: "nothing-landed", comments: [comment(1, "/epure plan")], body: "/epure to-tickets", posted: [1], expected: null }
  ])("$id", ({ comments, body, posted, expected }) => {
    expect(lostComment(comments, body, new Set(posted))?.id ?? null).toBe(expected);
  });
});

describe("PhaseClock", () => {
  it.each([
    { id: "successful-phase-is-ok", run: () => Promise.resolve("x"), outcome: "ok", settled: { value: "x" } },
    {
      id: "throwing-phase-is-failed-and-rethrows",
      run: () => Promise.reject(new Error("boom")),
      outcome: "failed",
      settled: { error: "boom" }
    }
  ] as const)("$id", async ({ run, outcome, settled }) => {
    const ticks = [1_000, 61_000];
    const clock = new PhaseClock(() => ticks.shift()!);

    const result = await clock.time("plan", run).then(
      (value) => ({ value }),
      (err: Error) => ({ error: err.message })
    );

    expect(result).toEqual(settled);
    expect(clock.phases).toEqual([
      { name: "plan", started_at: "1970-01-01T00:00:01.000Z", ended_at: "1970-01-01T00:01:01.000Z", duration_ms: 60_000, outcome }
    ]);
  });
});

describe("parseUsageLines", () => {
  const usage = { provider: "google", model: "gemini-3.8-flash", input_tokens: 10, cached_input_tokens: 4, output_tokens: 6, thinking_tokens: 2 };
  const line = `epure-llm-usage ${JSON.stringify(usage)}`;

  it.each([
    {
      id: "marker-right-after-the-actions-timestamp",
      log: `2026-11-08T10:00:00.1234567Z ${line}\r`,
      expected: [{ ...usage, at: "2026-11-08T10:00:00.123Z" }]
    },
    { id: "bare-line-without-timestamp", log: line, expected: [] },
    { id: "marker-after-other-text", log: `2026-11-08T10:00:00.1234567Z echo ${line}`, expected: [] },
    { id: "unrelated-lines", log: "2026-11-08T10:00:00.1234567Z npm ci\nepure: plan ready", expected: [] },
    { id: "truncated-json-is-skipped", log: '2026-11-08T10:00:00.1234567Z epure-llm-usage {"provider":"goo', expected: [] }
  ])("$id", ({ log, expected }) => {
    expect(parseUsageLines(log)).toEqual(expected);
  });
});

const usageAt = (at: string, model = "flash", input = 0, cached = 0, output = 0) => ({
  provider: "google" as const,
  model,
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  thinking_tokens: 0,
  at
});

describe("attributeUsage", () => {
  const phases = [
    { name: "plan", started_at: "2026-11-08T10:00:00.000Z", ended_at: "2026-11-08T10:10:00.000Z", duration_ms: 0, outcome: "ok" as const },
    { name: "implementation", started_at: "2026-11-08T11:00:00.000Z", ended_at: "2026-11-08T13:00:00.000Z", duration_ms: 0, outcome: "ok" as const }
  ];
  const resumes = [{ at: "2026-11-08T12:00:00.000Z", ticket: 3, command: "/epure continue" }];

  it.each([
    { id: "inside-a-phase-before-any-resume", at: "2026-11-08T10:05:00.000Z", expected: { phase: "plan", resumes_before: 0 } },
    { id: "after-a-resume", at: "2026-11-08T12:30:00.000Z", expected: { phase: "implementation", resumes_before: 1 } },
    { id: "between-phases", at: "2026-11-08T10:30:00.000Z", expected: { phase: "unattributed", resumes_before: 0 } }
  ])("$id", ({ at, expected }) => {
    const [record] = attributeUsage([{ ...usageAt(at), run_id: 7, job_id: 8 }], phases, resumes);

    expect(record).toMatchObject({ run_id: 7, job_id: 8, at, ...expected });
  });
});

describe("summarizeUsage", () => {
  const pricing = { "google/flash": { inputPerMTok: 1, outputPerMTok: 4, cachedInputPerMTok: 0.1 } };
  const at = "2026-11-08T10:00:00.000Z";

  it.each([
    { id: "cached-input-billed-at-cached-price", records: [usageAt(at, "flash", 1_000_000, 500_000, 1_000_000)], cost: 0.5 + 0.05 + 4 },
    {
      id: "sums-requests-of-one-model",
      records: [usageAt(at, "flash", 1_000_000), usageAt(at, "flash", 1_000_000)],
      cost: 2
    },
    { id: "no-records-cost-nothing", records: [], cost: 0 }
  ])("$id", ({ records, cost }) => {
    const summary = summarizeUsage(records, pricing);

    expect(summary.total.requests).toBe(records.length);
    expect(summary.total.cost_usd).toBeCloseTo(cost, 9);
  });

  it.each([
    { id: "one-unpriced-model-makes-the-total-unpriced", records: [usageAt(at, "flash", 1, 0, 1), usageAt(at, "pro", 1, 0, 1)] },
    { id: "only-unpriced-models", records: [usageAt(at, "pro", 1, 0, 1)] }
  ])("$id", ({ records }) => {
    expect(summarizeUsage(records, pricing).total.cost_usd).toBeNull();
  });

  it("splits cost per phase", () => {
    const record = (phase: string, input: number): UsageRecord => ({ ...usageAt(at, "flash", input), run_id: 1, job_id: 2, phase, resumes_before: 0 });

    const byPhase = summarizeUsageByPhase([record("plan", 1_000_000), record("implementation", 2_000_000)], pricing);

    expect(Object.fromEntries(Object.entries(byPhase).map(([phase, t]) => [phase, t.cost_usd]))).toEqual({ plan: 1, implementation: 2 });
  });
});

describe("actionsMinutes", () => {
  const job = (workflow: string, started: string | null, completed: string | null) => ({
    workflow,
    started_at: started && `2026-11-08T10:${started}Z`,
    completed_at: completed && `2026-11-08T10:${completed}Z`
  });

  it.each([
    {
      id: "sums-per-workflow-and-rounds-each-job-up-for-billing",
      jobs: [job("ci.yml", "00:00", "01:30"), job("ci.yml", "00:00", "00:30"), job("epure.yml", "00:00", "10:00")],
      expected: { jobs: 3, minutes: 12, billable_minutes: 2 + 1 + 10, by_workflow: { "ci.yml": 2, "epure.yml": 10 } }
    },
    {
      id: "skips-jobs-that-never-ran",
      jobs: [job("ci.yml", null, null), job("ci.yml", "00:00", null)],
      expected: { jobs: 0, minutes: 0, billable_minutes: 0, by_workflow: {} }
    }
  ])("$id", ({ jobs, expected }) => {
    expect(actionsMinutes(jobs)).toEqual(expected);
  });
});

describe("escalationReasonFromComment", () => {
  it.each([
    {
      id: "spec-gate-error-code",
      body: "mirror\n\n### ⚠️ Escalade `needs-human` — Échec de validation (`SPEC_MISSING_OR_INCOMPLETE`)\n\n- **Code** : `X`",
      expected: "SPEC_MISSING_OR_INCOMPLETE"
    },
    {
      id: "unproven-blocker",
      body: "### ⚠️ Escalade `needs-human` — Dépendance bloquante non prouvée pour #4 (`UNPROVEN_BLOCKER_CLOSURE`)",
      expected: "UNPROVEN_BLOCKER_CLOSURE"
    },
    { id: "ticket-escalation-without-code", body: "### ⚠️ Escalade humaine (`needs-human`) — ticket #3", expected: null },
    { id: "no-escalation-heading", body: "### Entretien de Cadrage (`/grill-with-docs`)", expected: null }
  ])("$id", ({ body, expected }) => {
    expect(escalationReasonFromComment(body)).toBe(expected);
  });
});

function unionMembers(file: string, typeName: string): string[] {
  const body = new RegExp(`export type ${typeName} =([^;]+);`).exec(readFileSync(file, "utf8"))?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

// Codes written literally into an escalation heading, e.g. (\`UNPROVEN_BLOCKER_CLOSURE\`).
function literalHeadingCodes(): string[] {
  return readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .flatMap((path) => readFileSync(join("src", path), "utf8").split("\n"))
    .filter((line) => line.includes("Escalade"))
    .flatMap((line) => [...line.matchAll(/\\`([A-Z][A-Z0-9_]+)\\`/g)].map((m) => m[1]!));
}

describe("escalation classification", () => {
  const recorded = unionMembers("src/execution/external-ci-gate.ts", "NeedsHumanEscalationReason");
  const gateCodes = unionMembers("src/planning/artifacts-gate.ts", "ArtifactsGateErrorCode").filter((c) => c !== "NONE");
  const agentsMd = readFileSync("AGENTS.md", "utf8");

  it("finds the reasons in the source", () => {
    expect(recorded.length).toBeGreaterThan(10);
    expect(gateCodes.length).toBeGreaterThan(3);
    expect(literalHeadingCodes()).toContain("UNPROVEN_BLOCKER_CLOSURE");
  });

  it("classifies exactly the reasons EPURE records", () => {
    expect(Object.keys(RECORDED_REASON_CLASS).sort()).toEqual([...recorded].sort());
  });

  it("classifies every gate code EPURE writes into an escalation heading", () => {
    expect(Object.keys(GATE_CODE_CLASS).sort()).toEqual([...new Set([...gateCodes, ...literalHeadingCodes()])].sort());
  });

  it.each([
    { reason: "remediation_exhausted", expected: "legitimate" },
    { reason: "epic_convergence_exhausted", expected: "legitimate" },
    { reason: "grace_window_timeout", expected: "legitimate" },
    { reason: "sensitive_path_violation", expected: "legitimate" },
    { reason: "merge_conflict_unresolved", expected: "legitimate" },
    { reason: "merge_conflict_stage1_failed", expected: "legitimate" },
    { reason: "pr_not_mergeable", expected: "legitimate" },
    { reason: "resync_verification_failed", expected: "internal" },
    { reason: "wall_clock_budget_exhausted", expected: "legitimate" },
    { reason: "transient_llm_api_exhausted", expected: "legitimate" },
    { reason: "llm_quota_or_auth_failure", expected: "legitimate" },
    { reason: "llm_request_invalid", expected: "internal" },
    { reason: "llm_refusal", expected: "legitimate" },
    { reason: "model_config_missing", expected: "internal" },
    { reason: "github_rate_limited", expected: "legitimate" },
    { reason: "branch_update_conflict", expected: "internal" },
    { reason: "ambiguous_feature_branch", expected: "internal" },
    { reason: "plan_manifest_missing", expected: "internal" },
    { reason: "internal_error", expected: "internal" },
    { reason: "GLOSSARY_MISSING_FOR_DOMAIN_TERMS", expected: "legitimate" },
    { reason: "ADR_MISSING_OR_INCOMPLETE", expected: "legitimate" },
    { reason: "SPEC_MISSING_OR_INCOMPLETE", expected: "legitimate" },
    { reason: "TICKET_GRAPH_EMPTY", expected: "legitimate" },
    { reason: "TICKET_GRAPH_CYCLE_DETECTED", expected: "legitimate" },
    { reason: "UNPROVEN_BLOCKER_CLOSURE", expected: "internal" },
    { reason: "unrecorded", expected: "unclassified" },
    { reason: "toString", expected: "unclassified" }
  ])("$reason is $expected", ({ reason, expected }) => {
    expect(classifyEscalation(reason)).toBe(expected);
  });

  it.each([...Object.entries(RECORDED_REASON_CLASS), ...Object.entries(GATE_CODE_CLASS)])(
    "AGENTS.md documents %s as %s",
    (reason, expected) => {
      expect(agentsMd).toContain(`| \`${reason}\` | ${expected} |`);
    }
  );
});

const escalation = (ticket: number, reason = "remediation_exhausted"): EscalationEvent => ({
  reason,
  class: classifyEscalation(reason),
  ticket,
  phase: "implementation",
  at: "2026-11-08T10:00:00.000Z"
});

describe("decideEscalation", () => {
  it.each([
    { id: "first-escalation-of-a-ticket-resumes", earlier: [], event: escalation(3), action: "resume" },
    { id: "escalation-of-another-ticket-resumes", earlier: [escalation(3)], event: escalation(4), action: "resume" },
    { id: "second-escalation-of-a-ticket-stops", earlier: [escalation(3)], event: escalation(3), action: "stop" },
    { id: "internal-escalation-stops-at-once", earlier: [], event: escalation(3, "llm_request_invalid"), action: "stop" },
    { id: "unclassified-escalation-stops-at-once", earlier: [], event: escalation(3, "unrecorded"), action: "stop" }
  ])("$id", ({ earlier, event, action }) => {
    expect(decideEscalation(earlier, event).action).toBe(action);
  });
});

describe("evaluateRun", () => {
  const pr = { number: 9, url: "https://github.com/o/sandbox/pull/9" };
  const failure = { run_id: 1, url: "https://github.com/o/sandbox/actions/runs/1", conclusion: "failure", phase: "spec", at: "" };

  it.each([
    { id: "open-pr-and-one-escalation-per-ticket-passes", pr, escalations: [escalation(3), escalation(4)], jobFailures: [], usage: 5, failed: [] },
    { id: "no-feature-pr-fails", pr: null, escalations: [], jobFailures: [], usage: 5, failed: ["feature-pr-open"] },
    {
      id: "internal-escalation-fails",
      pr,
      escalations: [escalation(1, "branch_update_conflict")],
      jobFailures: [],
      usage: 5,
      failed: ["no-internal-escalation"]
    },
    { id: "unclassified-escalation-fails", pr, escalations: [escalation(1, "unrecorded")], jobFailures: [], usage: 5, failed: ["no-internal-escalation"] },
    {
      id: "two-escalations-on-one-ticket-fail",
      pr,
      escalations: [escalation(3), escalation(3)],
      jobFailures: [],
      usage: 5,
      failed: ["at-most-one-escalation-per-ticket"]
    },
    { id: "failed-orchestrator-run-fails", pr, escalations: [], jobFailures: [failure], usage: 5, failed: ["no-orchestrator-job-failure"] },
    { id: "zero-usage-records-fail", pr, escalations: [], jobFailures: [], usage: 0, failed: ["llm-usage-recorded"] }
  ])("$id", ({ pr: featurePr, escalations, jobFailures, usage, failed }) => {
    const { success, checks } = evaluateRun({
      featurePr,
      escalations,
      jobFailures,
      usageRecords: usage,
      unavailableJobLogs: [],
      evidenceError: null
    });

    expect(checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(failed);
    expect(success).toBe(failed.length === 0);
  });

  it.each([
    { id: "every-orchestrator-log-read", unavailable: [], error: null, passed: true, detail: "5 requests" },
    {
      id: "orchestrator-job-without-log-leaves-the-cost-incomplete",
      unavailable: [128711902545],
      error: null,
      passed: false,
      detail: "no log for orchestrator jobs 128711902545: cost incomplete"
    },
    {
      id: "failed-collection-is-reported-not-shown-as-zero",
      unavailable: [],
      error: "GET /runs: HTTP 502",
      passed: false,
      detail: "evidence collection failed: GET /runs: HTTP 502"
    }
  ])("$id", ({ unavailable, error, passed, detail }) => {
    const { checks } = evaluateRun({
      featurePr: pr,
      escalations: [],
      jobFailures: [],
      usageRecords: 5,
      unavailableJobLogs: unavailable,
      evidenceError: error
    });

    expect(checks.find((c) => c.id === "llm-usage-recorded")).toEqual({ id: "llm-usage-recorded", passed, detail });
  });
});

describe("assessComparability", () => {
  it.each([
    { id: "two-tickets-ci-and-review", input: { tickets: 2, taskBranchCiRuns: 3, reviewedTaskPrs: 2 }, expected: { comparable: true, unmet: [] } },
    {
      id: "three-tickets",
      input: { tickets: 3, taskBranchCiRuns: 3, reviewedTaskPrs: 2 },
      expected: { comparable: false, unmet: ["3 tickets instead of 2"] }
    },
    {
      id: "no-task-ci-and-no-review",
      input: { tickets: 2, taskBranchCiRuns: 0, reviewedTaskPrs: 0 },
      expected: { comparable: false, unmet: ["no CI run on a task/* branch", "no review on a task pull request"] }
    },
    {
      id: "unread-workflow-runs-are-unknown-not-absent",
      input: { tickets: 2, taskBranchCiRuns: null, reviewedTaskPrs: 2 },
      expected: { comparable: false, unmet: ["CI runs on task/* branches unknown: evidence collection failed"] }
    },
    { id: "short-vm-pause-is-tolerated", input: { tickets: 2, taskBranchCiRuns: 3, reviewedTaskPrs: 2, hostAsleepMs: 20_000 }, expected: { comparable: true, unmet: [] } },
    {
      id: "host-asleep-inflates-durations",
      input: { tickets: 2, taskBranchCiRuns: 3, reviewedTaskPrs: 2, hostAsleepMs: 3_533_000 },
      expected: { comparable: false, unmet: ["the host slept 58.9 min during the run: durations are inflated"] }
    }
  ])("$id", ({ input, expected }) => {
    expect(assessComparability({ hostAsleepMs: 0, ...input })).toEqual(expected);
  });
});

describe("ranOnRunner", () => {
  const job = (conclusion: string | null, runner: string | null) => ({
    id: 1,
    conclusion,
    runner_name: runner,
    started_at: "2026-11-08T11:06:15Z",
    completed_at: "2026-11-08T11:06:15Z"
  });

  it.each([
    { id: "skipped-job-stamped-with-times-has-no-log", job: job("skipped", null), expected: false },
    { id: "successful-job-on-a-runner", job: job("success", "GitHub Actions 1000117064"), expected: true },
    { id: "failed-job-on-a-runner", job: job("failure", "GitHub Actions 1000117064"), expected: true },
    { id: "job-cancelled-before-a-runner-picked-it", job: job("cancelled", null), expected: false }
  ])("$id", ({ job: j, expected }) => {
    expect(ranOnRunner(j)).toBe(expected);
  });
});

describe("stepDone", () => {
  it.each([
    { id: "planning-step-awaiting-approval", progress: "settled", phase: "spec", status: "awaiting_human_approval", expected: true },
    { id: "grilling-awaiting-an-answer", progress: "settled", phase: "grilling", status: "active", expected: true },
    { id: "gate-3-feature-pr-awaits-the-human-merge", progress: "settled", phase: "review", status: "awaiting_human_approval", expected: true },
    { id: "implementation-idle-between-tickets-is-not-done", progress: "settled", phase: "implementation", status: "active", expected: false },
    { id: "review-still-active-is-not-done", progress: "settled", phase: "review", status: "active", expected: false },
    { id: "work-still-running", progress: "pending", phase: "review", status: "awaiting_human_approval", expected: false },
    { id: "epic-done", progress: "done", phase: "completed", status: "done", expected: true }
  ] as const)("$id", ({ progress, phase, status, expected }) => {
    expect(stepDone(progress, { phase, status })).toBe(expected);
  });
});

describe("deriveEngine", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it.each([
    {
      id: "issue-command-runs-the-in-house-loop-whatever-agents-yml-says",
      workflow: `      - uses: Giskard-AI/epure/actions/authorize-command@${sha}\n        uses: Giskard-AI/epure/actions/orchestrate-issue@${sha} # v1.1.0`,
      agents: "version: 1\nharness: pi\nmodel: google/gemini-3.8-flash\n",
      expected: { executed: "epure-in-house-loop", workflow_actions: ["authorize-command", "orchestrate-issue"], agents_yml_harness: "pi" }
    },
    {
      id: "run-agent-uses-the-configured-harness",
      workflow: `        uses: Giskard-AI/epure/actions/run-agent@${sha}`,
      agents: "harness: codex\n",
      expected: { executed: "agent harness (codex)", workflow_actions: ["run-agent"], agents_yml_harness: "codex" }
    },
    {
      id: "no-epure-action",
      workflow: "        uses: actions/checkout@v7",
      agents: "",
      expected: { executed: "unknown", workflow_actions: [], agents_yml_harness: null }
    }
  ])("$id", ({ workflow, agents, expected }) => {
    expect(deriveEngine(workflow, agents)).toEqual(expected);
  });
});

describe("codeUnderTestProblems", () => {
  const sha = "a".repeat(40);
  const clean = { pinnedSha: sha, headSha: sha, dirty: "", distDrift: "" };

  it.each([
    { id: "clean-checkout-of-the-pinned-commit", input: clean, expected: [] },
    {
      id: "checkout-of-another-commit",
      input: { ...clean, headSha: "b".repeat(40) },
      expected: ["the local checkout is at bbbbbbbbbbbb, the pinned EPURE commit is aaaaaaaaaaaa"]
    },
    { id: "dirty-worktree", input: { ...clean, dirty: " M src/llm/client.ts" }, expected: ["the worktree has uncommitted changes:\n M src/llm/client.ts"] },
    {
      id: "dist-out-of-date",
      input: { ...clean, distDrift: " M dist/cli/setup-repo.mjs" },
      expected: ["dist/ at the pinned commit does not match its source (rebuild, commit, push):\n M dist/cli/setup-repo.mjs"]
    }
  ])("$id", ({ input, expected }) => {
    expect(codeUnderTestProblems(input)).toEqual(expected);
  });
});

describe("installCiVerdict", () => {
  const ci = (status: string, conclusion: string | null) => ({ path: ".github/workflows/ci.yml", status, conclusion });
  const check = (status: string, conclusion: string | null) => ({ path: ".github/workflows/epure-check.yml", status, conclusion });

  it.each([
    { id: "no-run-yet", runs: [], failedJobs: [], expected: { state: "pending" } },
    { id: "ci-still-running", runs: [ci("in_progress", null)], failedJobs: [], expected: { state: "pending" } },
    { id: "only-other-workflows-ran", runs: [check("completed", "success")], failedJobs: [], expected: { state: "pending" } },
    { id: "every-run-green", runs: [ci("completed", "success"), check("completed", "skipped")], failedJobs: [], expected: { state: "green" } },
    {
      id: "failed-job-in-a-running-workflow-is-red-at-once",
      runs: [ci("in_progress", null)],
      failedJobs: [".github/workflows/ci.yml: Zizmor"],
      expected: { state: "red", failed: [".github/workflows/ci.yml: Zizmor"] }
    },
    {
      id: "completed-run-that-is-not-green",
      runs: [ci("completed", "success"), check("completed", "action_required")],
      failedJobs: [],
      expected: { state: "red", failed: [".github/workflows/epure-check.yml (action_required)"] }
    }
  ])("$id", ({ runs, failedJobs, expected }) => {
    expect(installCiVerdict(runs, failedJobs)).toEqual(expected);
  });
});

describe("thinkingLevelFor", () => {
  it.each([
    { id: "gemini-3-runs-high", model: "google/gemini-3.8-flash", expected: "HIGH" },
    { id: "other-provider-keeps-its-default", model: "anthropic/claude-sonnet", expected: "provider default" }
  ])("$id", ({ model, expected }) => {
    expect(thinkingLevelFor(model)).toBe(expected);
  });
});

describe("stepProgress", () => {
  const now = Date.parse("2026-11-08T10:00:00.000Z");
  const state = (patch: Partial<EpureIssueState>): EpureIssueState => ({
    ...createInitialIssueState(7),
    version: 5,
    last_processed_comment_id: 100,
    ...patch
  });
  const since = { commentId: 100, version: 4 };

  it.each([
    { id: "no-state-yet", s: null, active: 0, expected: "pending" },
    { id: "comment-not-processed", s: state({ last_processed_comment_id: 99, version: 4 }), active: 0, expected: "pending" },
    { id: "workflow-still-running", s: state({}), active: 1, expected: "pending" },
    {
      id: "live-lease",
      s: state({ claimed_by_run_id: "r1", claim_expires_at: "2026-11-08T11:00:00.000Z" }),
      active: 0,
      expected: "pending"
    },
    {
      id: "stale-lease-is-ignored",
      s: state({ phase: "grilling", status: "active", claimed_by_run_id: "r1", claim_expires_at: "2026-11-08T09:00:00.000Z" }),
      active: 0,
      expected: "settled"
    },
    { id: "awaiting-approval", s: state({ phase: "spec", status: "awaiting_human_approval" }), active: 0, expected: "settled" },
    { id: "suspended", s: state({ status: "suspended" }), active: 0, expected: "suspended" },
    { id: "done", s: state({ phase: "completed", status: "done" }), active: 0, expected: "done" },
    { id: "version-moved-without-cursor", s: state({ last_processed_comment_id: 50, status: "suspended" }), active: 0, expected: "suspended" }
  ])("$id", ({ s, active, expected }) => {
    expect(stepProgress(s, since, active, now)).toBe(expected);
  });
});

describe("renderMarkdownReport", () => {
  const baseResult = (patch: Partial<E2eRunResult>): E2eRunResult => {
    const escalations = [escalation(3)];
    return {
      schema_version: 2,
      run_id: "r1",
      repository: "Giskard-AI/epure-e2e-sandbox",
      code_under_test: { epure_ref: "dev", epure_sha: "0123456789abcdef", harness_commit: "0123456789abcdef" },
      seed: { tree_sha: "feedfacecafebeef", commit_sha: "c0ffee" },
      install_commit_sha: "deadbeef",
      engine: { executed: "epure-in-house-loop", workflow_actions: ["orchestrate-issue"], agents_yml_harness: "pi" },
      settings: {
        model: "google/gemini-3.8-flash",
        thinking_level: "HIGH",
        llm_environment: "epure-agent",
        max_grill_replies: 3,
        planning_step_timeout_minutes: 30,
        implementation_timeout_minutes: 240,
        install_ci_timeout_minutes: 20,
        poll_interval_ms: 30_000,
        stall_polls: 6
      },
      resume_policy: RESUME_POLICY,
      pricing: { source: "https://aistudio.google.com/docs/pricing, read 2026-11-08", table: {} },
      started_at: "2026-11-08T10:00:00.000Z",
      ended_at: "2026-11-08T11:00:00.000Z",
      duration_ms: 3_600_000,
      host_asleep_ms: 0,
      issue: { number: 1, url: "https://github.com/o/sandbox/issues/1" },
      tickets: [3, 4],
      feature_pr: null,
      phases: [{ name: "plan", started_at: "", ended_at: "", duration_ms: 90_000, outcome: "ok" }],
      usage: { ...summarizeUsage([], {}), by_phase: {}, unavailable_job_logs: [], records: [] },
      actions: { jobs: 4, minutes: 12.5, billable_minutes: 14, by_workflow: {} },
      escalations,
      resumes: [],
      job_failures: [],
      comparable: { comparable: false, unmet: ["no review on a task pull request"] },
      evidence_error: null,
      ...evaluateRun({ featurePr: null, escalations, jobFailures: [], usageRecords: 0, unavailableJobLogs: [], evidenceError: null }),
      error: "timed out",
      ...patch
    };
  };

  it.each([
    { id: "verdict", expected: "# EPURE e2e run r1: FAIL" },
    { id: "failed-check", expected: "- [ ] feature-pr-open: no open feature/* -> dev pull request" },
    { id: "both-shas", expected: "- EPURE under test: `dev` (0123456789ab); harness commit 0123456789ab" },
    { id: "seed-tree", expected: "- Seed tree: feedfacecafe; install commit: deadbeef" },
    { id: "engine-that-ran", expected: "- Engine: epure-in-house-loop (agents.yml harness: pi)" },
    { id: "actions-minutes", expected: "Actions: 12.5 min over 4 jobs (14 billable)" },
    { id: "comparable-flag", expected: "- Comparable: no (no review on a task pull request)" },
    { id: "phase-duration", expected: "| plan | 1.5 min | ok |" },
    { id: "zero-usage-is-unknown-cost-not-zero", expected: "No usage records: the cost of this run is unknown." },
    { id: "escalation-with-class", expected: "- #3 in implementation: `remediation_exhausted` (legitimate)" },
    { id: "harness-stop", expected: "- Harness stopped: timed out" }
  ])("states $id", ({ expected }) => {
    expect(renderMarkdownReport(baseResult({}))).toContain(expected);
  });

  it("lists job failures apart from escalations", () => {
    const report = renderMarkdownReport(
      baseResult({ job_failures: [{ run_id: 1, url: "https://x/runs/1", conclusion: "failure", phase: "spec", at: "2026-11-08T10:30:00.000Z" }] })
    );

    expect(report).toContain("## Orchestrator job failures (1)\n\n- failure in spec at 2026-11-08T10:30:00.000Z: https://x/runs/1");
  });
});
