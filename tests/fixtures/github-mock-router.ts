import { createHash } from "node:crypto";

export interface RecordedRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly body: unknown;
}

export interface MockReply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export type RouteHandler = (
  request: RecordedRequest,
  match: RegExpExecArray | null
) => MockReply | Promise<MockReply>;

export type RouteStep = MockReply | RouteHandler;

// A string matches the pathname only, unless it contains "?" (then the full path must be equal).
// A RegExp is tested against the full path including the query string.
export type PathPattern = string | RegExp;

interface DeclaredRoute {
  readonly method: string;
  readonly host: string;
  readonly path: PathPattern;
  readonly steps: readonly RouteStep[];
  served: number;
}

export interface GitHubMockRouter {
  readonly fetch: typeof fetch;
  readonly requests: readonly RecordedRequest[];
  readonly unmatched: readonly RecordedRequest[];
  on(
    method: string,
    path: PathPattern,
    ...steps: readonly [RouteStep, ...RouteStep[]]
  ): GitHubMockRouter;
  onHost(
    host: string,
    method: string,
    path: PathPattern,
    ...steps: readonly [RouteStep, ...RouteStep[]]
  ): GitHubMockRouter;
  calls(method: string, path: PathPattern, host?: string): number;
}

const GITHUB_API_HOST = "api.github.com";
const DOCS_URL = "https://docs.github.com/rest";

function matchPath(
  pattern: PathPattern,
  path: string
): { matched: boolean; groups: RegExpExecArray | null } {
  if (typeof pattern === "string") {
    const pathname = path.split("?")[0] ?? path;
    return {
      matched: pattern.includes("?") ? pattern === path : pattern === pathname,
      groups: null
    };
  }
  const groups = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(
    path
  );
  return { matched: groups !== null, groups };
}

function parseBody(raw: RequestInit["body"]): unknown {
  if (typeof raw !== "string") {
    return raw ?? undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function toResponse(reply: MockReply): Response {
  const headers = new Headers(reply.headers);
  if (reply.status === 204 || reply.body === undefined) {
    return new Response(null, { status: reply.status, headers });
  }
  if (typeof reply.body === "string") {
    return new Response(reply.body, { status: reply.status, headers });
  }
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers
  });
}

export function createGitHubMockRouter(): GitHubMockRouter {
  const routes: DeclaredRoute[] = [];
  const requests: RecordedRequest[] = [];
  const unmatched: RecordedRequest[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      host: url.host,
      path: `${url.pathname}${url.search}`,
      body: parseBody(init?.body)
    };
    requests.push(request);

    // Last declaration wins so a test can override a route set up by a shared helper.
    for (const route of [...routes].reverse()) {
      if (route.method !== request.method || route.host !== request.host) {
        continue;
      }
      const { matched, groups } = matchPath(route.path, request.path);
      if (!matched) {
        continue;
      }
      const step =
        route.steps[Math.min(route.served, route.steps.length - 1)]!;
      route.served += 1;
      const reply =
        typeof step === "function" ? await step(request, groups) : step;
      return toResponse(reply);
    }

    unmatched.push(request);
    throw new Error(
      `Undeclared GitHub mock route: ${request.method} ${request.host}${request.path}`
    );
  };

  const router: GitHubMockRouter = {
    fetch: fetchImpl,
    requests,
    unmatched,
    on: (method, path, ...steps) =>
      router.onHost(GITHUB_API_HOST, method, path, ...steps),
    onHost: (host, method, path, ...steps) => {
      routes.push({ method: method.toUpperCase(), host, path, steps, served: 0 });
      return router;
    },
    calls: (method, path, host = GITHUB_API_HOST) =>
      requests.filter(
        (r) =>
          r.method === method.toUpperCase() &&
          r.host === host &&
          matchPath(path, r.path).matched
      ).length
  };
  return router;
}

export function json(body: unknown, status = 200): MockReply {
  return { status, body };
}

export function noContent(): MockReply {
  return { status: 204 };
}

export function notFound(): MockReply {
  return { status: 404, body: { message: "Not Found", documentation_url: DOCS_URL } };
}

export function unprocessable(message: string): MockReply {
  return { status: 422, body: { message, documentation_url: DOCS_URL } };
}

export function serverError(status = 502): MockReply {
  return { status, body: { message: "Server Error" } };
}

