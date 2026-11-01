import type { WebToolsConfig } from "../../bootstrap/setup-repo.js";
import { wrapUntrustedContent } from "../../security/prompt-injection-guard.js";
import type {
  LlmFunctionDeclaration,
  LlmToolHandler
} from "../llm-helper.js";

export type WebToolsPhase = "plan" | "spec" | "implementation" | "review";

export type WebSearchSource =
  | "auto"
  | "duckduckgo"
  | "github"
  | "npm"
  | "pypi"
  | "crates"
  | "wikipedia";

export interface WebSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface AntiSsrfValidationResult {
  readonly valid: boolean;
  readonly normalizedUrl?: string | undefined;
  readonly reason?: string | undefined;
}

const DEFAULT_WEB_TOOLS_PHASES: readonly WebToolsPhase[] = [
  "plan",
  "spec",
  "implementation"
];
const DEFAULT_MAX_REQUESTS_PER_RUN = 8;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_FETCH_BYTES = 16384;
const MAX_REDIRECTS = 3;

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return true;
    }
    octets.push(n);
  }
  const [a, b] = octets as [number, number, number, number];
  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (private network)
  if (a === 10) return true;
  // 100.64.0.0/10 (shared address space / CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local & cloud metadata IMDS 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (private network)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private network)
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 (multicast & reserved 240.0.0.0/4)
  if (a >= 224) return true;

  return false;
}

function isBlockedIpv6(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) {
    return false;
  }
  if (
    host === "::1" ||
    host === "::" ||
    host === "0:0:0:0:0:0:0:1" ||
    host === "0:0:0:0:0:0:0:0"
  ) {
    return true;
  }
  // IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 or ::ffff:169.254.169.254 or hex ::ffff:7f00:1)
  if (host.startsWith("::ffff:") || host.startsWith("0:0:0:0:0:ffff:")) {
    const tail = host.slice(host.lastIndexOf(":") + 1);
    if (tail.includes(".")) {
      return isBlockedIpv4(tail);
    }
    return true;
  }
  // Unique Local Address fc00::/7 (fc00..fdff)
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) {
    return true;
  }
  // Link-Local fe80::/10 (fe80..febf)
  if (/^fe[89ab][0-9a-f]?:/.test(host)) {
    return true;
  }
  return false;
}

/**
 * Validates that a target URL is a safe public HTTPS URL (port 443) and does not point
 * to localhost, private networks, link-local addresses, or cloud metadata endpoints (SSRF guard).
 */
export function validatePublicHttpsUrlForWebTool(
  rawUrl: string
): AntiSsrfValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      valid: false,
      reason: "SSRF_BLOCKED: Invalid URL syntax."
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      valid: false,
      reason: `SSRF_BLOCKED: Disallowed protocol '${parsed.protocol}'. Only 'https:' is permitted.`
    };
  }

  if (parsed.port !== "" && parsed.port !== "443") {
    return {
      valid: false,
      reason: `SSRF_BLOCKED: Disallowed port '${parsed.port}'. Only default HTTPS port 443 is permitted.`
    };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      valid: false,
      reason: "SSRF_BLOCKED: URLs containing credentials are not permitted."
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) {
    return {
      valid: false,
      reason: "SSRF_BLOCKED: Empty hostname."
    };
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".arpa") ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data" ||
    hostname === "metadata"
  ) {
    return {
      valid: false,
      reason: `SSRF_BLOCKED: Internal or local hostname '${hostname}' is forbidden.`
    };
  }

  // Block integer/hex/octal single-label or obfuscated IP encodings
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
    return {
      valid: false,
      reason: `SSRF_BLOCKED: Numeric/hex IP encoding '${hostname}' is forbidden.`
    };
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isBlockedIpv4(hostname)) {
      return {
        valid: false,
        reason: `SSRF_BLOCKED: Private, loopback, link-local, or reserved IPv4 address '${hostname}' is forbidden.`
      };
    }
  }

  if (isBlockedIpv6(hostname)) {
    return {
      valid: false,
      reason: `SSRF_BLOCKED: Loopback, link-local, or private IPv6 address '${hostname}' is forbidden.`
    };
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString()
  };
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    });
}

export function cleanHtmlToReadableText(
  html: string,
  maxBytes: number = DEFAULT_MAX_FETCH_BYTES
): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const withLineBreaks = withoutScripts
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, "\n");

  const strippedTags = withLineBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(strippedTags);
  const normalized = decoded
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  return truncateUtf8Bytes(normalized, maxBytes);
}

