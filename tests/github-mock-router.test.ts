import { describe, expect, it } from "vitest";
import {
  createGitHubApiRefStateStore,
  updateIssueStateWithCas
} from "../src/state/git-ref-state.js";
import {
  createGitHubMockRouter,
  installFakeGitDataApi,
  json,
  noContent,
  notFound,
  primaryRateLimit,
  secondaryRateLimit,
  serverError,
  tooManyRequests,
  unprocessable,
  type MockReply
} from "./fixtures/github-mock-router.js";

const REPO = "acme/demo";
const API = "https://api.github.com";

async function send(
  router: ReturnType<typeof createGitHubMockRouter>,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return await router.fetch(`${API}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

describe("GitHub mock router (strict)", () => {
  it.each([
    { id: "undeclared-path", method: "GET", path: "/repos/acme/demo/issues/1" },
    { id: "declared-path-wrong-method", method: "DELETE", path: "/repos/acme/demo/labels" },
    { id: "declared-path-query-mismatch", method: "GET", path: "/repos/acme/demo/pulls?state=all" }
  ])("throws loudly on undeclared route [$id]", async ({ method, path }) => {
    const router = createGitHubMockRouter()
      .on("GET", "/repos/acme/demo/labels", json([]))
      .on("GET", "/repos/acme/demo/pulls?state=open", json([]));

    await expect(send(router, method, path)).rejects.toThrow(
      `Undeclared GitHub mock route: ${method} api.github.com${path}`
    );
    expect(router.unmatched).toEqual([
      { method, host: "api.github.com", path, body: undefined }
    ]);
  });

  it.each([
    { id: "non-github-host-is-undeclared-by-default", url: "https://generativelanguage.googleapis.com/v1beta/models" }
  ])("rejects other hosts unless declared with onHost [$id]", async ({ url }) => {
    const router = createGitHubMockRouter();
    await expect(router.fetch(url)).rejects.toThrow(
      "Undeclared GitHub mock route: GET generativelanguage.googleapis.com/v1beta/models"
    );
    router.onHost("generativelanguage.googleapis.com", "GET", "/v1beta/models", json({ models: [] }));
    expect((await router.fetch(url)).status).toBe(200);
  });

  it.each<{
    id: string;
    reply: MockReply;
    expectedStatus: number;
    expectedHeaders: Record<string, string>;
    expectedMessage: string | null;
  }>([
    {
      id: "primary-rate-limit-403-remaining-0-with-reset",
      reply: primaryRateLimit(1_800_000_000),
      expectedStatus: 403,
      expectedHeaders: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
      expectedMessage: "API rate limit exceeded"
    },
    {
      id: "secondary-rate-limit-403-with-retry-after",
      reply: secondaryRateLimit(60),
      expectedStatus: 403,
      expectedHeaders: { "retry-after": "60" },
      expectedMessage: "You have exceeded a secondary rate limit"
    },
    {
      id: "secondary-rate-limit-403-without-retry-after",
      reply: secondaryRateLimit(),
      expectedStatus: 403,
      expectedHeaders: { "x-ratelimit-remaining": "4990" },
      expectedMessage: "You have exceeded a secondary rate limit"
    },
    {
      id: "too-many-requests-429-with-retry-after",
      reply: tooManyRequests(30),
      expectedStatus: 429,
      expectedHeaders: { "retry-after": "30" },
      expectedMessage: "Too Many Requests"
    },
    {
      id: "server-error-503",
      reply: serverError(503),
      expectedStatus: 503,
      expectedHeaders: {},
      expectedMessage: "Server Error"
    },
    {
      id: "unprocessable-422",
      reply: unprocessable("Validation Failed"),
      expectedStatus: 422,
      expectedHeaders: {},
      expectedMessage: "Validation Failed"
    },
    {
      id: "not-found-404",
      reply: notFound(),
      expectedStatus: 404,
      expectedHeaders: {},
      expectedMessage: "Not Found"
    },
    {
      id: "no-content-204-has-null-body",
      reply: noContent(),
      expectedStatus: 204,
      expectedHeaders: {},
      expectedMessage: null
    }
  ])("serves canned reply [$id]", async ({ reply, expectedStatus, expectedHeaders, expectedMessage }) => {
    const router = createGitHubMockRouter().on("GET", "/rate", reply);
    const resp = await send(router, "GET", "/rate");

    expect(resp.status).toBe(expectedStatus);
    for (const [name, value] of Object.entries(expectedHeaders)) {
      expect(resp.headers.get(name)).toBe(value);
    }
    if (expectedMessage === null) {
      expect(await resp.text()).toBe("");
    } else {
      expect(((await resp.json()) as { message: string }).message).toContain(expectedMessage);
    }
  });

  it.each([
    { id: "rate-limited-then-ok-then-repeats-last", steps: [primaryRateLimit(1), json({ ok: true })], expected: [403, 200, 200] },
    { id: "two-5xx-then-ok", steps: [serverError(502), serverError(503), json({})], expected: [502, 503, 200] },
    { id: "single-step-repeats-forever", steps: [json({})], expected: [200, 200, 200] }
  ])("plays per-route response sequences [$id]", async ({ steps, expected }) => {
    const [first, ...rest] = steps;
    const router = createGitHubMockRouter().on("GET", "/repos/acme/demo", first!, ...rest);
    const statuses: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      statuses.push((await send(router, "GET", "/repos/acme/demo")).status);
    }
    expect(statuses).toEqual(expected);
  });

  it("last declared route wins so a test can override a shared helper's route", async () => {
    const router = createGitHubMockRouter()
      .on("GET", /^\/repos\/acme\/demo\/issues\/\d+$/, json({ number: 1 }))
      .on("GET", "/repos/acme/demo/issues/7", primaryRateLimit(1));

    expect((await send(router, "GET", "/repos/acme/demo/issues/7")).status).toBe(403);
    expect((await send(router, "GET", "/repos/acme/demo/issues/8")).status).toBe(200);
  });

  it("records per-route call counts and the request log with parsed JSON bodies", async () => {
    const router = createGitHubMockRouter()
      .on("POST", "/repos/acme/demo/issues/7/comments", json({ html_url: "u" }, 201))
      .on("GET", /^\/repos\/acme\/demo\/issues\/\d+$/, json({ number: 7 }));

    await send(router, "GET", "/repos/acme/demo/issues/7");
    await send(router, "GET", "/repos/acme/demo/issues/8");
    await send(router, "POST", "/repos/acme/demo/issues/7/comments", { body: "hi" });

    expect(router.calls("GET", /\/issues\/\d+$/)).toBe(2);
    expect(router.calls("POST", "/repos/acme/demo/issues/7/comments")).toBe(1);
    expect(router.requests).toHaveLength(3);
    expect(router.requests.at(-1)).toEqual({
      method: "POST",
      host: "api.github.com",
      path: "/repos/acme/demo/issues/7/comments",
      body: { body: "hi" }
    });
  });
});

describe("Fake Git Database API (refs, blobs, commits)", () => {
  function setup() {
    const router = createGitHubMockRouter();
    const git = installFakeGitDataApi(router, REPO);
    const root = git.putCommit({ parents: [], message: "root" });
    const child = git.putCommit({ parents: [root], message: "child" });
    const sibling = git.putCommit({ parents: [root], message: "sibling" });
    return { router, git, root, child, sibling };
  }

  it.each([
    { id: "get-missing-ref-is-404", ref: "epure/state/1", seed: false, expectedStatus: 404 },
    { id: "get-existing-ref-is-200", ref: "epure/state/1", seed: true, expectedStatus: 200 }
  ])("GET git/ref [$id]", async ({ ref, seed, expectedStatus }) => {
    const { router, git, root } = setup();
    if (seed) {
      git.setRef(`refs/${ref}`, root);
    }
    const resp = await send(router, "GET", `/repos/${REPO}/git/ref/${ref}`);
    expect(resp.status).toBe(expectedStatus);
  });

  it.each([
    { id: "create-new-ref", preexisting: false, ref: "refs/heads/live/x", expectedStatus: 201, expectedMessage: null },
    { id: "create-existing-ref-is-422", preexisting: true, ref: "refs/heads/live/x", expectedStatus: 422, expectedMessage: "Reference already exists" },
    { id: "create-ref-without-two-slashes-is-422", preexisting: false, ref: "refs/x", expectedStatus: 422, expectedMessage: "at least two slashes" }
  ])("POST git/refs [$id]", async ({ preexisting, ref, expectedStatus, expectedMessage }) => {
    const { router, git, root } = setup();
    if (preexisting) {
      git.setRef(ref, root);
    }
    const resp = await send(router, "POST", `/repos/${REPO}/git/refs`, { ref, sha: root });
    expect(resp.status).toBe(expectedStatus);
    if (expectedMessage) {
      expect(((await resp.json()) as { message: string }).message).toContain(expectedMessage);
    }
  });

  it.each([
    { id: "fast-forward-without-force-accepted", from: "root", to: "child", force: false, expectedStatus: 200, expectedRef: "child" },
    { id: "non-fast-forward-without-force-rejected-422", from: "child", to: "sibling", force: false, expectedStatus: 422, expectedRef: "child" },
    { id: "rewind-without-force-rejected-422", from: "child", to: "root", force: false, expectedStatus: 422, expectedRef: "child" },
    { id: "non-fast-forward-with-force-accepted", from: "child", to: "sibling", force: true, expectedStatus: 200, expectedRef: "sibling" },
    { id: "blob-target-without-force-accepted-no-fast-forward-protection", from: "blobA", to: "blobB", force: false, expectedStatus: 200, expectedRef: "blobB" },
    { id: "blob-target-with-force-accepted", from: "blobA", to: "blobB", force: true, expectedStatus: 200, expectedRef: "blobB" }
  ])("PATCH git/refs honors force [$id]", async ({ from, to, force, expectedStatus, expectedRef }) => {
    const { router, git, root, child, sibling } = setup();
    const shas: Record<string, string> = {
      root,
      child,
      sibling,
      blobA: git.putBlob("{\"v\":1}"),
      blobB: git.putBlob("{\"v\":2}")
    };
    git.setRef("refs/heads/live/x", shas[from]!);

    const resp = await send(router, "PATCH", `/repos/${REPO}/git/refs/heads/live/x`, {
      sha: shas[to],
      force
    });

    expect(resp.status).toBe(expectedStatus);
    if (expectedStatus === 422) {
      expect(((await resp.json()) as { message: string }).message).toBe(
        "Update is not a fast forward"
      );
    }
    expect(git.getRef("refs/heads/live/x")).toBe(shas[expectedRef]);
  });

  it.each([
    { id: "two-parent-merge-commit-descends-from-both", parents: ["child", "sibling"] as const }
  ])("POST git/commits builds the commit graph [$id]", async ({ parents }) => {
    const { router, git, child, sibling } = setup();
    const shas = { child, sibling };
    const childResp = await send(router, "GET", `/repos/${REPO}/git/commits/${child}`);
    const { tree: { sha: treeSha } } = (await childResp.json()) as { tree: { sha: string } };
    const commitResp = await send(router, "POST", `/repos/${REPO}/git/commits`, {
      message: "merge",
      tree: treeSha,
      parents: parents.map((p) => shas[p])
    });
    const { sha: mergeSha } = (await commitResp.json()) as { sha: string };

    expect(commitResp.status).toBe(201);
    expect(git.isAncestor(child, mergeSha)).toBe(true);
    expect(git.isAncestor(sibling, mergeSha)).toBe(true);
    const getResp = await send(router, "GET", `/repos/${REPO}/git/commits/${mergeSha}`);
    expect(((await getResp.json()) as { parents: unknown[] }).parents).toHaveLength(2);
  });

  it("onBeforeNextRefWrite runs once before the next write to that ref, simulating a concurrent writer", async () => {
    const { router, git, root, child, sibling } = setup();
    git.setRef("refs/heads/live/x", root);
    let hookRuns = 0;
    git.onBeforeNextRefWrite("refs/heads/live/x", () => {
      hookRuns += 1;
      git.setRef("refs/heads/live/x", sibling);
    });

    const first = await send(router, "PATCH", `/repos/${REPO}/git/refs/heads/live/x`, { sha: child, force: false });
    const second = await send(router, "PATCH", `/repos/${REPO}/git/refs/heads/live/x`, { sha: sibling, force: false });

    expect(first.status).toBe(422);
    expect(second.status).toBe(200);
    expect(hookRuns).toBe(1);
  });

  it.each([
    { id: "state-store-creates-then-updates-ref-through-fake-api", mutations: 2, expectedVersion: 2 }
  ])("drives the real GitHub API state store [$id]", async ({ mutations, expectedVersion }) => {
    const { router, git } = setup();
    const store = createGitHubApiRefStateStore({
      repository: REPO,
      githubToken: "ghs_test",
      fetchImpl: router.fetch
    });

    for (let i = 1; i <= mutations; i += 1) {
      await updateIssueStateWithCas({
        issueNumber: 12,
        store,
        mutator: (prev) => ({ ...prev, last_processed_comment_id: i })
      });
    }

    const snapshot = await store.readRef("refs/epure/state/12");
    expect(snapshot.state?.version).toBe(expectedVersion);
    expect(snapshot.sha).toBe(git.getRef("refs/epure/state/12"));
    expect(router.unmatched).toEqual([]);
  });
});
