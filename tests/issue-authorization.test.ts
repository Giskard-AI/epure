import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateIssueCommandGate,
  fetchEffectiveRepositoryPermission,
  parseEpureCommand,
  redactSecrets
} from "../src/auth/issue-command-gate.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_AUTHORIZE_ACTION_PATH = join(
  ROOT_DIR,
  "dist",
  "actions",
  "authorize-command",
  "index.mjs"
);
const AUTHORIZE_ACTION_MANIFEST_PATH = join(
  ROOT_DIR,
  "actions",
  "authorize-command",
  "action.yml"
);
const ISSUE_COMMAND_WORKFLOW_PATH = join(
  ROOT_DIR,
  ".github",
  "workflows",
  "issue-command.yml"
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

function invokeAuthorizeActionIsolated(inputs: Record<string, string>): ActionRunResult {
  const isolatedDir = mkdtempSync(join(tmpdir(), "epure-authorize-command-"));
  try {
    const isolatedBundle = join(isolatedDir, "index.mjs");
    const outputFile = join(isolatedDir, "github_output.txt");
    const summaryFile = join(isolatedDir, "github_summary.md");
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(summaryFile, "", "utf8");
    copyFileSync(BUNDLED_AUTHORIZE_ACTION_PATH, isolatedBundle);

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

describe("Command parser (parseEpureCommand)", () => {
  it.each([
    {
      id: "parses-epure-status-command",
      body: "/epure status",
      expected: { command: "status", args: "" }
    },
    {
      id: "parses-epure-plan-command-with-arguments",
      body: "Please run this:\n/epure plan --scope v1",
      expected: { command: "plan", args: "--scope v1" }
    },
    {
      id: "parses-epure-approve-command",
      body: "/epure approve",
      expected: { command: "approve", args: "" }
    },
    {
      id: "parses-epure-cancel-command",
      body: "/epure cancel",
      expected: { command: "cancel", args: "" }
    },
    {
      id: "ignores-command-inside-fenced-code-block",
      body: "Example usage:\n```text\n/epure plan\n```\nJust a regular comment.",
      expected: null
    },
    {
      id: "returns-null-on-ordinary-discussion-comment",
      body: "I think we should refactor this module.",
      expected: null
    }
  ])("$id", ({ body, expected }) => {
    expect(parseEpureCommand(body)).toEqual(expected);
  });
});

describe("Effective permission gate, misleading signals, and bot loop prevention (evaluateIssueCommandGate)", () => {
  it.each([
    {
      id: "accepts-user-with-effective-write-permission-for-status-command",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure status",
        actor: { login: "alice-dev", type: "User" },
        authorAssociation: "NONE",
        issueLabels: [],
        effectivePermission: { permission: "write", role_name: "write" }
      },
      expected: {
        authorized: true,
        decision: "authorized",
        error_code: "NONE",
        command: "status",
        effective_permission: "write",
        privileged_action_allowed: true,
        should_post_response: true
      }
    },
    {
      id: "accepts-user-with-effective-admin-permission-for-plan-command",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure plan",
        actor: { login: "bob-admin", type: "User" },
        authorAssociation: "OWNER",
        issueLabels: ["ready-for-agent"],
        effectivePermission: { permission: "admin", role_name: "admin" }
      },
      expected: {
        authorized: true,
        decision: "authorized",
        error_code: "NONE",
        command: "plan",
        effective_permission: "admin",
        privileged_action_allowed: true,
        llm_call_allowed: true,
        should_post_response: true
      }
    },
    {
      id: "accepts-user-with-maintain-role-name-for-approve-command",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure approve",
        actor: { login: "carol-maint", type: "User" },
        effectivePermission: { permission: "write", role_name: "maintain" }
      },
      expected: {
        authorized: true,
        decision: "authorized",
        error_code: "NONE",
        command: "approve",
        effective_permission: "maintain",
        privileged_action_allowed: true,
        should_post_response: true
      }
    },
    {
      id: "rejects-read-user-despite-collaborator-author-association-and-misleading-labels",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure plan",
        actor: { login: "mallory-reader", type: "User" },
        authorAssociation: "COLLABORATOR",
        issueLabels: ["ready-for-agent", "approved", "write-verified"],
        effectivePermission: { permission: "read", role_name: "read" }
      },
      expected: {
        authorized: false,
        decision: "denied_insufficient_permission",
        error_code: "INSUFFICIENT_EFFECTIVE_PERMISSION",
        command: "plan",
        effective_permission: "read",
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: true
      }
    },
    {
      id: "rejects-triage-user-despite-contributor-author-association-and-ready-for-agent-label",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure status",
        actor: { login: "triage-user", type: "User" },
        authorAssociation: "CONTRIBUTOR",
        issueLabels: ["ready-for-agent"],
        effectivePermission: { permission: "read", role_name: "triage" }
      },
      expected: {
        authorized: false,
        decision: "denied_insufficient_permission",
        error_code: "INSUFFICIENT_EFFECTIVE_PERMISSION",
        command: "status",
        effective_permission: "triage",
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: true
      }
    },
    {
      id: "rejects-none-permission-user-despite-member-association",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure approve",
        actor: { login: "external-user", type: "User" },
        authorAssociation: "MEMBER",
        issueLabels: ["approved"],
        effectivePermission: { permission: "none", role_name: "none" }
      },
      expected: {
        authorized: false,
        decision: "denied_insufficient_permission",
        error_code: "INSUFFICIENT_EFFECTIVE_PERMISSION",
        command: "approve",
        effective_permission: "none",
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: true
      }
    },
    {
      id: "ignores-bot-user-type-without-triggering-loop-or-response",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure plan",
        actor: { login: "custom-automation", type: "Bot" },
        authorAssociation: "COLLABORATOR",
        issueLabels: ["ready-for-agent"],
        effectivePermission: { permission: "write", role_name: "write" }
      },
      expected: {
        authorized: false,
        decision: "ignored_bot",
        error_code: "BOT_ACTOR_IGNORED",
        command: null,
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: false
      }
    },
    {
      id: "ignores-login-ending-with-bot-suffix-to-prevent-agent-loops",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure status",
        actor: { login: "epure-agent[bot]", type: "User" },
        effectivePermission: { permission: "admin", role_name: "admin" }
      },
      expected: {
        authorized: false,
        decision: "ignored_bot",
        error_code: "BOT_ACTOR_IGNORED",
        command: null,
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: false
      }
    },
    {
      id: "ignores-known-automation-app-actor-even-without-bot-suffix",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure approve",
        actor: { login: "github-actions", type: "User" },
        effectivePermission: { permission: "write", role_name: "write" }
      },
      expected: {
        authorized: false,
        decision: "ignored_bot",
        error_code: "BOT_ACTOR_IGNORED",
        command: null,
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: false
      }
    },
    {
      id: "rejects-unsupported-epure-subcommand-without-privileged-action",
      input: {
        repository: "acme-org/demo-repo",
        issueNumber: 42,
        commentBody: "/epure deploy-prod",
        actor: { login: "alice-dev", type: "User" },
        effectivePermission: { permission: "admin", role_name: "admin" }
      },
      expected: {
        authorized: false,
        decision: "denied_unsupported_command",
        error_code: "UNSUPPORTED_COMMAND",
        command: null,
        privileged_action_allowed: false,
        llm_call_allowed: false,
        should_post_response: true
      }
    }
  ])("$id", async ({ input, expected }) => {
    const result = await evaluateIssueCommandGate(input);
    expect(result).toMatchObject(expected);
  });

  it("queries GitHub Collaborators Permission API via verifyPermission callback and skips API call for bots", async () => {
    const verifySpy = vi.fn().mockResolvedValue({
      permission: "write",
      role_name: "write"
    });

    const botResult = await evaluateIssueCommandGate({
      repository: "acme-org/demo-repo",
      issueNumber: 7,
      commentBody: "/epure status",
      actor: { login: "epure-agent[bot]", type: "Bot" },
      verifyPermission: verifySpy
    });
    expect(botResult.decision).toBe("ignored_bot");
    expect(verifySpy).not.toHaveBeenCalled();

    const humanResult = await evaluateIssueCommandGate({
      repository: "acme-org/demo-repo",
      issueNumber: 7,
      commentBody: "/epure status",
      actor: { login: "maintainer-jane", type: "User" },
      verifyPermission: verifySpy
    });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith("acme-org/demo-repo", "maintainer-jane");
    expect(humanResult.authorized).toBe(true);
  });

  it("calls GET /repos/{owner}/{repo}/collaborators/{username}/permission via fetchEffectiveRepositoryPermission", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ permission: "write", role_name: "write" })
    });

    const perm = await fetchEffectiveRepositoryPermission({
      repository: "Giskard-AI/epure",
      username: "octocat",
      githubToken: "ghs_testSecretToken1234567890",
      fetchImpl: mockFetch as unknown as typeof fetch
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/Giskard-AI/epure/collaborators/octocat/permission",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer ghs_testSecretToken1234567890",
          Accept: "application/vnd.github+json"
        })
      })
    );
    expect(perm).toEqual({ permission: "write", role_name: "write" });
  });
});

