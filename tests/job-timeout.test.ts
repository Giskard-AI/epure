import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planAndApplyRepoSetup } from "../src/bootstrap/setup-repo.js";
import {
  GITHUB_MAX_JOB_TIMEOUT_MINUTES,
  parseJobTimeoutMinutes,
  resolveJobTimeoutMinutes
} from "../src/orchestrator/job-timeout.js";

function generatedIssueWorkflow(): string {
  const repoRootDir = mkdtempSync(join(tmpdir(), "epure-job-timeout-"));
  try {
    const result = planAndApplyRepoSetup({ repository: "acme-org/payments", repoRootDir, dryRun: true });
    return result.planned_workflows.find((w) => w.path === ".github/workflows/epure-issue-command.yml")!.content;
  } finally {
    rmSync(repoRootDir, { recursive: true, force: true });
  }
}

const GENERATED = generatedIssueWorkflow();
const ORCHESTRATE_TIMEOUT_LINE = "    timeout-minutes: 60\n    environment:";

describe("The lease length is the timeout-minutes GitHub enforces on the orchestrate-command job", () => {
  it.each([
    { id: "generated-caller-workflow-yields-the-orchestrate-command-literal-not-the-authorize-job-one", yaml: GENERATED, expected: 60 },
    { id: "a-literal-edited-in-the-workflow-file-wins-over-agents-yml", yaml: GENERATED.replace(ORCHESTRATE_TIMEOUT_LINE, "    timeout-minutes: 150 # raised by hand\n    environment:"), expected: 150 },
    { id: "a-quoted-literal-is-read", yaml: GENERATED.replace(ORCHESTRATE_TIMEOUT_LINE, '    timeout-minutes: "90"\n    environment:'), expected: 90 },
    { id: "an-expression-is-unresolvable", yaml: GENERATED.replace(ORCHESTRATE_TIMEOUT_LINE, "    timeout-minutes: ${{ fromJSON(vars.EPURE_TIMEOUT) }}\n    environment:"), expected: undefined },
    { id: "a-job-without-timeout-minutes-has-none", yaml: GENERATED.replace(ORCHESTRATE_TIMEOUT_LINE, "    environment:"), expected: undefined },
    { id: "a-step-level-timeout-minutes-is-not-the-job-timeout", yaml: "jobs:\n  orchestrate-command:\n    runs-on: x\n    steps:\n      - run: echo\n        timeout-minutes: 5\n", expected: undefined },
    { id: "a-missing-job-has-none", yaml: "jobs:\n  other:\n    timeout-minutes: 5\n", expected: undefined },
    { id: "a-same-named-key-nested-in-another-job-is-not-the-job-header", yaml: "jobs:\n  other:\n    outputs:\n      orchestrate-command:\n        timeout-minutes: 5\n  orchestrate-command:\n    timeout-minutes: 45\n", expected: 45 },
    { id: "a-same-named-key-outside-jobs-is-not-the-job-header", yaml: "env:\n  orchestrate-command:\n    timeout-minutes: 5\njobs:\n  orchestrate-command:\n    runs-on: x\n", expected: undefined },
    { id: "a-same-named-key-nested-in-another-job-without-the-job-has-none", yaml: "jobs:\n  other:\n    with:\n      orchestrate-command:\n        timeout-minutes: 5\n", expected: undefined }
  ])("$id", ({ yaml, expected }) => {
    expect(parseJobTimeoutMinutes(yaml, "orchestrate-command")).toBe(expected);
  });

  it.each([
    { id: "workflow-file-literal-is-used", file: GENERATED, expected: 60 },
    { id: "unresolvable-timeout-falls-back-to-the-github-maximum", file: "jobs:\n  orchestrate-command:\n    runs-on: x\n", expected: GITHUB_MAX_JOB_TIMEOUT_MINUTES },
    { id: "unreadable-workflow-file-falls-back-to-the-github-maximum", file: null, expected: GITHUB_MAX_JOB_TIMEOUT_MINUTES }
  ])("$id", async ({ file, expected }) => {
    const reads: string[] = [];
    const minutes = await resolveJobTimeoutMinutes(
      {
        readSingleBranchFile: async (ref, path) => {
          reads.push(`${path}@${ref}`);
          return file;
        }
      },
      { path: ".github/workflows/epure-issue-command.yml", ref: "wf-sha", jobId: "orchestrate-command" }
    );
    expect(minutes).toBe(expected);
    expect(reads).toEqual([".github/workflows/epure-issue-command.yml@wf-sha"]);
  });
});
