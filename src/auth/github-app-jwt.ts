import { createSign } from "node:crypto";

export interface GitHubAppCredentials {
  readonly appId: string;
  readonly privateKeyPem: string;
}

export interface MintInstallationTokenParams extends GitHubAppCredentials {
  readonly repository: string;
  readonly permissions?: Readonly<Record<string, "read" | "write">> | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface MintedInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly installationId: number;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function normalizePemKey(rawKey: string): string {
  const trimmed = rawKey.trim().replace(/\\n/g, "\n");
  return trimmed;
}

export function createGitHubAppJwt(
  credentials: GitHubAppCredentials,
  nowEpochSeconds = Math.floor(Date.now() / 1000)
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowEpochSeconds - 60,
    exp: nowEpochSeconds + 9 * 60,
    iss: credentials.appId.trim()
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(normalizePemKey(credentials.privateKeyPem));

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function mintRepositoryInstallationToken(
  params: MintInstallationTokenParams
): Promise<MintedInstallationToken> {
  const [owner, repo] = params.repository.trim().split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug '${params.repository}'.`);
  }

  const baseUrl = (params.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const fetchFn = params.fetchImpl ?? fetch;
  const appJwt = createGitHubAppJwt({
    appId: params.appId,
    privateKeyPem: params.privateKeyPem
  });

  // 1. Resolve repository installation ID
  const installResp = await fetchFn(
    `${baseUrl}/repos/${owner}/${repo}/installation`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );

  if (!installResp.ok) {
    const bodyText = await installResp.text();
    throw new Error(
      `Failed to resolve GitHub App installation for '${params.repository}' (HTTP ${installResp.status}): ${bodyText}`
    );
  }

  const installData = (await installResp.json()) as { id?: number };
  if (typeof installData.id !== "number") {
    throw new Error(
      `GitHub App installation response for '${params.repository}' did not contain an installation ID.`
    );
  }

  // 2. Mint scoped access token for this installation & repository
  const tokenBody: Record<string, unknown> = {
    repositories: [repo]
  };
  if (params.permissions && Object.keys(params.permissions).length > 0) {
    tokenBody.permissions = params.permissions;
  }

  const tokenResp = await fetchFn(
    `${baseUrl}/app/installations/${installData.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(tokenBody)
    }
  );

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(
      `Failed to mint installation token for installation ${installData.id} (HTTP ${tokenResp.status}): ${errText}`
    );
  }

  const tokenData = (await tokenResp.json()) as {
    token?: string;
    expires_at?: string;
  };
  if (typeof tokenData.token !== "string" || !tokenData.token) {
    throw new Error("GitHub installation token response was empty.");
  }

  return {
    token: tokenData.token,
    expiresAt: tokenData.expires_at ?? new Date(Date.now() + 3600_000).toISOString(),
    installationId: installData.id
  };
}

export async function revokeGitHubInstallationToken(params: {
  readonly token: string;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<void> {
  const baseUrl = (params.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const fetchFn = params.fetchImpl ?? fetch;
  await fetchFn(`${baseUrl}/installation/token`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
}