describe("Secret scrubbing in diagnostic and refusal outputs (redactSecrets)", () => {
  it.each([
    {
      id: "scrubs-github-installation-and-pat-tokens",
      raw: "Failed with token ghs_1234567890abcdefABCDEF1234567890ab and github_pat_11AABBCCDD_secretValue123456789",
      extra: [],
      forbidden: ["ghs_1234567890abcdefABCDEF1234567890ab", "github_pat_11AABBCCDD_secretValue123456789"]
    },
    {
      id: "scrubs-authorization-bearer-headers-and-llm-api-keys",
      raw: "Header Authorization: Bearer ghp_secretToken9876543210 and LLM key sk-ant-api03-secretKeyValue123456",
      extra: [],
      forbidden: ["ghp_secretToken9876543210", "sk-ant-api03-secretKeyValue123456"]
    },
    {
      id: "scrubs-explicit-custom-secret-values",
      raw: "Diagnostic error referencing custom secret MY_CUSTOM_SECRET_VALUE_999",
      extra: ["MY_CUSTOM_SECRET_VALUE_999"],
      forbidden: ["MY_CUSTOM_SECRET_VALUE_999"]
    }
  ])("$id", ({ raw, extra, forbidden }) => {
    const scrubbed = redactSecrets(raw, extra);
    expect(scrubbed).toContain("[REDACTED]");
    for (const secret of forbidden) {
      expect(scrubbed).not.toContain(secret);
    }
  });

  it("never leaks tokens in evaluateIssueCommandGate diagnostic or response markdown", async () => {
    const leakedToken = "ghs_SuperSecretInstallationTokenValue123456";
    const result = await evaluateIssueCommandGate({
      repository: "acme-org/demo-repo",
      issueNumber: 12,
      commentBody: `/epure status ${leakedToken}`,
      actor: { login: "reader-bob", type: "User" },
      effectivePermission: { permission: "read", role_name: "read" },
      secretsToRedact: [leakedToken]
    });

    expect(result.error_message).not.toContain(leakedToken);
    expect(result.response_markdown).not.toContain(leakedToken);
  });
});

