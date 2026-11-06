import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mintRepositoryInstallationToken,
  revokeGitHubInstallationToken
} from "../../src/auth/github-app-jwt.js";
import { syncBranchWithBase } from "../../src/orchestrator/github/branch-sync.js";
import { createGitHubRateLimitedFetch } from "../../src/orchestrator/github/rate-limit.js";
import {
  createGitHubRestHelper,
  PullRequestNotMergeableError
} from "../../src/orchestrator/github/rest-client.js";
import {
  createGitHubApiRefStateStore,
  updateIssueStateWithCas,
  type GitRefStateStore
} from "../../src/state/git-ref-state.js";

export interface LiveGitHubConfig {
  readonly repository: string;
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId?: number | undefined;
}

interface LiveGitHubConfigFile {
  readonly repository?: string;
  readonly appId?: string | number;
  readonly privateKey?: string;
  readonly privateKeyPath?: string;
  readonly installationId?: number;
}

function readKeyFile(path: string): string {
  return readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8");
}

function loadLiveGitHubConfig(): LiveGitHubConfig | null {
  const configPath = resolve(
    process.env.EPURE_LIVE_GITHUB_CONFIG?.trim() || "epure.live-github.json"
  );
  let file: LiveGitHubConfigFile = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, "utf8")) as LiveGitHubConfigFile;
    } catch {
      // The parser message can quote file content, including an inline private key.
      throw new Error(`invalid JSON in ${configPath}`);
    }
  }
  const env = process.env;
  const repository = env.EPURE_LIVE_GITHUB_REPOSITORY?.trim() || file.repository;
  const appId = env.EPURE_LIVE_GITHUB_APP_ID?.trim() || file.appId?.toString();
  const keyPath = env.EPURE_LIVE_GITHUB_APP_PRIVATE_KEY_PATH?.trim() || file.privateKeyPath;
  const privateKey =
    env.EPURE_LIVE_GITHUB_APP_PRIVATE_KEY?.trim() ||
    file.privateKey ||
    (keyPath ? readKeyFile(keyPath) : undefined);
  const installationId =
    Number(env.EPURE_LIVE_GITHUB_INSTALLATION_ID) || file.installationId;
  if (!repository || !appId || !privateKey) {
    return null;
  }
  return { repository, appId, privateKey, installationId };
}

function assertSandboxRepository(repository: string): void {
  const name = repository.split("/")[1] ?? "";
  if (repository.toLowerCase() === "giskard-ai/epure" || !name.toLowerCase().includes("sandbox")) {
    throw new Error(
      `refusing to run live GitHub tests against "${repository}": use a disposable repository whose name contains "sandbox"`
    );
  }
}

const OPTED_IN = process.env.EPURE_LIVE_GITHUB === "1";
const config = OPTED_IN ? loadLiveGitHubConfig() : null;
const describeLive = config ? describe : describe.skip;
const HOOK_TIMEOUT_MS = 120_000;
const STALE_NAMESPACE_AGE_MS = 24 * 60 * 60 * 1000;
const RUN_ID = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const NS = `live/${RUN_ID}`;
const NAMESPACE_IN_REF = /^refs\/(?:heads|epure\/state)\/(live\/([0-9a-z]+)-[0-9a-f]{6})\//;

interface ApiResult<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: T;
}

