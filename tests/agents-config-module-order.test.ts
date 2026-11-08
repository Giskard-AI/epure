import "../src/orchestrator/issue-orchestrator.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_CONFIG,
  parseAgentsYaml
} from "../src/bootstrap/setup-repo.js";
import {
  loadRepoAgentsConfig,
  loadTrustedAgentsProviders
} from "../src/orchestrator/github/rest-client.js";

describe("agents.yml parsing when the orchestrator module graph loads first", () => {
  it.each([
    {
      id: "models-only",
      yaml: "models:\n  planning: anthropic/claude-haiku-5-5\n",
      expectedReviewersDir: ".agents/reviewers"
    },
    {
      id: "custom-reviewers-dir",
      yaml: "reviewers_dir: .cursor/agents\nmodels:\n  planning: anthropic/claude-haiku-5-5\n",
      expectedReviewersDir: ".cursor/agents"
    }
  ])("[$id] parses and resolves reviewers_dir", ({ yaml, expectedReviewersDir }) => {
    expect(DEFAULT_AGENTS_CONFIG.reviewers_dir).toBe(".agents/reviewers");
    expect(parseAgentsYaml(yaml).reviewers_dir).toBe(expectedReviewersDir);
  });

  it.each([
    { id: "parent-segment-at-the-start", reviewersDir: "../reviewers" },
    { id: "parent-segment-in-the-middle", reviewersDir: ".agents/../../etc" },
    { id: "current-segment-at-the-start", reviewersDir: "./.agents/reviewers" },
    { id: "current-segment-in-the-middle", reviewersDir: ".agents/./reviewers" },
    { id: "backslash-parent-segment", reviewersDir: ".agents\\..\\x" }
  ])("[$id] a runtime agents.yml with a traversal segment in reviewers_dir is rejected", async ({ reviewersDir }) => {
    const yaml = `reviewers_dir: '${reviewersDir}'\n`;

    expect(() => parseAgentsYaml(yaml)).toThrow("must not contain '.' or '..' path segments");
    await expect(
      loadRepoAgentsConfig({ readSingleBranchFile: async (_b, path) => (path === ".github/agents.yml" ? yaml : null) }, "dev")
    ).rejects.toThrow("Invalid .github/agents.yml on 'dev'");
  });

  const PROVIDERS_YAML = [
    "providers:",
    "  corp-gateway:",
    "    provider: openai",
    "    base_url: https://llm.corp.example/v1",
    "    api_key: os.environ/CORP_GATEWAY_API_KEY",
    ""
  ].join("\n");
  it.each([
    { id: "read-from-dev", files: { dev: PROVIDERS_YAML }, expectedAlias: "corp-gateway" },
    { id: "falls-back-to-main-when-dev-has-none", files: { main: PROVIDERS_YAML }, expectedAlias: "corp-gateway" },
    { id: "no-agents-yml-on-either-branch", files: {}, expectedAlias: undefined }
  ])("[$id] loadTrustedAgentsProviders reads providers from the protected branches", async ({ files, expectedAlias }) => {
    const branchFiles: Record<string, string> = files;
    const providers = await loadTrustedAgentsProviders({
      readSingleBranchFile: async (branch, path) =>
        path === ".github/agents.yml" ? (branchFiles[branch] ?? null) : null
    });

    expect(providers ? Object.keys(providers) : undefined).toEqual(
      expectedAlias ? [expectedAlias] : undefined
    );
    if (expectedAlias) {
      expect(providers?.[expectedAlias]).toMatchObject({
        provider: "openai",
        base_url: "https://llm.corp.example/v1",
        api_key: "os.environ/CORP_GATEWAY_API_KEY"
      });
    }
  });
});