export function primaryRateLimit(resetEpochSeconds: number): MockReply {
  return {
    status: 403,
    body: {
      message: "API rate limit exceeded for installation ID 1.",
      documentation_url: `${DOCS_URL}/overview/rate-limits-for-the-rest-api`
    },
    headers: {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-used": "5000",
      "x-ratelimit-reset": String(resetEpochSeconds),
      "x-ratelimit-resource": "core"
    }
  };
}

export function secondaryRateLimit(retryAfterSeconds?: number): MockReply {
  return {
    status: 403,
    body: {
      message:
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      documentation_url: `${DOCS_URL}/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits`
    },
    headers: {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      ...(retryAfterSeconds !== undefined
        ? { "retry-after": String(retryAfterSeconds) }
        : {})
    }
  };
}

export function tooManyRequests(retryAfterSeconds: number): MockReply {
  return {
    status: 429,
    body: { message: "Too Many Requests" },
    headers: { "retry-after": String(retryAfterSeconds) }
  };
}

type GitObject =
  | { readonly type: "blob"; readonly content: string }
  | { readonly type: "tree" }
  | {
      readonly type: "commit";
      readonly tree: string;
      readonly parents: readonly string[];
      readonly message: string;
    };

export interface FakeGitDataApi {
  putBlob(content: string): string;
  putCommit(input: {
    readonly parents: readonly string[];
    readonly message?: string | undefined;
  }): string;
  setRef(ref: string, sha: string): void;
  getRef(ref: string): string | undefined;
  readBlob(sha: string): string | undefined;
  isAncestor(ancestorSha: string, descendantSha: string): boolean;
  onBeforeNextRefWrite(ref: string, hook: () => void): void;
}

