import "../src/orchestrator/issue-orchestrator.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_CONFIG,
  parseAgentsYaml
} from "../src/bootstrap/setup-repo.js";
import { loadRepoAgentsConfig } from "../src/orchestrator/github/rest-client.js";

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
});