describeLive(
  config
    ? `live GitHub harness on ${config.repository} (run ${NS})`
    : OPTED_IN
      ? "live GitHub harness skipped: no epure.live-github.json, EPURE_LIVE_GITHUB_CONFIG or EPURE_LIVE_GITHUB_* env"
      : "live GitHub harness skipped: EPURE_LIVE_GITHUB=1 is not set (run npm run test:live:github)",
  { timeout: 120_000 },
  () => {
    const cfg = config ?? { repository: "", appId: "", privateKey: "" };
    let token = "";
    let sandboxVerified = false;
    let baseSha = "";
    const R = `/repos/${cfg.repository}`;

    async function api<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
      const resp = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      const text = await resp.text();
      return {
        status: resp.status,
        headers: resp.headers,
        data: (text ? JSON.parse(text) : null) as T
      };
    }

    async function commitOnTop(parents: readonly string[], path: string, content: string): Promise<string> {
      const parent = await api<{ tree: { sha: string } }>("GET", `${R}/git/commits/${parents[0]}`);
      const blob = await api<{ sha: string }>("POST", `${R}/git/blobs`, { content, encoding: "utf-8" });
      const tree = await api<{ sha: string }>("POST", `${R}/git/trees`, {
        base_tree: parent.data.tree.sha,
        tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }]
      });
      const commit = await api<{ sha: string }>("POST", `${R}/git/commits`, {
        message: `test(${NS}): ${path}`,
        tree: tree.data.sha,
        parents
      });
      return commit.data.sha;
    }

    async function createBranch(name: string, sha: string): Promise<string> {
      const ref = `refs/heads/${NS}/${name}`;
      const res = await api("POST", `${R}/git/refs`, { ref, sha });
      expect(res.status).toBe(201);
      return `${NS}/${name}`;
    }

    function namespacedStore(store: GitRefStateStore): GitRefStateStore {
      const map = (ref: string) => ref.replace("refs/epure/state/", `refs/epure/state/${NS}/`);
      return {
        readRef: (ref) => store.readRef(map(ref)),
        compareAndSwapRef: (ref, sha, state) => store.compareAndSwapRef(map(ref), sha, state)
      };
    }

    function fetchWithConcurrentWriterBeforeStateUpdate(writer: () => Promise<void>): typeof fetch {
      let armed = true;
      return async (input, init) => {
        if (armed && init?.method === "POST" && String(input).endsWith("/graphql")) {
          armed = false;
          await writer();
        }
        return await fetch(input, init);
      };
    }

    async function listRefs(prefix: string): Promise<string[]> {
      const res = await api<Array<{ ref: string }>>("GET", `${R}/git/matching-refs/${prefix}`);
      if (res.status !== 200) {
        throw new Error(`GET git/matching-refs/${prefix}: HTTP ${res.status}`);
      }
      return res.data.map(({ ref }) => ref);
    }

    async function openPullRequestsUnder(namespaces: readonly string[]): Promise<number[]> {
      const found: number[] = [];
      for (let page = 1; ; page += 1) {
        const res = await api<Array<{ number: number; head: { ref: string } }>>(
          "GET",
          `${R}/pulls?state=open&per_page=100&page=${page}`
        );
        if (res.status !== 200) {
          throw new Error(`GET pulls page ${page}: HTTP ${res.status}`);
        }
        for (const pr of res.data) {
          if (namespaces.some((ns) => pr.head.ref.startsWith(`${ns}/`))) {
            found.push(pr.number);
          }
        }
        if (res.data.length < 100) {
          return found;
        }
      }
    }

    // Best effort: every call is isolated so one failure cannot skip the rest; failures become leftovers.
    async function removeNamespaces(namespaces: readonly string[]): Promise<string[]> {
      const leftovers: string[] = [];
      const attempt = async (item: string, action: () => Promise<boolean>): Promise<void> => {
        try {
          if (!(await action())) {
            leftovers.push(item);
          }
        } catch {
          leftovers.push(item);
        }
      };
      let prNumbers: number[] = [];
      await attempt("open-pr-scan", async () => {
        prNumbers = await openPullRequestsUnder(namespaces);
        return true;
      });
      for (const n of prNumbers) {
        await attempt(`PR#${n}`, async () => (await api("PATCH", `${R}/pulls/${n}`, { state: "closed" })).status === 200);
      }
      for (const ns of namespaces) {
        for (const prefix of [`heads/${ns}/`, `epure/state/${ns}/`]) {
          let refs: string[] = [];
          await attempt(`refs/${prefix}*`, async () => {
            refs = await listRefs(prefix);
            return true;
          });
          for (const ref of refs.filter((r) => r.startsWith(`refs/${prefix}`))) {
            await attempt(ref, async () => (await api("DELETE", `${R}/git/${ref}`)).status === 204);
          }
        }
      }
      return leftovers;
    }

    async function findStaleNamespaces(): Promise<string[]> {
      const stale = new Set<string>();
      for (const prefix of ["heads/live/", "epure/state/live/"]) {
        for (const ref of await listRefs(prefix)) {
          const match = NAMESPACE_IN_REF.exec(ref);
          if (match && match[1] !== NS && Date.now() - parseInt(match[2]!, 36) > STALE_NAMESPACE_AGE_MS) {
            stale.add(match[1]!);
          }
        }
      }
      return [...stale];
    }

    function summarize(label: string, leftovers: readonly string[]): string {
      return `[live-github] ${label} leftovers=${leftovers.length}${leftovers.length > 0 ? ` ${leftovers.join(" ")}` : ""}`;
    }

    beforeAll(async () => {
      assertSandboxRepository(cfg.repository);
      const minted = await mintRepositoryInstallationToken({
        appId: cfg.appId,
        privateKeyPem: cfg.privateKey,
        repository: cfg.repository,
        permissions: { contents: "write", pull_requests: "write" }
      });
      token = minted.token;
      if (cfg.installationId !== undefined) {
        expect(minted.installationId).toBe(cfg.installationId);
      }
      const installed = await api<{ repositories?: Array<{ full_name: string }> }>(
        "GET",
        "/installation/repositories?per_page=100"
      );
      const reachable = installed.data?.repositories?.map((r) => r.full_name) ?? [];
      if (reachable.length !== 1 || reachable[0] !== cfg.repository) {
        throw new Error(
          `refusing to run: installation token must reach exactly "${cfg.repository}", got [${reachable.join(", ")}] (HTTP ${installed.status})`
        );
      }
      sandboxVerified = true;

      const stale = await findStaleNamespaces();
      if (stale.length > 0) {
        console.warn(summarize(`stale-cleanup namespaces=${stale.join(",")}`, await removeNamespaces(stale)));
      }

      const repo = await api<{ default_branch: string }>("GET", R);
      const head = await api<{ object: { sha: string } }>(
        "GET",
        `${R}/git/ref/heads/${repo.data.default_branch}`
      );
      baseSha = head.data.object.sha;
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (!token) {
        return;
      }
      try {
        if (sandboxVerified) {
          console.warn(summarize(`teardown ns=${NS}`, await removeNamespaces([NS])));
        }
      } finally {
        await revokeGitHubInstallationToken({ token });
      }
    }, HOOK_TIMEOUT_MS);

    describe("git refs API parity with tests/fixtures/github-mock-router.ts", () => {
      it("GET git/ref on a missing ref is 404", async () => {
        const res = await api("GET", `${R}/git/ref/heads/${NS}/does-not-exist`);
        expect(res.status).toBe(404);
      });

      it("POST git/refs on an existing ref is 422 'Reference already exists'", async () => {
        await createBranch("dup", baseSha);
        const res = await api<{ message: string }>("POST", `${R}/git/refs`, {
          ref: `refs/heads/${NS}/dup`,
          sha: baseSha
        });
        expect(res.status).toBe(422);
        expect(res.data.message).toContain("Reference already exists");
      });

      it.each([
        { id: "fast-forward-without-force-accepted", target: "child", force: false, expectedStatus: 200 },
        { id: "non-fast-forward-without-force-rejected-422", target: "sibling", force: false, expectedStatus: 422 },
        { id: "non-fast-forward-with-force-accepted", target: "sibling", force: true, expectedStatus: 200 }
      ] as const)("PATCH git/refs honors force [$id]", async ({ id, target, force, expectedStatus }) => {
        const shas = {
          child: await commitOnTop([baseSha], "child.txt", "child"),
          sibling: await commitOnTop([baseSha], "sibling.txt", "sibling")
        };
        const branch = await createBranch(id, shas.child);
        const res = await api<{ message?: string }>("PATCH", `${R}/git/refs/heads/${branch}`, {
          sha: shas[target],
          force
        });
        expect(res.status).toBe(expectedStatus);
        if (expectedStatus === 422) {
          expect(res.data.message).toBe("Update is not a fast forward");
        }
      });

      it("PATCH git/refs on a blob target without force is accepted with 200 (no fast-forward protection)", async () => {
        const blobA = await api<{ sha: string }>("POST", `${R}/git/blobs`, { content: "{\"v\":1}", encoding: "utf-8" });
        const blobB = await api<{ sha: string }>("POST", `${R}/git/blobs`, { content: "{\"v\":2}", encoding: "utf-8" });
        const ref = `refs/epure/state/${NS}/blob-parity`;
        expect((await api("POST", `${R}/git/refs`, { ref, sha: blobA.data.sha })).status).toBe(201);
        const res = await api<{ ref: string; object: { sha: string; type: string } }>(
          "PATCH",
          `${R}/git/${ref}`,
          { sha: blobB.data.sha, force: false }
        );
        const after = await api<{ object: { sha: string } }>("GET", `${R}/git/${ref.replace(/^refs\//, "ref/")}`);

        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ ref, object: { sha: blobB.data.sha, type: "blob" } });
        expect(after.data.object.sha).toBe(blobB.data.sha);
      });

      it.each([
        { id: "commit-ref-matching-beforeOid-moves-the-ref", stale: false, from: "commit", accepted: true },
        { id: "commit-ref-stale-beforeOid-is-rejected-with-an-error-payload", stale: true, from: "commit", accepted: false },
        { id: "legacy-blob-ref-is-rejected-even-with-a-matching-beforeOid", stale: false, from: "blob", accepted: false }
      ] as const)("GraphQL updateRefs precondition on refs/epure/state/* [$id]", async ({ id, stale, from, accepted }) => {
        const object = async (type: "blob" | "commit", content: string) =>
          type === "blob"
            ? (await api<{ sha: string }>("POST", `${R}/git/blobs`, { content, encoding: "utf-8" })).data.sha
            : (await api<{ sha: string }>("POST", `${R}/git/commits`, { message: content, tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", parents: [] })).data.sha;
        const shas = {
          current: await object(from, `{"v":1,"id":"${id}"}`),
          next: await object("commit", `{"v":2,"id":"${id}"}`),
          other: await object(from, `{"v":0,"id":"${id}"}`)
        };
        const ref = `refs/epure/state/${NS}/graphql-${id}`;
        expect((await api("POST", `${R}/git/refs`, { ref, sha: shas.current })).status).toBe(201);
        const repo = await api<{ node_id: string }>("GET", R);

        const res = await api<{ data?: { updateRefs?: unknown }; errors?: unknown[] }>("POST", "/graphql", {
          query: "mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: {repositoryId: $repositoryId, refUpdates: $refUpdates}) { clientMutationId } }",
          variables: {
            repositoryId: repo.data.node_id,
            refUpdates: [{ name: ref, beforeOid: stale ? shas.other : shas.current, afterOid: shas.next, force: true }]
          }
        });
        const after = await api<{ object: { sha: string } }>("GET", `${R}/git/${ref.replace(/^refs\//, "ref/")}`);

        expect(res.status).toBe(200);
        expect(Boolean(res.data.data?.updateRefs)).toBe(accepted);
        expect(Boolean(res.data.errors?.length)).toBe(!accepted);
        expect(after.data.object.sha).toBe(accepted ? shas.next : shas.current);
      });
    });

    describe("concurrent CAS on refs/epure/state/* (createGitHubApiRefStateStore)", () => {
      async function seedAndRaceOnce(issueNumber: number) {
        const competingWrites: string[] = [];
        const stateRef = `refs/epure/state/${issueNumber}`;
        const plainStore = namespacedStore(
          createGitHubApiRefStateStore({ repository: cfg.repository, githubToken: token })
        );
        const writer = async () => {
          const current = await plainStore.readRef(stateRef);
          const competing = await plainStore.compareAndSwapRef(stateRef, current.sha, {
            ...current.state!,
            version: current.state!.version + 1,
            status: "cancelled"
          });
          expect(competing.swapped).toBe(true);
          competingWrites.push(competing.newSha);
        };
        await updateIssueStateWithCas({ issueNumber, store: plainStore, mutator: (prev) => ({ ...prev, phase: "implementation" }) });
        const racingStore = namespacedStore(
          createGitHubApiRefStateStore({
            repository: cfg.repository,
            githubToken: token,
            fetchImpl: fetchWithConcurrentWriterBeforeStateUpdate(writer)
          })
        );
        const result = await updateIssueStateWithCas({
          issueNumber,
          store: racingStore,
          mutator: (prev) => ({ ...prev, last_processed_comment_id: 42 })
        });
        const { state: final } = await plainStore.readRef(stateRef);
        if (!final) {
          throw new Error(`state ref for issue ${issueNumber} is missing after the race`);
        }
        return { result, final, competingWrites };
      }

      it("concurrent write between the CAS read and the ref update is detected and retried without a lost update", async () => {
        const { result, final, competingWrites } = await seedAndRaceOnce(2);
        expect(competingWrites).toHaveLength(1);
        expect(result.cas_conflicts_recovered).toBe(1);
        expect(final.status).toBe("cancelled");
        expect(final.last_processed_comment_id).toBe(42);
      });
    });

    describe("state format (ref -> state commit; legacy ref -> JSON blob)", () => {
      it("the writer stores state as an empty-tree commit chained on the previous state commit", async () => {
        const issueNumber = 3;
        const store = namespacedStore(createGitHubApiRefStateStore({ repository: cfg.repository, githubToken: token }));
        await updateIssueStateWithCas({ issueNumber, store, mutator: (prev) => ({ ...prev, phase: "spec" }) });
        const first = await store.readRef(`refs/epure/state/${issueNumber}`);
        await updateIssueStateWithCas({ issueNumber, store, mutator: (prev) => ({ ...prev, phase: "tickets" }) });

        const ref = await api<{ object: { type: string; sha: string } }>("GET", `${R}/git/ref/epure/state/${NS}/${issueNumber}`);
        const commit = await api<{ parents: Array<{ sha: string }> }>("GET", `${R}/git/commits/${ref.data.object.sha}`);
        expect(ref.data.object.type).toBe("commit");
        expect(commit.data.parents.map((p) => p.sha)).toEqual([first.sha]);
        expect((await store.readRef(`refs/epure/state/${issueNumber}`)).state).toMatchObject({ phase: "tickets", version: 2 });
      });

      it("a write on a legacy JSON-blob ref reads it then migrates it to a state commit", async () => {
        const issueNumber = 4;
        const ref = `refs/epure/state/${NS}/${issueNumber}`;
        const store = namespacedStore(createGitHubApiRefStateStore({ repository: cfg.repository, githubToken: token }));
        const legacy = await api<{ sha: string }>("POST", `${R}/git/blobs`, {
          content: JSON.stringify({ issue_number: issueNumber, version: 3, phase: "spec", status: "active", active_branch: "", last_processed_comment_id: 7, code_fix_attempts_used: 0, transient_retries_used: 0, updated_at: new Date().toISOString() }, null, 2),
          encoding: "utf-8"
        });
        expect((await api("POST", `${R}/git/refs`, { ref, sha: legacy.data.sha })).status).toBe(201);
        expect((await store.readRef(`refs/epure/state/${issueNumber}`)).state?.phase).toBe("spec");

        await updateIssueStateWithCas({ issueNumber, store, mutator: (prev) => ({ ...prev, phase: "tickets" }) });

        const after = await api<{ object: { type: string } }>("GET", `${R}/git/${ref.replace(/^refs\//, "ref/")}`);
        expect(after.data.object.type).toBe("commit");
        expect((await store.readRef(`refs/epure/state/${issueNumber}`)).state).toMatchObject({ phase: "tickets", version: 4, last_processed_comment_id: 7 });
      });
    });

    describe("pull request merge, already-merged and search after branch deletion", () => {
      let prNumber = 0;
      let headBranch = "";
      let headSha = "";
      let mergeSha = "";

      beforeAll(async () => {
        const base = await createBranch("merge-base", baseSha);
        headSha = await commitOnTop([baseSha], `${NS}/merge.txt`, "merge me");
        headBranch = await createBranch("merge-head", headSha);
        const pr = await api<{ number: number }>("POST", `${R}/pulls`, {
          title: `test(${NS}): merge`,
          head: headBranch,
          base
        });
        prNumber = pr.data.number;
      }, HOOK_TIMEOUT_MS);

      it("PUT pulls/:n/merge with a stale sha is 409, then with the head sha merges 200", async () => {
        const stale = await api<{ message: string }>("PUT", `${R}/pulls/${prNumber}/merge`, { sha: baseSha, merge_method: "squash" });
        const merged = await api<{ merged: boolean; message: string; sha: string }>("PUT", `${R}/pulls/${prNumber}/merge`, { sha: headSha, merge_method: "squash" });
        expect(stale.status).toBe(409);
        expect(stale.data.message).toBe("Head branch was modified. Review and try the merge again.");
        expect(merged.status).toBe(200);
        expect(merged.data).toMatchObject({ merged: true, message: "Pull Request successfully merged" });
        expect(merged.data.sha).toMatch(/^[0-9a-f]{40}$/);
        mergeSha = merged.data.sha;
      });

      it("a second merge of an already-merged PR returns 200 with the original merge sha", async () => {
        const again = await api<{ merged: boolean; message: string; sha: string }>("PUT", `${R}/pulls/${prNumber}/merge`, { sha: headSha, merge_method: "squash" });
        expect(again.status).toBe(200);
        expect(again.data).toEqual({ merged: true, message: "Pull Request successfully merged", sha: mergeSha });
      });

      it("rest client merge is idempotent on an already-merged PR", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        await expect(
          gh.mergePullRequest(prNumber, { headBranch, baseBranch: `${NS}/merge-base`, commitTitle: "again" })
        ).resolves.toBeUndefined();
      });

      it("PR search with state=all finds the merged PR after its head branch is deleted", async () => {
        expect((await api("DELETE", `${R}/git/refs/heads/${headBranch}`)).status).toBe(204);
        const owner = cfg.repository.split("/")[0]!;
        const all = await api<Array<{ number: number; merged_at: string | null }>>(
          "GET",
          `${R}/pulls?state=all&head=${encodeURIComponent(`${owner}:${headBranch}`)}`
        );
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        expect(all.data.map((p) => p.number)).toContain(prNumber);
        expect(all.data.find((p) => p.number === prNumber)?.merged_at).toBeTruthy();
        expect(await gh.findOpenPullRequestByHead(headBranch, `${NS}/merge-base`)).toBeNull();
      });

      it("duplicate guard finds the merged PR by head branch after the branch is deleted", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        expect(await gh.findMergedPullRequestByHead(headBranch, `${NS}/merge-base`)).toEqual({
          number: prNumber,
          html_url: expect.stringContaining(`/pull/${prNumber}`)
        });
      });
    });

    describe("epic closure reads on an open, unmerged PR", () => {
      let prNumber = 0;
      let base = "";
      let headBranch = "";

      beforeAll(async () => {
        base = await createBranch("closure-base", baseSha);
        headBranch = await createBranch("closure-head", await commitOnTop([baseSha], `${NS}/closure.txt`, "unmerged"));
        const pr = await api<{ number: number }>("POST", `${R}/pulls`, {
          title: `test(${NS}): closure`,
          head: headBranch,
          base
        });
        prNumber = pr.data.number;
      }, HOOK_TIMEOUT_MS);

      it("the open PR is listed by base, its commit counted as unmerged, and it is never reported as merged", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        expect(await gh.findMergedPullRequestByHead(headBranch, base)).toBeNull();
        expect((await gh.listOpenPullRequestsByBase(base)).map((pr) => pr.number)).toEqual([prNumber]);
        expect((await gh.compareCommits?.(base, headBranch))?.aheadBy).toBe(1);
      });
    });

    describe("git data API", () => {
      it("a two-parent merge commit fast-forwards the branch without force", async () => {
        const left = await commitOnTop([baseSha], `${NS}/left.txt`, "left");
        const right = await commitOnTop([baseSha], `${NS}/right.txt`, "right");
        const branch = await createBranch("two-parent", left);
        const leftCommit = await api<{ tree: { sha: string } }>("GET", `${R}/git/commits/${left}`);
        const merge = await api<{ sha: string; parents: unknown[] }>("POST", `${R}/git/commits`, {
          message: `test(${NS}): two-parent merge`,
          tree: leftCommit.data.tree.sha,
          parents: [left, right]
        });
        const update = await api("PATCH", `${R}/git/refs/heads/${branch}`, { sha: merge.data.sha, force: false });

        expect(merge.status).toBe(201);
        expect(merge.data.parents).toHaveLength(2);
        expect(update.status).toBe(200);
      });
    });

    describe("3-way conflict resolution makes a conflicting PR mergeable (#105)", () => {
      const FILE = `${NS}/conflict.txt`;
      let base = "";
      let target = "";
      let targetHead = "";
      let baseHead = "";
      let prNumber = 0;

      // GitHub recomputes mergeability asynchronously and keeps serving the previous value meanwhile.
      async function settledMergeable(expected: boolean): Promise<{ mergeable: boolean | null; mergeable_state: string }> {
        for (let attempt = 0; ; attempt += 1) {
          const pr = await api<{ mergeable: boolean | null; mergeable_state: string }>("GET", `${R}/pulls/${prNumber}`);
          if (pr.data.mergeable === expected || attempt >= 20) {
            return pr.data;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      beforeAll(async () => {
        const shared = await commitOnTop([baseSha], FILE, "shared\n");
        baseHead = await commitOnTop([shared], FILE, "base side\n");
        targetHead = await commitOnTop([shared], FILE, "target side\n");
        base = await createBranch("conflict-base", baseHead);
        target = await createBranch("conflict-target", targetHead);
        const pr = await api<{ number: number }>("POST", `${R}/pulls`, { title: `test(${NS}): conflict`, head: target, base });
        prNumber = pr.data.number;
      }, HOOK_TIMEOUT_MS);

      it("a conflicting PR is dirty and its merge is refused with PullRequestNotMergeableError", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        expect(await settledMergeable(false)).toMatchObject({ mergeable: false, mergeable_state: "dirty" });
        expect(await gh.getPullRequestMergeableState?.(prNumber)).toBe("dirty");
        await expect(
          gh.mergePullRequest(prNumber, { headBranch: target, baseBranch: base, commitTitle: "refused" })
        ).rejects.toBeInstanceOf(PullRequestNotMergeableError);
      });

      it("the resolution is a two-parent merge commit and the PR becomes mergeable", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        const llmFetch: typeof fetch = async (input, init) =>
          new URL(String(input)).hostname === "api.openai.com"
            ? new Response(
                JSON.stringify({
                  choices: [{ message: { content: JSON.stringify({ summary: "both", resolved_files: [{ path: FILE, content: "both sides\n" }] }) } }]
                }),
                { status: 200 }
              )
            : await fetch(input, init);

        const result = await syncBranchWithBase({
          gh,
          targetBranch: target,
          baseBranch: base,
          issueNumber: 1,
          llmApiKey: "unused",
          model: "openai/gpt-test",
          fetchImpl: llmFetch
        });
        const commit = await api<{ parents: Array<{ sha: string }> }>("GET", `${R}/git/commits/${result.headSha}`);

        expect(result).toMatchObject({ status: "resolved", conflictsResolved: [FILE] });
        expect(commit.data.parents.map((p) => p.sha)).toEqual([targetHead, baseHead]);
        expect(await settledMergeable(true)).toMatchObject({ mergeable: true });
        expect((await gh.mergeBranches?.({ base: target, head: base }))?.status).toBe("up_to_date");
      });
    });

    describe("rate limit headers", () => {
      it("every response carries numeric x-ratelimit-* headers", async () => {
        const res = await api("GET", R);
        for (const name of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-used", "x-ratelimit-reset"]) {
          expect(res.headers.get(name)).toMatch(/^\d+$/);
        }
        expect(res.headers.get("x-ratelimit-resource")).toBe("core");
      });

      it.each([
        { id: "200-repository-read", path: R, expectedStatus: 200 },
        { id: "403-permission-denied-is-not-a-rate-limit", path: `${R}/actions/secrets`, expectedStatus: 403 }
      ])("rate-limited fetch passes a real $id response through without waiting", async ({ path, expectedStatus }) => {
        const waits: number[] = [];
        const githubFetch = createGitHubRateLimitedFetch({
          fetchImpl: fetch,
          sleepFn: async (ms) => {
            waits.push(ms);
          }
        });
        const resp = await githubFetch(`https://api.github.com${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
        });
        expect(resp.status).toBe(expectedStatus);
        expect(waits).toEqual([]);
      });
    });
  }
);
