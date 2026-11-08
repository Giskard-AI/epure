export interface GitHubApi {
  readonly repository: string;
  call<T>(method: string, path: string, body?: unknown, okStatuses?: readonly number[]): Promise<T>;
  status(method: string, path: string, body?: unknown): Promise<number>;
  paginate<T>(path: string, pick?: (page: unknown) => readonly T[]): Promise<T[]>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  text(path: string): Promise<string>;
  // null for tokens without OAuth scopes (fine-grained PATs, App tokens).
  oauthScopes(): Promise<string[] | null>;
}

export function createGitHubApi(token: string, repository: string): GitHubApi {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const url = (path: string) => (path.startsWith("https://") ? path : `https://api.github.com${path}`);
  const send = (method: string, path: string, body?: unknown) =>
    fetch(url(path), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  const api: GitHubApi = {
    repository,
    async call<T>(method: string, path: string, body?: unknown, okStatuses: readonly number[] = [200, 201, 204]): Promise<T> {
      const resp = await send(method, path, body);
      const raw = await resp.text();
      if (!okStatuses.includes(resp.status)) {
        const message = raw ? ((JSON.parse(raw) as { message?: string }).message ?? "") : "";
        throw new Error(`${method} ${path}: HTTP ${resp.status} ${message}`.trim());
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
      const resp = await send("GET", path);
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
