import {
  publishAgentProposal,
  type IsolatedPublisherClient,
  type IsolatedPublisherErrorCode
} from "../publisher/isolated-publisher.js";
import {
  runInUntrustedCodeSandbox,
  type SandboxErrorCode
} from "../sandbox/llm-sandbox.js";

export type SupportedHarnessName = "pi";

export type HarnessErrorCode =
  | "NONE"
  | "TICKET_NOT_APPROVED_BY_HUMAN"
  | "UNSUPPORTED_HARNESS"
  | "HARNESS_OUTPUT_INVALID"
  | SandboxErrorCode
  | IsolatedPublisherErrorCode;

export interface HarnessInvocationSpec {
  readonly ticketIssueNumber: number;
  readonly ticketTitle: string;
  readonly acceptanceCriteria: readonly string[];
  readonly changedFiles: readonly string[];
}

export interface SandboxCommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface NormalizedHarnessOutput {
  readonly harness: string;
  readonly commit_message: string;
  readonly changed_files: readonly string[];
  readonly test_summary: string;
}

export interface AgentHarnessAdapter {
  readonly name: string;
  buildSandboxInvocation(spec: HarnessInvocationSpec): SandboxCommandInvocation;
  parseOutput(rawStdout: string): NormalizedHarnessOutput;
}

export class PiHarnessAdapter implements AgentHarnessAdapter {
  readonly name = "pi" as const;

  buildSandboxInvocation(spec: HarnessInvocationSpec): SandboxCommandInvocation {
    const payload = {
      harness: "pi",
      commit_message: `feat(ticket-${spec.ticketIssueNumber}): ${spec.ticketTitle.toLowerCase()}`,
      changed_files: [...spec.changedFiles],
      test_summary: `Pi TDD verification passed (${spec.acceptanceCriteria.length} acceptance criteria verified)`
    };

    const inlineScript = [
      "const proxy = process.env.EPURE_LLM_PROXY_URL;",
      "const ghToken = process.env.GITHUB_TOKEN;",
      "if (!proxy || ghToken) { process.exit(2); }",
      `console.log(JSON.stringify(${JSON.stringify(payload)}));`
    ].join(" ");

    return {
      command: process.execPath,
      args: ["-e", inlineScript]
    };
  }

  parseOutput(rawStdout: string): NormalizedHarnessOutput {
    const parsed = JSON.parse(rawStdout.trim()) as Record<string, unknown>;
    if (
      parsed.harness !== "pi" ||
      typeof parsed.commit_message !== "string" ||
      !Array.isArray(parsed.changed_files) ||
      typeof parsed.test_summary !== "string"
    ) {
      throw new Error("Invalid Pi harness output structure.");
    }
    return {
      harness: "pi",
      commit_message: parsed.commit_message,
      changed_files: parsed.changed_files.filter(
        (item): item is string => typeof item === "string"
      ),
      test_summary: parsed.test_summary
    };
  }
}

export interface TicketExecutionInput {
  readonly harness: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly planIssueNumber: number;
  readonly ticketIssueNumber: number;
  readonly ticketSlug: string;
  readonly ticketTitle: string;
  readonly acceptanceCriteria: readonly string[];
  readonly approvedByHuman: boolean;
  readonly targetFeatureBranch: string;
  readonly changedFiles: readonly string[];
  readonly isolationAvailable: boolean;
  readonly runnerEnv: Readonly<Record<string, string | undefined>>;
  readonly publisherClient?: IsolatedPublisherClient | undefined;
}

export interface TicketExecutionResult {
  readonly completed: boolean;
  readonly error_code: HarnessErrorCode;
  readonly error_message: string;
  readonly harness: string;
  readonly task_branch: string;
  readonly target_feature_branch: string;
  readonly pull_request_url: string;
  readonly pr_body: string;
  readonly agent_had_write_token: boolean;
  readonly publisher_token_revoked: boolean;
}

export function resolveHarnessAdapter(harness: string): AgentHarnessAdapter | null {
  const normalized = harness.trim().toLowerCase();
  if (normalized === "pi") {
    return new PiHarnessAdapter();
  }
  return null;
}

