import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildConsumerAppManifests,
  generateAppSetupGuide,
  verifyAppRoleBoundary
} from "../src/auth/github-apps.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_VERIFY_ROLE_ACTION_PATH = join(
  ROOT_DIR,
  "dist",
  "actions",
  "verify-app-role",
  "index.mjs"
);
const VERIFY_ROLE_ACTION_MANIFEST_PATH = join(
  ROOT_DIR,
  "actions",
  "verify-app-role",
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

function invokeVerifyRoleActionIsolated(inputs: Record<string, string>): ActionRunResult {
  const isolatedDir = mkdtempSync(join(tmpdir(), "epure-verify-app-role-"));
  try {
    const isolatedBundle = join(isolatedDir, "index.mjs");
    const outputFile = join(isolatedDir, "github_output.txt");
    const summaryFile = join(isolatedDir, "github_summary.md");
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(summaryFile, "", "utf8");
    copyFileSync(BUNDLED_VERIFY_ROLE_ACTION_PATH, isolatedBundle);

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

describe("Dual GitHub App manifests and setup guide (buildConsumerAppManifests & generateAppSetupGuide)", () => {
  it("generates two distinct GitHub App manifests with separated permissions and secret namespaces", () => {
    const manifests = buildConsumerAppManifests({
      ownerSlug: "acme-org",
      repository: "acme-org/payments"
    });

    expect(manifests.agentApp.role).toBe("agent");
    expect(manifests.releaseApp.role).toBe("release");
    expect(manifests.agentApp.name).not.toBe(manifests.releaseApp.name);
    expect(manifests.agentApp.secretNames.appId).toBe("EPURE_AGENT_APP_ID");
    expect(manifests.agentApp.secretNames.privateKey).toBe("EPURE_AGENT_APP_PRIVATE_KEY");
    expect(manifests.releaseApp.secretNames.appId).toBe("EPURE_RELEASE_APP_ID");
    expect(manifests.releaseApp.secretNames.privateKey).toBe("EPURE_RELEASE_APP_PRIVATE_KEY");

    expect(manifests.agentApp.default_permissions).toMatchObject({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "write"
    });
    expect(manifests.releaseApp.default_permissions).toMatchObject({
      contents: "write",
      metadata: "read"
    });
    expect(manifests.releaseApp.default_permissions.issues).toBeUndefined();
    expect(manifests.releaseApp.requiredEnvironment).toBe("release");
  });

  it.each([
    {
      id: "requires-explicit-human-confirmation-before-granting-elevated-app-permissions",
      params: {
        ownerSlug: "acme-org",
        repository: "acme-org/payments",
        humanConfirmed: false
      },
      expectedStatus: "awaiting_human_confirmation",
      expectedErrorCode: "HUMAN_CONFIRMATION_REQUIRED"
    },
    {
      id: "succeeds-when-human-confirmation-is-explicitly-granted",
      params: {
        ownerSlug: "acme-org",
        repository: "acme-org/payments",
        humanConfirmed: true
      },
      expectedStatus: "ready",
      expectedErrorCode: "NONE"
    },
    {
      id: "rejects-and-redacts-pem-private-key-in-prompt-or-issue-payload",
      params: {
        ownerSlug: "acme-org",
        repository: "acme-org/payments",
        humanConfirmed: true,
        extraTextToScan:
          "Here is my key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----"
      },
      expectedStatus: "error",
      expectedErrorCode: "PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD"
    }
  ])("$id", ({ params, expectedStatus, expectedErrorCode }) => {
    const guide = generateAppSetupGuide(params);
    expect(guide.status).toBe(expectedStatus);
    expect(guide.error_code).toBe(expectedErrorCode);
    expect(guide.guide_markdown).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(guide.guide_markdown).not.toContain("MIIEowIBAAKCAQEA1234567890abcdef");
  });
});

describe("Privilege separation between Agent App and Release App (verifyAppRoleBoundary)", () => {
  it.each([
    {
      id: "allows-agent-app-to-post-authorized-issue-comment",
      input: {
        appRole: "agent" as const,
        operation: "issue_comment" as const,
        workflowPath: ".github/workflows/issue-command.yml",
        agentAppId: "10001",
        releaseAppId: "10002"
      },
      expected: {
        allowed: true,
        error_code: "NONE",
        app_role: "agent",
        operation: "issue_comment"
      }
    },
    {
      id: "allows-agent-app-to-push-task-feature-and-plan-branches",
      input: {
        appRole: "agent" as const,
        operation: "push_branch" as const,
        targetRef: "refs/heads/task/3-authorized-issue-command",
        workflowPath: ".github/workflows/agent-execute.yml",
        agentAppId: "10001",
        releaseAppId: "10002"
      },
      expected: {
        allowed: true,
        error_code: "NONE",
        app_role: "agent",
        operation: "push_branch"
      }
    },
    {
      id: "forbids-agent-app-from-promoting-dev-to-main-release",
      input: {
        appRole: "agent" as const,
        operation: "promote_dev_to_main" as const,
        targetRef: "refs/heads/main",
        workflowPath: ".github/workflows/release.yml",
        environmentName: "release"
      },
      expected: {
        allowed: false,
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN",
        app_role: "agent",
        operation: "promote_dev_to_main"
      }
    },
    {
      id: "forbids-agent-app-from-creating-immutable-release-tags",
      input: {
        appRole: "agent" as const,
        operation: "create_release_tag" as const,
        targetRef: "refs/tags/v1.0.0",
        workflowPath: ".github/workflows/agent-execute.yml"
      },
      expected: {
        allowed: false,
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN",
        app_role: "agent",
        operation: "create_release_tag"
      }
    },
    {
      id: "forbids-agent-app-from-publishing-github-release",
      input: {
        appRole: "agent" as const,
        operation: "publish_github_release" as const,
        targetRef: "refs/tags/v1.0.0"
      },
      expected: {
        allowed: false,
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN",
        app_role: "agent",
        operation: "publish_github_release"
      }
    },
    {
      id: "forbids-agent-app-from-pushing-directly-to-main-or-dev-branches",
      input: {
        appRole: "agent" as const,
        operation: "push_branch" as const,
        targetRef: "refs/heads/main"
      },
      expected: {
        allowed: false,
        error_code: "AGENT_APP_PROTECTED_REF_FORBIDDEN",
        app_role: "agent",
        operation: "push_branch"
      }
    },
    {
      id: "allows-release-app-inside-protected-release-workflow-and-release-environment",
      input: {
        appRole: "release" as const,
        operation: "publish_github_release" as const,
        targetRef: "refs/tags/v1.2.0",
        workflowPath: ".github/workflows/release.yml",
        environmentName: "release",
        agentAppId: "10001",
        releaseAppId: "10002"
      },
      expected: {
        allowed: true,
        error_code: "NONE",
        app_role: "release",
        operation: "publish_github_release"
      }
    },
    {
      id: "forbids-release-app-when-invoked-outside-protected-release-workflow",
      input: {
        appRole: "release" as const,
        operation: "publish_github_release" as const,
        targetRef: "refs/tags/v1.2.0",
        workflowPath: ".github/workflows/issue-command.yml",
        environmentName: "release"
      },
      expected: {
        allowed: false,
        error_code: "RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN",
        app_role: "release",
        operation: "publish_github_release"
      }
    },
    {
      id: "forbids-release-app-when-release-environment-is-missing",
      input: {
        appRole: "release" as const,
        operation: "promote_dev_to_main" as const,
        targetRef: "refs/heads/main",
        workflowPath: ".github/workflows/release.yml",
        environmentName: ""
      },
      expected: {
        allowed: false,
        error_code: "RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN",
        app_role: "release",
        operation: "promote_dev_to_main"
      }
    },
    {
      id: "forbids-reusing-same-github-app-id-for-both-agent-and-release-roles",
      input: {
        appRole: "agent" as const,
        operation: "issue_comment" as const,
        agentAppId: "99999",
        releaseAppId: "99999"
      },
      expected: {
        allowed: false,
        error_code: "IDENTICAL_APP_IDENTITY_FORBIDDEN"
      }
    },
    {
      id: "requires-explicit-human-confirmation-for-elevated-permission-grant",
      input: {
        appRole: "agent" as const,
        operation: "grant_elevated_permission" as const,
        humanConfirmed: false
      },
      expected: {
        allowed: false,
        error_code: "HUMAN_CONFIRMATION_REQUIRED"
      }
    },
    {
      id: "allows-elevated-permission-grant-only-when-human-confirmed-true",
      input: {
        appRole: "agent" as const,
        operation: "grant_elevated_permission" as const,
        humanConfirmed: true
      },
      expected: {
        allowed: true,
        error_code: "NONE"
      }
    },
    {
      id: "rejects-private-key-material-leaked-in-public-payload",
      input: {
        appRole: "agent" as const,
        operation: "issue_comment" as const,
        publicPayloadText:
          "Comment body with -----BEGIN PRIVATE KEY-----\nabcdef123456\n-----END PRIVATE KEY-----"
      },
      expected: {
        allowed: false,
        error_code: "PRIVATE_KEY_EXPOSED_IN_PUBLIC_PAYLOAD"
      }
    }
  ])("$id", ({ input, expected }) => {
    const result = verifyAppRoleBoundary(input);
    expect(result).toMatchObject(expected);
    expect(result.error_message).not.toContain("BEGIN PRIVATE KEY");
  });
});

describe("Pre-bundled Custom Action (actions/verify-app-role)", () => {
  it("bundles actions/verify-app-role into dist/actions/verify-app-role/index.mjs", () => {
    expect(existsSync(BUNDLED_VERIFY_ROLE_ACTION_PATH)).toBe(true);
    expect(existsSync(VERIFY_ROLE_ACTION_MANIFEST_PATH)).toBe(true);
  });

  it.each([
    {
      id: "action-allows-agent-app-comment-and-forbids-release-capabilities",
      inputs: {
        INPUT_APP_ROLE: "agent",
        INPUT_OPERATION: "issue_comment",
        INPUT_AGENT_APP_ID: "101",
        INPUT_RELEASE_APP_ID: "202"
      },
      expectedExitCode: 0,
      expectedOutputs: {
        allowed: "true",
        app_role: "agent",
        operation: "issue_comment",
        error_code: "NONE"
      }
    },
    {
      id: "action-blocks-agent-app-from-publishing-release",
      inputs: {
        INPUT_APP_ROLE: "agent",
        INPUT_OPERATION: "publish_github_release",
        INPUT_TARGET_REF: "refs/tags/v1.0.0"
      },
      expectedExitCode: 1,
      expectedOutputs: {
        allowed: "false",
        app_role: "agent",
        operation: "publish_github_release",
        error_code: "AGENT_APP_RELEASE_OPERATION_FORBIDDEN"
      }
    },
    {
      id: "action-blocks-release-app-outside-protected-release-workflow",
      inputs: {
        INPUT_APP_ROLE: "release",
        INPUT_OPERATION: "promote_dev_to_main",
        INPUT_TARGET_REF: "refs/heads/main",
        INPUT_WORKFLOW_PATH: ".github/workflows/ci.yml",
        INPUT_ENVIRONMENT_NAME: ""
      },
      expectedExitCode: 1,
      expectedOutputs: {
        allowed: "false",
        app_role: "release",
        operation: "promote_dev_to_main",
        error_code: "RELEASE_APP_OUTSIDE_RELEASE_WORKFLOW_FORBIDDEN"
      }
    },
    {
      id: "action-blocks-elevated-permission-grant-without-human-confirmation",
      inputs: {
        INPUT_APP_ROLE: "agent",
        INPUT_OPERATION: "grant_elevated_permission",
        INPUT_HUMAN_CONFIRMED: "false"
      },
      expectedExitCode: 1,
      expectedOutputs: {
        allowed: "false",
        error_code: "HUMAN_CONFIRMATION_REQUIRED"
      }
    }
  ])("$id", ({ inputs, expectedExitCode, expectedOutputs }) => {
    const result = invokeVerifyRoleActionIsolated(inputs);
    expect(result.exitCode).toBe(expectedExitCode);
    expect(result.outputs).toMatchObject(expectedOutputs);
  });
});
