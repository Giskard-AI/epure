import { describe, expect, it } from "vitest";
import { GITHUB_ACTIONS_APP_ID } from "../src/auth/github-apps.js";
import { orchestrateIssueCommand } from "../src/orchestrator/issue-orchestrator.js";
import {
  embedManifestJson,
  isSupersedableTicket,
  parsePlanManifestFromComments,
  resolvePlanManifest,
  type EpureIdentity
} from "../src/orchestrator/plan-manifest.js";
import type {
  GitHubAppRef,
  IssueCommentRecord,
  IssueMetadata,
  OrchestrateIssueInput,
  TrackedTicketCommentMetadata
} from "../src/orchestrator/types.js";
import {
  createInitialIssueState,
  createInMemoryGitRefStateStore,
  toTerminalState,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore,
  type PlanManifestRecord
} from "../src/state/git-ref-state.js";
import {
  createGitHubMockRouter,
  json,
  noContent,
  notFound,
  unprocessable,
  type GitHubMockRouter
} from "./fixtures/github-mock-router.js";

const REPO = "acme/demo";
const ISSUE = 77;
const R = `/repos/${REPO}`;
const PLAN_BRANCH = "plan/77-demo";
const SPEC_PATH = "docs/specs/77-demo.md";
const EPURE: EpureIdentity = { appId: GITHUB_ACTIONS_APP_ID };
const EPURE_APP: GitHubAppRef = { id: GITHUB_ACTIONS_APP_ID, slug: "github-actions" };
const DEPENDABOT_APP: GitHubAppRef = { id: 29110, slug: "dependabot" };
const RENOVATE_APP: GitHubAppRef = { id: 2740, slug: "renovate" };

const ticket = (n: number, description = "d"): TrackedTicketCommentMetadata => ({
  ticketIssueNumber: n,
  slug: `t${n}`,
  title: `T${n}`,
  description,
  acceptanceCriteria: ["a"],
  blockedByIssueNumbers: [],
  filesToTouch: []
});
const manifest = (n: number, description?: string): PlanManifestRecord => ({
  planBranch: PLAN_BRANCH,
  tickets: [ticket(n, description)]
});
const manifestComment = (
  id: number,
  payload: unknown,
  login: string,
  app: GitHubAppRef | null
): IssueCommentRecord => ({
  id,
  body: `### Plan\n<!-- epure-plan-manifest:${embedManifestJson(payload)} -->`,
  user: { login, type: app ? "Bot" : "User" },
  created_at: "2026-11-06T00:00:00Z",
  performed_via_github_app: app
});
const state = (overrides: Partial<EpureIssueState>): EpureIssueState => ({
  ...createInitialIssueState(ISSUE),
  ...overrides
});

describe("A legacy manifest comment is trusted only when EPURE's App wrote it", () => {
  it.each([
    { id: "comment-by-epure-app-is-trusted", comments: [manifestComment(1, manifest(78), "github-actions[bot]", EPURE_APP)], identity: EPURE, expected: 78 },
    { id: "manifest-echoed-by-dependabot-is-ignored", comments: [manifestComment(1, manifest(999), "dependabot[bot]", DEPENDABOT_APP)], identity: EPURE, expected: undefined },
    { id: "manifest-echoed-by-another-installed-app-is-ignored", comments: [manifestComment(1, manifest(999), "renovate[bot]", RENOVATE_APP)], identity: EPURE, expected: undefined },
    { id: "manifest-forged-by-a-write-user-is-ignored", comments: [manifestComment(1, manifest(999), "maintainer", null)], identity: EPURE, expected: undefined },
    { id: "later-forged-comment-does-not-shadow-the-epure-one", comments: [manifestComment(1, manifest(78), "github-actions[bot]", EPURE_APP), manifestComment(2, manifest(999), "maintainer", null)], identity: EPURE, expected: 78 },
    { id: "github-actions-comment-is-ignored-when-epure-runs-as-its-own-app", comments: [manifestComment(1, manifest(999), "github-actions[bot]", EPURE_APP)], identity: { appId: 424242 }, expected: undefined }
  ])("$id", ({ comments, identity, expected }) => {
    expect(parsePlanManifestFromComments(comments, identity)?.tickets[0]?.ticketIssueNumber).toBe(expected);
  });
});

