import { describe, expect, it } from "vitest";
import { assertE2eSandboxRepository } from "./e2e/config.js";
import { planSandboxReset, readTreeFiles, SEED_DIR, type SandboxSnapshot } from "./e2e/reset.js";

describe("assertE2eSandboxRepository", () => {
  it.each([
    { id: "e2e-sandbox", repository: "Giskard-AI/epure-e2e-sandbox" },
    { id: "sandbox-in-mixed-case", repository: "someone/My-SandBox-Repo" }
  ])("accepts $id", ({ repository }) => {
    expect(() => assertE2eSandboxRepository(repository)).not.toThrow();
  });

  it.each([
    { id: "name-without-sandbox", repository: "Giskard-AI/epure-e2e", error: /must contain "sandbox"/ },
    { id: "sandbox-only-in-owner", repository: "sandbox-org/app", error: /must contain "sandbox"/ },
    { id: "live-github-sandbox", repository: "Giskard-AI/epure-live-sandbox", error: /reserved/ },
    { id: "live-github-sandbox-other-case", repository: "giskard-ai/EPURE-LIVE-SANDBOX", error: /reserved/ },
    { id: "epure-itself", repository: "Giskard-AI/epure", error: /reserved/ },
    { id: "not-a-slug", repository: "epure-e2e-sandbox", error: /invalid repository slug/ }
  ])("refuses $id", ({ repository, error }) => {
    expect(() => assertE2eSandboxRepository(repository)).toThrow(error);
  });
});

describe("planSandboxReset", () => {
  const empty: SandboxSnapshot = { refs: [], rulesets: [], openPullRequests: [], issues: [], activeRunIds: [] };

  it.each([
    {
      id: "deletes-every-branch-tag-and-state-ref-except-main-and-dev",
      snapshot: {
        ...empty,
        refs: ["refs/heads/main", "refs/heads/dev", "refs/heads/feature/1-x", "refs/heads/task/2-y", "refs/tags/v1.0.0", "refs/epure/state/1"]
      },
      expected: { deleteRefs: ["refs/heads/feature/1-x", "refs/heads/task/2-y", "refs/tags/v1.0.0", "refs/epure/state/1"] }
    },
    {
      id: "ignores-refs-outside-heads-tags-and-epure",
      snapshot: { ...empty, refs: ["refs/pull/3/head", "refs/notes/commits"] },
      expected: { deleteRefs: [] }
    },
    {
      id: "deletes-only-repository-rulesets-named-epure",
      snapshot: {
        ...empty,
        rulesets: [
          { id: 1, name: "epure-dev-governance", source_type: "Repository" },
          { id: 2, name: "Main basic protection", source_type: "Organization" },
          { id: 3, name: "epure-org-wide", source_type: "Organization" },
          { id: 4, name: "team-rule", source_type: "Repository" }
        ]
      },
      expected: { deleteRulesetIds: [1] }
    },
    {
      id: "cancels-active-runs-closes-open-prs-and-deletes-issues",
      snapshot: { ...empty, activeRunIds: [10, 11], openPullRequests: [5], issues: [{ number: 4, node_id: "I_4" }] },
      expected: { cancelRunIds: [10, 11], closePullRequests: [5], deleteIssues: [{ number: 4, node_id: "I_4" }] }
    }
  ])("$id", ({ snapshot, expected }) => {
    expect(planSandboxReset(snapshot)).toMatchObject(expected);
  });
});

describe("seed project", () => {
  it("holds a test suite, a lockfile and a CI workflow named CI", () => {
    const files = readTreeFiles(SEED_DIR);
    const ci = files.find((f) => f.path === ".github/workflows/ci.yml");

    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["package.json", "package-lock.json", "src/stats.js", "test/stats.test.js", ".github/workflows/ci.yml"])
    );
    expect(ci?.content).toMatch(/^name: "CI"$/m);
  });
});
