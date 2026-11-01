import "../src/orchestrator/issue-orchestrator.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_CONFIG,
  parseAgentsYaml
} from "../src/bootstrap/setup-repo.js";

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
});