describe("Approve and continue implement the recorded manifest or escalate, never a forged or missing one", () => {
  const FORGED_BY_BOT = manifestComment(5, manifest(999), "dependabot[bot]", DEPENDABOT_APP);
  const TASKLIST_BODY = "Epic\n\n<!-- epure-tickets-tasklist:start -->\n- [ ] #78\n<!-- epure-tickets-tasklist:end -->";

  it.each([
    { id: "manifest-in-state-wins-over-a-manifest-echoed-by-another-bot", state: state({ phase: "tickets", plan_manifest: manifest(78) }), comments: [FORGED_BY_BOT], epicBody: "", expected: { kind: "recorded", ticket: 78, fromLegacyComment: false } },
    { id: "legacy-epure-comment-is-read-and-flagged-for-migration", state: state({ phase: "tickets" }), comments: [manifestComment(1, manifest(78), "github-actions[bot]", EPURE_APP)], epicBody: "", expected: { kind: "recorded", ticket: 78, fromLegacyComment: true } },
    { id: "superseded-manifest-in-state-is-missing", state: state({ phase: "tickets", plan_manifest: { ...manifest(78), superseded: true } }), comments: [], epicBody: "", expected: { kind: "missing" } },
    { id: "tickets-phase-whose-manifest-comment-is-gone-is-missing", state: state({ phase: "tickets" }), comments: [FORGED_BY_BOT], epicBody: "", expected: { kind: "missing" } },
    { id: "epic-body-listing-generated-tickets-without-a-manifest-is-missing", state: state({ phase: "implementation" }), comments: [], epicBody: TASKLIST_BODY, expected: { kind: "missing" } },
    { id: "plan-that-never-produced-a-manifest-falls-back-to-the-issue-body", state: state({ phase: "spec" }), comments: [FORGED_BY_BOT], epicBody: "- [ ] Ship it", expected: { kind: "none" } }
  ] as const)("$id", ({ state: current, comments, epicBody, expected }) => {
    const resolution = resolvePlanManifest({ state: current, comments, identity: EPURE, epicBody });

    expect(resolution.kind).toBe(expected.kind);
    if (resolution.kind === "recorded" && expected.kind === "recorded") {
      expect(resolution.manifest.tickets[0]?.ticketIssueNumber).toBe(expected.ticket);
      expect(resolution.fromLegacyComment).toBe(expected.fromLegacyComment);
    }
  });
});

describe("Manifest JSON embedded in an HTML comment round-trips", () => {
  it.each([
    { id: "arrow-inside-a-ticket-description", description: "Map a --> b in the parser" },
    { id: "comment-terminator-at-the-end-of-a-description", description: "Trailing terminator -->" },
    { id: "nested-html-comment-in-a-description", description: "Keep <!-- note --> intact" },
    { id: "bang-terminator-in-a-description", description: "Edge --!> case" },
    { id: "run-of-dashes-in-a-description", description: "----> arrow" }
  ])("$id", ({ description }) => {
    const payload = manifest(78, description);
    const comment = manifestComment(1, payload, "github-actions[bot]", EPURE_APP);

    expect(embedManifestJson(payload)).not.toContain("--");
    expect(parsePlanManifestFromComments([comment], EPURE)).toEqual(payload);
  });
});

