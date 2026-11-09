import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cachedInputPerMTok?: number | undefined;
}

export interface E2eConfig {
  readonly repository: string;
  // Branch, tag or commit of Giskard-AI/epure whose code the sandbox workflows run.
  readonly epureRef: string;
  // One `<provider>/<model>` for planning, implementation and review.
  readonly model: string;
  readonly llmEnvironment: string;
  readonly agentAppId?: number | undefined;
  readonly releaseAppId?: number | undefined;
  // Keyed by `<provider>/<model>`, USD per million tokens.
  readonly pricing: Readonly<Record<string, ModelPricing>>;
  // Where and when the prices were read; copied into result.json.
  readonly pricingSource: string;
  readonly outputDir: string;
  readonly maxGrillReplies: number;
  readonly planningStepTimeoutMinutes: number;
  readonly implementationTimeoutMinutes: number;
  readonly installCiTimeoutMinutes: number;
}

const FORBIDDEN_REPOSITORIES = ["giskard-ai/epure", "giskard-ai/epure-live-sandbox"];

export function assertE2eSandboxRepository(repository: string): void {
  const slug = repository.trim().toLowerCase();
  const name = slug.split("/")[1] ?? "";
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(slug)) {
    throw new Error(`invalid repository slug "${repository}": expected <owner>/<name>`);
  }
  if (FORBIDDEN_REPOSITORIES.includes(slug)) {
    throw new Error(`refusing to reset "${repository}": it is reserved and must stay untouched`);
  }
  if (!name.includes("sandbox")) {
    throw new Error(`refusing to reset "${repository}": the repository name must contain "sandbox"`);
  }
}

type E2eConfigFile = Partial<E2eConfig>;

// An environment variable may fill a missing setting but never replace the file's value.
function pick<T extends string | number>(
  path: string,
  key: keyof E2eConfig,
  envName: string,
  envValue: T | undefined,
  fileValue: T | undefined
): T | undefined {
  if (envValue !== undefined && fileValue !== undefined && envValue !== fileValue) {
    throw new Error(`${envName}=${String(envValue)} conflicts with "${key}": ${String(fileValue)} in ${path}`);
  }
  return envValue ?? fileValue;
}

const envString = (value: string | undefined) => value?.trim() || undefined;
const envNumber = (value: string | undefined) => (value?.trim() ? Number(value) : undefined);

export function loadE2eConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const path = resolve(env.EPURE_E2E_CONFIG?.trim() || "epure.e2e.json");
  const file: E2eConfigFile = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as E2eConfigFile)
    : {};
  const config: E2eConfig = {
    repository: pick(path, "repository", "EPURE_E2E_REPOSITORY", envString(env.EPURE_E2E_REPOSITORY), file.repository) ?? "",
    epureRef: pick(path, "epureRef", "EPURE_E2E_EPURE_REF", envString(env.EPURE_E2E_EPURE_REF), file.epureRef) ?? "",
    model: pick(path, "model", "EPURE_E2E_MODEL", envString(env.EPURE_E2E_MODEL), file.model) ?? "",
    llmEnvironment: file.llmEnvironment || "epure-agent",
    agentAppId: pick(path, "agentAppId", "EPURE_E2E_AGENT_APP_ID", envNumber(env.EPURE_E2E_AGENT_APP_ID), file.agentAppId),
    releaseAppId: pick(path, "releaseAppId", "EPURE_E2E_RELEASE_APP_ID", envNumber(env.EPURE_E2E_RELEASE_APP_ID), file.releaseAppId),
    pricing: file.pricing ?? {},
    pricingSource: file.pricingSource ?? "",
    outputDir: file.outputDir || ".scratch/e2e",
    maxGrillReplies: file.maxGrillReplies ?? 3,
    planningStepTimeoutMinutes: file.planningStepTimeoutMinutes ?? 30,
    implementationTimeoutMinutes: file.implementationTimeoutMinutes ?? 240,
    installCiTimeoutMinutes: file.installCiTimeoutMinutes ?? 20
  };
  if (!config.repository) {
    throw new Error(`no sandbox repository: set "repository" in ${path} or EPURE_E2E_REPOSITORY`);
  }
  assertE2eSandboxRepository(config.repository);
  return config;
}

// Appended to the sandbox's `.github/agents.yml` so EPURE shows costs on GitHub; `read_on` is the date in `pricingSource`.
export function agentsYmlPricing(config: Pick<E2eConfig, "model" | "pricing" | "pricingSource">): string {
  const price = config.pricing[config.model];
  const readOn = /\bread (\d{4}-\d{2}-\d{2})\b/.exec(config.pricingSource)?.[1];
  if (!price || !readOn) {
    throw new Error(`the e2e config needs a "pricing" entry for ${config.model} and a "pricingSource" saying "read YYYY-MM-DD"`);
  }
  return [
    "pricing:",
    `  ${JSON.stringify(config.model)}:`,
    `    input_per_mtok: ${price.inputPerMTok}`,
    ...(price.cachedInputPerMTok === undefined ? [] : [`    cached_input_per_mtok: ${price.cachedInputPerMTok}`]),
    `    output_per_mtok: ${price.outputPerMTok}`,
    `    source: ${JSON.stringify(config.pricingSource)}`,
    `    read_on: ${JSON.stringify(readOn)}`,
    ""
  ].join("\n");
}

export interface GitHubToken {
  readonly token: string;
  readonly source: "EPURE_E2E_GITHUB_TOKEN" | "GH_TOKEN" | "GITHUB_TOKEN" | "gh auth token";
}

function readGhAuthToken(): string {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// The fine-grained sandbox token comes first: the gh token usually reaches every repository of its user.
export function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  ghAuthToken: () => string = readGhAuthToken
): GitHubToken {
  for (const name of ["EPURE_E2E_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const token = env[name]?.trim();
    if (token) {
      return { token, source: name };
    }
  }
  const token = ghAuthToken();
  if (!token) {
    throw new Error("no GitHub token: set EPURE_E2E_GITHUB_TOKEN (fine-grained, sandbox only) or run `gh auth login`");
  }
  return { token, source: "gh auth token" };
}
