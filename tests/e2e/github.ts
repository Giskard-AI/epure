import { createGitHubRateLimitedFetch, GitHubRateLimitError } from "../../src/orchestrator/github/rate-limit.js";

export interface GitHubApi {
  readonly repository: string;
  call<T>(method: string, path: string, body?: unknown, okStatuses?: readonly number[]): Promise<T>;
  status(method: string, path: string, body?: unknown): Promise<number>;
  paginate<T>(path: string, pick?: (page: unknown) => readonly T[]): Promise<T[]>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  // Follows one redirect without the token: job logs live behind a signed storage URL.
  text(path: string): Promise<string>;
  // null for tokens without OAuth scopes (fine-grained PATs, App tokens).
  oauthScopes(): Promise<string[] | null>;
}

export interface GitHubApiOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

// Creating an issue or a comment twice would change the scripted epic.
const isReplayable = (method: string, path: string) =>
  !(method === "POST" && /\/issues(\/\d+\/comments)?$/.test(path));

function errorDetail(raw: string): string {
  try {
    return (JSON.parse(raw) as { message?: string }).message ?? "";
  } catch {
    return raw.replace(/\s+/g, " ").slice(0, 200);
  }
}

export function createGitHubApi(token: string, repository: string, options: GitHubApiOptions = {}): GitHubApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const url = (path: string) => (path.startsWith("https://") ? path : `https://api.github.com${path}`);

  // A redirect (a renamed or transferred repository) surfaces as its 3xx status instead of being followed.
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    for (let attempt = 1; ; attempt += 1) {
      // A fresh wrapper per request: one shared wait budget would run out during an hours-long run.
      const rateLimited = createGitHubRateLimitedFetch({ fetchImpl, sleepFn: sleep });
      let resp: Response | null = null;
      let failure: unknown = null;
      try {
        resp = await rateLimited(url(path), {
          method,
          headers,
          redirect: "manual",
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          throw err;
        }
        failure = err;
      }
      const transient = resp === null || TRANSIENT_STATUSES.has(resp.status);
      if (!transient || attempt >= MAX_ATTEMPTS || !isReplayable(method, path)) {
        if (resp) {
          return resp;
        }
        throw new Error(`${method} ${path}: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      await resp?.body?.cancel();
      await sleep(1_000 * 2 ** attempt);
    }
  };

  const api: GitHubApi = {
    repository,
    async call<T>(method: string, path: string, body?: unknown, okStatuses: readonly number[] = [200, 201, 204]): Promise<T> {
      const resp = await send(method, path, body);
      const raw = await resp.text();
      if (!okStatuses.includes(resp.status)) {
        throw new Error(`${method} ${path}: HTTP ${resp.status} ${raw ? errorDetail(raw) : ""}`.trim());
      }
      return (raw ? JSON.parse(raw) : null) as T;
    },
    async status(method: string, path: string, body?: unknown): Promise<number> {
      const resp = await send(method, path, body);
      await resp.body?.cancel();
      return resp.status;
    },
    async paginate<T>(path: string, pick: (page: unknown) => readonly T[] = (page) => page as T[]): Promise<T[]> {
      const items: T[] = [];
      const separator = path.includes("?") ? "&" : "?";
      for (let page = 1; ; page += 1) {
        const batch = pick(await api.call<unknown>("GET", `${path}${separator}per_page=100&page=${page}`));
        items.push(...batch);
        if (batch.length < 100) {
          return items;
        }
      }
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const res = await api.call<{ data?: T; errors?: Array<{ message: string }> }>("POST", "/graphql", { query, variables });
      if (res.errors?.length) {
        throw new Error(`GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
      }
      return res.data as T;
    },
    async text(path: string): Promise<string> {
      let resp = await send("GET", path);
      const location = resp.headers.get("location");
      if (resp.status === 302 && location) {
        await resp.body?.cancel();
        resp = await fetchImpl(location, { redirect: "error" });
      }
      if (!resp.ok) {
        throw new Error(`GET ${path}: HTTP ${resp.status}`);
      }
      return await resp.text();
    },
    async oauthScopes(): Promise<string[] | null> {
      const resp = await send("GET", "/rate_limit");
      await resp.body?.cancel();
      const header = resp.headers.get("x-oauth-scopes");
      return header === null ? null : header.split(",").map((s) => s.trim()).filter(Boolean);
    }
  };
  return api;
}