describe("/epure to-tickets closes only open issues EPURE created as tickets of this plan", () => {
  const issue = (overrides: Partial<IssueMetadata>): IssueMetadata => ({
    number: 78,
    title: "T78",
    body: `Parent Plan: #${ISSUE}\nblocked_by: none`,
    state: "open",
    performed_via_github_app: EPURE_APP,
    is_pull_request: false,
    ...overrides
  });

  it.each([
    { id: "open-epure-ticket-of-this-plan-is-closed", ticket: issue({}), expected: true },
    { id: "pull-request-is-left-alone", ticket: issue({ is_pull_request: true }), expected: false },
    { id: "issue-opened-by-a-human-is-left-alone", ticket: issue({ performed_via_github_app: null }), expected: false },
    { id: "issue-opened-by-another-app-is-left-alone", ticket: issue({ performed_via_github_app: DEPENDABOT_APP }), expected: false },
    { id: "already-closed-epure-ticket-is-left-alone", ticket: issue({ state: "closed" }), expected: false },
    { id: "epure-ticket-of-another-plan-is-left-alone", ticket: issue({ body: "Parent Plan: #7\nblocked_by: none" }), expected: false },
    { id: "epure-ticket-of-a-plan-sharing-the-number-prefix-is-left-alone", ticket: issue({ body: "Parent Plan: #770\nblocked_by: none" }), expected: false }
  ])("$id", ({ ticket: candidate, expected }) => {
    expect(isSupersedableTicket(candidate, ISSUE, EPURE)).toBe(expected);
  });
});

interface FakeIssue {
  number: number;
  body: string;
  state: "open" | "closed";
  state_reason?: string | undefined;
  app: GitHubAppRef | null;
  pull_request?: boolean;
  parent?: number;
}

