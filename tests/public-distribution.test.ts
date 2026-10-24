import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_ACTION_PATH = join(ROOT_DIR, "dist", "actions", "epure-contract", "index.mjs");
const REUSABLE_WORKFLOW_PATH = join(ROOT_DIR, ".github", "workflows", "epure-check.yml");
const ACTION_MANIFEST_PATH = join(ROOT_DIR, "actions", "epure-contract", "action.yml");
const CONSUMER_FIXTURE_PATH = join(
  ROOT_DIR,
  "tests",
  "fixtures",
  "consumer-repo",
  ".github",
  "workflows",
  "consume-epure.yml"
);
const LICENSE_PATH = join(ROOT_DIR, "LICENSE");
const NOTICE_PATH = join(ROOT_DIR, "NOTICE");
const CONTRACTS_DOC_PATH = join(ROOT_DIR, "docs", "CONTRACTS.md");
const CI_WORKFLOW_PATH = join(ROOT_DIR, ".github", "workflows", "ci.yml");

interface ActionRunResult {
  exitCode: number;
  outputs: Record<string, string>;
  summary: string;
  stderr: string;
}

function parseGitHubOutputs(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);
    result[key] = value;
  }
  return result;
}

function invokeBundledActionIsolated(inputs: Record<string, string>): ActionRunResult {
  const isolatedDir = mkdtempSync(join(tmpdir(), "epure-consumer-runner-"));
  try {
    const isolatedBundle = join(isolatedDir, "index.mjs");
    const outputFile = join(isolatedDir, "github_output.txt");
    const summaryFile = join(isolatedDir, "github_summary.md");
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(summaryFile, "", "utf8");
    copyFileSync(BUNDLED_ACTION_PATH, isolatedBundle);

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_NO_WARNINGS: "1",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ...inputs
    };

    try {
      execFileSync(process.execPath, [isolatedBundle], {
        cwd: isolatedDir,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      return {
        exitCode: 0,
        outputs: parseGitHubOutputs(readFileSync(outputFile, "utf8")),
        summary: readFileSync(summaryFile, "utf8"),
        stderr: ""
      };
    } catch (err: unknown) {
      const execErr = err as { status?: number; stderr?: string };
      return {
        exitCode: execErr.status ?? 1,
        outputs: parseGitHubOutputs(readFileSync(outputFile, "utf8")),
        summary: readFileSync(summaryFile, "utf8"),
        stderr: execErr.stderr ?? ""
      };
    }
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
}

describe("Public Custom Action contract (actions/epure-contract pre-bundled on Node 24 LTS without node_modules)", () => {
  it("bundles the custom action into dist/actions/epure-contract/index.mjs", () => {
    expect(existsSync(BUNDLED_ACTION_PATH)).toBe(true);
  });

  it.each([
    {
      id: "valid-40-char-sha-pinned-reference-succeeds",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-consumer",
        INPUT_PINNED_REF: "Giskard-AI/epure/actions/epure-contract@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0",
        INPUT_STRICT_SHA_PINNING: "true"
      },
      expectedExitCode: 0,
      expectedOutputs: {
        status: "ok",
        version: "1.0.0",
        contract_valid: "true",
        error_code: "NONE"
      }
    },
    {
      id: "valid-semver-immutable-tag-when-strict-sha-disabled",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-consumer",
        INPUT_PINNED_REF: "Giskard-AI/epure/.github/workflows/epure-check.yml@v1.0.0",
        INPUT_STRICT_SHA_PINNING: "false"
      },
      expectedExitCode: 0,
      expectedOutputs: {
        status: "ok",
        version: "1.0.0",
        contract_valid: "true",
        error_code: "NONE"
      }
    },
    {
      id: "rejects-mutable-floating-major-tag-v1",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-consumer",
        INPUT_PINNED_REF: "Giskard-AI/epure/actions/epure-contract@v1",
        INPUT_STRICT_SHA_PINNING: "false"
      },
      expectedExitCode: 1,
      expectedOutputs: {
        status: "error",
        version: "1.0.0",
        contract_valid: "false",
        error_code: "MUTABLE_FLOATING_TAG_FORBIDDEN"
      }
    },
    {
      id: "rejects-non-sha-ref-when-strict-sha-pinning-enabled",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-consumer",
        INPUT_PINNED_REF: "Giskard-AI/epure/actions/epure-contract@v1.0.0",
        INPUT_STRICT_SHA_PINNING: "true"
      },
      expectedExitCode: 1,
      expectedOutputs: {
        status: "error",
        version: "1.0.0",
        contract_valid: "false",
        error_code: "INVALID_SHA_PINNING"
      }
    },
    {
      id: "rejects-invalid-repository-slug",
      inputs: {
        INPUT_REPOSITORY: "invalid-repo-without-owner",
        INPUT_PINNED_REF: "Giskard-AI/epure/actions/epure-contract@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0",
        INPUT_STRICT_SHA_PINNING: "true"
      },
      expectedExitCode: 1,
      expectedOutputs: {
        status: "error",
        version: "1.0.0",
        contract_valid: "false",
        error_code: "INVALID_REPOSITORY_SLUG"
      }
    },
    {
      id: "rejects-shared-maintainer-credential-injection",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-consumer",
        INPUT_PINNED_REF: "Giskard-AI/epure/actions/epure-contract@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0",
        INPUT_STRICT_SHA_PINNING: "true",
        EPURE_MAINTAINER_SHARED_TOKEN: "ghs_leaked_central_token"
      },
      expectedExitCode: 1,
      expectedOutputs: {
        status: "error",
        version: "1.0.0",
        contract_valid: "false",
        error_code: "SHARED_MAINTAINER_CREDENTIAL_FORBIDDEN"
      }
    }
  ])("$id", ({ inputs, expectedExitCode, expectedOutputs }) => {
    const result = invokeBundledActionIsolated(inputs);
    expect(result.exitCode).toBe(expectedExitCode);
    expect(result.outputs).toMatchObject(expectedOutputs);
  });
});

