#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  applyGitHubRepositoryGovernance,
  planAndApplyRepoSetup
} from "./setup-repo.js";

function parseArgs(argv: readonly string[]): {
  repository: string;
  repoRootDir: string | undefined;
  epurePinnedSha: string | undefined;
  requirePrApprovalsOnDev: number | undefined;
  applyGithubSettings: boolean;
  githubToken: string | undefined;
  agentAppIntegrationId: number | undefined;
  releaseAppIntegrationId: number | undefined;
  dryRun: boolean;
  json: boolean;
} {
  let repository = "";
  let repoRootDir: string | undefined;
  let epurePinnedSha: string | undefined;
  let requirePrApprovalsOnDev: number | undefined;
  let applyGithubSettings = false;
  let githubToken: string | undefined;
  let agentAppIntegrationId: number | undefined;
  let releaseAppIntegrationId: number | undefined;
  let dryRun = true;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo" && argv[i + 1]) {
      repository = argv[i + 1] ?? "";
      i += 1;
    } else if ((arg === "--dir" || arg === "--repo-root") && argv[i + 1]) {
      repoRootDir = argv[i + 1];
      i += 1;
    } else if (arg === "--pinned-sha" && argv[i + 1]) {
      epurePinnedSha = argv[i + 1];
      i += 1;
    } else if (arg === "--require-pr-approvals" && argv[i + 1]) {
      requirePrApprovalsOnDev = Number.parseInt(argv[i + 1] ?? "0", 10);
      i += 1;
    } else if (arg === "--github-token" && argv[i + 1]) {
      githubToken = argv[i + 1];
      i += 1;
    } else if (arg === "--agent-app-id" && argv[i + 1]) {
      agentAppIntegrationId = Number.parseInt(argv[i + 1] ?? "0", 10);
      i += 1;
    } else if (arg === "--release-app-id" && argv[i + 1]) {
      releaseAppIntegrationId = Number.parseInt(argv[i + 1] ?? "0", 10);
      i += 1;
    } else if (arg === "--apply-github-settings") {
      applyGithubSettings = true;
    } else if (arg === "--apply") {
      dryRun = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    }
  }

  return {
    repository,
    repoRootDir,
    epurePinnedSha,
    requirePrApprovalsOnDev,
    applyGithubSettings,
    githubToken,
    agentAppIntegrationId,
    releaseAppIntegrationId,
    dryRun,
    json
  };
}

function resolveGitHubToken(explicitToken: string | undefined): string {
  if (explicitToken && explicitToken.trim()) {
    return explicitToken.trim();
  }
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = planAndApplyRepoSetup({
    repository: args.repository,
    repoRootDir: args.repoRootDir,
    epurePinnedSha: args.epurePinnedSha,
    requirePrApprovalsOnDev: args.requirePrApprovalsOnDev,
    dryRun: args.dryRun
  });

  if (result.status !== "error" && !args.dryRun && args.applyGithubSettings) {
    const token = resolveGitHubToken(args.githubToken);
    if (!token) {
      throw new Error(
        "Missing GitHub token for --apply-github-settings. Authenticate via 'gh auth login' or set GITHUB_TOKEN."
      );
    }
    await applyGitHubRepositoryGovernance({
      repository: args.repository,
      githubToken: token,
      governanceRulesets: result.governance_rulesets,
      agentAppIntegrationId: args.agentAppIntegrationId,
      releaseAppIntegrationId: args.releaseAppIntegrationId
    });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.summary_markdown}\n`);
  }

  if (result.status === "error") {
    process.exitCode = 1;
  }
}

void main();