describe("Pre-bundled Custom Action (actions/authorize-command) and Reusable Workflow (.github/workflows/issue-command.yml)", () => {
  it("bundles actions/authorize-command into dist/actions/authorize-command/index.mjs", () => {
    expect(existsSync(BUNDLED_AUTHORIZE_ACTION_PATH)).toBe(true);
    expect(existsSync(AUTHORIZE_ACTION_MANIFEST_PATH)).toBe(true);
    expect(existsSync(ISSUE_COMMAND_WORKFLOW_PATH)).toBe(true);
  });

  it.each([
    {
      id: "bundled-action-authorizes-write-user-and-scrubs-tokens",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-repo",
        INPUT_ISSUE_NUMBER: "15",
        INPUT_COMMENT_BODY: "/epure status",
        INPUT_ACTOR: "alice-maintainer",
        INPUT_ACTOR_TYPE: "User",
        INPUT_AUTHOR_ASSOCIATION: "COLLABORATOR",
        INPUT_EFFECTIVE_PERMISSION: "write"
      },
      expectedExitCode: 0,
      expectedOutputs: {
        authorized: "true",
        decision: "authorized",
        command: "status",
        effective_permission: "write",
        error_code: "NONE",
        privileged_action_allowed: "true"
      }
    },
    {
      id: "bundled-action-denies-read-user-even-with-collaborator-association-and-ready-label",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-repo",
        INPUT_ISSUE_NUMBER: "15",
        INPUT_COMMENT_BODY: "/epure plan",
        INPUT_ACTOR: "mallory-reader",
        INPUT_ACTOR_TYPE: "User",
        INPUT_AUTHOR_ASSOCIATION: "COLLABORATOR",
        INPUT_ISSUE_LABELS: "ready-for-agent,approved",
        INPUT_EFFECTIVE_PERMISSION: "read"
      },
      expectedExitCode: 1,
      expectedOutputs: {
        authorized: "false",
        decision: "denied_insufficient_permission",
        command: "plan",
        effective_permission: "read",
        error_code: "INSUFFICIENT_EFFECTIVE_PERMISSION",
        privileged_action_allowed: "false",
        llm_call_allowed: "false"
      }
    },
    {
      id: "bundled-action-ignores-bot-comments-cleanly-without-looping",
      inputs: {
        INPUT_REPOSITORY: "acme-org/demo-repo",
        INPUT_ISSUE_NUMBER: "15",
        INPUT_COMMENT_BODY: "/epure status",
        INPUT_ACTOR: "epure-agent[bot]",
        INPUT_ACTOR_TYPE: "Bot",
        INPUT_EFFECTIVE_PERMISSION: "write"
      },
      expectedExitCode: 0,
      expectedOutputs: {
        authorized: "false",
        decision: "ignored_bot",
        error_code: "BOT_ACTOR_IGNORED",
        privileged_action_allowed: "false",
        llm_call_allowed: "false",
        should_post_response: "false"
      }
    }
  ])("$id", ({ inputs, expectedExitCode, expectedOutputs }) => {
    const result = invokeAuthorizeActionIsolated(inputs);
    expect(result.exitCode).toBe(expectedExitCode);
    expect(result.outputs).toMatchObject(expectedOutputs);
  });
});