export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  return buf.subarray(0, maxBytes).toString("utf8") + "\n...[truncated]";
}

export async function safePublicHttpsFetch(params: {
  readonly url: string;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}): Promise<
  | { readonly ok: true; readonly status: number; readonly body: string; readonly finalUrl: string }
  | { readonly ok: false; readonly error: string }
> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let currentUrl = params.url;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const check = validatePublicHttpsUrlForWebTool(currentUrl);
    if (!check.valid || !check.normalizedUrl) {
      return {
        ok: false,
        error: check.reason ?? "SSRF_BLOCKED: URL rejected."
      };
    }

    let response: Response;
    try {
      response = await fetchFn(check.normalizedUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "EPURE-WebExplorer/1.2 (+https://github.com/Giskard-AI/epure)",
          Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
          ...(params.headers ?? {})
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Fetch error for ${check.normalizedUrl}: ${msg}`
      };
    }

    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      if (redirectCount === MAX_REDIRECTS) {
        return {
          ok: false,
          error: `SSRF_BLOCKED: Maximum redirects (${MAX_REDIRECTS}) exceeded.`
        };
      }
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          error: `Redirect status ${response.status} without Location header.`
        };
      }
      try {
        currentUrl = new URL(location, check.normalizedUrl).toString();
      } catch {
        return {
          ok: false,
          error: `SSRF_BLOCKED: Invalid redirect Location '${location}'.`
        };
      }
      const redirectCheck = validatePublicHttpsUrlForWebTool(currentUrl);
      if (!redirectCheck.valid) {
        return {
          ok: false,
          error:
            redirectCheck.reason ??
            `SSRF_BLOCKED: Unsafe redirect target '${currentUrl}'.`
        };
      }
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} from ${check.normalizedUrl}`
      };
    }

    const body = await response.text();
    return {
      ok: true,
      status: response.status,
      body,
      finalUrl: check.normalizedUrl
    };
  }

  return {
    ok: false,
    error: "SSRF_BLOCKED: Redirect loop detected."
  };
}

export function parseDuckDuckGoLiteResults(
  html: string,
  limit = 5
): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const linkRegex =
    /<a\b[^>]*class=["'][^"']*result-link[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex =
    /<td\b[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null && links.length < limit) {
    const rawUrl = decodeHtmlEntities(match[1] ?? "").trim();
    const title = cleanHtmlToReadableText(match[2] ?? "", 512).replace(/\n+/g, " ");
    if (rawUrl && title) {
      links.push({ url: rawUrl, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < limit) {
    snippets.push(
      cleanHtmlToReadableText(match[1] ?? "", 1024).replace(/\n+/g, " ")
    );
  }

  for (let i = 0; i < links.length && results.length < limit; i += 1) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i] ?? ""
    });
  }

  return results;
}

