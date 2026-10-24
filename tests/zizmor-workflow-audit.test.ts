import { describe, expect, it } from "vitest";
import { auditGitHubWorkflowSecurity } from "../src/security/zizmor-workflow-audit.js";

describe("Ticket 28 (#29) — Fail CI on vulnerable GitHub Actions workflows (zizmor rules)", () => {
  const VULNERABLE_WORKFLOW = `
name: Vulnerable Workflow
on:
  pull_request_target:
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "Title: \${{ github.event.issue.title }}"
`;

  const HARDENED_WORKFLOW = `
name: Hardened Workflow
on:
  pull_request:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - env:
          ISSUE_TITLE: \${{ github.event.issue.title }}
        run: echo "Title: \$ISSUE_TITLE"
`;

  it.each([
    {
      id: "fails-ci-on-vulnerable-workflow-with-unpinned-actions-and-template-injection",
      workflowPath: ".github/workflows/vulnerable.yml",
      workflowYaml: VULNERABLE_WORKFLOW,
      expectedPassed: false,
      expectedFindingRules: [
        "unpinned-uses",
        "template-injection",
        "excessive-permissions",
        "dangerous-triggers"
      ]
    },
    {
      id: "passes-ci-on-hardened-workflow-with-40-char-sha-and-minimal-permissions",
      workflowPath: ".github/workflows/hardened.yml",
      workflowYaml: HARDENED_WORKFLOW,
      expectedPassed: true,
      expectedFindingRules: []
    }
  ])(
    "auditGitHubWorkflowSecurity [$id]: detects zizmor workflow vulnerabilities with file/line diagnostics",
    ({
      workflowPath,
      workflowYaml,
      expectedPassed,
      expectedFindingRules
    }) => {
      const result = auditGitHubWorkflowSecurity({
        workflowPath,
        workflowYaml
      });

      expect(result.passed).toBe(expectedPassed);
      const actualRules = result.findings.map((f) => f.rule_id);
      for (const expectedRule of expectedFindingRules) {
        expect(actualRules).toContain(expectedRule);
      }
      if (expectedPassed) {
        expect(result.findings).toHaveLength(0);
      } else {
        expect(result.findings[0]?.line).toBeGreaterThan(0);
      }
    }
  );
});
