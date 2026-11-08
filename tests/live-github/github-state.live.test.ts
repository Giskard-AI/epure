import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  mintRepositoryInstallationToken,
  revokeGitHubInstallationToken
} from "../../src/auth/github-app-jwt.js";
import {
  buildGitHubRulesetApiPayload,
  buildGovernanceRulesets,
  GITHUB_ACTIONS_INTEGRATION_ID,
  planGitHubRulesetChanges,
  type RepositoryRulesetSpec
} from "../../src/bootstrap/setup-repo.js";
import { syncBranchWithBase } from "../../src/orchestrator/github/branch-sync.js";
import { createGitHubRateLimitedFetch } from "../../src/orchestrator/github/rate-limit.js";
import {
  createGitHubRestHelper,
  PullRequestHeadMovedError,
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
const NAMESPACE_IN_REF = /^refs\/(?:heads|tags|epure\/state)\/(live\/([0-9a-z]+)-[0-9a-f]{6})\//;

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

    async function api<T>(method: string, path: string, body?: unknown, auth: string = token): Promise<ApiResult<T>> {
      const resp = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${auth}`,
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

    async function commitOnTop(parents: readonly string[], path: string, content: string, auth: string = token): Promise<string> {
      const parent = await api<{ tree: { sha: string } }>("GET", `${R}/git/commits/${parents[0]}`, undefined, auth);
      const blob = await api<{ sha: string }>("POST", `${R}/git/blobs`, { content, encoding: "utf-8" }, auth);
      const tree = await api<{ sha: string }>("POST", `${R}/git/trees`, {
        base_tree: parent.data.tree.sha,
        tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }]
      }, auth);
      const commit = await api<{ sha: string }>("POST", `${R}/git/commits`, {
        message: `test(${NS}): ${path}`,
        tree: tree.data.sha,
        parents
      }, auth);
      return commit.data.sha;
    }

    async function createBranch(name: string, sha: string, auth: string = token): Promise<string> {
      const ref = `refs/heads/${NS}/${name}`;
      const res = await api("POST", `${R}/git/refs`, { ref, sha }, auth);
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
        for (const prefix of [`heads/${ns}/`, `tags/${ns}/`, `epure/state/${ns}/`]) {
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
      for (const prefix of ["heads/live/", "tags/live/", "epure/state/live/"]) {
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

      it("rest client merge pinned to a stale sha throws PullRequestHeadMovedError and does not merge", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        await expect(
          gh.mergePullRequest(prNumber, { headBranch, baseBranch: `${NS}/merge-base`, expectedHeadSha: baseSha, commitTitle: "stale" })
        ).rejects.toBeInstanceOf(PullRequestHeadMovedError);
        expect(await gh.findMergedPullRequestByHead(headBranch, `${NS}/merge-base`)).toBeNull();
      });

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
          gh.mergePullRequest(prNumber, { headBranch, baseBranch: `${NS}/merge-base`, expectedHeadSha: headSha, commitTitle: "again" })
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
        expect((await gh.compareCommits(base, headBranch)).aheadBy).toBe(1);
      });

      it("a closer without repository access reads as permission none with the App token", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        expect(await gh.getCollaboratorPermission("octocat")).toBe("none");
      });
    });

    describe("roster and workflow reads list only their own directory (contents API)", () => {
      const DIR = `${NS}/reviewers`;
      let branch = "";

      beforeAll(async () => {
        let head = await commitOnTop([baseSha], `${DIR}/security-reviewer.md`, "# security\n");
        head = await commitOnTop([head], `${DIR}/notes.txt`, "not a reviewer\n");
        head = await commitOnTop([head], `${DIR}/nested/deep-reviewer.md`, "# nested\n");
        branch = await createBranch("scoped-reads", head);
      }, HOOK_TIMEOUT_MS);

      it.each([
        { id: "reviewer-directory-yields-only-its-direct-markdown-children", dir: DIR, expected: { [`${DIR}/security-reviewer.md`]: "# security\n" } },
        { id: "missing-reviewer-directory-yields-no-roster-file", dir: `${NS}/missing`, expected: {} }
      ])("$id", async ({ dir, expected }) => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });

        const roster = await gh.readTrustedBaseRosterFiles(branch, dir);
        roster.delete("DESIGN.md");

        expect(Object.fromEntries(roster)).toEqual(expected);
      });

      it("workflow map holds only top-level workflow files and path hints include the committed files", async () => {
        const gh = createGitHubRestHelper({ repository: cfg.repository, token });

        const workflows = [...(await gh.readDevWorkflowsMap(branch)).keys()];
        const hints = await gh.listBranchPathHints(branch);

        expect(workflows.filter((p) => !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))).toEqual([]);
        expect(hints).toEqual(expect.arrayContaining([`${DIR}/security-reviewer.md`, `${DIR}/notes.txt`, `${DIR}/nested/deep-reviewer.md`]));
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

    describe("commitFilesToBranch on a branch moved by a concurrent push (#109)", () => {
      function fetchWithConcurrentPushBeforeRefUpdate(branch: string, push: () => Promise<string>): typeof fetch {
        let armed = true;
        return async (input, init) => {
          if (armed && init?.method === "PATCH" && String(input).endsWith(`/git/refs/heads/${encodeURIComponent(branch)}`)) {
            armed = false;
            await push();
          }
          return await fetch(input, init);
        };
      }

      async function writeDuringConcurrentPush(slug: string, concurrentFile: string) {
        const branch = await createBranch(`concurrent-${slug}`, baseSha);
        const epurePath = `${NS}/${slug}/epure.txt`;
        const humanPath = `${NS}/${slug}/${concurrentFile}`;
        let humanSha = "";
        const gh = createGitHubRestHelper({
          repository: cfg.repository,
          token,
          fetchImpl: fetchWithConcurrentPushBeforeRefUpdate(branch, async () => {
            humanSha = await commitOnTop([baseSha], humanPath, "human push\n");
            expect((await api("PATCH", `${R}/git/refs/heads/${branch}`, { sha: humanSha, force: false })).status).toBe(200);
            return humanSha;
          })
        });
        const commit = gh.commitFilesToBranch({
          branch,
          commitMessage: `test(${NS}): epure write`,
          files: [{ path: epurePath, content: "epure write\n" }]
        });
        return { branch, epurePath, humanPath, commit, humanSha: () => humanSha };
      }

      it("disjoint-concurrent-push-is-kept-and-the-commit-is-rebuilt-on-it", async () => {
        const { epurePath, humanPath, commit, humanSha } = await writeDuringConcurrentPush("disjoint", "other.txt");

        const headSha = await commit;
        const head = await api<{ parents: Array<{ sha: string }> }>("GET", `${R}/git/commits/${headSha}`);
        const tree = await api<{ tree: Array<{ path: string }> }>("GET", `${R}/git/trees/${headSha}?recursive=1`);

        expect(head.data.parents.map((p) => p.sha)).toEqual([humanSha()]);
        expect(tree.data.tree.map((e) => e.path)).toEqual(expect.arrayContaining([epurePath, humanPath]));
      });

      it("concurrent-push-on-a-written-path-throws-BranchUpdateConflictError-without-overwriting-it", async () => {
        const { branch, epurePath, commit, humanSha } = await writeDuringConcurrentPush("overlap", "epure.txt");

        await expect(commit).rejects.toMatchObject({ name: "BranchUpdateConflictError", overlappingPaths: [epurePath] });
        const head = await api<{ object: { sha: string } }>("GET", `${R}/git/ref/heads/${branch}`);

        expect(head.data.object.sha).toBe(humanSha());
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
        expect(await gh.getPullRequestMergeableState(prNumber)).toBe("dirty");
        await expect(
          gh.mergePullRequest(prNumber, { headBranch: target, baseBranch: base, expectedHeadSha: targetHead, commitTitle: "refused" })
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

    // Committing a workflow file needs `workflows: write`, reading runs `actions: read`; the sandbox App may not have them yet.
    describe("3-way conflict resolution triggers the PR checks on the new head (#105e)", () => {
      const FILE = `${NS}/conflict-checks.txt`;
      const WORKFLOW_PATH = `.github/workflows/live-${RUN_ID}.yml`;
      const RUN_TIMEOUT_MS = 120_000;
      let checksToken = "";
      let missingPermission = "";

      beforeAll(async () => {
        try {
          checksToken = (
            await mintRepositoryInstallationToken({
              appId: cfg.appId,
              privateKeyPem: cfg.privateKey,
              repository: cfg.repository,
              permissions: { contents: "write", pull_requests: "write", workflows: "write", actions: "read" }
            })
          ).token;
        } catch (err: unknown) {
          if (!(err instanceof Error && /HTTP 422/.test(err.message))) {
            throw err;
          }
          missingPermission = "the sandbox App lacks workflows: write or actions: read; grant them and rerun";
        }
      }, HOOK_TIMEOUT_MS);

      afterAll(async () => {
        if (checksToken) {
          await revokeGitHubInstallationToken({ token: checksToken });
        }
      }, HOOK_TIMEOUT_MS);

      it("a pull_request workflow run registers on the two-parent resolution head", { timeout: RUN_TIMEOUT_MS + 60_000 }, async (ctx) => {
        if (missingPermission) {
          ctx.skip(missingPermission);
        }
        // `if: false` registers the run without spending runner minutes.
        const workflow = [
          `name: live-${RUN_ID}`,
          "on:",
          "  pull_request:",
          `    branches: ["${NS}/**"]`,
          "jobs:",
          "  noop:",
          "    if: false",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: true",
          ""
        ].join("\n");
        const withWorkflow = await commitOnTop([baseSha], WORKFLOW_PATH, workflow, checksToken);
        const shared = await commitOnTop([withWorkflow], FILE, "shared\n", checksToken);
        const baseHead = await commitOnTop([shared], FILE, "base side\n", checksToken);
        const targetHead = await commitOnTop([shared], FILE, "target side\n", checksToken);
        const base = await createBranch("checks-base", baseHead, checksToken);
        const target = await createBranch("checks-target", targetHead, checksToken);
        const pr = await api<{ number: number }>("POST", `${R}/pulls`, { title: `test(${NS}): checks`, head: target, base }, checksToken);
        expect(pr.status).toBe(201);

        const gh = createGitHubRestHelper({ repository: cfg.repository, token: checksToken });
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
        expect(result).toMatchObject({ status: "resolved", conflictsResolved: [FILE] });

        type Run = { event: string; head_sha: string; path: string };
        let runs: Run[] = [];
        for (const deadline = Date.now() + RUN_TIMEOUT_MS; runs.length === 0 && Date.now() < deadline; ) {
          await new Promise((r) => setTimeout(r, 5000));
          const listed = await api<{ workflow_runs: Run[] }>(
            "GET",
            `${R}/actions/runs?event=pull_request&head_sha=${result.headSha}`,
            undefined,
            checksToken
          );
          runs = listed.data.workflow_runs.filter((run) => run.path === WORKFLOW_PATH);
        }

        expect(runs).toContainEqual(expect.objectContaining({ event: "pull_request", head_sha: result.headSha }));
      });
    });

    // The sandbox App has no `administration` permission: an admin token only creates and deletes rulesets scoped to this run.
    const ADMIN_TOKEN = process.env.EPURE_LIVE_GITHUB_ADMIN_TOKEN?.trim() ?? "";

    async function adminApi<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
      return await api<T>(method, path, body, ADMIN_TOKEN);
    }

    function scopeToRun(spec: RepositoryRulesetSpec, slug: string): RepositoryRulesetSpec {
      return {
        ...spec,
        name: `${spec.name}-${RUN_ID}-${slug}`,
        targetRefs: spec.targetRefs.map((ref) => ref.replace(/^refs\/(heads|tags)\//, `refs/$1/${NS}/`))
      };
    }

    (ADMIN_TOKEN ? describe : describe.skip)("setup-repo generated rulesets on GitHub", () => {
      const rulesetIds: number[] = [];
      const generated = buildGovernanceRulesets({ agentAppName: "agent", releaseAppName: "release" });

      async function createRuleset(spec: RepositoryRulesetSpec, appIds: { releaseAppIntegrationId?: number }): Promise<ApiResult<{ id: number; target: string }>> {
        const created = await adminApi<{ id: number; target: string }>("POST", `${R}/rulesets`, buildGitHubRulesetApiPayload(spec, appIds));
        if (created.status === 201) {
          rulesetIds.push(created.data.id);
        }
        return created;
      }

      afterEach(async () => {
        for (const id of rulesetIds.splice(0)) {
          await adminApi("DELETE", `${R}/rulesets/${id}`);
        }
      });

      it("every-generated-ruleset-is-accepted-with-its-target-and-a-rerun-changes-nothing", async () => {
        const appIds = { agentAppIntegrationId: Number(cfg.appId), releaseAppIntegrationId: Number(cfg.appId) };
        const specs = generated.all.map((spec) => scopeToRun(spec, "all"));

        for (const spec of specs) {
          const created = await createRuleset(spec, appIds);
          expect({ name: spec.name, status: created.status, target: created.data.target }).toEqual({
            name: spec.name,
            status: 201,
            target: spec.target
          });
        }
        const plan = await planGitHubRulesetChanges({ repository: cfg.repository, githubToken: ADMIN_TOKEN, governanceRulesets: specs, ...appIds });
        const reapplied = await Promise.all(
          specs.map(async (spec, i) => (await adminApi("PUT", `${R}/rulesets/${rulesetIds[i]}`, buildGitHubRulesetApiPayload(spec, appIds))).status)
        );

        expect(plan.map((p) => p.action)).toEqual(specs.map(() => "noop"));
        expect(reapplied).toEqual(specs.map(() => 200));
      });

      it("previous-dev-ruleset-without-required-checks-is-updated-in-place-and-a-rerun-changes-nothing", async () => {
        const spec = scopeToRun(generated.devGovernance, "checks-upgrade");
        const plan = async () => (await planGitHubRulesetChanges({ repository: cfg.repository, githubToken: ADMIN_TOKEN, governanceRulesets: [spec] }))[0]?.action;
        const created = await createRuleset({ ...spec, requiredStatusChecks: undefined }, {});
        expect(created.status).toBe(201);

        const before = await plan();
        const updated = await adminApi("PUT", `${R}/rulesets/${created.data.id}`, buildGitHubRulesetApiPayload(spec, {}));
        const after = await plan();
        const stored = await adminApi<{ rules: Array<{ type: string; parameters?: Record<string, unknown> }> }>("GET", `${R}/rulesets/${created.data.id}`);

        expect({ before, updated: updated.status, after }).toEqual({ before: "update", updated: 200, after: "noop" });
        expect(stored.data.rules.find((r) => r.type === "required_status_checks")?.parameters).toMatchObject({
          strict_required_status_checks_policy: false,
          required_status_checks: (spec.requiredStatusChecks ?? []).map((context) => ({ context, integration_id: GITHUB_ACTIONS_INTEGRATION_ID }))
        });
      });

      it("previous-main-and-v-tags-branch-ruleset-is-rejected-with-422", async () => {
        const previous = scopeToRun({ ...generated.releaseImmutability, targetRefs: ["refs/heads/main", "refs/tags/v*"] }, "previous");

        const created = await createRuleset(previous, { releaseAppIntegrationId: Number(cfg.appId) });

        expect(created.status).toBe(422);
      });

      it.each([
        { id: "tag-ruleset-refuses-creating-moving-and-deleting-a-v-tag-without-bypass", bypass: false, expected: { create: 422, move: 422, remove: 422 } },
        { id: "tag-ruleset-lets-the-release-app-bypass-create-move-and-delete-a-v-tag", bypass: true, expected: { create: 201, move: 200, remove: 204 } }
      ])("$id", async ({ bypass, expected }) => {
        const slug = bypass ? "tags-bypass" : "tags-locked";
        const tagSpec = scopeToRun(generated.releaseTags, slug);
        const tagPrefix = `refs/tags/${NS}/${slug}`;
        const spec = { ...tagSpec, targetRefs: [`${tagPrefix}/v*`] };
        const moved = await commitOnTop([baseSha], `${NS}/${slug}.txt`, "tag target\n");
        const existing = await api("POST", `${R}/git/refs`, { ref: `${tagPrefix}/v1.0.0`, sha: baseSha });
        expect(existing.status).toBe(201);
        expect((await createRuleset(spec, bypass ? { releaseAppIntegrationId: Number(cfg.appId) } : {})).status).toBe(201);

        const create = await api("POST", `${R}/git/refs`, { ref: `${tagPrefix}/v1.1.0`, sha: baseSha });
        const move = await api("PATCH", `${R}/git/${tagPrefix}/v1.0.0`, { sha: moved, force: true });
        const remove = await api("DELETE", `${R}/git/${tagPrefix}/v1.0.0`);

        expect({ create: create.status, move: move.status, remove: remove.status }).toEqual(expected);
      });

      // Replays the push of release-promote.yml: annotated tag, then one `git push --atomic` of main and the tag,
      // the token passed to git through the process environment only.
      function atomicReleasePush(auth: string, sha: string, mainRef: string, tagRef: string): boolean {
        const dir = mkdtempSync(join(tmpdir(), "epure-live-release-"));
        const basicAuth = Buffer.from(`x-access-token:${auth}`).toString("base64");
        const env = {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`,
          GIT_COMMITTER_NAME: "epure-live",
          GIT_COMMITTER_EMAIL: "epure-live@users.noreply.github.com"
        };
        const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
        const remote = `https://github.com/${cfg.repository}.git`;
        try {
          git("init", "-q");
          // Depth 2 brings the current main (the parent): without it git refuses the fast-forward client-side.
          git("fetch", "-q", "--depth=2", remote, sha);
          git("tag", "-a", tagRef.replace("refs/tags/", ""), sha, "-m", `test(${NS}): release`);
          try {
            git("push", "-q", "--atomic", remote, `${sha}:${mainRef}`, `${tagRef}:${tagRef}`);
            return true;
          } catch (error) {
            console.warn(`[live-github] atomic release push refused: ${String((error as { stderr?: Buffer }).stderr ?? "").trim()}`);
            return false;
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      // The sandbox App plays both roles: a writer that is not a bypass actor, and the bypassing Release App.
      it.each([
        {
          id: "previous-main-ruleset-without-update-rule-lets-a-non-bypass-writer-merge-a-pr-into-main",
          blockUpdates: false,
          bypass: false,
          via: "pr-merge",
          expected: { accepted: true, mainMoved: true, tagCreated: false }
        },
        {
          id: "main-ruleset-refuses-a-pr-merge-into-main-by-a-non-bypass-writer",
          blockUpdates: true,
          bypass: false,
          via: "pr-merge",
          expected: { accepted: false, mainMoved: false, tagCreated: false }
        },
        {
          id: "main-and-tag-rulesets-refuse-the-atomic-release-push-of-a-non-bypass-writer-and-move-neither-ref",
          blockUpdates: true,
          bypass: false,
          via: "atomic-push",
          expected: { accepted: false, mainMoved: false, tagCreated: false }
        },
        {
          id: "release-app-bypass-fast-forwards-main-and-pushes-the-v-tag-in-one-atomic-push",
          blockUpdates: true,
          bypass: true,
          via: "atomic-push",
          expected: { accepted: true, mainMoved: true, tagCreated: true }
        }
      ] as const)("$id", async ({ blockUpdates, bypass, via, expected }) => {
        const slug = `main-${blockUpdates ? "locked" : "open"}-${bypass ? "bypass" : "writer"}-${via}`;
        const main = await createBranch(`${slug}/main`, baseSha);
        const next = await commitOnTop([baseSha], `${NS}/${slug}.txt`, "release candidate\n");
        const dev = await createBranch(`${slug}/dev`, next);
        const mainRef = `refs/heads/${main}`;
        const tagRef = `refs/tags/${NS}/${slug}/v1.0.0`;
        const releaseApp = bypass ? { releaseAppIntegrationId: Number(cfg.appId) } : {};
        const immutability = { ...scopeToRun(generated.releaseImmutability, slug), targetRefs: [mainRef], blockUpdates };
        const tags = { ...scopeToRun(generated.releaseTags, slug), targetRefs: [`refs/tags/${NS}/${slug}/v*`] };
        expect((await createRuleset(tags, releaseApp)).status).toBe(201);
        expect((await createRuleset(immutability, releaseApp)).status).toBe(201);

        let accepted: boolean;
        if (via === "pr-merge") {
          const pr = await api<{ number: number }>("POST", `${R}/pulls`, { title: `test(${NS}): promote`, head: dev, base: main });
          expect(pr.status).toBe(201);
          accepted = (await api("PUT", `${R}/pulls/${pr.data.number}/merge`, { merge_method: "squash" })).status === 200;
        } else {
          accepted = atomicReleasePush(token, next, mainRef, tagRef);
        }
        const mainSha = (await api<{ object: { sha: string } }>("GET", `${R}/git/${mainRef}`)).data.object.sha;
        const tag = await api("GET", `${R}/git/${tagRef}`);

        expect({ accepted, mainMoved: mainSha !== baseSha, tagCreated: tag.status === 200 }).toEqual(expected);
      });
    });

    (ADMIN_TOKEN ? describe : describe.skip)("setup-repo feature/* rulesets vs EPURE direct writes (#108)", () => {
      const rulesetIds: number[] = [];

      async function installFeatureRulesets(slug: string, legacy: boolean): Promise<void> {
        const generated = buildGovernanceRulesets({ agentAppName: "agent", releaseAppName: "release" });
        const specs = legacy
          ? [
              {
                ...generated.featureGovernance,
                blockForcePushes: true,
                blockDeletions: true,
                requiredLinearHistory: true,
                bypassActors: generated.featureGovernance.bypassActors.map((a) => ({ ...a, mode: "pull_request" as const }))
              }
            ]
          : [generated.featureIntegrity, generated.featureGovernance];
        for (const spec of specs) {
          const created = await adminApi<{ id: number }>(
            "POST",
            `${R}/rulesets`,
            buildGitHubRulesetApiPayload(
              { ...spec, name: `${spec.name}-${RUN_ID}-${slug}`, targetRefs: [`refs/heads/${NS}/feature/*`] },
              { agentAppIntegrationId: Number(cfg.appId) }
            )
          );
          expect(created.status).toBe(201);
          rulesetIds.push(created.data.id);
        }
      }

      afterEach(async () => {
        for (const id of rulesetIds.splice(0)) {
          await adminApi("DELETE", `${R}/rulesets/${id}`);
        }
      });

      it("integrity-ruleset-refuses-a-force-push-and-a-deletion-of-a-feature-branch-by-the-agent-app", async () => {
        const feature = await createBranch("feature/integrity", await commitOnTop([baseSha], `${NS}/integrity.txt`, "feature work\n"));
        await installFeatureRulesets("integrity", false);

        const forcePush = await api("PATCH", `${R}/git/refs/heads/${feature}`, { sha: baseSha, force: true });
        const deletion = await api("DELETE", `${R}/git/refs/heads/${feature}`);

        expect(forcePush.status).toBe(422);
        expect(deletion.status).toBe(422);
        expect((await api("GET", `${R}/git/ref/heads/${feature}`)).status).toBe(200);
      });

      it.each([
        { id: "generated-rulesets-let-plan-integration-and-a-dev-merge-sync-through", legacy: false },
        { id: "previous-pull-request-bypass-ruleset-rejects-the-plan-integration-with-422", legacy: true }
      ])("$id", async ({ legacy }) => {
        const slug = legacy ? "legacy" : "generated";
        const feature = await createBranch(`feature/${slug}`, baseSha);
        const dev = await createBranch(`dev-${slug}`, await commitOnTop([baseSha], `${NS}/${slug}-dev.txt`, "dev moved\n"));
        await installFeatureRulesets(slug, legacy);

        const gh = createGitHubRestHelper({ repository: cfg.repository, token });
        const planIntegration = gh.commitFilesToBranch({
          branch: feature,
          commitMessage: "docs(plan): integrate approved plan artifacts",
          files: [{ path: `${NS}/${slug}-spec.md`, content: "# Spec\n" }]
        });
        if (legacy) {
          await expect(planIntegration).rejects.toThrow(/422/);
          return;
        }
        await planIntegration;
        const sync = await syncBranchWithBase({
          gh,
          targetBranch: feature,
          baseBranch: dev,
          issueNumber: 1,
          llmApiKey: "unused",
          model: "openai/gpt-test"
        });
        const merge = await api<{ parents: unknown[] }>("GET", `${R}/git/commits/${sync.headSha}`);

        expect(sync.status).toBe("merged");
        expect(merge.data.parents).toHaveLength(2);
      });
    });

    // Merging a PR that adds a workflow needs `workflows: write`, waiting for its run `actions: read`.
    (ADMIN_TOKEN ? describe : describe.skip)("required CI checks on the generated dev and feature rulesets (#123)", () => {
      const CHECK = "live-ci";
      const RUN_TIMEOUT_MS = 240_000;
      const rulesetIds: number[] = [];
      let checksToken = "";
      let missingPermission = "";

      beforeAll(async () => {
        try {
          checksToken = (
            await mintRepositoryInstallationToken({
              appId: cfg.appId,
              privateKeyPem: cfg.privateKey,
              repository: cfg.repository,
              permissions: { contents: "write", pull_requests: "write", workflows: "write", actions: "read" }
            })
          ).token;
        } catch (err: unknown) {
          if (!(err instanceof Error && /HTTP 422/.test(err.message))) {
            throw err;
          }
          missingPermission = "the sandbox App lacks workflows: write or actions: read; grant them and rerun";
        }
      }, HOOK_TIMEOUT_MS);

      afterEach(async () => {
        for (const id of rulesetIds.splice(0)) {
          await adminApi("DELETE", `${R}/rulesets/${id}`);
        }
      });

      afterAll(async () => {
        if (checksToken) {
          await revokeGitHubInstallationToken({ token: checksToken });
        }
      }, HOOK_TIMEOUT_MS);

      it("feature-rulesets-let-a-non-bypass-actor-create-a-feature-branch-on-a-commit-without-the-required-checks", async () => {
        const generated = buildGovernanceRulesets({ agentAppName: "agent", releaseAppName: "release" });
        for (const spec of [generated.featureIntegrity, generated.featureGovernance]) {
          const created = await adminApi<{ id: number }>(
            "POST",
            `${R}/rulesets`,
            buildGitHubRulesetApiPayload({ ...spec, name: `${spec.name}-${RUN_ID}-create`, targetRefs: [`refs/heads/${NS}/create/feature/*`] }, {})
          );
          expect(created.status).toBe(201);
          rulesetIds.push(created.data.id);
        }

        const created = await api<{ message?: string }>("POST", `${R}/git/refs`, { ref: `refs/heads/${NS}/create/feature/1-new`, sha: baseSha });

        expect({ status: created.status, message: created.data?.message }).toEqual({ status: 201, message: undefined });
      });

      it.for([
        { id: "dev-ruleset-refuses-a-squash-merge-while-the-required-check-is-red", ruleset: "devGovernance" as const, ciPasses: false, expectedMerge: 405 },
        { id: "dev-ruleset-lets-a-squash-merge-through-once-the-required-check-is-green", ruleset: "devGovernance" as const, ciPasses: true, expectedMerge: 200 },
        { id: "feature-ruleset-lets-the-agent-app-merge-a-task-pr-with-green-ci", ruleset: "featureGovernance" as const, ciPasses: true, expectedMerge: 200 }
      ])("$id", { timeout: RUN_TIMEOUT_MS + 60_000 }, async ({ ruleset, ciPasses, expectedMerge }, ctx) => {
        if (missingPermission) {
          ctx.skip(missingPermission);
        }
        const slug = `${ruleset === "devGovernance" ? "dev" : "feature"}-${ciPasses ? "green" : "red"}`;
        const workflowPath = `.github/workflows/live-${RUN_ID}-${slug}.yml`;
        const workflow = [
          `name: live-${RUN_ID}-${slug}`,
          "on:",
          "  pull_request:",
          `    branches: ["${NS}/**"]`,
          "jobs:",
          "  ci:",
          `    name: ${CHECK}`,
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 5",
          "    steps:",
          `      - run: exit ${ciPasses ? 0 : 1}`,
          ""
        ].join("\n");
        const base = await createBranch(`ci-${slug}-base`, baseSha, checksToken);
        const headSha = await commitOnTop([baseSha], workflowPath, workflow, checksToken);
        const head = await createBranch(`ci-${slug}-head`, headSha, checksToken);
        const spec = buildGovernanceRulesets({ agentAppName: "agent", releaseAppName: "release" })[ruleset];
        const created = await adminApi<{ id: number }>(
          "POST",
          `${R}/rulesets`,
          buildGitHubRulesetApiPayload(
            { ...spec, name: `${spec.name}-${RUN_ID}-${slug}`, targetRefs: [`refs/heads/${base}`], requiredStatusChecks: [CHECK] },
            { agentAppIntegrationId: Number(cfg.appId) }
          )
        );
        expect(created.status).toBe(201);
        rulesetIds.push(created.data.id);
        const pr = await api<{ number: number }>("POST", `${R}/pulls`, { title: `test(${NS}): ${slug}`, head, base }, checksToken);
        expect(pr.status).toBe(201);

        type Run = { path: string; status: string; conclusion: string | null };
        let run: Run | undefined;
        for (const deadline = Date.now() + RUN_TIMEOUT_MS; run?.status !== "completed" && Date.now() < deadline; ) {
          await new Promise((r) => setTimeout(r, 5000));
          const listed = await api<{ workflow_runs: Run[] }>("GET", `${R}/actions/runs?event=pull_request&head_sha=${headSha}`, undefined, checksToken);
          run = listed.data.workflow_runs.find((r) => r.path === workflowPath);
        }
        const merge = await api<{ message?: string }>(
          "PUT",
          `${R}/pulls/${pr.data.number}/merge`,
          { merge_method: "squash", sha: headSha, commit_title: `test(${NS}): ${slug}` },
          checksToken
        );

        expect({ ci: run?.conclusion, merge: merge.status }).toEqual({ ci: ciPasses ? "success" : "failure", merge: expectedMerge });
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
