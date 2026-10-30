import { describe, expect, it } from "vitest";
import {
  CodexHarnessAdapter,
  PiHarnessAdapter,
  resolveHarnessFromAgentsConfig,
  runTicketWithHarness,
  type TicketExecutionInput
} from "../src/harness/agent-harness.js";

describe("Ticket 07 (#8) — Pi agent harness execution & isolated PR publication", () => {
  const BASE_RUNNER_ENV: Readonly<Record<string, string>> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    OPENAI_API_KEY: "sk-proj-TestPiRunnerKey1234567890ABCDEF"
  };

  it.each([
    {
      id: "pi-implements-approved-ticket-and-opens-pr-on-feature-branch",
      input: {
        harness: "pi",
        repository: "Giskard-AI/consumer-app",
        repositoryId: 7001,
        planIssueNumber: 1,
        ticketIssueNumber: 8,
        ticketSlug: "pi-agent-harness",
        ticketTitle: "Implement first ticket with Pi",
        acceptanceCriteria: [
          "Adds healthcheck endpoint",
          "Passes unit tests"
        ],
        approvedByHuman: true,
        targetFeatureBranch: "feature/1-v1",
        changedFiles: ["src/health.ts", "tests/health.test.ts"],
        isolationAvailable: true,
        runnerEnv: BASE_RUNNER_ENV
      } satisfies TicketExecutionInput,
      expectedSuccess: true,
      expectedErrorCode: "NONE",
      expectedHarnessUsed: "pi",
      expectedTaskBranch: "task/8-pi-agent-harness"
    },
    {
      id: "pi-rejects-unapproved-ticket-before-running-llm",
      input: {
        harness: "pi",
        repository: "Giskard-AI/consumer-app",
        repositoryId: 7001,
        planIssueNumber: 1,
        ticketIssueNumber: 8,
        ticketSlug: "pi-agent-harness",
        ticketTitle: "Unapproved ticket",
        acceptanceCriteria: ["Should not execute"],
        approvedByHuman: false,
        targetFeatureBranch: "feature/1-v1",
        changedFiles: ["src/health.ts"],
        isolationAvailable: true,
        runnerEnv: BASE_RUNNER_ENV
      } satisfies TicketExecutionInput,
      expectedSuccess: false,
      expectedErrorCode: "TICKET_NOT_APPROVED_BY_HUMAN",
      expectedHarnessUsed: "pi",
      expectedTaskBranch: "task/8-pi-agent-harness"
    },
    {
      id: "pi-rejects-direct-target-to-protected-dev-or-main",
      input: {
        harness: "pi",
        repository: "Giskard-AI/consumer-app",
        repositoryId: 7001,
        planIssueNumber: 1,
        ticketIssueNumber: 8,
        ticketSlug: "pi-agent-harness",
        ticketTitle: "Invalid target branch",
        acceptanceCriteria: ["Should be blocked by publisher"],
        approvedByHuman: true,
        targetFeatureBranch: "dev",
        changedFiles: ["src/health.ts"],
        isolationAvailable: true,
        runnerEnv: BASE_RUNNER_ENV
      } satisfies TicketExecutionInput,
      expectedSuccess: false,
      expectedErrorCode: "PROTECTED_BRANCH_FORBIDDEN",
      expectedHarnessUsed: "pi",
      expectedTaskBranch: "task/8-pi-agent-harness"
    },
    {
      id: "pi-fails-closed-when-sandbox-isolation-unavailable",
      input: {
        harness: "pi",
        repository: "Giskard-AI/consumer-app",
        repositoryId: 7001,
        planIssueNumber: 1,
        ticketIssueNumber: 8,
        ticketSlug: "pi-agent-harness",
        ticketTitle: "No sandbox",
        acceptanceCriteria: ["Should fail closed"],
        approvedByHuman: true,
        targetFeatureBranch: "feature/1-v1",
        changedFiles: ["src/health.ts"],
        isolationAvailable: false,
        runnerEnv: BASE_RUNNER_ENV
      } satisfies TicketExecutionInput,
      expectedSuccess: false,
      expectedErrorCode: "SANDBOX_ISOLATION_UNAVAILABLE",
      expectedHarnessUsed: "pi",
      expectedTaskBranch: "task/8-pi-agent-harness"
    }
  ])(
    "runTicketWithHarness [$id]: executes Pi inside sandbox and publishes PR via isolated publisher",
    async ({
      input,
      expectedSuccess,
      expectedErrorCode,
      expectedHarnessUsed,
      expectedTaskBranch
    }) => {
      const result = await runTicketWithHarness(input);
      expect(result.completed).toBe(expectedSuccess);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.harness).toBe(expectedHarnessUsed);
      expect(result.task_branch).toBe(expectedTaskBranch);

      if (expectedSuccess) {
        expect(result.pull_request_url).toBe(
          "https://github.com/Giskard-AI/consumer-app/pull/1"
        );
        expect(result.pr_body).toContain("Closes #8");
        expect(result.pr_body).toContain("Part of #1");
        expect(result.agent_had_write_token).toBe(false);
        expect(result.publisher_token_revoked).toBe(true);
      }
    }
  );

  it.each([
    {
      id: "pi-harness-adapter-builds-deterministic-non-interactive-command-args",
      adapter: new PiHarnessAdapter(),
      expectedName: "pi",
      ticketTitle: "Implement first ticket with Pi"
    },
    {
      id: "codex-harness-adapter-builds-deterministic-non-interactive-command-args",
      adapter: new CodexHarnessAdapter(),
      expectedName: "codex",
      ticketTitle: "Implement ticket with Codex"
    }
  ])("$id", ({ adapter, expectedName, ticketTitle }) => {
    expect(adapter.name).toBe(expectedName);
    const invocation = adapter.buildSandboxInvocation({
      ticketIssueNumber: 8,
      ticketTitle,
      acceptanceCriteria: ["Adds healthcheck endpoint"],
      changedFiles: ["src/health.ts"]
    });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args.length).toBeGreaterThan(0);
  });

  it.each([
    {
      id: "swaps-pi-for-codex-via-agents-config-with-identical-contract",
      agentsConfigHarness: "codex" as const,
      expectedHarness: "codex"
    },
    {
      id: "defaults-to-pi-via-agents-config",
      agentsConfigHarness: "pi" as const,
      expectedHarness: "pi"
    },
    {
      id: "rejects-unknown-harness-name",
      agentsConfigHarness: "unknown-engine" as unknown as "pi",
      expectedHarness: "UNSUPPORTED_HARNESS"
    }
  ])(
    "Ticket 08 (#9) [$id]: swaps Pi and Codex on the exact same ticket without changing controller or permissions",
    async ({ agentsConfigHarness, expectedHarness }) => {
      const resolvedHarness = resolveHarnessFromAgentsConfig({
        harness: agentsConfigHarness
      });

      const baseTicket: TicketExecutionInput = {
        harness: resolvedHarness,
        repository: "Giskard-AI/consumer-app",
        repositoryId: 7001,
        planIssueNumber: 1,
        ticketIssueNumber: 8,
        ticketSlug: "pi-agent-harness",
        ticketTitle: "Implement first ticket with Pi or Codex",
        acceptanceCriteria: [
          "Adds healthcheck endpoint",
          "Passes unit tests"
        ],
        approvedByHuman: true,
        targetFeatureBranch: "feature/1-v1",
        changedFiles: ["src/health.ts", "tests/health.test.ts"],
        isolationAvailable: true,
        runnerEnv: BASE_RUNNER_ENV
      };

      const result = await runTicketWithHarness(baseTicket);

      if (expectedHarness === "UNSUPPORTED_HARNESS") {
        expect(result.completed).toBe(false);
        expect(result.error_code).toBe("UNSUPPORTED_HARNESS");
        return;
      }

      expect(result.completed).toBe(true);
      expect(result.error_code).toBe("NONE");
      expect(result.harness).toBe(expectedHarness);
      expect(result.task_branch).toBe("task/8-pi-agent-harness");
      expect(result.target_feature_branch).toBe("feature/1-v1");
      expect(result.pull_request_url).toBe(
        "https://github.com/Giskard-AI/consumer-app/pull/1"
      );
      expect(result.pr_body).toContain("Closes #8");
      expect(result.pr_body).toContain("Part of #1");
      expect(result.agent_had_write_token).toBe(false);
      expect(result.publisher_token_revoked).toBe(true);
    }
  );
});
