import { appendFileSync } from "node:fs";
import { redactSecrets } from "../../src/auth/issue-command-gate.js";
import { publishAgentProposal } from "../../src/publisher/isolated-publisher.js";

function writeGitHubOutputs(outputs: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, " ")}`)
    .join("\n");
  appendFileSync(outputPath, `${lines}\n`, "utf8");
}

function writeStepSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || !markdown.trim()) {
    return;
  }
  appendFileSync(summaryPath, `${markdown}\n`, "utf8");
}

async function run(): Promise<void> {
  const repository = process.env.INPUT_REPOSITORY ?? "";
  const repositoryId = Number.parseInt(
    process.env.INPUT_REPOSITORY_ID ?? "0",
    10
  );
  const assignedIssueNumber = Number.parseInt(
    process.env.INPUT_ASSIGNED_ISSUE_NUMBER ?? "0",
    10
  );
  const assignedBranchPrefix = process.env.INPUT_ASSIGNED_BRANCH_PREFIX ?? "";
  const allowedTargetFeatureBranch =
    process.env.INPUT_ALLOWED_TARGET_FEATURE_BRANCH ?? "";
  const rawProposal = process.env.INPUT_PROPOSAL_JSON ?? "";
  const allowWorkflowOrConfigEdits =
    (process.env.INPUT_ALLOW_WORKFLOW_OR_CONFIG_EDITS ?? "false")
      .trim()
      .toLowerCase() === "true";

  let agentEnvSnapshot: Record<string, string | undefined> = {};
  try {
    const rawEnv = process.env.INPUT_AGENT_ENV_JSON ?? "{}";
    const parsedEnv = JSON.parse(rawEnv) as unknown;
    if (typeof parsedEnv === "object" && parsedEnv !== null) {
      agentEnvSnapshot = parsedEnv as Record<string, string | undefined>;
    }
  } catch {
    // Keep empty snapshot if not valid JSON
  }

  const result = await publishAgentProposal({
    rawProposal,
    scope: {
      repository,
      repositoryId,
      assignedIssueNumber,
      assignedBranchPrefix,
      allowedTargetFeatureBranch,
      allowWorkflowOrConfigEdits
    },
    agentEnvSnapshot
  });

  writeGitHubOutputs({
    published: String(result.published),
    operation: result.operation,
    artifact_url: result.artifact_url,
    token_revoked: String(result.token_revoked),
    error_code: result.error_code,
    error_message: redactSecrets(result.error_message)
  });

  writeStepSummary(redactSecrets(result.summary_markdown));

  if (!result.published) {
    process.stderr.write(
      `::error title=EPURE Isolated Publisher Rejected (${result.error_code})::${redactSecrets(result.error_message)}\n`
    );
    process.exitCode = 1;
  }
}

void run();
