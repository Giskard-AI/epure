import { appendFileSync } from "node:fs";
import type { EpureCommandName } from "../../src/auth/issue-command-gate.js";
import { redactSecrets } from "../../src/auth/issue-command-gate.js";
import { orchestrateIssueCommand } from "../../src/orchestrator/issue-orchestrator.js";

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
  const repository =
    process.env.INPUT_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
  const issueNumber =
    Number.parseInt(process.env.INPUT_ISSUE_NUMBER ?? "0", 10) || 0;
  const command = (process.env.INPUT_COMMAND ?? "status").trim() as EpureCommandName;
  const commandArgs = process.env.INPUT_COMMAND_ARGS ?? "";
  const commentId =
    Number.parseInt(process.env.INPUT_COMMENT_ID ?? "0", 10) || 0;
  const actor = process.env.INPUT_ACTOR ?? process.env.GITHUB_ACTOR ?? "";
  const agentAppId = (
    process.env.INPUT_AGENT_APP_ID ??
    process.env.EPURE_AGENT_APP_ID ??
    ""
  ).trim();
  const agentAppPrivateKey = (
    process.env.INPUT_AGENT_APP_PRIVATE_KEY ??
    process.env.EPURE_AGENT_APP_PRIVATE_KEY ??
    ""
  ).trim();
  const fallbackGithubToken = (
    process.env.INPUT_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    ""
  ).trim();
  const llmApiKey = (
    process.env.INPUT_LLM_API_KEY ??
    process.env.LLM_API_KEY ??
    ""
  ).trim();
  const model = (process.env.INPUT_MODEL ?? "gemini-2.5-flash").trim();

  const secrets = [agentAppPrivateKey, fallbackGithubToken, llmApiKey].filter(
    (s) => s.length >= 4
  );

  try {
    const result = await orchestrateIssueCommand({
      repository,
      issueNumber,
      command,
      commandArgs,
      commentId,
      actor,
      agentAppId,
      agentAppPrivateKey,
      fallbackGithubToken,
      llmApiKey,
      model
    });

    writeGitHubOutputs({
      executed: String(result.executed),
      phase: result.phase,
      status: result.status,
      active_branch: result.active_branch,
      feature_pr_url: result.feature_pr_url
    });

    if (result.summary_markdown) {
      writeStepSummary(redactSecrets(result.summary_markdown, secrets));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const safeMsg = redactSecrets(msg, secrets);
    process.stderr.write(`::error title=EPURE Orchestration Failed::${safeMsg}\n`);
    process.exitCode = 1;
  }
}

void run();