function gitSha(type: string, payload: string): string {
  return createHash("sha1")
    .update(`${type} ${Buffer.byteLength(payload, "utf8")}\0${payload}`, "utf8")
    .digest("hex");
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Refs and blobs mirror what src/state/git-ref-state.ts calls; commits (all on the empty tree)
// exist only to build the graph that fast-forward checks walk.
export function installFakeGitDataApi(
  router: GitHubMockRouter,
  repository: string
): FakeGitDataApi {
  const objects = new Map<string, GitObject>();
  const refs = new Map<string, string>();
  const refWriteHooks = new Map<string, () => void>();
  const prefix = `/repos/${escapeRegExp(repository)}/git`;
  const emptyTreeSha = gitSha("tree", "");
  objects.set(emptyTreeSha, { type: "tree" });

  const isAncestor = (ancestorSha: string, descendantSha: string): boolean => {
    const pending = [descendantSha];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const sha = pending.pop()!;
      if (sha === ancestorSha) {
        return true;
      }
      const obj = objects.get(sha);
      if (seen.has(sha) || obj?.type !== "commit") {
        continue;
      }
      seen.add(sha);
      pending.push(...obj.parents);
    }
    return false;
  };

  const runRefWriteHook = (ref: string): void => {
    const hook = refWriteHooks.get(ref);
    if (hook) {
      refWriteHooks.delete(ref);
      hook();
    }
  };

  const refBody = (ref: string, sha: string) => ({
    ref,
    object: { sha, type: objects.get(sha)?.type ?? "commit" }
  });

  const api: FakeGitDataApi = {
    putBlob: (content) => {
      const sha = gitSha("blob", content);
      objects.set(sha, { type: "blob", content });
      return sha;
    },
    putCommit: ({ parents, message = "fake commit" }) => {
      const payload = [
        `tree ${emptyTreeSha}`,
        ...parents.map((p) => `parent ${p}`),
        "",
        message
      ].join("\n");
      const sha = gitSha("commit", payload);
      objects.set(sha, { type: "commit", tree: emptyTreeSha, parents, message });
      return sha;
    },
    setRef: (ref, sha) => {
      refs.set(ref, sha);
    },
    getRef: (ref) => refs.get(ref),
    readBlob: (sha) => {
      const obj = objects.get(sha);
      return obj?.type === "blob" ? obj.content : undefined;
    },
    isAncestor,
    onBeforeNextRefWrite: (ref, hook) => {
      refWriteHooks.set(ref, hook);
    }
  };

  router
    .on("GET", new RegExp(`^${prefix}/ref/(.+)$`), (_req, m) => {
      const ref = `refs/${decodeURIComponent(m![1]!)}`;
      const sha = refs.get(ref);
      return sha ? json(refBody(ref, sha)) : notFound();
    })
    .on("GET", new RegExp(`^${prefix}/matching-refs/(.*)$`), (_req, m) => {
      const refPrefix = `refs/${decodeURIComponent(m![1]!)}`;
      return json(
        [...refs.entries()]
          .filter(([ref]) => ref.startsWith(refPrefix))
          .map(([ref, sha]) => refBody(ref, sha))
      );
    })
    .on("POST", `/repos/${repository}/git/refs`, (req) => {
      const { ref, sha } = req.body as { ref?: string; sha?: string };
      if (!ref?.startsWith("refs/") || ref.split("/").length < 3) {
        return unprocessable(
          "Reference name must start with 'refs/' and have at least two slashes."
        );
      }
      runRefWriteHook(ref);
      if (!sha || !objects.has(sha)) {
        return unprocessable("Object does not exist");
      }
      if (refs.has(ref)) {
        return unprocessable("Reference already exists");
      }
      refs.set(ref, sha);
      return json(refBody(ref, sha), 201);
    })
    .on("PATCH", new RegExp(`^${prefix}/refs/(.+)$`), (req, m) => {
      const ref = `refs/${decodeURIComponent(m![1]!)}`;
      const { sha, force } = req.body as { sha?: string; force?: boolean };
      runRefWriteHook(ref);
      const current = refs.get(ref);
      if (!current) {
        return unprocessable("Reference does not exist");
      }
      if (!sha || !objects.has(sha)) {
        return unprocessable("Object does not exist");
      }
      if (force !== true && !isAncestor(current, sha)) {
        return unprocessable("Update is not a fast forward");
      }
      refs.set(ref, sha);
      return json(refBody(ref, sha));
    })
    .on("DELETE", new RegExp(`^${prefix}/refs/(.+)$`), (_req, m) => {
      const ref = `refs/${decodeURIComponent(m![1]!)}`;
      return refs.delete(ref) ? noContent() : unprocessable("Reference does not exist");
    })
    .on("POST", `/repos/${repository}/git/blobs`, (req) => {
      const { content, encoding } = req.body as {
        content?: string;
        encoding?: string;
      };
      const decoded =
        encoding === "base64"
          ? Buffer.from(content ?? "", "base64").toString("utf8")
          : (content ?? "");
      return json({ sha: api.putBlob(decoded) }, 201);
    })
    .on("GET", new RegExp(`^${prefix}/blobs/([0-9a-f]+)$`), (_req, m) => {
      const content = api.readBlob(m![1]!);
      return content === undefined
        ? notFound()
        : json({
            sha: m![1],
            size: Buffer.byteLength(content, "utf8"),
            encoding: "base64",
            content: Buffer.from(content, "utf8").toString("base64")
          });
    })
    .on("POST", `/repos/${repository}/git/commits`, (req) => {
      const { tree, parents, message } = req.body as {
        tree?: string;
        parents?: string[];
        message?: string;
      };
      const parentShas = parents ?? [];
      if (
        !tree ||
        objects.get(tree)?.type !== "tree" ||
        parentShas.some((p) => objects.get(p)?.type !== "commit")
      ) {
        return unprocessable("Tree SHA or parent SHA does not exist");
      }
      const payload = [
        `tree ${tree}`,
        ...parentShas.map((p) => `parent ${p}`),
        "",
        message ?? ""
      ].join("\n");
      const sha = gitSha("commit", payload);
      objects.set(sha, {
        type: "commit",
        tree,
        parents: parentShas,
        message: message ?? ""
      });
      return json(
        {
          sha,
          message,
          tree: { sha: tree },
          parents: parentShas.map((p) => ({ sha: p }))
        },
        201
      );
    })
    .on("GET", new RegExp(`^${prefix}/commits/([0-9a-f]+)$`), (_req, m) => {
      const obj = objects.get(m![1]!);
      return obj?.type === "commit"
        ? json({
            sha: m![1],
            message: obj.message,
            tree: { sha: obj.tree },
            parents: obj.parents.map((p) => ({ sha: p }))
          })
        : notFound();
    });

  return api;
}