/** Issues, sub-issues and closures of a fake repository; every other read is a 404. */
function declareRepository(
  router: GitHubMockRouter,
  issues: Map<number, FakeIssue>,
  options: {
    readonly epicBody?: string | undefined;
    readonly comments?: readonly IssueCommentRecord[];
    readonly failCreateAt?: number;
    readonly failCloseOf?: readonly number[];
    readonly onCreate?: (createdCount: number) => Promise<void>;
  } = {}
): GitHubMockRouter {
  let created = 0;
  return router
    .on("GET", /.*/, notFound())
    .on("POST", /.*/, json({}, 201))
    .on("PATCH", /.*/, json({}))
    .on("DELETE", /.*/, noContent())
    .on("GET", /\/issues\/(\d+)$/, (req) => {
      const found = issues.get(Number(/\/issues\/(\d+)$/.exec(req.path)?.[1]));
      return found
        ? json({ number: found.number, title: `#${found.number}`, body: found.body, state: found.state, state_reason: found.state_reason ?? null, performed_via_github_app: found.app, ...(found.pull_request ? { pull_request: {} } : {}) })
        : notFound();
    })
    .on("GET", `${R}/issues/${ISSUE}`, json({ number: ISSUE, title: "Demo", body: options.epicBody ?? "- [ ] Ship it", state: "open" }))
    .on("GET", `${R}/issues/${ISSUE}/comments?per_page=100`, json(options.comments ?? []))
    .on("GET", `${R}/git/matching-refs/heads/feature/${ISSUE}-`, json([]))
    .on("GET", /\/git\/ref\/heads\//, json({ object: { sha: "branch-sha" } }))
    .on("GET", new RegExp(`^${R}/contents/docs/specs/77-demo\\.md\\?ref=`), json({ type: "file", encoding: "base64", content: Buffer.from("# Spec\n").toString("base64") }))
    .on("GET", `${R}/issues/${ISSUE}/sub_issues?per_page=100`, () =>
      json([...issues.values()].filter((i) => i.parent === ISSUE).map((i) => ({ number: i.number })))
    )
    .on("PATCH", /\/issues\/(\d+)$/, (req) => {
      const n = Number(/\/issues\/(\d+)$/.exec(req.path)?.[1]);
      const body = req.body as { state?: "closed"; state_reason?: string };
      if (options.failCloseOf?.includes(n)) {
        return unprocessable("close refused");
      }
      const found = issues.get(n);
      if (found && body.state === "closed") {
        found.state = "closed";
        found.state_reason = body.state_reason;
      }
      return json({});
    })
    .on("POST", `${R}/issues`, async (req) => {
      created += 1;
      await options.onCreate?.(created);
      if (created === options.failCreateAt) {
        return unprocessable("issue creation refused");
      }
      const number = 100 + created;
      issues.set(number, { number, body: (req.body as { body: string }).body, state: "open", app: EPURE_APP, parent: ISSUE });
      return json({ number, html_url: `https://github.com/${REPO}/issues/${number}` }, 201);
    })
    .onHost("api.openai.com", "POST", "/v1/chat/completions", json({
      choices: [{ message: { content: JSON.stringify({
        tickets: [
          { index: 1, slug: "parse", title: "[Ticket 1] Parse", description: "Map a --> b in the parser", acceptance_criteria: ["WHEN a, parse returns b"], blocked_by_indices: [], files_to_create_or_update: ["src/parse.ts"] },
          { index: 2, slug: "wire", title: "[Ticket 2] Wire", description: "Wire the parser", acceptance_criteria: ["WHEN run, cli calls parse"], blocked_by_indices: [1], files_to_create_or_update: ["src/cli.ts"] }
        ]
      }) } }]
    }));
}

async function seed(overrides: Partial<EpureIssueState>): Promise<GitRefStateStore> {
  const store = createInMemoryGitRefStateStore();
  await updateIssueStateWithCas({ issueNumber: ISSUE, store, mutator: (prev) => ({ ...prev, ...overrides }) });
  return store;
}

async function run(
  router: GitHubMockRouter,
  store: GitRefStateStore,
  input: Pick<OrchestrateIssueInput, "command">
) {
  return await orchestrateIssueCommand({
    repository: REPO,
    issueNumber: ISSUE,
    commandArgs: "",
    actor: "maintainer",
    commentId: 900,
    fallbackGithubToken: "ghs_test",
    llmApiKey: "key_test",
    model: "openai/gpt-test",
    stateStore: store,
    fetchImpl: router.fetch,
    ...input
  });
}

async function readState(store: GitRefStateStore): Promise<EpureIssueState> {
  return (await store.readRef(`refs/epure/state/${ISSUE}`)).state!;
}

function epicComments(router: GitHubMockRouter): string[] {
  return router.requests
    .filter((r) => r.method === "POST" && r.path === `${R}/issues/${ISSUE}/comments`)
    .map((r) => (r.body as { body: string }).body);
}

const openTickets = (issues: Map<number, FakeIssue>): number[] =>
  [...issues.values()].filter((i) => i.state === "open" && !i.pull_request).map((i) => i.number);

const SPEC_STATE: Partial<EpureIssueState> = {
  phase: "spec",
  status: "awaiting_human_approval",
  active_branch: PLAN_BRANCH,
  plan_branch: PLAN_BRANCH,
  spec_manifest: { planBranch: PLAN_BRANCH, specPath: SPEC_PATH, adrPaths: [], targetFilesHint: [] },
  plan_manifest: manifest(78)
};

const previousGraph = (): Map<number, FakeIssue> =>
  new Map<number, FakeIssue>([
    [78, { number: 78, body: `Parent Plan: #${ISSUE}\nblocked_by: none`, state: "open", app: EPURE_APP, parent: ISSUE }],
    [90, { number: 90, body: `Parent Plan: #${ISSUE}\nblocked_by: none`, state: "open", app: EPURE_APP, pull_request: true, parent: ISSUE }],
    [91, { number: 91, body: "A human sub-task", state: "open", app: null, parent: ISSUE }]
  ]);

describe("Approve and continue escalate when the recorded manifest cannot be read", () => {
  it.each([
    { id: "approve-after-to-tickets-whose-manifest-comment-is-gone-escalates", seedState: { phase: "tickets", status: "awaiting_human_approval" }, command: "approve", epicBody: undefined, expectedPhase: "tickets" },
    { id: "approve-after-an-interrupted-regeneration-escalates", seedState: { phase: "tickets", status: "suspended", plan_manifest: { ...manifest(78), superseded: true as const } }, command: "approve", epicBody: undefined, expectedPhase: "tickets" },
    { id: "continue-mid-epic-without-a-readable-manifest-escalates", seedState: { phase: "implementation", status: "suspended" }, command: "continue", epicBody: "<!-- epure-tickets-tasklist:start -->\n- [ ] #78\n<!-- epure-tickets-tasklist:end -->", expectedPhase: "implementation" }
  ] as const)("$id", async ({ seedState, command, epicBody, expectedPhase }) => {
    const store = await seed({ ...seedState, active_branch: PLAN_BRANCH });
    const router = declareRepository(createGitHubMockRouter(), new Map(), {
      epicBody,
      comments: [manifestComment(5, manifest(999), "dependabot[bot]", DEPENDABOT_APP)]
    });

    const res = await run(router, store, { command });

    const after = await readState(store);
    expect(res.status).toBe("suspended");
    expect(after).toMatchObject({ status: "suspended", phase: expectedPhase, last_escalation: { reason: "plan_manifest_missing" } });
    expect(epicComments(router).at(-1)).toContain("plan_manifest_missing");
    expect(router.requests.filter((r) => r.method === "POST" && r.path === `${R}/git/refs`)).toEqual([]);
    expect(router.requests.filter((r) => /999|plan%2Fevil/.test(r.path))).toEqual([]);
  });
});

describe("Ticket graph regeneration leaves exactly one open graph, the one the state records", () => {
  it("regeneration-closes-only-the-epure-ticket-and-records-the-new-graph-in-the-state", async () => {
    const store = await seed(SPEC_STATE);
    const issues = previousGraph();
    const router = declareRepository(createGitHubMockRouter(), issues);

    const res = await run(router, store, { command: "to-tickets" });
    const after = await readState(store);
    expect(res.created_ticket_numbers).toEqual([101, 102]);
    expect(issues.get(78)).toMatchObject({ state: "closed", state_reason: "not_planned" });
    expect(issues.get(90)?.state).toBe("open");
    expect(issues.get(91)?.state).toBe("open");
    expect(after.plan_manifest?.superseded).toBeUndefined();
    expect(after.plan_manifest?.tickets.map((t) => t.ticketIssueNumber)).toEqual([101, 102]);
    expect(after.plan_manifest?.tickets[0]?.description).toBe("Map a --> b in the parser");
    const displayed = manifestComment(1, null, "github-actions[bot]", EPURE_APP);
    expect(parsePlanManifestFromComments([{ ...displayed, body: epicComments(router).at(-1)! }], EPURE)).toEqual(after.plan_manifest);
  });

  it.each([
    { id: "creation-failure-closes-the-tickets-it-created", failCloseOf: [] as number[], expectedOpenAfterFailure: [91] },
    { id: "creation-failure-whose-cleanup-fails-is-cleaned-by-the-retry", failCloseOf: [101], expectedOpenAfterFailure: [91, 101] }
  ])("$id", async ({ failCloseOf, expectedOpenAfterFailure }) => {
    const store = await seed(SPEC_STATE);
    const issues = previousGraph();

    await run(declareRepository(createGitHubMockRouter(), issues, { failCreateAt: 2, failCloseOf }), store, { command: "to-tickets" });

    expect(openTickets(issues)).toEqual(expectedOpenAfterFailure);
    expect((await readState(store)).plan_manifest).toMatchObject({ superseded: true });
    const approve = await run(declareRepository(createGitHubMockRouter(), issues), store, { command: "approve" });
    expect(approve.status).toBe("suspended");
    expect((await readState(store)).last_escalation?.reason).toBe("plan_manifest_missing");

    const retry = await run(declareRepository(createGitHubMockRouter(), issues), store, { command: "to-tickets" });

    expect(openTickets(issues)).toEqual([91, ...retry.created_ticket_numbers]);
    expect((await readState(store)).plan_manifest?.tickets.map((t) => t.ticketIssueNumber)).toEqual(retry.created_ticket_numbers);
  });

  it("cancel-during-regeneration-closes-the-new-tickets-and-keeps-the-old-manifest-superseded", async () => {
    const store = await seed(SPEC_STATE);
    const issues = previousGraph();
    const router = declareRepository(createGitHubMockRouter(), issues, {
      onCreate: async (count) => {
        if (count === 2) {
          await updateIssueStateWithCas({ issueNumber: ISSUE, store, mutator: (prev) => toTerminalState(prev, { status: "cancelled" }) });
        }
      }
    });

    const res = await run(router, store, { command: "to-tickets" });

    expect(res.executed).toBe(false);
    expect(openTickets(issues)).toEqual([91]);
    expect(await readState(store)).toMatchObject({ status: "cancelled", plan_manifest: { superseded: true } });
  });
});
