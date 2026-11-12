import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EPURE_PINNED_SHA,
  planAndApplyRepoSetup
} from "../src/bootstrap/setup-repo.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_PROMOTE_WORKFLOW = readFileSync(
  join(ROOT_DIR, ".github", "workflows", "release-promote.yml"),
  "utf8"
);

function consumerReleaseWorkflow(): string {
  const result = planAndApplyRepoSetup({
    repository: "my-org/craft-calculator",
    dryRun: true,
    epurePinnedSha: DEFAULT_EPURE_PINNED_SHA
  });
  const release = result.planned_workflows.find(
    (w) => w.path === ".github/workflows/release.yml"
  );
  if (!release) throw new Error("release.yml not planned");
  return release.content;
}

function runBlockLines(workflow: string): string[] {
  const lines = workflow.split("\n");
  const collected: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    collected.push(match[2] ?? "");
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? "";
      if (next.trim() !== "" && next.search(/\S/) <= indent) break;
      collected.push(next);
      i++;
    }
  }
  return collected;
}

describe("release-promote.yml hardening invariants", () => {
  it.each([
    {
      scenario: "denies all token permissions at workflow level",
      holds: (wf: string) => /^permissions: \{\}$/m.test(wf)
    },
    {
      scenario: "pins every remote action to a full commit SHA",
      holds: (wf: string) =>
        [...wf.matchAll(/uses: (\S+)/g)].every(
          ([, ref]) => ref?.startsWith("./") || /@[0-9a-f]{40}$/.test(ref ?? "")
        )
    },
    {
      scenario: "never persists checkout credentials",
      holds: (wf: string) =>
        wf.match(/uses: actions\/checkout@/g)?.length ===
        wf.match(/persist-credentials: false/g)?.length
    },
    {
      scenario: "keeps every expression out of run blocks",
      holds: (wf: string) => runBlockLines(wf).every((line) => !line.includes("${{"))
    },
    {
      scenario: "refuses a direct dispatch outside dev while leaving the ref of consumer callers alone",
      holds: (wf: string) =>
        /JOB_WORKFLOW_REPOSITORY: \$\{\{ job\.workflow_repository \}\}/.test(wf) &&
        /\[\[ "\$JOB_WORKFLOW_REPOSITORY" != "\$GITHUB_REPOSITORY" \|\| "\$GITHUB_REF" == refs\/heads\/dev \]\]/.test(wf)
    },
    {
      scenario: "serializes promotions without cancelling an in-flight one",
      holds: (wf: string) =>
        /group: epure-release-promote-\$\{\{ github\.repository \}\}\n\s+cancel-in-progress: false/.test(wf)
    },
    {
      scenario: "fast-forwards main and pushes the tag in one atomic push without force",
      holds: (wf: string) =>
        /git push --atomic origin/.test(wf) && !/--force|\s-f\s|\+refs\//.test(wf)
    },
    {
      scenario: "revokes the Release App token even when an earlier step fails",
      holds: (wf: string) =>
        /if: \$\{\{ always\(\) && steps\.release-token\.outputs\.token != '' \}\}/.test(wf) &&
        /gh api --method DELETE installation\/token/.test(wf)
    },
    {
      scenario: "requests only contents write on the Release App token",
      holds: (wf: string) =>
        wf.match(/permission-[a-z-]+:/g)?.join(",") === "permission-contents:"
    }
  ])("$scenario", ({ holds }) => {
    expect(holds(RELEASE_PROMOTE_WORKFLOW)).toBe(true);
  });
});

describe("consumer release.yml template reuses release-promote.yml", () => {
  it.each([
    {
      scenario: "calls the EPURE reusable workflow pinned to the distribution SHA",
      expected: `uses: Giskard-AI/epure/.github/workflows/release-promote.yml@${DEFAULT_EPURE_PINNED_SHA}`
    },
    { scenario: "forwards the semver_tag input", expected: "semver_tag: ${{ inputs.semver_tag }}" },
    {
      scenario: "forwards the expected_dev_sha input",
      expected: "expected_dev_sha: ${{ inputs.expected_dev_sha }}"
    },
    { scenario: "denies all token permissions at workflow level", expected: "permissions: {}" }
  ])("$scenario", ({ expected }) => {
    expect(consumerReleaseWorkflow()).toContain(expected);
  });

  it("passes no secrets, since the reusable job reads the caller's release environment", () => {
    expect(consumerReleaseWorkflow()).not.toContain("secrets:");
  });

  it.each([
    { scenario: "semver_tag", input: "semver_tag" },
    { scenario: "expected_dev_sha", input: "expected_dev_sha" },
    { scenario: "ci_workflow", input: "ci_workflow" }
  ])("reusable workflow accepts $scenario from workflow_call", ({ input }) => {
    const workflowCall = RELEASE_PROMOTE_WORKFLOW.split("workflow_call:")[1]?.split("permissions:")[0] ?? "";
    expect(workflowCall).toContain(`${input}:`);
  });
});
