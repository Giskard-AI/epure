import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeMinimalInstallationPermissions,
  publishAgentProposal,
  validateAgentProposal,
  verifyAgentJobIsolation
} from "../src/publisher/isolated-publisher.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_PUBLISHER_ACTION_PATH = join(
  ROOT_DIR,
  "dist",
  "actions",
  "publish-agent-output",
  "index.mjs"
);
const PUBLISHER_ACTION_MANIFEST_PATH = join(
  ROOT_DIR,
  "actions",
  "publish-agent-output",
  "action.yml"
);

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

function invokePublisherActionIsolated(
  inputs: Record<string, string>
): ActionRunResult {
  const isolatedDir = mkdtempSync(join(tmpdir(), "epure-isolated-publisher-"));
  try {
    const isolatedBundle = join(isolatedDir, "index.mjs");
    const outputFile = join(isolatedDir, "github_output.txt");
    const summaryFile = join(isolatedDir, "github_summary.md");
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(summaryFile, "", "utf8");
    copyFileSync(BUNDLED_PUBLISHER_ACTION_PATH, isolatedBundle);

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

describe("1. Agent job isolation check (verifyAgentJobIsolation)", () => {
  it.each([
    {
      id: "passes-when-agent-env-has-no-write-token-and-no-app-private-key",
      env: {
        PATH: "/usr/bin",
        EPURE_PROXY_URL: "http://127.0.0.1:4319"
      },
      expected: {
        isolated: true,
        error_code: "NONE"
      }
    },
    {
      id: "passes-when-github-token-is-explicitly-marked-read-only",
      env: {
        GITHUB_TOKEN: "ghs_readonly1234567890",
        GITHUB_TOKEN_PERMISSIONS: "contents:read"
      },
      expected: {
        isolated: true,
        error_code: "NONE"
      }
    },
    {
      id: "fails-when-agent-env-contains-epure-agent-app-private-key",
      env: {
        EPURE_AGENT_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"
      },
      expected: {
        isolated: false,
        error_code: "AGENT_ENV_PRIVATE_KEY_FORBIDDEN"
      }
    },
    {
      id: "fails-when-agent-env-contains-write-capable-github-token",
      env: {
        GITHUB_TOKEN: "ghs_writecapabletoken1234567890",
        GITHUB_TOKEN_PERMISSIONS: "contents:write,issues:write"
      },
      expected: {
        isolated: false,
        error_code: "AGENT_ENV_WRITE_TOKEN_FORBIDDEN"
      }
    },
    {
      id: "fails-when-agent-env-contains-unscoped-gh-token-or-installation-token",
      env: {
        EPURE_INSTALLATION_TOKEN: "ghs_secretinstallationtoken123"
      },
      expected: {
        isolated: false,
        error_code: "AGENT_ENV_WRITE_TOKEN_FORBIDDEN"
      }
    }
  ])("$id", ({ env, expected }) => {
    const res = verifyAgentJobIsolation(env);
    expect(res).toMatchObject(expected);
  });
});

describe("2. Proposal validation & scope boundaries (validateAgentProposal)", () => {
  const baseScope = {
    repository: "acme-org/payments",
    repositoryId: 4242,
    assignedIssueNumber: 6,
    assignedBranchPrefix: "task/6-",
    allowedTargetFeatureBranch: "feature/1-epure-v1",
    allowWorkflowOrConfigEdits: false
  };

  it.each([
    {
      id: "accepts-valid-issue-comment-proposal-on-assigned-issue",
      rawProposal: JSON.stringify({
        operation: "comment_issue",
        repository: "acme-org/payments",
        issue_number: 6,
        body: "### Task Progress\nImplemented isolated publisher validation."
      }),
      scope: baseScope,
      expectedValid: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "accepts-valid-task-branch-push-with-in-scope-files",
      rawProposal: JSON.stringify({
        operation: "push_task_branch",
        repository: "acme-org/payments",
        target_branch: "task/6-isolated-publisher",
        commit_message: "feat: add isolated publisher",
        changed_files: ["src/publisher/isolated-publisher.ts", "tests/isolated-publisher.test.ts"]
      }),
      scope: baseScope,
      expectedValid: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "accepts-valid-pull-request-from-task-branch-into-feature-branch",
      rawProposal: JSON.stringify({
        operation: "open_pull_request",
        repository: "acme-org/payments",
        head_branch: "task/6-isolated-publisher",
        base_branch: "feature/1-epure-v1",
        title: "feat: isolated publisher (#6)",
        body: "Closes #6\nPart of #1"
      }),
      scope: baseScope,
      expectedValid: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "rejects-malformed-json-proposal-payload",
      rawProposal: "{ invalid json",
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "MALFORMED_PROPOSAL_PAYLOAD"
    },
    {
      id: "rejects-proposal-with-missing-required-fields",
      rawProposal: JSON.stringify({
        operation: "comment_issue",
        repository: "acme-org/payments",
        issue_number: 6,
        body: "   "
      }),
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "MALFORMED_PROPOSAL_PAYLOAD"
    },
    {
      id: "rejects-push-targeting-protected-main-branch",
      rawProposal: JSON.stringify({
        operation: "push_task_branch",
        repository: "acme-org/payments",
        target_branch: "main",
        commit_message: "attempt direct push to main",
        changed_files: ["src/index.ts"]
      }),
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "PROTECTED_BRANCH_FORBIDDEN"
    },
    {
      id: "rejects-push-targeting-protected-dev-branch",
      rawProposal: JSON.stringify({
        operation: "push_task_branch",
        repository: "acme-org/payments",
        target_branch: "refs/heads/dev",
        commit_message: "attempt direct push to dev",
        changed_files: ["src/index.ts"]
      }),
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "PROTECTED_BRANCH_FORBIDDEN"
    },
    {
      id: "rejects-pull-request-targeting-protected-main-or-dev-branch",
      rawProposal: JSON.stringify({
        operation: "open_pull_request",
        repository: "acme-org/payments",
        head_branch: "task/6-isolated-publisher",
        base_branch: "dev",
        title: "bypass feature branch",
        body: "attempt PR straight to dev"
      }),
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "PROTECTED_BRANCH_FORBIDDEN"
    },
    {
      id: "rejects-comment-targeting-unassigned-issue-number",
      rawProposal: JSON.stringify({
        operation: "comment_issue",
        repository: "acme-org/payments",
        issue_number: 999,
        body: "Commenting on wrong issue"
      }),
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "OUT_OF_SCOPE_TARGET"
    },
    {
      id: "rejects-push-to-unassigned-task-branch",
      rawProposal: JSON.stringify({
        operation: "push_task_branch",
        repository: "acme-org/payments",
        target_branch: "task/99-other-ticket",
        commit_message: "touch another ticket branch",
        changed_files: ["src/index.ts"]
      }),
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "OUT_OF_SCOPE_TARGET"
    },
    {
      id: "rejects-modifying-github-workflows-without-explicit-human-authorization",
      rawProposal: JSON.stringify({
        operation: "push_task_branch",
        repository: "acme-org/payments",
        target_branch: "task/6-isolated-publisher",
        commit_message: "sneak workflow modification",
        changed_files: [".github/workflows/release.yml"]
      }),
      scope: baseScope,
      expectedValid: false,
      expectedErrorCode: "SENSITIVE_PATH_OUT_OF_SCOPE"
    }
  ])("$id", ({ rawProposal, scope, expectedValid, expectedErrorCode }) => {
    const result = validateAgentProposal(rawProposal, scope);
    expect(result.valid).toBe(expectedValid);
    expect(result.error_code).toBe(expectedErrorCode);
  });
});

describe("3. Short-lived repository-scoped & permission-scoped installation token lifecycle (publishAgentProposal)", () => {
  it.each([
    {
      id: "scopes-comment-issue-token-solely-to-issues-write",
      operation: "comment_issue" as const,
      expectedPermissions: { issues: "write" }
    },
    {
      id: "scopes-push-task-branch-token-solely-to-contents-write",
      operation: "push_task_branch" as const,
      expectedPermissions: { contents: "write" }
    },
    {
      id: "scopes-open-pull-request-token-to-pull-requests-write-and-contents-read",
      operation: "open_pull_request" as const,
      expectedPermissions: { pull_requests: "write", contents: "read" }
    },
    {
      id: "scopes-publish-check-run-token-solely-to-checks-write",
      operation: "publish_check_run" as const,
      expectedPermissions: { checks: "write" }
    }
  ])("$id", ({ operation, expectedPermissions }) => {
    expect(computeMinimalInstallationPermissions(operation)).toEqual(
      expectedPermissions
    );
  });

  it("mints a repo-scoped installation token, applies a valid proposal, revokes the token immediately, and never leaks the token in outputs", async () => {
    const lifecycleEvents: string[] = [];
    let capturedTokenScope: {
      repositoryIds: readonly number[];
      permissions: Readonly<Record<string, "read" | "write">>;
    } | null = null;
    const EphemeralToken = "ghs_ephemeralScopedToken9876543210";

    const result = await publishAgentProposal({
      rawProposal: JSON.stringify({
        operation: "push_task_branch",
        repository: "acme-org/payments",
        target_branch: "task/6-isolated-publisher",
        commit_message: "feat: implement isolated publisher",
        changed_files: ["src/publisher/isolated-publisher.ts"]
      }),
      scope: {
        repository: "acme-org/payments",
        repositoryId: 4242,
        assignedIssueNumber: 6,
        assignedBranchPrefix: "task/6-",
        allowedTargetFeatureBranch: "feature/1-epure-v1"
      },
      agentEnvSnapshot: {
        PATH: "/usr/bin"
      },
      publisherClient: {
        requestScopedInstallationToken: async (req) => {
          capturedTokenScope = req;
          lifecycleEvents.push("mint_token");
          return {
            token: EphemeralToken,
            expiresAt: "2026-10-23T19:30:00Z"
          };
        },
        applyValidatedOperation: async (proposal, token) => {
          expect(token).toBe(EphemeralToken);
          expect(proposal.operation).toBe("push_task_branch");
          lifecycleEvents.push("apply_operation");
          return {
            artifactUrl:
              "https://github.com/acme-org/payments/commit/11223344556677889900aabbccddeeff00112233",
            commitSha: "11223344556677889900aabbccddeeff00112233"
          };
        },
        revokeInstallationToken: async (token) => {
          expect(token).toBe(EphemeralToken);
          lifecycleEvents.push("revoke_token");
        }
      }
    });

    expect(result.published).toBe(true);
    expect(result.error_code).toBe("NONE");
    expect(result.token_revoked).toBe(true);
    expect(result.artifact_url).toBe(
      "https://github.com/acme-org/payments/commit/11223344556677889900aabbccddeeff00112233"
    );
    expect(lifecycleEvents).toEqual([
      "mint_token",
      "apply_operation",
      "revoke_token"
    ]);
    expect(capturedTokenScope).toEqual({
      repositoryIds: [4242],
      permissions: { contents: "write" }
    });
    expect(JSON.stringify(result)).not.toContain(EphemeralToken);
  });
});

describe("4. Pre-bundled Custom Action (actions/publish-agent-output)", () => {
  it("bundles actions/publish-agent-output into dist/actions/publish-agent-output/index.mjs", () => {
    expect(existsSync(BUNDLED_PUBLISHER_ACTION_PATH)).toBe(true);
    expect(existsSync(PUBLISHER_ACTION_MANIFEST_PATH)).toBe(true);
  });

  it.each([
    {
      id: "action-publishes-valid-task-branch-proposal-and-revokes-ephemeral-token",
      inputs: {
        INPUT_REPOSITORY: "acme-org/payments",
        INPUT_REPOSITORY_ID: "4242",
        INPUT_ASSIGNED_ISSUE_NUMBER: "6",
        INPUT_ASSIGNED_BRANCH_PREFIX: "task/6-",
        INPUT_ALLOWED_TARGET_FEATURE_BRANCH: "feature/1-epure-v1",
        INPUT_PROPOSAL_JSON: JSON.stringify({
          operation: "comment_issue",
          repository: "acme-org/payments",
          issue_number: 6,
          body: "Verified comment via isolated publisher."
        })
      },
      expectedExitCode: 0,
      expectedOutputs: {
        published: "true",
        operation: "comment_issue",
        error_code: "NONE",
        token_revoked: "true"
      }
    },
    {
      id: "action-rejects-push-to-protected-main-branch",
      inputs: {
        INPUT_REPOSITORY: "acme-org/payments",
        INPUT_REPOSITORY_ID: "4242",
        INPUT_ASSIGNED_ISSUE_NUMBER: "6",
        INPUT_ASSIGNED_BRANCH_PREFIX: "task/6-",
        INPUT_ALLOWED_TARGET_FEATURE_BRANCH: "feature/1-epure-v1",
        INPUT_PROPOSAL_JSON: JSON.stringify({
          operation: "push_task_branch",
          repository: "acme-org/payments",
          target_branch: "main",
          commit_message: "illegal push to main",
          changed_files: ["src/index.ts"]
        })
      },
      expectedExitCode: 1,
      expectedOutputs: {
        published: "false",
        error_code: "PROTECTED_BRANCH_FORBIDDEN"
      }
    },
    {
      id: "action-rejects-execution-when-agent-env-leaked-private-key",
      inputs: {
        INPUT_REPOSITORY: "acme-org/payments",
        INPUT_REPOSITORY_ID: "4242",
        INPUT_ASSIGNED_ISSUE_NUMBER: "6",
        INPUT_ASSIGNED_BRANCH_PREFIX: "task/6-",
        INPUT_ALLOWED_TARGET_FEATURE_BRANCH: "feature/1-epure-v1",
        INPUT_AGENT_ENV_JSON: JSON.stringify({
          EPURE_AGENT_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nleaked\n-----END RSA PRIVATE KEY-----"
        }),
        INPUT_PROPOSAL_JSON: JSON.stringify({
          operation: "comment_issue",
          repository: "acme-org/payments",
          issue_number: 6,
          body: "Hello"
        })
      },
      expectedExitCode: 1,
      expectedOutputs: {
        published: "false",
        error_code: "AGENT_ENV_PRIVATE_KEY_FORBIDDEN"
      }
    }
  ])("$id", ({ inputs, expectedExitCode, expectedOutputs }) => {
    const res = invokePublisherActionIsolated(inputs);
    expect(res.exitCode).toBe(expectedExitCode);
    expect(res.outputs).toMatchObject(expectedOutputs);
  });
});