export async function executeZeroKeyWebSearch(params: {
  readonly query: string;
  readonly source?: WebSearchSource | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<{
  readonly source: string;
  readonly results?: readonly WebSearchResultItem[] | undefined;
  readonly content?: string | undefined;
  readonly error?: string | undefined;
}> {
  const q = params.query.trim();
  if (!q) {
    return { source: "none", error: "Search query must not be empty." };
  }
  const source: WebSearchSource = params.source ?? "auto";

  if (source === "npm") {
    const res = await safePublicHttpsFetch({
      url: `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=5`,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      return { source: "npm", error: res.error };
    }
    try {
      const parsed = JSON.parse(res.body) as {
        objects?: Array<{
          package?: {
            name?: string;
            version?: string;
            description?: string;
            links?: { npm?: string; homepage?: string };
          };
        }>;
      };
      const items: WebSearchResultItem[] = (parsed.objects ?? [])
        .slice(0, 5)
        .map((obj) => ({
          title: `${obj.package?.name ?? "unknown"}@${obj.package?.version ?? "latest"}`,
          url:
            obj.package?.links?.npm ??
            `https://www.npmjs.com/package/${obj.package?.name ?? ""}`,
          snippet: obj.package?.description ?? ""
        }));
      return {
        source: "npm",
        results: items,
        content: wrapUntrustedContent(
          "untrusted_web_content",
          JSON.stringify(items, null, 2)
        )
      };
    } catch {
      return { source: "npm", error: "Failed to parse npm registry response." };
    }
  }

  if (source === "pypi") {
    const pkgName = q.split(/\s+/)[0] ?? q;
    const res = await safePublicHttpsFetch({
      url: `https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      return { source: "pypi", error: res.error };
    }
    try {
      const parsed = JSON.parse(res.body) as {
        info?: {
          name?: string;
          version?: string;
          summary?: string;
          package_url?: string;
          home_page?: string;
        };
      };
      const item: WebSearchResultItem = {
        title: `${parsed.info?.name ?? pkgName}==${parsed.info?.version ?? "latest"}`,
        url:
          parsed.info?.package_url ??
          `https://pypi.org/project/${encodeURIComponent(pkgName)}/`,
        snippet: parsed.info?.summary ?? ""
      };
      return {
        source: "pypi",
        results: [item],
        content: wrapUntrustedContent(
          "untrusted_web_content",
          JSON.stringify([item], null, 2)
        )
      };
    } catch {
      return { source: "pypi", error: "Failed to parse PyPI JSON response." };
    }
  }

  if (source === "crates") {
    const res = await safePublicHttpsFetch({
      url: `https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=5`,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      return { source: "crates", error: res.error };
    }
    try {
      const parsed = JSON.parse(res.body) as {
        crates?: Array<{
          name?: string;
          max_version?: string;
          description?: string;
        }>;
      };
      const items: WebSearchResultItem[] = (parsed.crates ?? [])
        .slice(0, 5)
        .map((c) => ({
          title: `${c.name ?? "unknown"} v${c.max_version ?? "0.0.0"}`,
          url: `https://crates.io/crates/${c.name ?? ""}`,
          snippet: c.description ?? ""
        }));
      return {
        source: "crates",
        results: items,
        content: wrapUntrustedContent(
          "untrusted_web_content",
          JSON.stringify(items, null, 2)
        )
      };
    } catch {
      return { source: "crates", error: "Failed to parse crates.io response." };
    }
  }

  if (source === "github") {
    const res = await safePublicHttpsFetch({
      url: `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=5`,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) {
      return { source: "github", error: res.error };
    }
    try {
      const parsed = JSON.parse(res.body) as {
        items?: Array<{
          full_name?: string;
          html_url?: string;
          description?: string;
          stargazers_count?: number;
        }>;
      };
      const items: WebSearchResultItem[] = (parsed.items ?? [])
        .slice(0, 5)
        .map((repo) => ({
          title: `${repo.full_name ?? "unknown"} (${repo.stargazers_count ?? 0}★)`,
          url: repo.html_url ?? "",
          snippet: repo.description ?? ""
        }));
      return {
        source: "github",
        results: items,
        content: wrapUntrustedContent(
          "untrusted_web_content",
          JSON.stringify(items, null, 2)
        )
      };
    } catch {
      return { source: "github", error: "Failed to parse GitHub search response." };
    }
  }

  if (source === "wikipedia") {
    const res = await safePublicHttpsFetch({
      url: `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=1&format=json&srlimit=5`,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      return { source: "wikipedia", error: res.error };
    }
    try {
      const parsed = JSON.parse(res.body) as {
        query?: {
          search?: Array<{
            title?: string;
            snippet?: string;
          }>;
        };
      };
      const items: WebSearchResultItem[] = (parsed.query?.search ?? [])
        .slice(0, 5)
        .map((item) => ({
          title: item.title ?? "",
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent((item.title ?? "").replace(/\s+/g, "_"))}`,
          snippet: cleanHtmlToReadableText(item.snippet ?? "", 512)
        }));
      return {
        source: "wikipedia",
        results: items,
        content: wrapUntrustedContent(
          "untrusted_web_content",
          JSON.stringify(items, null, 2)
        )
      };
    } catch {
      return {
        source: "wikipedia",
        error: "Failed to parse Wikipedia API response."
      };
    }
  }

  // Default: DuckDuckGo HTML Lite (zero API key)
  const ddgRes = await safePublicHttpsFetch({
    url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl
  });
  if (!ddgRes.ok) {
    return { source: "duckduckgo", error: ddgRes.error };
  }
  const items = parseDuckDuckGoLiteResults(ddgRes.body, 5);
  return {
    source: "duckduckgo",
    results: items,
    content: wrapUntrustedContent(
      "untrusted_web_content",
      JSON.stringify(items, null, 2)
    )
  };
}

export function isWebToolsEnabledForPhase(
  phase: WebToolsPhase | undefined,
  config?: WebToolsConfig | undefined
): boolean {
  if (config?.enabled === false) {
    return false;
  }
  const effectivePhase: WebToolsPhase = phase ?? "implementation";
  const allowedPhases: readonly WebToolsPhase[] =
    config?.phases && config.phases.length > 0
      ? config.phases
      : DEFAULT_WEB_TOOLS_PHASES;
  return allowedPhases.includes(effectivePhase);
}

export function buildWebExplorationToolsAndHandlers(params?: {
  readonly phase?: WebToolsPhase | undefined;
  readonly webToolsConfig?: WebToolsConfig | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): {
  readonly tools: readonly LlmFunctionDeclaration[];
  readonly toolHandlers: Readonly<Record<string, LlmToolHandler>>;
} {
  if (!isWebToolsEnabledForPhase(params?.phase, params?.webToolsConfig)) {
    return { tools: [], toolHandlers: {} };
  }

  const maxRequests =
    params?.webToolsConfig?.max_requests_per_run ??
    params?.webToolsConfig?.max_requests_per_turn ??
    DEFAULT_MAX_REQUESTS_PER_RUN;
  const timeoutMs = params?.webToolsConfig?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxFetchBytes =
    params?.webToolsConfig?.max_fetch_bytes ??
    params?.webToolsConfig?.max_bytes_per_response ??
    DEFAULT_MAX_FETCH_BYTES;
  let requestsUsed = 0;

  const tools: readonly LlmFunctionDeclaration[] = [
    {
      name: "web_search",
      description:
        "Search the public web or package registries without API keys (DuckDuckGo Lite, npm, PyPI, crates.io, GitHub, Wikipedia). Returns top 5 results wrapped in <untrusted_web_content>.",
      parameters: {
        type: "OBJECT" as const,
        properties: {
          query: {
            type: "STRING" as const,
            description: "Search query or package name"
          },
          source: {
            type: "STRING" as const,
            description:
              "Optional source: 'auto' | 'duckduckgo' | 'npm' | 'pypi' | 'crates' | 'github' | 'wikipedia'"
          }
        },
        required: ["query"]
      }
    },
    {
      name: "web_fetch",
      description:
        "Fetch a public HTTPS URL (port 443), strip HTML/scripts into clean text truncated to 16KB, and return it wrapped in <untrusted_web_content>. Blocks private IPs, localhost, and cloud metadata.",
      parameters: {
        type: "OBJECT" as const,
        properties: {
          url: {
            type: "STRING" as const,
            description: "Public https:// URL to fetch"
          }
        },
        required: ["url"]
      }
    }
  ];

  const toolHandlers: Readonly<Record<string, LlmToolHandler>> = {
    web_search: async (args: Readonly<Record<string, unknown>>) => {
      if (requestsUsed >= maxRequests) {
        return {
          error: `Web tool request budget (${maxRequests}) exceeded for this run.`
        };
      }
      requestsUsed += 1;
      const query = String(args.query ?? "").trim();
      const rawSource = String(args.source ?? "auto")
        .trim()
        .toLowerCase();
      const validSources: readonly WebSearchSource[] = [
        "auto",
        "duckduckgo",
        "github",
        "npm",
        "pypi",
        "crates",
        "wikipedia"
      ];
      const source: WebSearchSource = (
        validSources.includes(rawSource as WebSearchSource) ? rawSource : "auto"
      ) as WebSearchSource;

      return executeZeroKeyWebSearch({
        query,
        source,
        timeoutMs,
        fetchImpl: params?.fetchImpl
      });
    },
    web_fetch: async (args: Readonly<Record<string, unknown>>) => {
      if (requestsUsed >= maxRequests) {
        return {
          error: `Web tool request budget (${maxRequests}) exceeded for this run.`
        };
      }
      requestsUsed += 1;
      const url = String(args.url ?? "").trim();
      const fetched = await safePublicHttpsFetch({
        url,
        timeoutMs,
        fetchImpl: params?.fetchImpl
      });
      if (!fetched.ok) {
        return { error: fetched.error };
      }
      const cleaned = cleanHtmlToReadableText(fetched.body, maxFetchBytes);
      return {
        url: fetched.finalUrl,
        content: wrapUntrustedContent("untrusted_web_content", cleaned)
      };
    }
  };

  return { tools, toolHandlers };
}