describe("Public Reusable Workflow (.github/workflows/epure-check.yml) and Consumer Fixture Seam", () => {
  it.each([
    {
      id: "reusable-workflow-declares-workflow-call-least-privilege-and-outputs",
      targetPath: REUSABLE_WORKFLOW_PATH,
      requiredSnippets: [
        "workflow_call:",
        "inputs:",
        "repository:",
        "pinned_ref:",
        "strict_sha_pinning:",
        "outputs:",
        "status:",
        "version:",
        "contract_valid:",
        "permissions:",
        "contents: read",
        "repository: Giskard-AI/epure",
        "uses: ./actions/epure-contract"
      ],
      forbiddenSnippets: ["npm install", "npm ci", "repository_dispatch", "write-all"]
    },
    {
      id: "custom-action-manifest-declares-node24-prebundled-entrypoint-and-contract-outputs",
      targetPath: ACTION_MANIFEST_PATH,
      requiredSnippets: [
        'using: "node24"',
        'main: "../../dist/actions/epure-contract/index.mjs"',
        "repository:",
        "pinned_ref:",
        "strict_sha_pinning:",
        "status:",
        "version:",
        "contract_valid:",
        "error_code:",
        "error_message:"
      ],
      forbiddenSnippets: ["npm install", "composite"]
    },
    {
      id: "consumer-fixture-invokes-reusable-workflow-and-custom-action-pinned-by-40-char-sha",
      targetPath: CONSUMER_FIXTURE_PATH,
      requiredSnippets: [
        "uses: Giskard-AI/epure/.github/workflows/epure-check.yml@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0",
        "uses: Giskard-AI/epure/actions/epure-contract@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 # v1.0.0",
        "permissions:",
        "contents: read"
      ],
      forbiddenSnippets: [
        "npm install",
        "npm ci",
        "repository_dispatch",
        "EPURE_MAINTAINER_SHARED_TOKEN",
        "@v1\n"
      ]
    }
  ])("$id", ({ targetPath, requiredSnippets, forbiddenSnippets }) => {
    expect(existsSync(targetPath)).toBe(true);
    const content = readFileSync(targetPath, "utf8");
    for (const snippet of requiredSnippets) {
      expect(content).toContain(snippet);
    }
    for (const forbidden of forbiddenSnippets) {
      expect(content).not.toContain(forbidden);
    }
  });
});

describe("Licensing, third-party attributions (NOTICE), public contract docs, and CI workflow", () => {
  it.each([
    {
      id: "apache-2-0-license-present",
      filePath: LICENSE_PATH,
      expectedFragments: ["Apache License", "Version 2.0, January 2004"]
    },
    {
      id: "notice-contains-matt-pocock-impeccable-and-ifixai-attributions-with-provenance",
      filePath: NOTICE_PATH,
      expectedFragments: [
        "EPURE (Giskard-AI/epure)",
        "Apache License, Version 2.0",
        "mattpocock/skills",
        "MIT",
        "skills-lock.json",
        "pbakaus/impeccable",
        "ifixai-ai/iFixAi"
      ]
    },
    {
      id: "public-contracts-documentation-covers-inputs-outputs-errors-permissions-and-sha-pinning",
      filePath: CONTRACTS_DOC_PATH,
      expectedFragments: [
        ".github/workflows/epure-check.yml",
        "actions/epure-contract",
        "contents: read",
        "INVALID_REPOSITORY_SLUG",
        "MUTABLE_FLOATING_TAG_FORBIDDEN",
        "INVALID_SHA_PINNING",
        "SHARED_MAINTAINER_CREDENTIAL_FORBIDDEN",
        "Giskard-AI/epure/.github/workflows/epure-check.yml@",
        "# v1.0.0"
      ]
    },
    {
      id: "ci-workflow-verifies-typecheck-tests-and-up-to-date-dist-bundle",
      filePath: CI_WORKFLOW_PATH,
      expectedFragments: [
        "npm run typecheck",
        "npm run build",
        "npm test",
        "git diff --exit-code dist/",
        "contents: read"
      ]
    }
  ])("$id", ({ filePath, expectedFragments }) => {
    expect(existsSync(filePath)).toBe(true);
    const text = readFileSync(filePath, "utf8");
    for (const fragment of expectedFragments) {
      expect(text).toContain(fragment);
    }
  });
});


