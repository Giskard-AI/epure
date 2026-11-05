export const GITHUB_RATE_LIMIT_MAX_WAIT_MS = 5 * 60 * 1000;
const SECONDARY_RATE_LIMIT_DEFAULT_WAIT_MS = 60 * 1000;
const MIN_RATE_LIMIT_WAIT_MS = 1000;

export class GitHubRateLimitError extends Error {
  override readonly name = "GitHubRateLimitError";

  constructor(
    readonly method: string,
    readonly url: string,
    readonly retryAfterMs: number
  ) {
    super(
      `GitHub API ${method} ${url} is rate limited: the next retry in ${Math.ceil(retryAfterMs / 1000)}s would exceed the ${GITHUB_RATE_LIMIT_MAX_WAIT_MS / 1000}s wait budget`
    );
  }
}

/**
 * Wait before retrying a GitHub rate-limited response (primary or secondary limit),
 * or null when the response is not a rate limit. Follows GitHub's guidance:
 * `retry-after` first, then `x-ratelimit-reset` when the quota is spent, else one minute.
 */
export async function githubRateLimitWaitMs(
  resp: Response,
  nowMs: number
): Promise<number | null> {
  if (resp.status !== 403 && resp.status !== 429) {
    return null;
  }
  const retryAfterSeconds = Number(resp.headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(MIN_RATE_LIMIT_WAIT_MS, retryAfterSeconds * 1000);
  }
  const resetSeconds = Number(resp.headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (resp.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(resetSeconds)) {
    return Math.max(MIN_RATE_LIMIT_WAIT_MS, resetSeconds * 1000 - nowMs);
  }
  if (resp.status === 429) {
    return SECONDARY_RATE_LIMIT_DEFAULT_WAIT_MS;
  }
  const body = await resp.clone().text();
  return /rate limit/i.test(body) ? SECONDARY_RATE_LIMIT_DEFAULT_WAIT_MS : null;
}

/** Wraps fetch so rate-limited GitHub responses are retried within one shared wait budget. */
export function createGitHubRateLimitedFetch(params: {
  readonly fetchImpl: typeof fetch;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}): typeof fetch {
  const sleep =
    params.sleepFn ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = params.now ?? Date.now;
  let waitedMs = 0;
  return async (input, init) => {
    for (;;) {
      const resp = await params.fetchImpl(input, init);
      const waitMs = await githubRateLimitWaitMs(resp, now());
      if (waitMs === null) {
        return resp;
      }
      if (waitedMs + waitMs > GITHUB_RATE_LIMIT_MAX_WAIT_MS) {
        throw new GitHubRateLimitError(
          (init?.method ?? "GET").toUpperCase(),
          input instanceof Request ? input.url : String(input),
          waitMs
        );
      }
      waitedMs += waitMs;
      await sleep(waitMs);
    }
  };
}