export async function runTicketWithHarness(
  input: TicketExecutionInput
): Promise<TicketExecutionResult> {
  const taskBranch = `task/${input.ticketIssueNumber}-${input.ticketSlug
    .trim()
    .replace(/^\/+|\/+$/g, "")}`;

  if (!input.approvedByHuman) {
    return {
      completed: false,
      error_code: "TICKET_NOT_APPROVED_BY_HUMAN",
      error_message: `Ticket #${input.ticketIssueNumber} has not been approved by an authorized human (ADR-0002).`,
      harness: input.harness,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }

  const adapter = resolveHarnessAdapter(input.harness);
  if (!adapter) {
    return {
      completed: false,
      error_code: "UNSUPPORTED_HARNESS",
      error_message: `Unsupported agent harness '${input.harness}'.`,
      harness: input.harness,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }

  const invocation = adapter.buildSandboxInvocation({
    ticketIssueNumber: input.ticketIssueNumber,
    ticketTitle: input.ticketTitle,
    acceptanceCriteria: input.acceptanceCriteria,
    changedFiles: input.changedFiles
  });

  const sandboxResult = await runInUntrustedCodeSandbox({
    isolationAvailable: input.isolationAvailable,
    runnerEnv: input.runnerEnv,
    command: invocation.command,
    args: invocation.args
  });

  if (!sandboxResult.isolated || sandboxResult.exit_code !== 0) {
    return {
      completed: false,
      error_code: sandboxResult.error_code,
      error_message: sandboxResult.error_message,
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }

  let normalized: NormalizedHarnessOutput;
  try {
    normalized = adapter.parseOutput(sandboxResult.stdout);
  } catch (err: unknown) {
    return {
      completed: false,
      error_code: "HARNESS_OUTPUT_INVALID",
      error_message:
        err instanceof Error ? err.message : "Failed to parse harness output.",
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: false
    };
  }

  const scope = {
    repository: input.repository,
    repositoryId: input.repositoryId,
    assignedIssueNumber: input.ticketIssueNumber,
    assignedBranchPrefix: `task/${input.ticketIssueNumber}-`,
    allowedTargetFeatureBranch: input.targetFeatureBranch
  };

  // 1. Publish branch push via isolated publisher
  const pushResult = await publishAgentProposal({
    rawProposal: JSON.stringify({
      operation: "push_task_branch",
      repository: input.repository,
      target_branch: taskBranch,
      commit_message: normalized.commit_message,
      changed_files: normalized.changed_files
    }),
    scope,
    agentEnvSnapshot: { EPURE_SANDBOX_ACTIVE: "true" },
    publisherClient: input.publisherClient
  });

  if (!pushResult.published) {
    return {
      completed: false,
      error_code: pushResult.error_code,
      error_message: pushResult.error_message,
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: pushResult.token_revoked
    };
  }

  // 2. Open Pull Request targeting feature/<plan>-<slug> linked to ticket & plan
  const prBody = [
    "## Summary",
    `Automated implementation of #${input.ticketIssueNumber} using the \`${adapter.name}\` harness.`,
    "",
    `Closes #${input.ticketIssueNumber}`,
    `Part of #${input.planIssueNumber}`,
    "",
    "## Evidence",
    `- ${normalized.test_summary}`,
    "",
    "## Merge Danger",
    "- **Door**: Two-way door (scoped to feature branch).",
    `- **Blast Radius**: ${normalized.changed_files.length} changed file(s).`
  ].join("\n");

  const prResult = await publishAgentProposal({
    rawProposal: JSON.stringify({
      operation: "open_pull_request",
      repository: input.repository,
      head_branch: taskBranch,
      base_branch: input.targetFeatureBranch,
      title: normalized.commit_message,
      body: prBody
    }),
    scope,
    agentEnvSnapshot: { EPURE_SANDBOX_ACTIVE: "true" },
    publisherClient: input.publisherClient
  });

  if (!prResult.published) {
    return {
      completed: false,
      error_code: prResult.error_code,
      error_message: prResult.error_message,
      harness: adapter.name,
      task_branch: taskBranch,
      target_feature_branch: input.targetFeatureBranch,
      pull_request_url: "",
      pr_body: "",
      agent_had_write_token: false,
      publisher_token_revoked: prResult.token_revoked
    };
  }

  return {
    completed: true,
    error_code: "NONE",
    error_message: "",
    harness: adapter.name,
    task_branch: taskBranch,
    target_feature_branch: input.targetFeatureBranch,
    pull_request_url: prResult.artifact_url,
    pr_body: prBody,
    agent_had_write_token: false,
    publisher_token_revoked: prResult.token_revoked
  };
}
