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
  readonly outputDir: string;
  readonly maxGrillReplies: number;
  readonly planningStepTimeoutMinutes: number;
  readonly implementationTimeoutMinutes: number;
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

export function loadE2eConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const path = resolve(env.EPURE_E2E_CONFIG?.trim() || "epure.e2e.json");
  const file: E2eConfigFile = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as E2eConfigFile)
    : {};
  const config: E2eConfig = {
    repository: env.EPURE_E2E_REPOSITORY?.trim() || file.repository || "",
    epureRef: env.EPURE_E2E_EPURE_REF?.trim() || file.epureRef || "",
    model: env.EPURE_E2E_MODEL?.trim() || file.model || "",
    llmEnvironment: file.llmEnvironment || "epure-agent",
    agentAppId: file.agentAppId,
    releaseAppId: file.releaseAppId,
    pricing: file.pricing ?? {},
    outputDir: file.outputDir || ".scratch/e2e",
    maxGrillReplies: file.maxGrillReplies ?? 3,
    planningStepTimeoutMinutes: file.planningStepTimeoutMinutes ?? 30,
    implementationTimeoutMinutes: file.implementationTimeoutMinutes ?? 240
  };
  if (!config.repository) {
    throw new Error(`no sandbox repository: set "repository" in ${path} or EPURE_E2E_REPOSITORY`);
  }
  assertE2eSandboxRepository(config.repository);
  return config;
}

export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (!token) {
    throw new Error("no GitHub token: run `gh auth login` or set GH_TOKEN");
  }
  return token;
}
