import { createGitHubRateLimitedFetch, GitHubRateLimitError } from "../../src/orchestrator/github/rate-limit.js";

export interface GitHubApi {
  readonly repository: string;
  call<T>(method: string, path: string, body?: unknown, okStatuses?: readonly number[]): Promise<T>;
  status(method: string, path: string, body?: unknown): Promise<number>;
  paginate<T>(path: string, pick?: (page: unknown) => readonly T[]): Promise<T[]>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  // Follows one redirect without the token: job logs live behind a signed storage URL. null on 404.
  text(path: string): Promise<string | null>;
  // null for tokens without OAuth scopes (fine-grained PATs, App tokens).
  oauthScopes(): Promise<string[] | null>;
  // The same timeouts and retries for code that takes a fetch, such as EPURE's state store.
  readonly fetch: typeof fetch;
}

export interface GitHubApiOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
// About one minute of backoff: long enough for a network that comes back after the host wakes up.
const MAX_ATTEMPTS = 6;
// A connection that died while the host slept must not hold the run until the OS gives up on it.
const REQUEST_TIMEOUT_MS = 60_000;
const CREATE_ATTEMPTS = 4;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Creating an issue or a comment twice would change the scripted epic.
const isReplayable = (method: string, path: string) =>
  !(method === "POST" && /\/issues(\/\d+\/comments)?$/.test(path));

// A creation whose response was lost: GitHub may or may not have created it.
export class GitHubOutcomeUnknownError extends Error {
  constructor(method: string, path: string, detail: string) {
    super(`${method} ${path}: ${detail} (outcome unknown, not replayed)`);
    this.name = "GitHubOutcomeUnknownError";
  }
}

// After a lost response, `landed` looks for the creation before it is posted again.
export async function createOnce<T>(
  create: () => Promise<T>,
  landed: () => Promise<T | null>,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await create();
    } catch (err) {
      if (!(err instanceof GitHubOutcomeUnknownError) || attempt >= CREATE_ATTEMPTS) {
        throw err;
      }
    }
    await sleep(5_000 * 2 ** attempt);
    const found = await landed();
    if (found !== null) {
      return found;
    }
  }
}

function errorDetail(raw: string): string {
  try {
    return (JSON.parse(raw) as { message?: string }).message ?? "";
  } catch {
    return raw.replace(/\s+/g, " ").slice(0, 200);
  }
}

export function createGitHubApi(token: string, repository: string, options: GitHubApiOptions = {}): GitHubApi {
  const baseFetch = options.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (input, init) => baseFetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const sleep = options.sleep ?? defaultSleep;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const url = (path: string) => (path.startsWith("https://") ? path : `https://api.github.com${path}`);

  // A redirect (a renamed or transferred repository) surfaces as its 3xx status instead of being followed.
  const send = async (method: string, path: string, init: RequestInit = {}): Promise<Response> => {
    for (let attempt = 1; ; attempt += 1) {
      // A fresh wrapper per request: one shared wait budget would run out during an hours-long run.
      const rateLimited = createGitHubRateLimitedFetch({ fetchImpl, sleepFn: sleep });
      let resp: Response | null = null;
      let failure: unknown = null;
      try {
        resp = await rateLimited(url(path), {
          ...init,
          method,
          headers: { ...(init.headers as Record<string, string> | undefined), ...headers },
          redirect: "manual"
        });
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          throw err;
        }
        failure = err;
      }
      if (resp !== null && !TRANSIENT_STATUSES.has(resp.status)) {
        return resp;
      }
      const detail = resp ? `HTTP ${resp.status}` : failure instanceof Error ? failure.message : String(failure);
      if (!isReplayable(method, path)) {
        await resp?.body?.cancel();
        throw new GitHubOutcomeUnknownError(method, path, detail);
      }
      if (attempt >= MAX_ATTEMPTS) {
        if (resp) {
          return resp;
        }
        throw new Error(`${method} ${path}: ${detail}`);
      }
      await resp?.body?.cancel();
      await sleep(1_000 * 2 ** attempt);
    }
  };

  const api: GitHubApi = {
    repository,
    async call<T>(method: string, path: string, body?: unknown, okStatuses: readonly number[] = [200, 201, 204]): Promise<T> {
      const resp = await send(method, path, body !== undefined ? { body: JSON.stringify(body) } : {});
      const raw = await resp.text();
      if (!okStatuses.includes(resp.status)) {
        throw new Error(`${method} ${path}: HTTP ${resp.status} ${raw ? errorDetail(raw) : ""}`.trim());
      }
      return (raw ? JSON.parse(raw) : null) as T;
    },
    async status(method: string, path: string, body?: unknown): Promise<number> {
      const resp = await send(method, path, body !== undefined ? { body: JSON.stringify(body) } : {});
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
    async text(path: string): Promise<string | null> {
      for (let attempt = 1; ; attempt += 1) {
        let resp: Response | null = await send("GET", path);
        const location = resp.headers.get("location");
        if (resp.status === 302 && location) {
          await resp.body?.cancel();
          // A fresh signed URL on each attempt: the storage host fails on its own.
          resp = await fetchImpl(location, { redirect: "error" }).catch((err: unknown) => {
            if (attempt >= MAX_ATTEMPTS) {
              throw err;
            }
            return null;
          });
          if (resp === null || (TRANSIENT_STATUSES.has(resp.status) && attempt < MAX_ATTEMPTS)) {
            await resp?.body?.cancel();
            await sleep(1_000 * 2 ** attempt);
            continue;
          }
        }
        if (resp.status === 404) {
          await resp.body?.cancel();
          return null;
        }
        if (!resp.ok) {
          throw new Error(`GET ${path}: HTTP ${resp.status}`);
        }
        return await resp.text();
      }
    },
    async oauthScopes(): Promise<string[] | null> {
      const resp = await send("GET", "/rate_limit");
      await resp.body?.cancel();
      const header = resp.headers.get("x-oauth-scopes");
      return header === null ? null : header.split(",").map((s) => s.trim()).filter(Boolean);
    },
    fetch: (input, init) =>
      send((init?.method ?? "GET").toUpperCase(), input instanceof Request ? input.url : String(input), init ?? {})
  };
  return api;
}
